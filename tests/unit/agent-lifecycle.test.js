// dsh-plugin-safe-session-delete — agent lifecycle tests
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
// Prove the lifecycle helpers enforce every guarantee we promise:
//   - cancellation is requested, NOT assumed;
//   - a stuck agent (whenIdle never resolves) causes DeleteQuiescenceError;
//   - self-deletion is detected;
//   - the lifecycle tolerates missing host services.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  probeLifecycleServices,
  cancelAgentIfRunning,
  flushLiveSessions,
  detachLiveSession,
  isSessionRunning,
  isSessionAttachedInPersistence,
  callTargetsOwnSession,
  AgentNotIdleError,
  SessionFlushError,
  DEFAULT_QUIESCENCE_TIMEOUT_MS,
} from '../../src/services/session-lifecycle.js';

// --- a tiny fake Agent harness ------------------------------------------

function makeAgent(behavior) {
  const calls = [];
  return {
    calls,
    get id() { return behavior.id; },
    cancel(cause) { calls.push({ kind: 'cancel', cause }); behavior.onCancel?.(); },
    async whenIdle() { calls.push({ kind: 'whenIdle' }); return behavior.onWhenIdle?.() ?? Promise.resolve(); },
  };
}

function makeAgentRegistry(agentMap) {
  return { get: (id) => agentMap[id] };
}

function makeSessionController(behavior = {}) {
  return {
    calls: [],
    async cancel(req) {
      this.calls.push({ kind: 'cancel', req });
      if (behavior.throwOnCancel) throw new Error(behavior.throwOnCancel);
      return { accepted: true };
    },
  };
}

function makeSessionStore(sessions) {
  return {
    store: {
      get: (id) => sessions[id],
      delete: (id) => { delete sessions[id]; return true; },
    },
    flush: async (session) => { session._flushed = (session._flushed || 0) + 1; },
    get(id) { return sessions[id]; },
    detachEntered(session) { session._detached = true; },
  };
}

function makePersistence(attachedIds = []) {
  return {
    stat: async (id) => attachedIds.includes(id) ? { header: { id }, revision: 'r' } : undefined,
  };
}

/**
 * Build a fake cordis ctx out of a flat object whose keys match the
 * optional services. The lifecycle helpers use ctx.get(name), so the
 * fake must look them up that way.
 */
function ctxWith(services) {
  return {
    get(name) { return services[name]; },
  };
}

// --- probeLifecycleServices ---------------------------------------------

test('probeLifecycleServices reports which services the host exposes', () => {
  const ctx = ctxWith({
    sessionController: { cancel: () => {} },
    agents: { get: () => {} },
    sessions: { get: () => {} },
    sessionPersistence: { stat: () => {} },
  });
  const r = probeLifecycleServices(ctx);
  assert.deepEqual(r, {
    sessionController: true,
    agents: true,
    sessions: true,
    sessionPersistence: true,
  });
});

test('probeLifecycleServices tolerates a missing sessionController (terminal-only)', () => {
  const ctx = ctxWith({
    agents: { get: () => {} },
    sessions: { get: () => {} },
    sessionPersistence: { stat: () => {} },
  });
  const r = probeLifecycleServices(ctx);
  assert.equal(r.sessionController, false);
});

// --- isSessionRunning ---------------------------------------------------

test('isSessionRunning returns true when an agent is attached', () => {
  const id = 'session-aaaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const ctx = ctxWith({ agents: makeAgentRegistry({ [id]: makeAgent({ id }) }) });
  assert.equal(isSessionRunning(ctx, id).running, true);
});

test('isSessionRunning returns false when no agent and no persisted attachment', () => {
  const id = 'session-aaaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const ctx = ctxWith({ agents: makeAgentRegistry({}), sessionPersistence: makePersistence([]) });
  assert.equal(isSessionRunning(ctx, id).running, false);
});

test('isSessionAttachedInPersistence returns true when stat finds the id', async () => {
  const id = 'session-aaaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const ctx = ctxWith({ sessionPersistence: makePersistence([id]) });
  const r = await isSessionAttachedInPersistence(ctx, id);
  assert.equal(r, true);
});

test('isSessionAttachedInPersistence tolerates missing persistence', async () => {
  const id = 'session-aaaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  assert.equal(await isSessionAttachedInPersistence({ get: () => undefined }, id), false);
});

// --- cancelAgentIfRunning -----------------------------------------------

