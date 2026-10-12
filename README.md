# dsh-plugin-safe-session-delete

> Safe, auditable, permanent session deletion for the DeepSeek
> Harness.

Deletion of a session is one of the most destructive actions a user can
take in the harness: it removes durable logs, projection caches, and
workspace accounting that the agent and the host rely on. This plugin
builds every entry point around three commitments — **identity**,
**integrity**,
**authorization** — so that the right session disappears, only the
right session disappears, and only with the user's deliberate consent.

- A header **Delete session** button next to each session's title.
- A sidebar three-dot menu command sourced from each row's
  authoritative session id.
- A shared **confirmation dialog** with explicit acknowledgement
  before any deletion proceeds.
- The **`workbench_session_delete` agent tool**, exposed to models
  through the harness tool registry with a mandatory trusted-user
  approval gate. The tool refuses self-deletion; running agents
  must be explicitly interrupted before deletion proceeds.

Every entry point routes through one central deletion service that
runs as a transactional state machine
(`VALIDATED → AUTHORIZED → LOCKED → QUIESCED → PREPARED → RETIRED →
METADATA_UPDATED → PERSISTENCE_PURGED → VERIFIED`) and refuses to
report success until the target session id is provably absent from
every layer. A durable intent marker enables crash-safe recovery.

```sh
dsh plugin --profile web add https://github.com/SteindelSE/dsh-plugin-safe-session-delete
```

---

## What this plugin provides (v1.0.0)

* A **Delete session** button in the conversation header (slot
  `conversation.session.header.actions`). One click opens the
  confirmation dialog.
* A **Delete session** command in the sidebar row's three-dot menu
  (slot `sidebar.workspaces.session.menu.item`). Closes the menu
  first, then opens the dialog.
* A **Delete Permanently** dialog mounted on the `shell.overlay`
  slot. Shows the session id, the resolved title from the
  projection cache, the running flag, and the source. Two
  acknowledgements are required for running sessions (general +
  interrupt). Cancel does nothing; Delete Permanently calls the
  host's `dialogConfirm` seam.
* The **`workbench_session_delete`** agent tool, registered on the
  host and exposed to every agent in the profile through the harness
  tool registry.
* A mandatory **`tools/pre-execute` approval gate**. Every
  agent invocation is shown to the user for approval; without an
  approval service mounted, the registry degrades to denial.
* A central **`SessionDeleteService`** that runs the
  transactional deletion state machine and the
  **`AuthorizationManager`** that mints and redeems single-use
  authorization receipts.

### How the renderer talks to the host

The renderer never sees the harness tool registry. Instead, the host
installs `globalThis.__dsh_safe_session_delete_seam__` for the
plugin's lifetime, with three methods:

* `describeSession({ sessionId })` → `{ sessionId, title, running }`
* `dialogConfirm({ sessionId, sourceTag, interruptActive })` →
  `{ ok, phases, removed, canonicalId }` or `{ ok: false, error }`
* `onDeleted({ canonicalId })` — a hook the host invokes to tell
  the renderer to refresh

The client bundle calls these via the global. The host disposes
the global on disable/update/uninstall.

## Safety commitments

### Identity — the right session disappears

* Sessions are resolved **only by** the authoritative session id
  received from the harness's client state. The plugin never matches
  sessions by title, partial title, row position, or any text on
  screen.
* Identifiers are validated against a strict UUID pattern; anything
  that doesn't look like a session id is rejected before any
  filesystem operation.
* Raw `uuid` and `session-<uuid>` spellings are proven to describe
  the same session through filesystem, planner, and projection-cache
  cross-checks. Two records under either spelling cannot be
  collapsed.
* Prefix-colliding identifiers (`...aaa` vs `...aab`) cannot
  collide.

### Integrity — only the right session disappears

* The plugin refuses to traverse symbolic links at the slug, session
  directory, or projection-cache layers.
* Every path operation is contained inside the canonical storage
  root; prefix-attack paths (`/home/x/.dsh-evil`) are rejected by a
  separator-boundary check.
