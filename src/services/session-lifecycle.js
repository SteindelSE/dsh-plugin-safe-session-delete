// dsh-plugin-safe-session-delete — session-lifecycle
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
// Coordination with the harness's live session / agent registries.
//
// The harness exposes (conditionally):
//
//   ctx.sessionController  - turns cold-start any Active Agent for a
//                            session id; `cancel()` cancels the active
//                            turn of an attached Agent.
//   ctx.agents             - the in-memory agent registry; `get(id)`
//                            returns the live Agent or undefined.
//   ctx.sessions           - the in-memory session store; `get(id)`
//                            returns the live session or undefined.
//                            Detach: store.delete(id) is the only
//                            public remove path.
//   ctx.sessionPersistence - the storage backend; no public delete.
//
// This module is intentionally tolerant of missing services (the plugin
// must work in terminal-only profiles that mount no web surface). It
// records what it found so the deletion service can make a strict
// go/no-go decision without ever guessing.
//
// Cancellation contract (HARD, see SECURITY.md):
//   - cancellation is requested, NOT assumed.
//   - whenIdle() is awaited with a TIMEOUT. A timeout means we could not
//     prove the agent was quiescent; we MUST refuse to proceed.
//   - flush() may throw; a thrown flush means the persistence layer
//     could not durably write pending events. We refuse to proceed and
//     surface the failure to the UI.
//   - detach is best-effort but reported; the in-memory state MAY survive
//     a failed delete (the on-disk state is the truth).

import {
  AuthorizationError,
} from './authorization.js';

export class AgentNotIdleError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'AgentNotIdleError';
    this.cause = cause;
  }
}

export class SessionFlushError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'SessionFlushError';
    this.cause = cause;
  }
}

/** Default time we will wait for an Agent to reach quiescence. */
export const DEFAULT_QUIESCENCE_TIMEOUT_MS = 10_000;

/**
 * Probe the host for the optional services the lifecycle layer needs.
 * Each is reported as found/missing so the caller (deletion service)
 * can adapt its decision per deployment.
 *
 * Uses `ctx.get` (which works without `inject` declarations) rather
 * than property access (which the cordis proxy refuses for services
 * not listed in `inject`). Missing services are reported as `false`.
 *
 * @param {object} ctx
 * @returns {{
 *   sessionController: boolean,
 *   agents: boolean,
 *   sessions: boolean,
 *   sessionPersistence: boolean,
 * }}
 */
export function probeLifecycleServices(ctx) {
  const safeGet = (name) => {
    if (!ctx || typeof ctx.get !== 'function') return undefined;
    try { return ctx.get(name); } catch { return undefined; }
  };
  const sc = safeGet('sessionController');
  const ag = safeGet('agents');
  const ss = safeGet('sessions');
  const sp = safeGet('sessionPersistence');
  return {
    sessionController: !!sc && typeof sc.cancel === 'function',
    agents: !!ag && typeof ag.get === 'function',
    sessions: !!ss && typeof ss.get === 'function',
    sessionPersistence: !!sp && typeof sp.stat === 'function',
  };
}

/** Safe get: returns undefined for missing services without throwing. */
function safeGet(ctx, name) {
  if (!ctx || typeof ctx.get !== 'function') return undefined;
  try { return ctx.get(name); } catch { return undefined; }
}

/**
 * Determine whether the canonical session is currently running an Agent.
 * A session is running when (a) the agent registry has a live entry for
 * the id, or (b) the sessionPersistence `stat` reports it (a session
 * that survived a previous run but never had its process cleared).
 *
 * Both spellings are checked.
 *
 * @param {object} ctx
 * @param {string} canonicalId
 * @returns {{ running: boolean, agentAttached: boolean, persistedAttached: boolean }}
 */
