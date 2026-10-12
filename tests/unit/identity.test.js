// dsh-plugin-safe-session-delete — identity tests
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
// Every deletion must resolve the EXACT session id from authoritative
// state. These tests prove the resolver rejects every input that
// could lead to wrong-session deletion.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  normalizeSessionId,
  sessionIdVariants,
  verifySingleSession,
  SESSION_ID_RE,
  SessionIdFormatError,
  SessionAmbiguousError,
  SessionPathEscapeError,
} from '../../src/services/session-resolver.js';

import {
  createSyntheticHome,
  addSessionDir,
  addProjcacheEntry,
  addWorkspaceMembership,
  slugFor,
} from '../fixtures/synthetic-home.js';

// --- helpers -----------------------------------------------------------

function withHome(fn) {
  const { root, cleanup } = createSyntheticHome();
  return (t) => {
    t.after(() => cleanup());
    return fn(root);
  };
}

function readWorkspace(root) {
  return JSON.parse(fs.readFileSync(root + '/storages/workspace.json', 'utf8'));
}

// --- regex and basic normalization --------------------------------------

test('SESSION_ID_RE accepts raw uuid', () => {
  assert.match('12345678-1234-1234-1234-123456789012', SESSION_ID_RE);
});
test('SESSION_ID_RE accepts session-prefixed uuid', () => {
  assert.match('session-12345678-1234-1234-1234-123456789012', SESSION_ID_RE);
});
test('SESSION_ID_RE rejects arbitrary strings', () => {
  assert.doesNotMatch('not-a-uuid', SESSION_ID_RE);
  assert.doesNotMatch('', SESSION_ID_RE);
  assert.doesNotMatch('session', SESSION_ID_RE);
  assert.doesNotMatch('session-', SESSION_ID_RE);
  assert.doesNotMatch('session-123', SESSION_ID_RE);
  assert.doesNotMatch('../../../etc/passwd', SESSION_ID_RE);
  assert.doesNotMatch('foo/../session-12345678-1234-1234-1234-123456789012', SESSION_ID_RE);
});

test('normalizeSessionId returns canonical lowercased prefixed form', () => {
  assert.equal(normalizeSessionId('12345678-1234-1234-1234-123456789012'),
    'session-12345678-1234-1234-1234-123456789012');
  assert.equal(normalizeSessionId('SESSION-12345678-1234-1234-1234-123456789012'),
    'session-12345678-1234-1234-1234-123456789012');
  assert.equal(normalizeSessionId('  12345678-1234-1234-1234-123456789012  '),
    'session-12345678-1234-1234-1234-123456789012');
});

test('normalizeSessionId throws on malformed ids', () => {
  assert.throws(() => normalizeSessionId(''), SessionIdFormatError);
  assert.throws(() => normalizeSessionId('   '), SessionIdFormatError);
  assert.throws(() => normalizeSessionId(null), SessionIdFormatError);
  assert.throws(() => normalizeSessionId(undefined), SessionIdFormatError);
  assert.throws(() => normalizeSessionId(42), SessionIdFormatError);
  assert.throws(() => normalizeSessionId('session-x'), SessionIdFormatError);
});

test('sessionIdVariants returns the unique spelling set', () => {
  const variants = sessionIdVariants('session-12345678-1234-1234-1234-123456789012');
  assert.deepEqual(new Set(variants), new Set([
    'session-12345678-1234-1234-1234-123456789012',
    '12345678-1234-1234-1234-123456789012',
  ]));
});

// --- verifySingleSession: the authoritative resolution gate -------------

test('verifySingleSession accepts a unique, well-formed session', withHome((root) => {
  const id = 'session-11111111-1111-1111-1111-111111111111';
  addSessionDir(root, slugFor('/work/proj'), id);
  addProjcacheEntry(root, id, { cwd: '/work/proj' });
  const resolved = verifySingleSession(id, root, readWorkspace(root));
  assert.equal(resolved.canonicalId, id);
  assert.equal(typeof resolved.sessionDir, 'string');
  assert.ok(resolved.sessionDir.endsWith('/sessions/-work-proj/' + id), `sessionDir was ${resolved.sessionDir}`);
}));

test('verifySingleSession rejects a session with no on-disk log', withHome((root) => {
  const id = 'session-22222222-2222-2222-2222-222222222222';
  addProjcacheEntry(root, id); // projcache-only, no log
  assert.throws(() => verifySingleSession(id, root, readWorkspace(root)), SessionIdFormatError);
}));

