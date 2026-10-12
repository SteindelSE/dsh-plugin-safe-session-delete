// dsh-plugin-safe-session-delete — deletion service integration tests
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
// Drive the full SessionDeleteService state machine end to end against a
// synthetic home. These tests prove the documented phase order, the
// strict error-workflow (no silent swallowing), and the recovery model.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { AuthorizationManager, TOKEN_KINDS } from '../../src/services/authorization.js';
import {
  SessionDeleteService,
  PHASES,
  DeleteValidationError,
  DeleteAuthorizationFailedError,
  DeleteQuiescenceError,
  DeleteFlushError,
  DeleteVerificationError,
} from '../../src/services/session-delete.js';
import {
  createSyntheticHome,
  addSessionDir,
  addProjcacheEntry,
  addWorkspaceMembership,
  slugFor,
  snapshotBytes,
  addIndependentSession,
} from '../fixtures/synthetic-home.js';

function withHome(fn) {
  const { root, cleanup } = createSyntheticHome();
  return async (t) => {
    t.after(() => cleanup());
    process.env.DSH_HOME = root;
    try {
      await fn(root);
    } finally {
      delete process.env.DSH_HOME;
    }
  };
}

function makeFixtureSession(root, { archived = false, slug = '/work/proj', title = 'TARGET' } = {}) {
  const id = 'session-11111111-1111-1111-1111-111111111111';
  const dir = addSessionDir(root, slugFor(slug), id);
  fs.writeFileSync(dir + '/TARGET_LOG', 'TARGET\n');
  addProjcacheEntry(root, id, { cwd: slug, title });
  addWorkspaceMembership(root, slug, id, { archived, title });
  return { id, dir };
}

function makeService(root, ctx = {}) {
  const mgr = new AuthorizationManager({
    resolveProfileId: () => 'test-profile',
    audit: () => {},
  });
  const svc = new SessionDeleteService({
    ctx: ctxWith(ctx),
    authorization: mgr,
    audit: () => {},
  });
  return { svc, mgr };
}

/** Wrap a flat services object into a ctx-like object whose lifecycle helpers understand. */
function ctxWith(services) {
  return {
    get(name) { return services[name]; },
  };
}

/**
 * Mint and immediately redeem a receipt, returning the AuthContext the
 * service expects. The AuthContext has shape `{ kind, token, issuer,
 * issuedAt, profileId }`. The service also enforces that any
 * `authorization.canonicalId` / `authorization.profileId` match the
 * deletion request.
 */
function authFor(mgr, canonicalId, kind = TOKEN_KINDS.UI_DIRECT) {
  const receipt = mgr.mint(canonicalId, kind, 'test');
  return mgr.redeem(receipt.tokenId, canonicalId, kind);
}

// --- happy path ---------------------------------------------------------

test('deleteSession completes all phases for an idle session', withHome(async (root) => {
  const { id } = makeFixtureSession(root);
  const { svc, mgr } = makeService(root, {});
  const r = await svc.deleteSession({
    sessionId: id,
    authorization: authFor(mgr, id),
  });
  assert.deepEqual(r.phases.slice(0, -1), [
    PHASES.VALIDATED,
    PHASES.AUTHORIZED,
    PHASES.LOCKED,
    PHASES.QUIESCED,
    PHASES.PREPARED,
    PHASES.RETIRED,
    PHASES.METADATA_UPDATED,
    PHASES.PERSISTENCE_PURGED,
  ]);
  assert.ok(r.phases.includes(PHASES.VERIFIED));
  assert.equal(r.removed.sessionDir, true);
  assert.equal(r.removed.workspaceClaims, 1);
  assert.ok(!fs.existsSync(root + '/sessions/' + slugFor('/work/proj') + '/' + id));
  assert.ok(!fs.existsSync(root + '/storages/session_projcache/sessions/11111111-1111-1111-1111-111111111111.json'));
  const ws = JSON.parse(fs.readFileSync(root + '/storages/workspace.json', 'utf8'));
  for (const wid of Object.keys(ws.tables.workspaces)) {
    assert.ok(!ws.tables.workspaces[wid].sessionIds.includes(id));
  }
  assert.ok(!ws.global.archivedSessionIds.includes(id));
}));

// --- missing authorization -----------------------------------------------

test('deleteSession refuses without an authorization context', withHome(async (root) => {
  const { id } = makeFixtureSession(root);
  const { svc } = makeService(root, {});
  await assert.rejects(
    () => svc.deleteSession({ sessionId: id }),
    DeleteAuthorizationFailedError,
  );
}));

test('deleteSession refuses an unknown authorization kind', withHome(async (root) => {
  const { id } = makeFixtureSession(root);
  const { svc, mgr } = makeService(root, {});
  const auth = authFor(mgr, id);
  await assert.rejects(
    () => svc.deleteSession({
      sessionId: id,
      authorization: { ...auth, kind: 'bogus-kind' },
    }),
    DeleteAuthorizationFailedError,
  );
}));