test('cancelAgentIfRunning with no agent returns clean', async () => {
  const ctx = { agents: makeAgentRegistry({}) };
  const r = await cancelAgentIfRunning(ctx, 'session-aaaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
  assert.deepEqual(r, { cancelled: false, quiescent: true });
});

test('cancelAgentIfRunning uses sessionController and waits for whenIdle', async () => {
  const id = 'session-aaaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  let whenIdleResolved = false;
  const agent = makeAgent({
    id,
    onWhenIdle: () => { whenIdleResolved = true; },
  });
  const controller = makeSessionController();
  const ctx = ctxWith({
    sessionController: controller,
    agents: makeAgentRegistry({ [id]: agent }),
  });
  const r = await cancelAgentIfRunning(ctx, id);
  assert.equal(r.cancelled, true);
  assert.equal(r.quiescent, true);
  assert.equal(whenIdleResolved, true);
  assert.equal(controller.calls.length, 1);
});

test('cancelAgentIfRunning refuses when whenIdle never resolves (stuck agent)', async () => {
  const id = 'session-aaaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const agent = {
    id,
    cancel() { /* */ },
    whenIdle: () => new Promise(() => {}), // never resolves
  };
  const ctx = ctxWith({
    sessionController: makeSessionController(),
    agents: makeAgentRegistry({ [id]: agent }),
  });
  await assert.rejects(
    () => cancelAgentIfRunning(ctx, id, 80),
    AgentNotIdleError,
  );
});

test('cancelAgentIfRunning refuses when sessionController.cancel rejects', async () => {
  const id = 'session-aaaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const agent = makeAgent({ id });
  const ctx = ctxWith({
    sessionController: makeSessionController({ throwOnCancel: 'no' }),
    agents: makeAgentRegistry({ [id]: agent }),
  });
  await assert.rejects(
    () => cancelAgentIfRunning(ctx, id),
    AgentNotIdleError,
  );
});

test('cancelAgentIfRunning refuses when whenIdle is absent', async () => {
  const id = 'session-aaaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const agent = { id, cancel() {} }; // no whenIdle
  const ctx = ctxWith({
    sessionController: makeSessionController(),
    agents: makeAgentRegistry({ [id]: agent }),
  });
  await assert.rejects(
    () => cancelAgentIfRunning(ctx, id),
    AgentNotIdleError,
  );
});

// --- flushLiveSessions --------------------------------------------------

test('flushLiveSessions flushes both spellings and reports count', async () => {
  const id = 'session-11111111-1111-1111-1111-111111111111';
  const uuid = '11111111-1111-1111-1111-111111111111';
  const sessionA = { id };
  const sessionB = { id: uuid };
  const store = makeSessionStore({ [id]: sessionA, [uuid]: sessionB });
  const ctx = ctxWith({ sessions: store });
  const n = await flushLiveSessions(ctx, id);
  assert.equal(n, 2);
  assert.equal(sessionA._flushed, 1);
  assert.equal(sessionB._flushed, 1);
});

test('flushLiveSessions throws on failure', async () => {
  const id = 'session-aaaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const session = { id };
  const ctx = ctxWith({
    sessions: {
      get: () => session,
      flush: async () => { throw new Error('disk full'); },
    },
  });
  await assert.rejects(() => flushLiveSessions(ctx, id), SessionFlushError);
});

// --- detachLiveSession --------------------------------------------------

test('detachLiveSession detaches via detachEntered', () => {
  const id = 'session-aaaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const session = { id };
  const store = {
    get: (id) => ({ session }),
    delete: () => {},
  };
  const ctx = ctxWith({
    sessions: {
      store,
      get: (id) => store.get(id),
      detachEntered(entry) { entry.session._detached = true; },
    },
  });
  const r = detachLiveSession(ctx, id);
  assert.equal(r.detached, true);
  assert.equal(session._detached, true);
});

test('detachLiveSession reports no-detach-api when only store.delete is available', () => {
  const id = 'session-aaaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const session = { id };
  const store = {
    get: (id) => session,
    delete: (id) => { /* */ },
  };
  const ctx = ctxWith({
    sessions: { store, get: (id) => store.get(id) },
  });
  const r = detachLiveSession(ctx, id);
  assert.equal(r.detached, true);
});

// --- callTargetsOwnSession ----------------------------------------------

test('callTargetsOwnSession detects same id (raw and prefixed)', () => {
  const id = 'session-11111111-1111-1111-1111-111111111111';
  const uuid = '11111111-1111-1111-1111-111111111111';
  assert.equal(callTargetsOwnSession({ agent: { id } }, id), true);
  assert.equal(callTargetsOwnSession({ agent: { id: uuid } }, id), true);
});

test('callTargetsOwnSession returns false for unrelated ids', () => {
  assert.equal(callTargetsOwnSession({ agent: { id: 'session-bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' } },
    'session-aaaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'), false);
});

test('callTargetsOwnSession returns false when there is no agent', () => {
  assert.equal(callTargetsOwnSession({}, 'session-aaaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'), false);
});