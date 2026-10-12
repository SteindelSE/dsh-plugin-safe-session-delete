# Security Architecture

Deletion of a session is irreversible. This document is the
threat-model justification for every decision in the deletion flow:
each section names a specific attack class the plugin is designed to
defeat, and the corresponding defense.

## Threat model

The plugin assumes:

1. **The local filesystem can be partially hostile.** A misbehaving
   host (or any user with write access to `~/.dsh/sessions/`) could
   plant symlinks, fake entries, or duplicate records intended to
   redirect a deletion at an unrelated session.
2. **Untrusted text is the most common input.** Model output,
   retrieved web pages, repository files, and tool responses can
   all be coerced into attempting destructive actions.
3. **The renderer is trusted** but communicates with the host over
   a narrow seam; the seam is the only path the renderer uses to
   request deletion.
4. **The harness is a single-user app** but Desktop and the bundled
   CLI may share the same `$DSH_HOME` concurrently; the plugin
   tolerates that but does not require it.
5. **A process can crash at any point** between phases and must
   leave a recoverable state.

## Decisions, by threat class

### 1. Identifier ambiguity

**Attack.** The harness stores session ids under two spellings:
`session-<uuid>` (canonical, used by `workspace.json` and the
host-side session store) and `<uuid>` (raw, used by the projection
cache and the JSONL log backend). A plugin that looks up either
spelling can collapse them and delete more than it intended; a
plugin that only checks one spelling can leave half of the
session's records behind.

**Defense.** `verifySingleSession()` in
`services/session-resolver.js` requires exactly one persisted target
under the canonical id:

* The on-disk log must appear under exactly one slug.
* The projection cache may carry zero or one entry per spelling.
* The workspace membership may be empty (an idle session is valid).
* Malformed or duplicate projection-cache records are an automatic
  refusal.

The plugin never looks up a session by title.

### 2. Symlink redirection

**Attack.** A symlinked slug, a symlinked session directory, or a
symlinked projection-cache file lets an attacker point any of these
paths at a target the user did not authorize.

**Defense.** `lstatSync` is used to classify every candidate. A
symlink at any of these layers throws `SessionPathEscapeError` and
the deletion aborts. The plugin never walks through symlinks.

The container check `root` ⊃ `path` is enforced with a
path-separator boundary, so a target `/home/x/.dsh-evil` cannot
pass a naive `startsWith('/home/x/.dsh')` check.

### 3. Path traversal in the id

**Attack.** A caller passes `'../../../etc/passwd'` or
`'/etc/passwd'` expecting the plugin to treat it as a session id.

**Defense.** `normalizeSessionId()` validates the id against
`SESSION_ID_RE = /^(session-)?[0-9a-f]{8}-...{12}$/i`. Anything
else throws `SessionIdFormatError`. The id never reaches a path
operation until it has been validated.

### 4. Running-agent race

**Attack.** The host could not finish cancelling an active agent,
or its persistence layer could re-materialize the session directory
while the workspace edit was in flight, leaving the user with a
half-deleted session.

**Defense.**

* `cancelAgentIfRunning()` does NOT use `Promise.race`. It awaits
  `whenIdle()` and rejects with `AgentNotIdleError` on timeout.
* `flushLiveSessions()` is awaited after cancellation. A throw
  there is `DeleteFlushError`; the deletion aborts.
* `removeSessionDir()` is not retried. The plugin stages the
  directory to a tmp sibling, removes it, then verifies the
  canonical path is absent. A reappearing directory is
  `DeleteVerificationError`.
* The VERIFIED phase re-reads every layer; if the session is
  referenced anywhere, the deletion fails honestly rather than
  reporting partial success.

### 5. Silent error swallowing

**Attack.** A plugin that wraps persistence calls in
`try { ... } catch { /* */ }` may leave an inconsistent state if
one layer fails silently.

**Defense.** All persistence operations are surfaced to the
deletion service. The service does not swallow errors; any thrown
error fails the deletion and leaves the intent record for recovery.

### 6. Authenticated HTTP endpoints

**Attack.** Any HTTP endpoint that exposes deletion requires origin
validation, CSRF tokens, replay protection, target-bound
authorization, and request-body limits.