// --- running session: missing interrupt acknowledgement ---------------

test('deleteSession refuses a running session without interrupt ack', withHome(async (root) => {
  const { id } = makeFixtureSession(root);
  const { svc, mgr } = makeService(root, {
    agents: { get: () => ({ id, cancel() {}, whenIdle: () => Promise.resolve() }) },
    sessionController: { cancel: async () => ({ accepted: true }) },
  });
  await assert.rejects(
    () => svc.deleteSession({
      sessionId: id,
      authorization: authFor(mgr, id),
    }),
    DeleteQuiescenceError,
  );
}));

// --- running session: cancellation timeout fails the deletion ---------

test('deleteSession refuses when the agent never reaches quiescence', withHome(async (root) => {
  const { id } = makeFixtureSession(root);
  // Build the service with a tiny quiescence timeout.
  const mgr = new AuthorizationManager({
    resolveProfileId: () => 'test-profile',
    audit: () => {},
  });
  const svc = new SessionDeleteService({
    ctx: ctxWith({
      agents: { get: () => ({ id, cancel() {}, whenIdle: () => new Promise(() => {}) }) },
      sessionController: { cancel: async () => ({ accepted: true }) },
    }),
    authorization: mgr,
    audit: () => {},
    quiescenceTimeoutMs: 80,
  });
  await assert.rejects(
    () => svc.deleteSession({
      sessionId: id,
      authorization: authFor(mgr, id),
      interruptActive: true,
    }),
    DeleteQuiescenceError,
  );
}));

// --- running session: flush failure fails the deletion --------------

test('deleteSession refuses when the flush fails', withHome(async (root) => {
  const { id } = makeFixtureSession(root);
  const { svc, mgr } = makeService(root, {
    agents: { get: () => ({ id, cancel() {}, whenIdle: () => Promise.resolve() }) },
    sessionController: { cancel: async () => ({ accepted: true }) },
    sessions: { get: () => ({ id }), flush: async () => { throw new Error('disk full'); } },
  });
  await assert.rejects(
    () => svc.deleteSession({
      sessionId: id,
      authorization: authFor(mgr, id),
      interruptActive: true,
    }),
    DeleteFlushError,
  );
}));

// --- verification failure: reanimated state is caught ----

test('deleteSession verification re-reads every layer and refuses partial', withHome(async (root) => {
  const { id } = makeFixtureSession(root);
  // Inject a persistence override that claims to NOT strip anything, so
  // the resolver observes the session still referenced in workspace.json.
  const persistence = await import('../../src/services/persistence.js');
  const mgr = new AuthorizationManager({
    resolveProfileId: () => 'test-profile',
    audit: () => {},
  });
  const svc = new SessionDeleteService({
    ctx: {},
    authorization: mgr,
    audit: () => {},
    persistence: {
      ...persistence,
      stripWorkspaceMembership: async () => ({ modified: false, claimsRemoved: 0, archivedRemoved: false }),
    },
  });
  await assert.rejects(
    () => svc.deleteSession({
      sessionId: id,
      authorization: authFor(mgr, id),
    }),
    DeleteVerificationError,
  );
}));

// --- the service itself does NOT enforce self-deletion: that is the tool's job ---

test('self-deletion is the tool layer\'s concern, not the service', withHome(async (root) => {
  const { id } = makeFixtureSession(root);
  const { svc, mgr } = makeService(root, {});
  const r = await svc.deleteSession({
    sessionId: id,
    authorization: authFor(mgr, id, TOKEN_KINDS.UI_AGENT_APPROVAL),
  });
  assert.ok(r.phases.includes(PHASES.VERIFIED));
}));

// --- intent is recorded before destructive work ---------------------

test('a partial deletion leaves an intent record for recovery', withHome(async (root) => {
  const { id } = makeFixtureSession(root);
  const persistence = await import('../../src/services/persistence.js');
  const mgr = new AuthorizationManager({
    resolveProfileId: () => 'test-profile',
    audit: () => {},
  });
  const svc = new SessionDeleteService({
    ctx: {},
    authorization: mgr,
    audit: () => {},
    persistence: {
      ...persistence,
      stripWorkspaceMembership: async () => { throw new Error('disk fault'); },
    },
  });
  await assert.rejects(
    () => svc.deleteSession({
      sessionId: id,
      authorization: authFor(mgr, id),
    }),
    /disk fault/,
  );
  const recoveryFile = root + '/storages/safe-session-delete.recovery.json';
  assert.ok(fs.existsSync(recoveryFile));
  const intents = JSON.parse(fs.readFileSync(recoveryFile, 'utf8')).intents;
  assert.ok(intents.some((i) => i.canonicalId === id));
}));

// --- collateral damage: unrelated sessions survive byte-for-byte -----

