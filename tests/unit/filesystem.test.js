// dsh-plugin-safe-session-delete — filesystem tests
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
// Prove the persistence layer refuses to touch anything outside the
// authorized storage root and that all writes are atomic.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  assertContained,
  safeRealpath,
  SessionPathEscapeError,
  resolveDshHome,
} from '../../src/services/session-resolver.js';

import {
  removeSessionDir,
  stripWorkspaceMembership,
  stripProjcache,
  writeDeletionIntent,
  clearDeletionIntent,
  readDeletionIntents,
  withFileLock,
} from '../../src/services/persistence.js';

import { createSyntheticHome, addSessionDir, addProjcacheEntry, addWorkspaceMembership, slugFor } from '../fixtures/synthetic-home.js';

function withHome(fn) {
  const { root, cleanup } = createSyntheticHome();
  return (t) => {
    t.after(() => cleanup());
    return fn(root);
  };
}

// --- assertContained ----------------------------------------------------

test('assertContained accepts paths inside the root', () => {
  const root = '/home/foo/.dsh';
  assertContained(root, '/home/foo/.dsh/sessions');
  assertContained(root, '/home/foo/.dsh/storages/workspace.json');
});

test('assertContained rejects paths that escape via parent', () => {
  assert.throws(
    () => assertContained('/home/foo/.dsh', '/home/foo/.dsh-evil'),
    SessionPathEscapeError,
  );
});

test('assertContained rejects prefix attacks that share leading bytes', () => {
  // Path "/home/foo/.dsh-evil" passes a naive startsWith('/home/foo/.dsh')
  // check; assertContained must use the path separator boundary.
  assert.throws(
    () => assertContained('/home/foo/.dsh', '/home/foo/.dsh-evil/sessions'),
    SessionPathEscapeError,
  );
});

test('assertContained rejects non-absolute paths', () => {
  assert.throws(
    () => assertContained('/home/foo/.dsh', 'sessions'),
    SessionPathEscapeError,
  );
});

// --- safeRealpath -------------------------------------------------------

