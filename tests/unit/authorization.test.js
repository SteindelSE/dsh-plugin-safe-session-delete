// dsh-plugin-safe-session-delete — authorization tests
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
// Prove the AuthorizationManager enforces every guarantee we promise:
//   - tokens are bound to a single canonical session id;
//   - tokens are single-use (replay rejected);
//   - tokens have a short lifetime and expire;
//   - tokens cannot be redeemed for a different session (cross-session);
//   - tokens cannot be redeemed for a different operation kind;
//   - tokens cannot be redeemed under a different profile;
//   - "boolean parameter" not a token, "model statement of permission"
//     not a token, etc.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  AuthorizationManager,
  TOKEN_KINDS,
  AuthorizationError,
  AuthorizationExpiredError,
  AuthorizationReplayError,
  AuthorizationTargetMismatchError,
  AuthorizationKindMismatchError,
  AuthorizationMissingError,
} from '../../src/services/authorization.js';

function makeManager(profileId = 'profile-A') {
  let active = profileId;
  const audit = [];
  return {
    mgr: new AuthorizationManager({
      resolveProfileId: () => active,
      audit: (token, event, payload) => audit.push({ token, event, payload }),
    }),
    setProfile: (next) => { active = next; },
    audit,
  };
}

test('mint returns a receipt bound to the canonical id', () => {
  const { mgr } = makeManager();
  const r = mgr.mint('session-11111111-1111-1111-1111-111111111111', TOKEN_KINDS.UI_DIRECT, 'header');
  assert.equal(r.canonicalId, 'session-11111111-1111-1111-1111-111111111111');
  assert.equal(r.kind, TOKEN_KINDS.UI_DIRECT);
  assert.equal(r.profileId, 'profile-A');
  assert.ok(typeof r.tokenId === 'string' && r.tokenId.length >= 32);
});

test('redeem succeeds exactly once and is then rejected', () => {
  const { mgr } = makeManager();
  const r = mgr.mint('session-11111111-1111-1111-1111-111111111111', TOKEN_KINDS.UI_DIRECT, 'header');
  const ctx = mgr.redeem(r.tokenId, 'session-11111111-1111-1111-1111-111111111111', TOKEN_KINDS.UI_DIRECT);
  assert.equal(ctx.token, r.tokenId);
  assert.throws(
    () => mgr.redeem(r.tokenId, 'session-11111111-1111-1111-1111-111111111111', TOKEN_KINDS.UI_DIRECT),
    (err) => err instanceof AuthorizationReplayError || err instanceof AuthorizationMissingError,
  );
});

test('cross-session replay is rejected', () => {
  const { mgr } = makeManager();
  const r = mgr.mint('session-aaaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', TOKEN_KINDS.UI_DIRECT, 'header');
  assert.throws(
    () => mgr.redeem(r.tokenId, 'session-bbbbbbbb-bbbb-bbbb-bbbbbbbbbbbbb', TOKEN_KINDS.UI_DIRECT),
    AuthorizationTargetMismatchError,
  );
});

test('cross-kind redemption is rejected', () => {
  const { mgr } = makeManager();
  const r = mgr.mint('session-aaaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', TOKEN_KINDS.UI_DIRECT, 'header');
  assert.throws(
    () => mgr.redeem(r.tokenId, 'session-aaaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', TOKEN_KINDS.UI_AGENT_APPROVAL),
    AuthorizationKindMismatchError,
  );
});

test('cross-profile redemption is rejected', () => {
  const { mgr, setProfile } = makeManager('profile-A');
  const r = mgr.mint('session-aaaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', TOKEN_KINDS.UI_DIRECT, 'header');
  setProfile('profile-B');
  assert.throws(
    () => mgr.redeem(r.tokenId, 'session-aaaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', TOKEN_KINDS.UI_DIRECT),
    AuthorizationTargetMismatchError,
  );
});

test('expired token is rejected', async () => {
  const { mgr } = makeManager();
  const r = mgr.mint('session-aaaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', TOKEN_KINDS.UI_DIRECT, 'header', 50);
  await new Promise((r) => setTimeout(r, 80));
  assert.throws(
    () => mgr.redeem(r.tokenId, 'session-aaaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', TOKEN_KINDS.UI_DIRECT),
    AuthorizationExpiredError,
  );
});

test('forged / unknown tokens are rejected', () => {
  const { mgr } = makeManager();
  assert.throws(
    () => mgr.redeem('not-a-real-token', 'session-aaaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', TOKEN_KINDS.UI_DIRECT),
    (err) => err instanceof AuthorizationReplayError || err instanceof AuthorizationMissingError,
  );
  assert.throws(
    () => mgr.redeem('', 'session-aaaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', TOKEN_KINDS.UI_DIRECT),
    AuthorizationMissingError,
  );
  assert.throws(
    () => mgr.redeem(null, 'session-aaaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', TOKEN_KINDS.UI_DIRECT),
    AuthorizationMissingError,
  );
});

test('revokeFor discards outstanding receipts for one session', () => {
  const { mgr } = makeManager();
  mgr.mint('session-aaaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', TOKEN_KINDS.UI_DIRECT, 'header');
  mgr.mint('session-aaaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', TOKEN_KINDS.UI_AGENT_APPROVAL, 'tool');
  mgr.mint('session-bbbbbbbb-bbbb-bbbb-bbbbbbbbbbbbb', TOKEN_KINDS.UI_DIRECT, 'header');
  const removed = mgr.revokeFor('session-aaaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
  assert.equal(removed, 2);
  assert.equal(mgr.outstanding(), 1);
});

test('dispose clears every receipt', () => {
  const { mgr } = makeManager();
  mgr.mint('session-aaaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', TOKEN_KINDS.UI_DIRECT, 'header');
  mgr.mint('session-bbbbbbbb-bbbb-bbbb-bbbbbbbbbbbbb', TOKEN_KINDS.UI_AGENT_APPROVAL, 'tool');
  mgr.dispose();
  assert.equal(mgr.outstanding(), 0);
});

test('audit hook fires for mint / redeem / revoke / dispose', () => {
  const { mgr, audit } = makeManager();
  const r = mgr.mint('session-aaaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', TOKEN_KINDS.UI_DIRECT, 'header');
  mgr.redeem(r.tokenId, 'session-aaaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', TOKEN_KINDS.UI_DIRECT);
  mgr.mint('session-bbbbbbbb-bbbb-bbbb-bbbbbbbbbbbbb', TOKEN_KINDS.UI_DIRECT, 'header');
  mgr.revokeFor('session-bbbbbbbb-bbbb-bbbb-bbbbbbbbbbbbb');
  // Mint one more so dispose still has work to log.
  mgr.mint('session-cccccccc-cccc-cccc-cccc-cccccccccccc', TOKEN_KINDS.UI_DIRECT, 'header');
  mgr.dispose();
  const events = audit.map((e) => e.event);
  assert.deepEqual(events, ['mint', 'redeem', 'mint', 'revoke', 'mint', 'dispose']);
});

test('minting an unknown kind rejects', () => {
  const { mgr } = makeManager();
  assert.throws(() => mgr.mint('session-aaaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'unauthorized', 'header'),
    (err) => err instanceof AuthorizationError && err.code === 'UNKNOWN_KIND');
});

test('boolean parameter is NOT an authorization receipt', () => {
  // Direct contract proof: a boolean cannot be redeemed.
  const { mgr } = makeManager();
  assert.throws(
    () => mgr.redeem(true, 'session-aaaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', TOKEN_KINDS.UI_DIRECT),
    (err) => err instanceof AuthorizationMissingError || err instanceof AuthorizationReplayError,
  );
});