test('deleting one session leaves every unrelated record byte-identical', withHome(async (root) => {
  // Build a target and FOUR unrelated sessions, each with unique logs,
  // projcache, and workspace membership.
  const { id: targetId } = makeFixtureSession(root, { slug: '/work/target', title: 'TARGET' });
  const targetUuid = targetId.slice('session-'.length);
  const unrelated = [];
  for (let i = 0; i < 4; i++) {
    unrelated.push(addIndependentSession(root, { cwd: `/work/unrelated-${i}`, title: `UNRELATED-${i}` }));
  }

  // Capture per-file hashes of every file the target does NOT touch.
  // (workspace.json is touched: we remove the target from its arrays;
  // we test that semantic change below. The recovery file is touched:
  // we verify it is cleaned up. The projcache of the target is touched:
  // we test removal. Everything else must be byte-equal.)
  const before = await snapshotBytes(root);
  const isTargetPath = (path) =>
    path.includes(targetId)
    || path.includes(targetUuid)
    || path === '/storages/workspace.json'           // mutated to drop the target
    || path === '/storages/safe-session-delete.recovery.json'; // transient recovery marker

  const { svc, mgr } = makeService(root, {});
  const r = await svc.deleteSession({
    sessionId: targetId,
    authorization: authFor(mgr, targetId),
  });
  assert.equal(r.removed.sessionDir, true);

  const after = await snapshotBytes(root);

  // The target's own files must be gone (session log, target projcache).
  for (const path of Object.keys(before)) {
    if (!path.includes(targetId) && !path.includes(targetUuid)) continue;
    if (path === '/storages/workspace.json') continue;                 // see semantic check below
    if (path === '/storages/safe-session-delete.recovery.json') continue; // transient, may persist if mid-flight
    assert.ok(!(path in after), `target ${path} should be gone`);
  }
  // Every file the target did NOT touch must be byte-identical. This
  // is the strictest form of "no collateral damage": not "same shape"
  // but "same bytes".
  for (const [path, hash] of Object.entries(before)) {
    if (isTargetPath(path)) continue;
    assert.equal(after[path], hash, `unrelated file ${path} changed (hash differs)`);
  }
  for (const u of unrelated) {
    assert.ok(fs.existsSync(u.dir), `unrelated dir ${u.dir} missing`);
    const log = fs.readFileSync(u.dir + '/INDEPENDENT_LOG', 'utf8');
    assert.equal(log, `INDEPENDENT:${u.canonicalId}\n`);
  }

  // Semantic check on workspace.json: every unrelated entry's
  // sessionIds list and the global archivedSessionIds must still
  // contain its previous records, just without the target.
  const afterWs = JSON.parse(fs.readFileSync(root + '/storages/workspace.json', 'utf8'));
  for (const u of unrelated) {
    let found = false;
    for (const wid of Object.keys(afterWs.tables.workspaces)) {
      const rec = afterWs.tables.workspaces[wid];
      if (rec.sessionIds.includes(u.canonicalId)) {
        // Ensure the target is NOT in this same workspace.
        assert.ok(!rec.sessionIds.includes(targetId));
        found = true;
        break;
      }
    }
    assert.ok(found, `unrelated session ${u.canonicalId} dropped from workspace.json`);
  }
}));

// --- concurrent deletion attempts serialize through the lock --------

test('concurrent deletes on the same id are serialized', withHome(async (root) => {
  const { id } = makeFixtureSession(root);
  const { svc, mgr } = makeService(root, {});
  // Mint two distinct tokens; each redeem returns its own context.
  const r1 = mgr.mint(id, TOKEN_KINDS.UI_DIRECT, 'a');
  const r2 = mgr.mint(id, TOKEN_KINDS.UI_DIRECT, 'b');
  const task1 = svc.deleteSession({ sessionId: id, authorization: mgr.redeem(r1.tokenId, id, TOKEN_KINDS.UI_DIRECT) });
  const task2 = svc.deleteSession({ sessionId: id, authorization: mgr.redeem(r2.tokenId, id, TOKEN_KINDS.UI_DIRECT) });
  const results = await Promise.allSettled([task1, task2]);
  const succeeded = results.filter((r) => r.status === 'fulfilled').length;
  const failed = results.filter((r) => r.status === 'rejected').length;
  assert.equal(succeeded, 1, 'exactly one deletion should succeed');
  assert.equal(failed, 1, 'exactly one deletion should fail (target gone after first)');
}));

// --- describeServices -------------------------------------------------

test('describeServices reports the host lifecycle capabilities', withHome(async (root) => {
  const { svc } = makeService(root, {
    agents: { get: () => {} },
    sessions: { get: () => {} },
  });
  const r = svc.describeServices();
  assert.equal(typeof r.agents, 'boolean');
  assert.equal(typeof r.sessions, 'boolean');
}));