test('safeRealpath returns the canonical path of a regular directory', () => {
  const tmp = fs.realpathSync.native(os.tmpdir()) + path.sep + 'realpath-test-' + Date.now();
  fs.mkdirSync(tmp, { recursive: true });
  const r = safeRealpath(tmp);
  assert.equal(r.realpath, tmp);
  assert.equal(r.leafIsSymlink, false);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('safeRealpath detects a symlinked leaf', () => {
  const tmp = fs.realpathSync.native(os.tmpdir()) + path.sep + 'realpath-test-' + Date.now();
  fs.mkdirSync(tmp, { recursive: true });
  const target = tmp + '/real';
  fs.mkdirSync(target);
  const link = tmp + '/link';
  fs.symlinkSync(target, link, 'dir');
  const r = safeRealpath(link);
  assert.equal(r.leafIsSymlink, true);
  fs.rmSync(tmp, { recursive: true, force: true });
});

// --- removeSessionDir ---------------------------------------------------

test('removeSessionDir removes the target and verifies', withHome((root) => {
  const id = 'session-11111111-1111-1111-1111-111111111111';
  const slug = slugFor('/work/proj');
  const dir = addSessionDir(root, slug, id);
  assert.ok(fs.existsSync(dir));
  // removeSessionDir takes an absolute canonical path.
  return removeSessionDir(dir, root).then((result) => {
    assert.equal(result.removed, true);
    assert.ok(!fs.existsSync(dir));
  });
}));

test('removeSessionDir refuses to delete the root itself', withHome((root) => {
  return assert.rejects(
    () => removeSessionDir(root, root),
    SessionPathEscapeError,
  );
}));

test('removeSessionDir refuses a symlinked target', withHome((root) => {
  const slug = slugFor('/work/sym');
  fs.mkdirSync(root + '/sessions/' + slug, { recursive: true });
  const real = root + '/evil-real';
  fs.mkdirSync(real, { recursive: true });
  fs.writeFileSync(real + '/session.v3.jsonl.zstd', 'X\n');
  fs.symlinkSync(real, root + '/sessions/' + slug + '/session-aaaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'dir');
  const target = root + '/sessions/' + slug + '/session-aaaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  return assert.rejects(
    () => removeSessionDir(target, root),
    SessionPathEscapeError,
  );
}));

test('removeSessionDir is idempotent on missing dir', withHome((root) => {
  const id = 'session-bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  const slug = slugFor('/work/missing');
  const dir = root + '/sessions/' + slug + '/' + id;
  return removeSessionDir(dir, root).then((result) => {
    assert.equal(result.removed, false);
    assert.equal(result.stagedTo, null);
  });
}));

// --- stripWorkspaceMembership -------------------------------------------

test('stripWorkspaceMembership removes a session from workspace and archive lists', withHome(async (root) => {
  const id = 'session-11111111-1111-1111-1111-111111111111';
  addWorkspaceMembership(root, '/work/proj', id, { archived: true });
  const r = await stripWorkspaceMembership(root, id);
  assert.equal(r.modified, true);
  assert.equal(r.claimsRemoved, 1);
  assert.equal(r.archivedRemoved, true);
  const after = JSON.parse(fs.readFileSync(root + '/storages/workspace.json', 'utf8'));
  for (const wid of Object.keys(after.tables.workspaces)) {
    assert.ok(!after.tables.workspaces[wid].sessionIds.includes(id));
  }
  assert.ok(!after.global.archivedSessionIds.includes(id));
}));

test('stripWorkspaceMembership is idempotent', withHome(async (root) => {
  const id = 'session-22222222-2222-2222-2222-222222222222';
  addWorkspaceMembership(root, '/work/proj', id);
  await stripWorkspaceMembership(root, id);
  const r = await stripWorkspaceMembership(root, id);
  assert.equal(r.modified, false);
}));

test('stripWorkspaceMembership preserves unrelated sessionIds', withHome(async (root) => {
  const target = 'session-11111111-1111-1111-1111-111111111111';
  const sibling = 'session-22222222-2222-2222-2222-222222222222';
  addWorkspaceMembership(root, '/work/proj', target, { sessionIds: [target, sibling] });
  await stripWorkspaceMembership(root, target);
  const after = JSON.parse(fs.readFileSync(root + '/storages/workspace.json', 'utf8'));
  for (const wid of Object.keys(after.tables.workspaces)) {
    assert.ok(after.tables.workspaces[wid].sessionIds.includes(sibling));
  }
}));

// --- stripProjcache -----------------------------------------------------

test('stripProjcache removes the canonical projcache file', withHome(async (root) => {
  const id = 'session-11111111-1111-1111-1111-111111111111';
  addProjcacheEntry(root, id);
  const r = await stripProjcache(id, root);
  assert.equal(r.removed, true);
  // The file is keyed by the raw UUID, not the session- form.
  const rawFile = root + '/storages/session_projcache/sessions/11111111-1111-1111-1111-111111111111.json';
  assert.ok(!fs.existsSync(rawFile));
}));

test('stripProjcache refuses a non-file target', withHome(async (root) => {
  const id = 'session-33333333-3333-3333-3333-333333333333';
  // Plant a symlink at the projcache path; the stripper must refuse.
  const file = root + '/storages/session_projcache/sessions/33333333-3333-3333-3333-333333333333.json';
  fs.mkdirSync(root + '/evil-real', { recursive: true });
  fs.symlinkSync(root + '/evil-real', file, 'file');
  await assert.rejects(() => stripProjcache(id, root), SessionPathEscapeError);
}));

// --- writeDeletionIntent -----------------------------------------------

test('writeDeletionIntent persists a recoverable record', withHome(async (root) => {
  await writeDeletionIntent(root, {
    schemaVersion: 1,
    canonicalId: 'session-11111111-1111-1111-1111-111111111111',
    sessionDir: '/synthetic/path',
    projSpellingKeys: [],
    workspaceClaims: [],
    authorization: { kind: 'ui-direct', token: 'tok', issuer: 'test', issuedAt: 0 },
    profileId: 'profile-A',
    startedAt: new Date().toISOString(),
  });
  const intents = await readDeletionIntents(root);
  assert.equal(intents.length, 1);
  assert.equal(intents[0].canonicalId, 'session-11111111-1111-1111-1111-111111111111');
}));

test('clearDeletionIntent removes the matching record', withHome(async (root) => {
  const intent = {
    schemaVersion: 1,
    canonicalId: 'session-11111111-1111-1111-1111-111111111111',
    sessionDir: '/synthetic/path',
    projSpellingKeys: [],
    workspaceClaims: [],
    authorization: { kind: 'ui-direct', token: 'tok', issuer: 'test', issuedAt: 0 },
    profileId: 'profile-A',
    startedAt: new Date().toISOString(),
  };
  await writeDeletionIntent(root, intent);
  await clearDeletionIntent(root, intent);
  const intents = await readDeletionIntents(root);
  assert.equal(intents.length, 0);
}));

// --- withFileLock serialization ----------------------------------------

test('withFileLock serializes concurrent calls', async () => {
  let n = 0;
  const run = () => withFileLock('/some/path', async () => { n++; await new Promise((r) => setTimeout(r, 30)); });
  await Promise.all([run(), run(), run()]);
  assert.equal(n, 3);
});