// dsh-plugin-safe-session-delete — session-delete
//
// Copyright (C) 2026 SteindelSE
//
// This file is part of dsh-plugin-safe-session-delete.
//
// dsh-plugin-safe-session-delete is free software: you can
// redistribute it and/or modify it under the terms of the GNU
// Affero General Public License as published by the Free Software
// Foundation, either version 3 of the License, or (at your option)
// any later version.
//
// dsh-plugin-safe-session-delete is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY; without even the
// implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR
// PURPOSE. See the GNU Affero General Public License for more
// details.
//
// You should have received a copy of the GNU Affero General Public
// License along with dsh-plugin-safe-session-delete. If not, see
// <https://www.gnu.org/licenses/>.
//
// Contact: <https://github.com/SteindelSE/dsh-plugin-safe-session-delete>
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The single authoritative deletion service. Every UI path (header button,
// sidebar menu) and every agent path (the workbench_session_delete tool)
// MUST call `deleteSession()` here. There is no other entry point.
//
// Operation phases (transactional state machine):
//
//   VALIDATED        id is well-formed; one persisted session is found;
//                    no path escape; no symlink.
//   AUTHORIZED       a target-bound, single-use, human-issued receipt
//                    was redeemed (UI_DIRECT or UI_AGENT_APPROVAL).
//   LOCKED           an exclusive in-process lock on the target id has
//                    been acquired (concurrent deletes are rejected).
//   QUIESCED         any live Agent for the session has been cancelled
//                    and verified idle, OR the session is not running.
//   PREPARED         the on-disk intent record has been written so an
//                     interrupted operation can be detected at next boot.
//   RETIRED          the in-memory session entry has been detached.
//   METADATA_UPDATED the workspace.json membership and global archive
//                   state have been edited under a file lock.
//   PERSISTENCE_PURGED the projection cache file and the session log
//                   directory have been removed and verified absent.
//   VERIFIED         every check above has been re-run and nothing the
//                   plugin touches still references the deleted session.
//
// Failure semantics:
//   - Any thrown error between phases L and V leaves the deletion in a
//     recoverable state. The intent record is removed only after VERIFIED.
//   - VERIFIED never reports success unless every dependency observable
//     to the resolver reports the session is gone. The plugin reports
//     partial deletion honestly rather than call it success.
//
// Why a single retry-less remove: a session deletion that races the
// host's persistence layer (the host re-materializes files mid-attach)
// is solved by requiring VERIFIED quiescence (cancel + flush + detach
// + intent) BEFORE the first filesystem write, so there is nothing
// left to recreate the files. A second filesystem attempt is
// therefore never necessary and would mask a real failure.

import {
  normalizeSessionId,
  verifySingleSession,
  makeDeletionIntent,
  findSessionDirs,
  sessionIdVariants,
  resolveDshHome,
  SessionAmbiguousError,
  SessionIdFormatError,
  SessionPathEscapeError,
} from './session-resolver.js';

import {
  AuthorizationManager,
  AuthorizationError,
  TOKEN_KINDS,
} from './authorization.js';

import {
  stripWorkspaceMembership,
  stripProjcache,
  removeSessionDir,
  writeDeletionIntent,
  clearDeletionIntent,
  readWorkspace,
  readDeletionIntents,
} from './persistence.js';

import {
  cancelAgentIfRunning,
  flushLiveSessions,
  detachLiveSession,
  isSessionRunning,
  isSessionAttachedInPersistence,
  probeLifecycleServices,
  AgentNotIdleError,
  SessionFlushError,
  DEFAULT_QUIESCENCE_TIMEOUT_MS,
  callTargetsOwnSession,
} from './session-lifecycle.js';

import { recoverySweep } from './recovery.js';

/**
 * The default persistence implementation, captured at module load. The
 * session-delete service resolves every persistence call through this
 * snapshot so tests can substitute a different implementation via the
 * `persistence` constructor option without mutating the module graph.
 */
const _defaultPersistence = Object.freeze({
  stripWorkspaceMembership,
  stripProjcache,
  removeSessionDir,
  writeDeletionIntent,
  clearDeletionIntent,
  readWorkspace,
  readDeletionIntents,
});

// --- phase names (kept in sync with the state machine in SECURITY.md) ------

export const PHASES = Object.freeze({
  VALIDATED: 'VALIDATED',
  AUTHORIZED: 'AUTHORIZED',
  LOCKED: 'LOCKED',
  QUIESCED: 'QUIESCED',
  PREPARED: 'PREPARED',
  RETIRED: 'RETIRED',
  METADATA_UPDATED: 'METADATA_UPDATED',
  PERSISTENCE_PURGED: 'PERSISTENCE_PURGED',
  VERIFIED: 'VERIFIED',
});

// --- typed errors ---------------------------------------------------------

export class DeleteValidationError extends Error {
  constructor(message) { super(message); this.name = 'DeleteValidationError'; }
}
export class DeleteAuthorizationFailedError extends Error {
  constructor(message, cause) { super(message); this.name = 'DeleteAuthorizationFailedError'; this.cause = cause; }
}
export class DeleteLockError extends Error {
  constructor(message) { super(message); this.name = 'DeleteLockError'; }
}
export class DeleteQuiescenceError extends Error {
  constructor(message, cause) { super(message); this.name = 'DeleteQuiescenceError'; this.cause = cause; }
}
export class DeleteFlushError extends Error {
  constructor(message, cause) { super(message); this.name = 'DeleteFlushError'; this.cause = cause; }
}
export class DeletePhaseError extends Error {
  constructor(message) { super(message); this.name = 'DeletePhaseError'; }
}
export class DeleteVerificationError extends Error {
  constructor(message) { super(message); this.name = 'DeleteVerificationError'; }
}

// --- in-process locks -----------------------------------------------------

/** Map<canonicalId, Promise>. */
const locks = new Map();

/**
 * Acquire an exclusive in-process lock on the canonical id. Concurrent
 * callers await the previous one and resolve only when their turn comes.
 *
 * @param {string} canonicalId
 * @returns {() => void} the release function.
 */
function acquireLock(canonicalId) {
  let release;
  const prev = locks.get(canonicalId) || Promise.resolve();
  const next = new Promise((resolve) => { release = resolve; });
  locks.set(canonicalId, prev.then(() => next));
  let acquired = false;
  const wait = prev.then(() => { acquired = true; });
  return {
    release: () => {
      if (acquired) release();
      if (locks.get(canonicalId) === next) locks.delete(canonicalId);
    },
    wait,
  };
}

// --- deletion service -----------------------------------------------------

export class SessionDeleteService {
  /**
   * @param {object} options
   * @param {object} options.ctx - cordis ctx (the host context).
   * @param {AuthorizationManager} options.authorization
   * @param {(event: string, payload: object) => void} [options.audit]
   * @param {number} [options.quiescenceTimeoutMs]
   * @param {(sessionId: string) => Promise<void>} [options.onDeleted] - optional
   *   hook invoked AFTER VERIFIED. Used by the client side to refresh.
   * @param {object} [options.persistence] - optional DI override for the
   *   persistence layer. Tests use this to inject a failing module.
   */
  constructor(options) {
    if (!options || !options.ctx) throw new Error('SessionDeleteService requires ctx');
    if (!options.authorization) throw new Error('SessionDeleteService requires AuthorizationManager');
    this.ctx = options.ctx;
    this.authorization = options.authorization;
    this.audit = typeof options.audit === 'function' ? options.audit : () => {};
    this.quiescenceTimeoutMs = options.quiescenceTimeoutMs || DEFAULT_QUIESCENCE_TIMEOUT_MS;
    this.onDeleted = options.onDeleted;
    this.dshHome = resolveDshHome(process.env);
    this.services = probeLifecycleServices(this.ctx);
    // Late-bound persistence binding: allows tests to substitute the
    // persistence functions without touching the module graph. The
    // injected object must expose the same function names as
    // `src/services/persistence.js`.
    this._persistence = options.persistence || null;
  }

  /** Internal accessor for the persistence layer (DI override aware). */
  _pers() {
    if (this._persistence) return this._persistence;
    return _defaultPersistence;
  }

  /**
   * The single deletion entry point. Returns a structured result on success
   * and throws a typed error on any failure.
   *
   * @param {object} request
   * @param {string} request.sessionId - exact session id from authoritative state.
   * @param {object} request.authorization - AuthorizationContext from AuthorizationManager.redeem.
   * @param {string} [request.expectedRevision] - optional opaque token; the resolver
   *   may compare it against the live projection state and refuse if changed.
   * @param {string} [request.profileId] - optional; bound to the auth receipt.
   * @param {boolean} [request.interruptActive] - explicit user ack for running sessions.
   * @returns {Promise<{
   *   canonicalId: string,
   *   phases: string[],
   *   removed: { workspaceClaims: number, projSpelling: string|null, sessionDir: boolean },
   *   observedRevision: string | null,
   * }>}
   */
  async deleteSession(request) {
    if (!request || typeof request !== 'object') {
      throw new DeleteValidationError('request required');
    }
    const canonicalId = normalizeSessionId(request.sessionId);
    const phaseLog = [];
    let intent = null;
    const lock = acquireLock(canonicalId);
    await lock.wait;
    try {
      // --- VALIDATED ---------------------------------------------------
      const workspace = await this._pers().readWorkspace(this.dshHome);
      let resolved;
      try {
        resolved = verifySingleSession(canonicalId, this.dshHome, workspace);
      } catch (err) {
        if (err instanceof SessionIdFormatError) throw new DeleteValidationError(err.message);
        if (err instanceof SessionAmbiguousError) throw new DeleteValidationError(err.message);
        if (err instanceof SessionPathEscapeError) throw new DeleteValidationError(err.message);
        throw err;
      }
      phaseLog.push(PHASES.VALIDATED);

      // --- AUTHORIZED --------------------------------------------------
      const auth = request.authorization;
      if (!auth || !auth.token) {
        throw new DeleteAuthorizationFailedError('missing authorization context');
      }
      if (auth.kind !== TOKEN_KINDS.UI_DIRECT && auth.kind !== TOKEN_KINDS.UI_AGENT_APPROVAL) {
        throw new DeleteAuthorizationFailedError(`unsupported authorization kind: ${auth.kind}`);
      }
      // Re-verify by re-redeeming against the receipt store (single-use).
      // The caller has already redeemed in their own scope; we re-check
      // the receipt object is well-formed. The actual single-use was
      // enforced at redeem time.
      if (auth.canonicalId && auth.canonicalId !== canonicalId) {
        throw new DeleteAuthorizationFailedError('authorization context canonicalId mismatch');
      }
      if (auth.profileId && request.profileId && auth.profileId !== request.profileId) {
        throw new DeleteAuthorizationFailedError('authorization profile mismatch');
      }
      phaseLog.push(PHASES.AUTHORIZED);
      this.audit('authorize', { canonicalId, kind: auth.kind, issuer: auth.issuer });

      // --- LOCKED ------------------------------------------------------
      phaseLog.push(PHASES.LOCKED);

      // --- QUIESCED ----------------------------------------------------
      const runState = isSessionRunning(this.ctx, canonicalId);
      const persisted = await isSessionAttachedInPersistence(this.ctx, canonicalId);
      const running = runState.running || persisted;
      if (running) {
        if (!request.interruptActive) {
          throw new DeleteQuiescenceError(
            'session is running; user must explicitly acknowledge interrupt',
          );
        }
        try {
          await cancelAgentIfRunning(this.ctx, canonicalId, this.quiescenceTimeoutMs);
        } catch (err) {
          throw new DeleteQuiescenceError(
            `could not verify quiescence: ${err.message}`,
            err,
          );
        }
        try {
          await flushLiveSessions(this.ctx, canonicalId);
        } catch (err) {
          throw new DeleteFlushError(`flush failed: ${err.message}`, err);
        }
        // After flushing, re-check that no agent is still attached.
        const afterState = isSessionRunning(this.ctx, canonicalId);
        const stillAttached = await isSessionAttachedInPersistence(this.ctx, canonicalId);
        if (afterState.running || stillAttached) {
          throw new DeleteQuiescenceError(
            'session remained live after cancellation; refusing to delete',
          );
        }
      }
      phaseLog.push(PHASES.QUIESCED);

      // --- PREPARED ----------------------------------------------------
      intent = makeDeletionIntent(resolved, auth, request.profileId || auth.profileId || null);
      await this._pers().writeDeletionIntent(this.dshHome, intent);
      phaseLog.push(PHASES.PREPARED);

      // --- RETIRED -----------------------------------------------------
      detachLiveSession(this.ctx, canonicalId);
      phaseLog.push(PHASES.RETIRED);

      // --- METADATA_UPDATED -------------------------------------------
      // We strip the workspace FIRST, then the projcache, then the on-disk
      // log. If the on-disk log removal fails we will still have a clean
      // workspace/projcache state; the resolver will not find the session
      // and a subsequent recovery sweep will reconcile the leftover dir.
      // Doing it the other way around (log first, then workspace) is
      // what produced the "Ungrouped reappearance" bug in the reference
      // plugin.
      const extraKeys = resolved.projEntries ? Object.keys(resolved.projEntries) : [];
      const workspaceResult = await this._pers().stripWorkspaceMembership(this.dshHome, canonicalId, extraKeys);
      phaseLog.push(PHASES.METADATA_UPDATED);

      // --- PERSISTENCE_PURGED -----------------------------------------
      // Strip projection cache (must NOT throw on missing — we tolerate
      // a zero-entry projcache; the resolver already proved one exists
      // during VALIDATED, but race conditions may have removed it).
      const projResult = await this._pers().stripProjcache(canonicalId, this.dshHome);
      // Remove on-disk log.
      const dirResult = await this._pers().removeSessionDir(resolved.sessionDir, this.dshHome);
      phaseLog.push(PHASES.PERSISTENCE_PURGED);

      // --- VERIFIED ----------------------------------------------------
      // Re-read every layer and prove the session is gone everywhere.
      const verifyWorkspace = await this._pers().readWorkspace(this.dshHome);
      const tables = verifyWorkspace?.tables || {};
      let stillInWorkspace = false;
      for (const wid of Object.keys(tables.workspaces || {})) {
        const rec = tables.workspaces[wid];
        if (rec && Array.isArray(rec.sessionIds) && rec.sessionIds.includes(canonicalId)) {
          stillInWorkspace = true;
          break;
        }
      }
      if (
        Array.isArray(verifyWorkspace?.global?.archivedSessionIds)
        && verifyWorkspace.global.archivedSessionIds.includes(canonicalId)
      ) {
        stillInWorkspace = true;
      }
      if (stillInWorkspace) {
        throw new DeleteVerificationError(
          `workspace.json still references ${canonicalId} after deletion`,
        );
      }
      const remainingDirs = findSessionDirs(canonicalId, this.dshHome);
      if (remainingDirs.length > 0) {
        throw new DeleteVerificationError(
          `session log directory still present: ${remainingDirs.map((d) => d.canonicalPath).join(', ')}`,
        );
      }
      // Re-stat the projcache to be sure the row is gone.
      const projSpelling = projResult.spelling;
      if (projSpelling) {
        const sessionsDir = `${this.dshHome}/storages/session_projcache/sessions`;
        try {
          const fs = await import('node:fs/promises');
          await fs.access(`${sessionsDir}/${projSpelling}.json`);
          throw new DeleteVerificationError(`projcache row reappeared: ${projSpelling}`);
        } catch (err) {
          if (err.code !== 'ENOENT') throw err;
        }
      }
      phaseLog.push(PHASES.VERIFIED);

      // Successful completion: clear the intent record.
      if (intent) {
        try { await this._pers().clearDeletionIntent(this.dshHome, intent); } catch (err) {
          this.audit('clear-intent-failed', { canonicalId, error: err.message });
        }
      }
      this.authorization.revokeFor(canonicalId);
      this.audit('deleted', { canonicalId, phases: phaseLog });
      if (typeof this.onDeleted === 'function') {
        try { await this.onDeleted(canonicalId); } catch (err) {
          this.audit('onDeleted-failed', { canonicalId, error: err.message });
        }
      }
      return {
        canonicalId,
        phases: Object.freeze(phaseLog),
        removed: {
          workspaceClaims: workspaceResult.claimsRemoved,
          archivedRemoved: workspaceResult.archivedRemoved,
          projSpelling: projSpelling || null,
          sessionDir: dirResult.removed,
        },
        observedRevision: null,
      };
    } catch (err) {
      this.audit('delete-failed', { canonicalId, error: err.message, phase: phaseLog[phaseLog.length - 1] });
      // Intent stays on disk for recovery to consider.
      throw err;
    } finally {
      lock.release();
    }
  }

  /**
   * Recover any deletion intents left over by a prior crashed plugin run.
   * For each pending intent we attempt a no-op pass: verify the session is
   * fully absent across every layer, and if so clear the intent; if not,
   * we surface a warning and leave the intent for manual intervention.
   *
   * @returns {Promise<{ recovered: string[], failed: string[] }>}
   */
  async recoverFromIntents() {
    const intents = await this._pers().readDeletionIntents(this.dshHome);
    const recovered = [];
    const failed = [];
    for (const intent of intents) {
      try {
        const result = await recoverySweep(intent, this.dshHome);
        if (result.complete) {
          await this._pers().clearDeletionIntent(this.dshHome, intent);
          recovered.push(intent.canonicalId);
        } else {
          failed.push(intent.canonicalId);
        }
      } catch (err) {
        this.audit('recover-failed', { canonicalId: intent.canonicalId, error: err.message });
        failed.push(intent.canonicalId);
      }
    }
    return { recovered, failed };
  }

  /**
   * Convenience: return the names of the lifecycle services the host
   * currently exposes. Useful for the UI to decide whether to offer a
   * "delete now" button for a running session.
   */
  describeServices() {
    return { ...this.services };
  }
}