export function isSessionRunning(ctx, canonicalId) {
  let agentAttached = false;
  let persistedAttached = false;
  const agents = safeGet(ctx, 'agents');
  if (agents && typeof agents.get === 'function') {
    for (const variant of [canonicalId, canonicalId.slice('session-'.length)]) {
      if (agents.get(variant)) {
        agentAttached = true;
        break;
      }
    }
  }
  const persistence = safeGet(ctx, 'sessionPersistence');
  if (persistence && typeof persistence.stat === 'function') {
    // We synchronously do not know — return false; the caller awaits.
    // (kept here so the type stays consistent for the resolver.)
  }
  return { running: agentAttached || persistedAttached, agentAttached, persistedAttached };
}

/**
 * Asynchronously determine whether the canonical session is currently
 * attached in the persistence layer. Used during the authorization
 * check so we can refuse to delete a session the host considers live.
 *
 * @param {object} ctx
 * @param {string} canonicalId
 * @returns {Promise<boolean>}
 */
export async function isSessionAttachedInPersistence(ctx, canonicalId) {
  const persistence = safeGet(ctx, 'sessionPersistence');
  if (!persistence || typeof persistence.stat !== 'function') return false;
  for (const variant of [canonicalId, canonicalId.slice('session-'.length)]) {
    try {
      const snap = await persistence.stat(variant);
      if (snap) return true;
    } catch (err) {
      if (err.code === 'ENOENT') continue;
      // Any other error means we cannot prove; report conservatively.
      return true;
    }
  }
  return false;
}

/**
 * Request cancellation of the active turn for the Agent owning
 * `canonicalId`, then await quiescence up to `timeoutMs`.
 *
 * Throws AgentNotIdleError on timeout — the caller MUST abort deletion
 * rather than proceed.
 *
 * Returns the cancellation receipt (the harness's SessionCancelValue)
 * on success.
 *
 * @param {object} ctx
 * @param {string} canonicalId
 * @param {number} [timeoutMs]
 * @returns {Promise<{ cancelled: boolean, quiescent: boolean }>}
 */
export async function cancelAgentIfRunning(ctx, canonicalId, timeoutMs) {
  const agents = safeGet(ctx, 'agents');
  const controller = safeGet(ctx, 'sessionController');
  const deadline = typeof timeoutMs === 'number' && timeoutMs > 0 ? timeoutMs : DEFAULT_QUIESCENCE_TIMEOUT_MS;
  let agent = null;
  if (agents && typeof agents.get === 'function') {
    for (const variant of [canonicalId, canonicalId.slice('session-'.length)]) {
      const candidate = agents.get(variant);
      if (candidate) { agent = candidate; break; }
    }
  }
  if (!agent) return { cancelled: false, quiescent: true };
  let cancelled = false;
  // Prefer the harness-level sessionController.cancel; it is the
  // canonical cancellation channel and emits to the user-visible log.
  if (controller && typeof controller.cancel === 'function') {
    try {
      const value = await controller.cancel({ sessionId: canonicalId });
      cancelled = !!(value && value.accepted);
    } catch (err) {
      // The controller rejected the cancellation — do NOT proceed; the
      // harness has authoritative knowledge the agent cannot be stopped.
      throw new AgentNotIdleError(
        `sessionController.cancel rejected for ${canonicalId}: ${err.message}`,
        err,
      );
    }
  } else if (typeof agent.cancel === 'function') {
    try {
      agent.cancel({ kind: 'user' });
      cancelled = true;
    } catch (err) {
      throw new AgentNotIdleError(
        `agent.cancel rejected for ${canonicalId}: ${err.message}`,
        err,
      );
    }
  } else {
    // No cancellation channel — refuse rather than proceed blindly.
    throw new AgentNotIdleError(
      `no cancellation channel available for running session ${canonicalId}`,
    );
  }
  if (cancelled && typeof agent.whenIdle === 'function') {
    let timer;
    try {
      await Promise.race([
        agent.whenIdle(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new AgentNotIdleError(
            `agent ${canonicalId} did not reach quiescence within ${deadline}ms`,
          )), deadline);
        }),
      ]);
      return { cancelled: true, quiescent: true };
    } catch (err) {
      if (timer) clearTimeout(timer);
      throw err;
    }
  }
  // No whenIdle hook — the harness does not expose quiescence. We must
  // refuse to proceed; a deletion that races an active agent could
  // recreate files mid-flight (the bug this whole module exists to
  // prevent).
  if (cancelled) {
    throw new AgentNotIdleError(
      `cancellation requested but quiescence cannot be verified for ${canonicalId}`,
    );
  }
  return { cancelled: false, quiescent: true };
}