test('verifySingleSession rejects duplicate slug dirs (ambiguous)', withHome((root) => {
  const id = 'session-33333333-3333-3333-3333-333333333333';
  addSessionDir(root, slugFor('/work/proj-a'), id);
  addSessionDir(root, slugFor('/work/proj-b'), id);
  addProjcacheEntry(root, id);
  assert.throws(() => verifySingleSession(id, root, readWorkspace(root)), SessionAmbiguousError);
}));

test('verifySingleSession rejects a symlinked slug directory', withHome((root) => {
  const id = 'session-44444444-4444-4444-4444-444444444444';
  const target = root + '/sessions/-evil-target-' + id;
  fs.mkdirSync(target + '/' + id, { recursive: true });
  fs.writeFileSync(target + '/' + id + '/session.v3.jsonl.zstd', 'SYNTHETIC:' + id + '\n');
  fs.symlinkSync(target, root + '/sessions/-symlink-slug', 'dir');
  addProjcacheEntry(root, id);
  assert.throws(() => verifySingleSession(id, root, readWorkspace(root)), SessionPathEscapeError);
}));

test('verifySingleSession rejects a symlinked session dir', withHome((root) => {
  const id = 'session-55555555-5555-5555-5555-555555555555';
  const slug = root + '/sessions/-work-slug';
  fs.mkdirSync(slug, { recursive: true });
  const real = root + '/evil-store-' + id;
  fs.mkdirSync(real, { recursive: true });
  fs.writeFileSync(real + '/session.v3.jsonl.zstd', 'SYNTHETIC:' + id + '\n');
  fs.symlinkSync(real, slug + '/' + id, 'dir');
  addProjcacheEntry(root, id);
  assert.throws(() => verifySingleSession(id, root, readWorkspace(root)), SessionPathEscapeError);
}));

test('verifySingleSession rejects malformed projcache entries', withHome((root) => {
  const id = 'session-66666666-6666-6666-6666-666666666666';
  addSessionDir(root, slugFor('/work/proj'), id);
  fs.writeFileSync(root + '/storages/session_projcache/sessions/'
    + id.slice('session-'.length) + '.json', '{"version":7}');
  assert.throws(() => verifySingleSession(id, root, { tables: { workspaces: {} } }), SessionAmbiguousError);
}));

test('verifySingleSession succeeds without workspace.json (cold machine)', withHome((root) => {
  const id = 'session-77777777-7777-7777-7777-777777777777';
  addSessionDir(root, slugFor('/work/proj'), id);
  addProjcacheEntry(root, id);
  const resolved = verifySingleSession(id, root, null);
  assert.equal(resolved.canonicalId, id);
  assert.equal(resolved.workspaceClaims.length, 0);
}));

test('verifySingleSession records workspace claims but does not require any', withHome((root) => {
  const id = 'session-88888888-8888-8888-8888-888888888888';
  addSessionDir(root, slugFor('/work/proj'), id);
  addProjcacheEntry(root, id);
  addWorkspaceMembership(root, '/work/proj', id);
  const resolved = verifySingleSession(id, root, readWorkspace(root));
  assert.equal(resolved.workspaceClaims.length, 1);
}));

// --- prefix-colliding id ---------------------------------------------------

test('verifySingleSession does NOT collapse two ids that share a prefix', withHome((root) => {
  const idA = 'session-99999999-9999-9999-9999-999999999999';
  const idB = 'session-99999999-9999-9999-9999-99999999999a';
  addSessionDir(root, slugFor('/work/a'), idA);
  addSessionDir(root, slugFor('/work/b'), idB);
  addProjcacheEntry(root, idA);
  addProjcacheEntry(root, idB);
  const ws = readWorkspace(root);
  const resolvedA = verifySingleSession(idA, root, ws);
  assert.equal(resolvedA.canonicalId, idA);
  assert.ok(resolvedA.sessionDir.includes('-work-a'));
  const resolvedB = verifySingleSession(idB, root, ws);
  assert.equal(resolvedB.canonicalId, idB);
  assert.ok(resolvedB.sessionDir.includes('-work-b'));
}));

// --- path traversal in the id --------------------------------------------

test('normalizeSessionId refuses values that look like paths', () => {
  const malicious = [
    '../../../etc/passwd',
    'session-../../etc/passwd',
    'session-12345678-1234-1234-1234-123456789012/../../../etc/passwd',
    'session-12345678-1234-1234-1234-123456789012\x00',
  ];
  for (const m of malicious) {
    assert.throws(() => normalizeSessionId(m), SessionIdFormatError, `should reject ${m}`);
  }
});