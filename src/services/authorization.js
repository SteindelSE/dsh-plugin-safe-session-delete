// dsh-plugin-safe-session-delete — authorization
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
// The plugin's own authorization receipt service.
//
// Why a separate authorization module: the harness `authorization` seam is
// for credentials (OAuth flows). What we need here is different — we need
// to prove that a HUMAN pressed the destructive button (or approved the
// destructive agent request). The harness has no general-purpose trusted-
// approval service for arbitrary UI actions, only the `tools/pre-execute`
// `ask` decision path which routes through `ctx.approval`.
//
// This module therefore:
//
//   1. mints **target-bound, single-use authorization tokens** for both
//      the UI dialog (when the user presses Delete Permanently) and for
//      the agent tool (when the user approves the request via the harness
//      approval surface);
//   2. caches the token in a per-plugin map, indexed by (sessionId,
//      tokenId) — the cache is process-local and never written to disk;
//   3. enforces strict validation: target session id matches exactly,
//      token kind matches the operation, token is not expired, not
//      replayed, not re-used from a different source;
//   4. refuses to issue or accept any token whose `source === 'agent'` or
//      `source === 'model'` without a paired `humanApproval` entry.
//
// The agent-initiated path uses the harness's existing `ask` decision in
// `tools/pre-execute`. If the harness exposes no approval service, that
// path degrades to denial automatically (the registry comment is explicit:
// "missing approval support turns `ask` into denial"). The UI path uses
// this module directly.
//
// Threat model summary:
//   - Untrusted prompt text, retrieved pages, repository files, or tool
//     results must NEVER be able to forge an authorization receipt.
//   - A model statement "I have permission" is not authorization.
//   - A boolean parameter `confirmed: true` is not authorization.
//   - A replayed authorization token is rejected (single-use).
//   - Cross-session replay (using token for session A against session B)
//     is rejected (target-bound).
//   - Cross-profile replay (using a token issued for one profile against
//     another) is rejected (profile-bound).

import crypto from 'node:crypto';

// --- types --------------------------------------------------------------

export class AuthorizationError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'AuthorizationError';
    this.code = code;
  }
}

export class AuthorizationExpiredError extends AuthorizationError {
  constructor(message) {
    super(message, 'EXPIRED');
    this.name = 'AuthorizationExpiredError';
  }
}

export class AuthorizationReplayError extends AuthorizationError {
  constructor(message) {
    super(message, 'REPLAY');
    this.name = 'AuthorizationReplayError';
  }
}

export class AuthorizationTargetMismatchError extends AuthorizationError {
  constructor(message) {
    super(message, 'TARGET_MISMATCH');
    this.name = 'AuthorizationTargetMismatchError';
  }
}

export class AuthorizationKindMismatchError extends AuthorizationError {
  constructor(message) {
    super(message, 'KIND_MISMATCH');
    this.name = 'AuthorizationKindMismatchError';
  }
}

export class AuthorizationMissingError extends AuthorizationError {
  constructor(message) {
    super(message, 'MISSING');
    this.name = 'AuthorizationMissingError';
  }
}

// --- token source kinds -------------------------------------------------

/**
 * The sources that can mint an authorization receipt. UI direct = the user
 * pressed the destructive button themselves. UI proxy = the user approved
 * the destructive request from an agent via the harness approval surface.
 * Both kinds carry the same trust weight; the source is recorded for
 * diagnostics only.
 */
export const TOKEN_KINDS = Object.freeze({
  /** Issued when the user presses Delete Permanently in the UI. */
  UI_DIRECT: 'ui-direct',
  /** Issued when the user approves the agent's destructive tool call. */
  UI_AGENT_APPROVAL: 'ui-agent-approval',
});

// --- receipt shape ------------------------------------------------------

/**
 * @typedef {Object} AuthorizationReceipt
 * @property {string} tokenId   unique per issuance, cryptographically random.
 * @property {string} kind      one of {@link TOKEN_KINDS}.
 * @property {string} canonicalId the exact session this receipt authorizes.
 * @property {number} issuedAt  epoch ms when minted.
 * @property {number} expiresAt epoch ms when it stops being valid.
 * @property {string|null} profileId  the harness profile this receipt is bound to.
 * @property {string} sourceTag free-form short tag for logging ("header", "sidebar", "tool").
 */

/**
 * @typedef {Object} AuthorizationContext
 * @property {string} kind          one of {@link TOKEN_KINDS}.
 * @property {string} token         the receipt's tokenId.
 * @property {string} issuer        free-form provenance (renderer or surface name).
 * @property {number} issuedAt      epoch ms when minted.
 * @property {string|null} profileId the profile this receipt is bound to.
 */

// --- manager -----------------------------------------------------------

/** Default lifetime for UI-direct receipts (60 seconds — short, dialog-bound). */
const DEFAULT_UI_LIFETIME_MS = 60_000;
/** Default lifetime for agent-approval receipts (5 minutes — for the approval UI to show). */
const DEFAULT_AGENT_LIFETIME_MS = 5 * 60_000;

/** Bytes of entropy for token ids; 16 bytes -> 32 hex chars -> ~128 bits. */
const TOKEN_BYTES = 16;