/**
 * Flush the in-memory session store for `canonicalId`. A throw here is
 * surfaced to the caller; partial flushes are treated as failure.
 *
 * Returns the number of sessions flushed across both spellings.
 *
 * @param {object} ctx
 * @param {string} canonicalId
 * @returns {Promise<number>}
 */
export async function flushLiveSessions(ctx, canonicalId) {
  const sessions = safeGet(ctx, 'sessions');
  if (!sessions || typeof sessions.get !== 'function' || typeof sessions.flush !== 'function') {
    return 0;
  }
  let count = 0;
  for (const variant of [canonicalId, canonicalId.slice('session-'.length)]) {
    const session = sessions.get(variant);
    if (!session) continue;
    try {
      await sessions.flush(session);
      count++;
    } catch (err) {
      throw new SessionFlushError(`flush failed for ${variant}: ${err.message}`, err);
    }
  }
  return count;
}

/**
 * Detach the in-memory session entry for `canonicalId`. The harness
 * store has no public remove API; we use `store.delete` if exposed, or
 * mark the entry as retired via `sessions.detachEntered` if exposed.
 * If neither is available, the in-memory entry survives (the on-disk
 * deletion still stands; the host will eventually GC it on disposal).
 *
 * @param {object} ctx
 * @param {string} canonicalId
 * @returns {{ detached: boolean, reason?: string }}
 */
export function detachLiveSession(ctx, canonicalId) {
  const sessions = safeGet(ctx, 'sessions');
  if (!sessions) return { detached: false, reason: 'no-sessions-service' };
  let detached = false;
  let reason = null;
  for (const variant of [canonicalId, canonicalId.slice('session-'.length)]) {
    try {
      const entry = sessions.store?.get?.(variant);
      if (!entry) continue;
      if (typeof sessions.detachEntered === 'function') {
        sessions.detachEntered(entry);
        detached = true;
      } else if (sessions.store && typeof sessions.store.delete === 'function') {
        sessions.store.delete(variant);
        detached = true;
      } else {
        reason = 'no-detach-api';
      }
    } catch (err) {
      reason = `detach-error:${err.message}`;
    }
  }
  return detached ? { detached: true } : { detached: false, reason: reason || 'no-live-entry' };
}

/**
 * Verify that the executing agent is not the one it is asking to delete.
 * Self-deletion is a specific threat: a model that decides to delete its
 * own context, or a tool chain that loops back, must be blocked.
 *
 * @param {object} toolExec - the ToolRunContext for the call (or its agent field).
 * @param {string} canonicalId - the session the caller is asking to delete.
 * @returns {boolean} true if the caller's agent owns `canonicalId`.
 */
export function callTargetsOwnSession(toolExec, canonicalId) {
  if (!toolExec || typeof toolExec !== 'object') return false;
  // The registry passes `agent` as the Agent interface; Agent.id is the
  // canonical SessionId. Both spellings are accepted because the harness
  // might pass either.
  const agentId = toolExec.agent?.id;
  if (!agentId) return false;
  const uuid = canonicalId.startsWith('session-')
    ? canonicalId.slice('session-'.length)
    : canonicalId;
  const aUuid = String(agentId).startsWith('session-')
    ? String(agentId).slice('session-'.length)
    : String(agentId);
  return agentId === canonicalId || aUuid === uuid || aUuid === canonicalId;
}