* Deletion is a transactional state machine
  (`VALIDATED → AUTHORIZED → LOCKED → QUIESCED → PREPARED → RETIRED →
  METADATA_UPDATED → PERSISTENCE_PURGED → VERIFIED`). The VERIFIED
  phase re-reads every layer and refuses to report success if the
  session is still referenced anywhere.
* Concurrent deletes on the same id are serialized through an
  in-process lock; two callers cannot race the same deletion.
* Workspace membership edits are atomic (lock + rename-after-temp);
  torn writes are not possible.
* Session logs are removed by staging to a tmp sibling, deleting,
  and verifying absence; a reappearing directory is a hard failure.

### Authorization — only with the user's deliberate consent

* The UI dialog mints a 16-byte cryptographic authorization receipt
  when the user presses **Delete Permanently**. The receipt is
  bound to the canonical session id and the active profile.
* Agent-initiated deletion routes through the harness's
  `tools/pre-execute` `ask` decision. Every invocation is shown to
  the user for approval; without an approval service mounted, the
  registry degrades to denial.
* Receipts are **single-use**. Replay, cross-session reuse, and
  cross-profile reuse are all rejected.
* A model statement of permission is **not** authorization. A
  boolean parameter (`confirmed: true`) is **not** authorization.
  Only a minted, redeemed token counts.
* The executing agent cannot delete its own session. The tool's
  execute checks `exec.agent?.id` against the requested id and
  refuses with `DeleteAuthorizationFailedError` even when a fresh
  token has been minted.
* Running sessions require explicit acknowledgement of the
  interrupt. Cancellation is requested, **not assumed** —
  cancellation timeouts fail the deletion rather than proceeding.

### Recovery

* A durable intent marker is written to
  `~/.dsh/storages/safe-session-delete.recovery.json` **before** any
  irreversible operation begins.
* On the next plugin load, `recoverFromIntents()` sweeps every
  pending intent and either clears it (when the target is fully
  gone) or surfaces it for the user (when the deletion was
  interrupted mid-flight).
* A partial deletion never reports success. The VERIFIED phase is
  the only source of truth.

---

## What this plugin does not do

* **HTTP deletion endpoints.** The plugin does not register any
  HTTP route. All destruction flows through the in-process
  `ctx.safeSessionDelete` seam, which lives in the same trust zone
  as the rest of the harness. Adding an HTTP deletion surface in
  the future would require origin validation, CSRF protection,
  replay protection, target-bound authorization, and request-body
  limits — none of which are trivial to design correctly.
* **Bulk or wildcard deletion.** Every deletion targets exactly one
  canonical id. There is no "delete all", "delete by prefix", or
  "delete by title" surface.
* **Self-deletion via the agent tool.** A model cannot delete its
  own session even with a fresh token.
* **Cross-process recovery.** The plugin's locks are per-process.
  Multi-process harness environments need deployment-level
  coordination that the plugin does not attempt.
* **A bypass to the user's approval.** The harness's `approval`
  seam, when mounted, may persist a prior "always allow"
  preference; the plugin honors that seam but implements no
  bypass of its own.

These are intentional, not unfinished. Each is safer than any
plausible implementation that would address it.

---

## Installation

The plugin follows the cordis bundle rule: it ships as a local
package with a self-contained `cordis.patch.yml` that mounts the
plugin's own `src/index.js`. After the package is installed, the
bundle loader reads `./cordis.patch.yml` from inside the
package and resolves its `name:` field relative to that file —
which means the install is **location-independent** and works
regardless of where the plugin was cloned, installed, or
unzipped on your machine.

A `postinstall` script registers the package name in the parent
profile's `dsh.profile.bundles` array, so no manual `package.json`
editing is required once pnpm is allowed to run the script (one-time,
per profile).

### One-command install (recommended)

Open the DSH web UI, go to **Settings → Plugins**, click **Add
plugin**, and paste a GitHub URL or local path:

```text
https://github.com/SteindelSE/dsh-plugin-safe-session-delete
```