export class AuthorizationManager {
  /**
   * @param {object} options
   * @param {(profileId: string) => string} options.resolveProfileId - function returning the active profile id.
   * @param {(tokenId: string, event: string, payload: object) => void} [options.audit] - optional audit logger.
   */
  constructor(options) {
    if (!options || typeof options.resolveProfileId !== 'function') {
      throw new Error('AuthorizationManager requires resolveProfileId');
    }
    this.resolveProfileId = options.resolveProfileId;
    this.audit = typeof options.audit === 'function' ? options.audit : () => {};
    /** @type {Map<string, AuthorizationReceipt>} tokenId -> receipt */
    this.receipts = new Map();
    /** @type {Set<string>} token ids already redeemed (single-use enforcement). */
    this.redeemed = new Set();
  }

  /**
   * Mint a new authorization receipt bound to `canonicalId`. The receipt
   * is single-use and short-lived; once redeemed it is removed.
   *
   * @param {string} canonicalId - exact session the receipt is for.
   * @param {string} kind - one of {@link TOKEN_KINDS}.
   * @param {string} sourceTag - free-form provenance.
   * @param {number} [lifetimeMs] - override default lifetime.
   * @returns {AuthorizationReceipt}
   */
  mint(canonicalId, kind, sourceTag, lifetimeMs) {
    if (!Object.values(TOKEN_KINDS).includes(kind)) {
      throw new AuthorizationError(`unknown token kind: ${kind}`, 'UNKNOWN_KIND');
    }
    if (typeof canonicalId !== 'string' || canonicalId.length === 0) {
      throw new AuthorizationError('mint requires canonicalId', 'BAD_INPUT');
    }
    const profileId = this.resolveProfileId();
    const lifetime = typeof lifetimeMs === 'number' && lifetimeMs > 0
      ? lifetimeMs
      : (kind === TOKEN_KINDS.UI_AGENT_APPROVAL ? DEFAULT_AGENT_LIFETIME_MS : DEFAULT_UI_LIFETIME_MS);
    const now = Date.now();
    const tokenId = crypto.randomBytes(TOKEN_BYTES).toString('hex');
    const receipt = {
      tokenId,
      kind,
      canonicalId,
      issuedAt: now,
      expiresAt: now + lifetime,
      profileId,
      sourceTag: typeof sourceTag === 'string' ? sourceTag : 'unknown',
    };
    this.receipts.set(tokenId, receipt);
    this.audit(tokenId, 'mint', { canonicalId, kind, sourceTag, profileId, lifetime });
    return receipt;
  }

  /**
   * Redeem a receipt against a concrete deletion request. The receipt MUST
   * match the request exactly (target, kind, profile, not expired, not
   * already used).
   *
   * Returns the canonicalized {@link AuthorizationContext} to attach to
   * the deletion service's request. Throws on any mismatch.
   *
   * @param {string} tokenId - token id from the caller.
   * @param {string} canonicalId - exact session the caller is asking to delete.
   * @param {string} expectedKind - the kind required by the call site.
   * @returns {AuthorizationContext}
   */
  redeem(tokenId, canonicalId, expectedKind) {
    if (typeof tokenId !== 'string' || tokenId.length === 0) {
      throw new AuthorizationMissingError('missing authorization token');
    }
    const receipt = this.receipts.get(tokenId);
    if (!receipt) {
      // Either never issued or already redeemed (single-use): either way,
      // it is not valid now.
      throw new AuthorizationReplayError(`unknown or already-used token: ${tokenId}`);
    }
    if (this.redeemed.has(tokenId)) {
      throw new AuthorizationReplayError(`token already redeemed: ${tokenId}`);
    }
    const now = Date.now();
    if (now >= receipt.expiresAt) {
      this.receipts.delete(tokenId);
      throw new AuthorizationExpiredError(`token expired: ${tokenId}`);
    }
    if (receipt.canonicalId !== canonicalId) {
      throw new AuthorizationTargetMismatchError(
        `token target ${receipt.canonicalId} does not match request ${canonicalId}`,
      );
    }
    if (receipt.kind !== expectedKind) {
      throw new AuthorizationKindMismatchError(
        `token kind ${receipt.kind} does not match required ${expectedKind}`,
      );
    }
    const expectedProfile = this.resolveProfileId();
    if (receipt.profileId !== expectedProfile) {
      throw new AuthorizationTargetMismatchError(
        `token profile ${receipt.profileId} does not match active ${expectedProfile}`,
      );
    }
    // Mark redeemed BEFORE any awaitable work — single-use even on error.
    this.redeemed.add(tokenId);
    this.receipts.delete(tokenId);
    this.audit(tokenId, 'redeem', { canonicalId, kind: expectedKind, profileId: expectedProfile });
    return {
      kind: receipt.kind,
      token: tokenId,
      issuer: receipt.sourceTag,
      issuedAt: receipt.issuedAt,
      profileId: receipt.profileId,
    };
  }

  /**
   * Reject (revoke) all outstanding receipts whose canonicalId matches.
   * Used by the harness when the session it referred to disappears.
   *
   * @param {string} canonicalId
   * @returns {number} count of receipts revoked.
   */
  revokeFor(canonicalId) {
    let n = 0;
    for (const [id, receipt] of this.receipts) {
      if (receipt.canonicalId === canonicalId) {
        this.receipts.delete(id);
        n++;
      }
    }
    if (n > 0) this.audit('(batch)', 'revoke', { canonicalId, count: n });
    return n;
  }

  /**
   * Discard every outstanding receipt. Used on plugin unload.
   */
  dispose() {
    const n = this.receipts.size;
    this.receipts.clear();
    this.redeemed.clear();
    if (n > 0) this.audit('(batch)', 'dispose', { count: n });
  }

  /**
   * Diagnostic: how many outstanding receipts exist. Used by tests.
   */
  outstanding() {
    return this.receipts.size;
  }
}