**Defense.** This plugin does not register HTTP endpoints. The
renderer reaches the deletion service through the in-process
`ctx.safeSessionDelete` seam, which is bound to the same host
trust zone as the rest of the harness.

### 7. Authorization tokens

**Attack.** Untrusted model output might say "the user has
confirmed" or "set `confirmed: true`" in an attempt to bypass a
token check.

**Defense.**

* A token is a **16-byte cryptographically-random hex string**
  minted by the `AuthorizationManager` when the user presses
  **Delete Permanently** (`UI_DIRECT`) or approves the agent's
  request via the harness approval surface (`UI_AGENT_APPROVAL`).
* A token is **single-use**. Replay is rejected with
  `AuthorizationReplayError`.
* A token is **target-bound**. Using it against a different
  session id is rejected with
  `AuthorizationTargetMismatchError`.
* A token is **profile-bound**. Using it under a different
  profile is rejected with `AuthorizationTargetMismatchError`.
* A token has a **short expiration** (60 seconds for direct
  dialogs, 5 minutes for agent approval surfaces).
* Tokens are stored **in process memory only**. They are not
  written to disk; an uninstalled plugin discards them on dispose.
* Boolean `confirmed: true` is not a token. A token is a 32-char
  hex string; anything else is refused at the tool's argument
  validation step.

### 8. Self-deletion by the executing agent

**Attack.** A model running on session X could call
`workbench_session_delete(sessionId=X)` to escape its own context.

**Defense.** The tool's `execute` checks `exec.agent?.id` against
the requested session id and refuses with
`DeleteAuthorizationFailedError("an agent may not delete its own
executing session")`. This is in addition to the standard approval
requirement; the user must mint a fresh token **and** the
executing agent must not own the target.

### 9. Storage torn writes

**Attack.** A concurrent editor could read-modify-write
`workspace.json` and lose one set of changes.

**Defense.** All edits to `workspace.json` are performed under
`withFileLock(filePath, ...)` and committed via rename-after-temp.
The `workspace.json` write is never a direct in-place rewrite.

### 10. Filesystem escape during staged removal

**Attack.** A symlink planted between resolve and delete could
redirect the staged rename to an unrelated tree.

**Defense.** `removeSessionDir()`:

1. `lstat()`s the leaf and rejects if it is non-directory or a
   symlink;
2. realpath's the parent, then `assertContained(root, parent)`;
3. Renames to a sibling tmp inside the parent;
4. Awaits the `rm` of the staged directory;
5. Verifies the canonical path is absent afterwards. A reappearing
   directory is `DeleteVerificationError`.

### 11. Project crash during deletion

**Attack.** Process crash between workspace edit and log deletion
leaves a half-deleted session.

**Defense.** Before any destructive write, the deletion service
records a `DeletionIntent` to
`~/.dsh/storages/safe-session-delete.recovery.json`. The intent
includes the canonical id, the canonical session directory realpath,
the projection spellings, and the workspace claims. On the next
plugin load, `recoverFromIntents()` sweeps each intent:

* If the target is fully gone, the intent is cleared.
* If the target is still partially present, the user is warned and
  the intent is left for manual intervention.

The VERIFIED phase also runs an inline re-check on every
successful deletion: the workspace.json, the session log directory,
and the projection cache are all re-read and the target id must be
absent in each before the deletion reports success.

---

## What this plugin does not do

* It does not patch the harness core or any other installed plugin.
* It does not register a web server, an HTTP endpoint, or a
  WebSocket for deletion. The renderer is the only trusted client.
* It does not implement cross-process recovery. `withFileLock` is
  per-process; cross-process coordination is a deployment concern.
* It does not attempt to detect or repair damage caused by another
  plugin or a malicious process on the host filesystem.

---

## Audit log

Every authorization mint, redeem, revoke, and dispose is logged
via `AuthorizationManager.audit`. Every deletion phase transition
and every failure is logged via `SessionDeleteService.audit`.
Hosts are expected to wire these to their logger:

```js
ctx.logger?.('dsh-plugin-safe-session-delete')?.info?.(
  'delete:%s:%s', event, JSON.stringify(payload || {}),
);
```

The plugin does not silently fail. If your logger cannot be
mounted yet, the audit hooks no-op; that is a degraded but never
silent posture.