The UI prompts you to approve the build script the first time,
runs `pnpm add`, lets the `postinstall` hook register the
bundle, and reloads the profile. Refresh the browser once and
the **Delete session** button, sidebar command, and dialog
overlay are live.

### CLI install

The same package installs from the command line:

```sh
# from a local clone
dsh plugin --profile <name> add file:/absolute/path/to/dsh-plugin-safe-session-delete

# directly from GitHub
dsh plugin --profile <name> add https://github.com/SteindelSE/dsh-plugin-safe-session-delete
```

pnpm 10+ blocks lifecycle scripts for non-registry dependencies
by default, so the first run aborts with `ERR_PNPM_IGNORED_BUILDS`.
Approve the build and re-run:

```sh
pnpm --dir ~/.dsh/profiles/<name> approve-builds
dsh plugin --profile <name> add https://github.com/SteindelSE/dsh-plugin-safe-session-delete
```

The second run executes the `postinstall` hook, which writes
the package name into `~/.dsh/profiles/<name>/package.json`'s
`dsh.profile.bundles` array. Refresh the browser and the plugin
is active.

### Verifying the install

1. Confirm your installed harness version is `0.2.0-rc.2` or
   newer:

   ```sh
   dsh --version
   ```

2. Confirm the bundle is registered:

   ```sh
   grep -A1 '"bundles"' ~/.dsh/profiles/<name>/package.json
   # should list "dsh-plugin-safe-session-delete"
   ```

3. Restart the profile if it was already running before the
   install (`dsh web` or your Desktop client). The plugin
   loads through the cordis loader, registers its host-side
   tool, and the bundled client mounts the header button,
   sidebar menu item, and dialog overlay on the first render.

> **Do not** copy the `insert:` block out of `cordis.patch.yml`
> into your own `~/.dsh/cordis.patch.yml`. The `name:` field is
> a path relative to the patch file. It only resolves correctly
> when the bundle loader reads the patch from inside the
> installed plugin directory. Use the dsh plugin install path
> instead.

## Uninstall

Removing the plugin is a clean uninstall with no harness-side
residue:

* If you installed via `dsh plugin add`, run:

  ```sh
  dsh plugin --profile <profile> remove dsh-plugin-safe-session-delete
  ```

* Restart the profile. (If `pnpm` is on PATH for the profile's
  shell — see "Troubleshooting" below — this is automatic.)

> The plugin never writes to a global patch file. There is
> nothing to remove from `~/.dsh/cordis.patch.yml` or from a
> profile's own `cordis.patch.yml` for a `dsh plugin add`
> install.

The plugin owns every registration through `ctx.effect`, so disposal
unregisters the tool, removes slot entries, releases locks, and
disposes the authorization manager. The plugin writes nothing to
disk except its own transient recovery marker, which is removed
automatically on the next successful run.

---

## Compatibility

| Component                                  | Status         |
|--------------------------------------------|----------------|
| Tested with `dsh` `0.2.0-rc.2`             | ✔              |
| Peer-deps on `@deepseek-ai/dsh-tools ^0.2.0-rc.2` | ✔ |
| Web profile                                | ✔              |
| Terminal-only profile                      | ✔ (HTTP-less; tool and slots still register) |
| Desktop profile (Electron)                 | ✔ (slot-based UI; no separate API path required) |
| Headless / SDK profile                     | ✔ (tool-only; UI surfaces are web-only) |

---

## Tests

```bash
mkdir -p node_modules/@deepseek-ai && \
  ln -sf <dsh-install>/node_modules/@deepseek-ai/dsh-tools \
        node_modules/@deepseek-ai/dsh-tools
node --test tests/
```

There are **87 tests** in six suites:

| Suite | Count | What it proves |
|---|---|---|
| `tests/unit/identity.test.js` | 16 | id validation, ambiguous spellings, symlinked targets, prefix collisions, path traversal. |
| `tests/unit/authorization.test.js` | 12 | target binding, single-use, replay, expiry, cross-kind, cross-profile, boolean-as-token. |
| `tests/unit/filesystem.test.js` | 18 | path containment, symlink rejection, atomic writes, file locks, idempotency. |
| `tests/unit/agent-lifecycle.test.js` | 18 | cancellation, quiescence timeout (transition aborts), flush failure (transition aborts), self-deletion detection, missing services. |
| `tests/integration/session-delete.test.js` | 12 | full state machine end to end, **mandatory collateral-damage test** (4 unrelated sessions stay byte-identical), concurrent deletion serialization. |
| `tests/security/authorization-attacks.test.js` | 11 | forged tokens, replay, cross-session, cross-profile, model-statement-of-permission, boolean parameter, missing-approval-service degradation, self-deletion, recovery. |

All tests run against synthetic `$DSH_HOME` directories built by
`tests/fixtures/synthetic-home.js` and never touch real sessions.

---

## Project layout

```text
dsh-plugin-safe-session-delete/
  package.json
  cordis.patch.yml
  build.mjs                           esbuild client-bundle script
  README.md
  SECURITY.md
  LICENSE
  src/
    index.js                          host plugin entry (registers tool, seam, global bridge)
    client.entry.js                   source for the renderer bundle (esbuild input)
    client.js                         generated renderer bundle (IIFE / factory form)
    services/
      session-resolver.js             authoritative id + scope validation
      authorization.js                target-bound single-use tokens
      persistence.js                  atomic workspace.json edits,
                                      symlink-aware projcache removal,
                                      session-log staged-then-removed
      session-lifecycle.js            cancel + quiesce + flush + detach
      session-delete.js                 central deletion state machine
      recovery.js                     interrupted-delete recovery sweep
    tools/
      workbench-session-delete.js     agent tool + tools/pre-execute gate
  tests/
    fixtures/synthetic-home.js        isolated $DSH_HOME builder
    unit/                             resolver / auth / fs / lifecycle tests
    integration/                      end-to-end + collateral damage
    security/                         authorization attack tests
```

### Build pipeline

The client bundle (`src/client.js`) is a build artifact produced by
`esbuild` from `src/client.entry.js`. The artifact is **committed
to the repository**, so `dsh plugin add` does not need to run any
lifecycle scripts on the user's machine (pnpm blocks git-hosted
packages' scripts by default; shipping the prebuilt bundle keeps
the install path frictionless).

For a contributor who edits `src/client.entry.js`, regenerate the
bundle:

```sh
pnpm build
# or
node build.mjs
```

Before pushing, verify the regenerated bundle matches what was
committed. The build is deterministic; a `git diff src/client.js`
after `pnpm build` should be empty if the source was unchanged.

The bundle:

* Uses `--format=iife` so the output is a single classic script that
  runs `window.__ModuleLoader__.load(...)` at script load time.
* Marks `react`, `react/jsx-runtime`, `react-dom`, `react-dom/client`,
  and `@deepseek-ai/*` as **externals** — the harness's module graph
  provides them through the factory's `require` parameter. Inlining
  them would create a second React instance in the page.
* Does not use JSX. The source calls
  `require("react/jsx-runtime").jsx(...)` explicitly to keep the
  bundle portable and the transform trivial.

---

## License

GNU Affero General Public License, version 3 or (at your option) any
later version. See `LICENSE` for the full text.

This plugin is free software: you can redistribute it and/or modify it
under the terms of the AGPL-3.0-or-later. The AGPL is chosen
deliberately because session deletion is a network-side action — the
plugin modifies state in a running harness, including state that
end users reach over a network. The AGPL ensures that anyone
distributing a modified version of this plugin over a network must
also make the corresponding source available under the same terms.

## Contact

Issues, security disclosures, and contribution proposals are tracked
on the upstream project page:

<https://github.com/SteindelSE/dsh-plugin-safe-session-delete>

The `LICENSE` file ends with the project's contact notice; the
per-file headers carry the SPDX-License-Identifier for tooling that
parses them.

If you cannot accept the AGPL for a specific integration, please open
an issue on the upstream page to discuss alternative licensing.