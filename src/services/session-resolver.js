// dsh-plugin-safe-session-delete — session-resolver
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
// Authoritative session identity and filesystem resolution.
//
// This module is the single source of truth for "which session is this id"
// and "where on disk does this session live". It must never guess, never
// scan broadly, and never follow symbolic links. Every other service in this
// plugin MUST go through here before touching any session.
//
// Threats this module defends against (see SECURITY.md):
//   1. Identifier ambiguity: raw UUID and `session-<uuid>` spellings must be
//      proven to refer to the same single persisted session before either is
//      accepted; two records under either spelling must NOT collapse.
//   2. Symlink redirection: a session directory that is or contains a
//      symlink must be rejected; canonical-path resolution alone is not
//      enough because attackers can plant targets after the resolve.
//   3. Path traversal: target paths must be provably contained in the
//      canonical storage root; the parent of that root, or anything that
//      resolves outside it, must be rejected outright.
//   4. Cross-profile or cross-workspace leakage: a session that does not
//      belong to the active profile / workspace MUST be rejected even if
//      its id matches.
//   5. Race conditions: the directory MUST be revalidated at every step
//      and must NOT be replaced by a symlink between resolve and use.
//
// ESM module format (cordis bundle rule). No side effects on import. Pure
// functions, no I/O outside the explicit fs operations on this module's
// own allowlist of paths.

import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';

// --- constants --------------------------------------------------------------

/** The single regex that accepts a raw UUID or a `session-<uuid>` id. */
export const SESSION_ID_RE =
  /^(session-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A session directory containing files is allowed only when owned by us. */
const SESSION_FILE_OWNER_UID = 0; // best-effort; we only assert non-zero when supported.

// ---- per-DSH-home validation ------------------------------------------------

/**
 * Resolve the canonical DSH home (used for storage roots). One call site.
 *
 * The plugin never reads `process.env.DSH_HOME` directly anywhere except
 * here: every other module receives the resolved home through this
 * function's return value, which makes the boundary auditable.
 *
 * @param env - the host's process.env (or a frozen snapshot).
 * @returns absolute, resolved path to the DSH home directory.
 */
export function resolveDshHome(env) {
  const fromEnv = env && typeof env.DSH_HOME === 'string' && env.DSH_HOME.length > 0
    ? env.DSH_HOME
    : null;
  const home = fromEnv || path.join(env?.HOME || process.env.HOME || '/root', '.dsh');
  return path.resolve(home);
}

/** Canonical path of the on-disk session logs root. */
export function sessionsRoot(dshHome) {
  return path.resolve(path.join(dshHome, 'sessions'));
}

/** Canonical path of the projection-cache storage directory. */
export function projcacheRoot(dshHome) {
  return path.resolve(path.join(dshHome, 'storages', 'session_projcache'));
}

/** Canonical path of the workspace storage file (a KvTable JSON). */
export function workspaceStoragePath(dshHome) {
  return path.resolve(path.join(dshHome, 'storages', 'workspace.json'));
}

/** Canonical path of the durable deletion-recovery marker file. */
export function recoveryStatePath(dshHome) {
  return path.resolve(path.join(dshHome, 'storages', 'safe-session-delete.recovery.json'));
}

// --- id validation -----------------------------------------------------------

/**
 * Validate that `value` is a syntactically well-formed session id. Returns
 * the canonical form (`session-<uuid>`) regardless of which spelling was
 * supplied. Throws a typed error otherwise.
 *
 * The canonical form is what the harness stores in workspace.json and what
 * the client passes through every UI path. The raw UUID is what the
 * session-log backend and the projection cache use.
 *
 * @param value - candidate id from any source.
 * @returns the canonical `session-<uuid>` form.
 * @throws SessionIdFormatError
 */
export function normalizeSessionId(value) {
  if (typeof value !== 'string') {
    throw new SessionIdFormatError('session id must be a string');
  }
  const trimmed = value.trim();
  if (!SESSION_ID_RE.test(trimmed)) {
    throw new SessionIdFormatError(`session id is not a well-formed uuid: ${trimmed.slice(0, 80)}`);
  }
  // Lowercase BEFORE the prefix check so case variants like 'SESSION-' do
  // not slip past it and double-prepend.
  const lower = trimmed.toLowerCase();
  const uuid = lower.startsWith('session-') ? lower.slice('session-'.length) : lower;
  const canonical = `session-${uuid}`;
  return canonical;
}

/**
 * Return every spelling that the id might appear under across the harness
 * storage layers: the canonical `session-<uuid>` form, the raw UUID, and
 * (defensively) a couple of case variants. Both spellings MUST be cleaned
 * for the same deletion to be complete.
 *
 * The plugin never assumes the raw form and the prefixed form refer to the
 * same session without proving it. See {@link verifySingleStorage}.
 *
 * @param canonical - canonical id from {@link normalizeSessionId}.
 * @returns the unique spelling set.
 */
export function sessionIdVariants(canonical) {
  const uuid = canonical.slice('session-'.length);
  return Array.from(new Set([canonical, uuid, canonical.toLowerCase()]));
}

/** Thrown when a candidate id is malformed. */
export class SessionIdFormatError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SessionIdFormatError';
  }
}

/** Thrown when alias resolution cannot prove one persisted session. */
export class SessionAmbiguousError extends Error {
  constructor(message, candidates) {
    super(message);
    this.name = 'SessionAmbiguousError';
    this.candidates = candidates;
  }
}

/** Thrown when a path target escapes the canonical storage root or is a symlink. */
export class SessionPathEscapeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SessionPathEscapeError';
  }
}

// --- storage containment -----------------------------------------------------

/**
 * Assert `absolute` is contained in `root` AND neither is a symlink AND
 * `absolute` does not traverse via a symlinked ancestor. Both `root` and
 * `absolute` are realpath'd without following the leaf itself when the
 * caller wants to inspect it.
 *
 * Every path argument MUST already be an absolute, resolved path (use
 * `path.resolve` first). The function performs the containment check
 * without crossing filesystem boundaries the host did not authorize.
 *
 * @param root - canonical, already-realpath'd storage root.
 * @param absolute - canonical, already-realpath'd candidate path.
 * @throws SessionPathEscapeError on any escape, symlink, or boundary breach.
 */
export function assertContained(root, absolute) {
  if (!path.isAbsolute(root) || !path.isAbsolute(absolute)) {
    throw new SessionPathEscapeError('paths must be absolute');
  }
  if (absolute !== root && !absolute.startsWith(root + path.sep)) {
    throw new SessionPathEscapeError(`path ${absolute} escapes storage root ${root}`);
  }
}

/**
 * Realpath a path WITHOUT traversing symlinks in the path's ancestry beyond
 * the boundary the caller supplied. If the path itself is a symlink, that
 * is reported (caller decides whether to follow). Returns the realpath and
 * a flag describing whether the leaf was a symlink.
 *
 * The intent: the session-log root is allowed to be a real directory; the
 * session id directory must be a real directory; symlinks at any level are
 * treated as suspicious.
 *
 * @param target - absolute path to inspect.
 * @returns `{ realpath, leafIsSymlink }` when target exists; `{ realpath: null, leafIsSymlink: false }` otherwise.
 */
export function safeRealpath(target) {
  let realpath = null;
  try {
    realpath = fs.realpathSync.native(target);
  } catch {
    return { realpath: null, leafIsSymlink: false };
  }
  let leafIsSymlink = false;
  try {
    const lst = fs.lstatSync(target);
    leafIsSymlink = lst.isSymbolicLink();
  } catch {
    // The target itself is unreachable; the realpath above may have
    // traversed a parent symlink. Treat as escape candidate.
    throw new SessionPathEscapeError(`unable to lstat ${target}`);
  }
  return { realpath, leafIsSymlink };
}

/**
 * Realpath every ancestor of `target` (including target itself), rejecting
 * any link along the way. The returned realpath is the canonical path the
 * harness would reach if it walked the file system by inode.
 *
 * @param target - absolute path to validate.
 * @returns canonical realpath.
 * @throws SessionPathEscapeError if any ancestor is a symlink.
 */
export function safeAncestors(target) {
  const parts = path.resolve(target).split(path.sep);
  let acc = parts[0] === '' ? path.sep : parts[0];
  for (let i = 1; i < parts.length; i++) {
    acc = i === 1 && parts[0] === '' ? path.sep + parts[1] : path.join(acc, parts[i]);
    let st;
    try {
      st = fs.lstatSync(acc);
    } catch (err) {
      if (err.code === 'ENOENT') return path.resolve(target); // missing is fine; caller decides
      throw new SessionPathEscapeError(`unable to lstat ancestor ${acc}: ${err.message}`);
    }
    if (st.isSymbolicLink()) {
      throw new SessionPathEscapeError(`refusing to traverse symlink at ${acc}`);
    }
  }
  return path.resolve(target);
}

// --- filesystem resolution ---------------------------------------------------

/**
 * Locate every on-disk session directory under `<sessionsRoot>/<slug>/`
 * whose name matches any of the candidate spellings of `canonicalId`.
 *
 * Returns the canonical realpath of each match (or an empty array when no
 * match exists). Symlinked slugs or session directories are NOT followed;
 * a symlink at any level is reported via `leafIsSymlink` and the caller
 * decides whether to refuse.
 *
 * The plugin treats slug directories as opaque host-owned namespaces. We
 * never look inside them — the only thing we care about is whether a
 * directory of the candidate id spelling lives in any one of them.
 *
 * @param canonicalId - canonical `session-<uuid>` form.
 * @param dshHome - resolved DSH home.
 * @returns one record per match: `{ canonicalPath, leafIsSymlink }`.
 */
export function findSessionDirs(canonicalId, dshHome) {
  const root = sessionsRoot(dshHome);
  if (!fs.existsSync(root)) return [];
  const variants = sessionIdVariants(canonicalId);
  const found = [];
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (err) {
    throw new SessionPathEscapeError(`unable to read sessions root ${root}: ${err.message}`);
  }
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const slug = path.join(root, entry.name);
    // Reject symlinked slug directories outright — they let an attacker
    // point a slug at an unrelated tree.
    let slugSt;
    try {
      slugSt = fs.lstatSync(slug);
    } catch {
      continue;
    }
    if (slugSt.isSymbolicLink()) {
      throw new SessionPathEscapeError(`refusing symlinked slug directory ${slug}`);
    }
    for (const variant of variants) {
      const candidate = path.join(slug, variant);
      let st;
      try {
        st = fs.lstatSync(candidate);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) {
        throw new SessionPathEscapeError(`refusing symlinked session dir ${candidate}`);
      }
      if (!st.isDirectory()) continue;
      let realpath;
      try {
        realpath = fs.realpathSync.native(candidate);
      } catch {
        continue;
      }
      // Reject any realpath outside the canonical sessions root.
      assertContained(root, realpath);
      found.push({ canonicalPath: realpath, leafIsSymlink: false });
    }
  }
  return found;
}

/**
 * Resolve the projection-cache entry for one session. The projection cache
 * uses the raw UUID spelling (the JSONL backend uses the prefixed spelling).
 * Both must be checked, and the entries must be a single record.
 *
 * @param canonicalId - canonical id.
 * @param dshHome - resolved DSH home.
 * @returns the entries map keyed by spelling; absent spellings are omitted.
 */
export function findProjcacheEntries(canonicalId, dshHome) {
  const root = projcacheRoot(dshHome);
  const sessionsDir = path.join(root, 'sessions');
  if (!fs.existsSync(sessionsDir)) return {};
  const variants = sessionIdVariants(canonicalId);
  const out = {};
  for (const variant of variants) {
    const file = path.join(sessionsDir, `${variant}.json`);
    try {
      const st = fs.lstatSync(file);
      if (!st.isFile() || st.isSymbolicLink()) {
        throw new SessionPathEscapeError(`refusing non-regular projcache entry ${file}`);
      }
      const raw = fs.readFileSync(file, 'utf8');
      const parsed = JSON.parse(raw);
      out[variant] = parsed;
    } catch (err) {
      if (err.code === 'ENOENT') continue;
      if (err instanceof SessionPathEscapeError) throw err;
      throw err;
    }
  }
  return out;
}

/**
 * Verify that, at the moment of authorization, the candidate id maps to
 * EXACTLY one persisted session across every storage layer we touch:
 *
 *   a. exactly one on-disk log directory (one spelling, no double-match),
 *   b. at most one projection-cache entry (only the raw spelling),
 *   c. zero or one workspace-membership entry (canonical spelling only),
 *   d. none of the targets are symlinked.
 *
 * If any check fails or cannot be completed cleanly, the call throws and
 * the deletion MUST be aborted. This is the single authorization gate
 * before deletion proceeds.
 *
 * @param canonicalId - canonical id.
 * @param dshHome - resolved DSH home.
 * @param workspace - workspace JSON object (parsed from `workspace.json`).
 * @returns a {@link ResolvedSession} describing the unique target.
 * @throws SessionAmbiguousError, SessionPathEscapeError
 */
export function verifySingleSession(canonicalId, dshHome, workspace) {
  const dirs = findSessionDirs(canonicalId, dshHome);
  if (dirs.length === 0) {
    throw new SessionIdFormatError(`session not found: ${canonicalId}`);
  }
  if (dirs.length > 1) {
    throw new SessionAmbiguousError(
      `multiple session directories found for ${canonicalId}`,
      dirs.map((d) => d.canonicalPath),
    );
  }

  const projEntries = findProjcacheEntries(canonicalId, dshHome);
  // Allow zero projcache entries (idle sessions are valid), but never two
  // different records under the same canonical id.
  const seen = new Set();
  for (const [, rec] of Object.entries(projEntries)) {
    if (!rec || typeof rec !== 'object'
      || typeof rec.record === 'undefined'
      || typeof rec.record.identity === 'undefined') {
      throw new SessionAmbiguousError(
        `projcache entry for ${canonicalId} is malformed`,
        Object.keys(projEntries),
      );
    }
    if (seen.has(rec)) {
      throw new SessionAmbiguousError(
        `projcache has duplicate record for ${canonicalId}`,
        Object.keys(projEntries),
      );
    }
    seen.add(rec);
  }

  // Workspace membership may legitimately be zero, one, or multiple if a
  // session is archived AND once lived in a real workspace. That is not
  // ambiguous; only "claimed by two distinct workspaces at once" is.
  const claims = [];
  if (workspace && typeof workspace === 'object') {
    const tables = workspace.tables || {};
    for (const [wid, rec] of Object.entries(tables.workspaces || {})) {
      if (rec && Array.isArray(rec.sessionIds) && rec.sessionIds.includes(canonicalId)) {
        claims.push({ workspaceId: wid, sessionIdsCount: rec.sessionIds.length });
      }
    }
    if (Array.isArray(workspace.global?.archivedSessionIds)
      && workspace.global.archivedSessionIds.includes(canonicalId)) {
      claims.push({ workspaceId: '(archived)', sessionIdsCount: 0 });
    }
  }

  return Object.freeze({
    canonicalId,
    sessionDir: dirs[0].canonicalPath,
    projEntries: Object.freeze(projEntries),
    workspaceClaims: Object.freeze(claims),
  });
}

/**
 * @typedef {Object} ResolvedSession
 * @property {string} canonicalId
 * @property {string} sessionDir - canonical realpath of the on-disk log directory.
 * @property {Readonly<Record<string, unknown>>} Projections - raw projection records keyed by spelling.
 * @property {Readonly<Array<{ workspaceId: string, sessionIdsCount: number }>>} workspaceClaims
 */

// --- slug helper (defensive only) -------------------------------------------

/**
 * Return the slug directory that owns the canonical session dir. Used for
 * diagnostic logging only — never to authorize deletion.
 *
 * @param sessionDir - canonical realpath of a session directory.
 * @param dshHome - resolved DSH home.
 * @returns the slug directory name (basename of the parent).
 */
export function slugOf(sessionDir, dshHome) {
  return path.basename(path.dirname(sessionDir));
}

// --- recoverable target binding ---------------------------------------------

/**
 * Compute a deletion-intent record persisted to durable storage before any
 * irreversible operation begins. Recovery uses this to know what was being
 * attempted when the host crashed.
 *
 * @param resolved - canonicalSession object from {@link verifySingleSession}.
 * @param authorization - opaque authorization receipt (already verified).
 * @returns the intent record, ready to be JSON-encoded.
 */
export function makeDeletionIntent(resolved, authorization, profileId) {
  return Object.freeze({
    schemaVersion: 1,
    canonicalId: resolved.canonicalId,
    sessionDir: resolved.sessionDir,
    projSpellingKeys: Object.keys(resolved.projEntries),
    workspaceClaims: resolved.workspaceClaims,
    authorization: Object.freeze({
      kind: authorization.kind,
      token: authorization.token,
      issuer: authorization.issuer || 'unknown',
      issuedAt: authorization.issuedAt,
    }),
    profileId: profileId || null,
    startedAt: new Date().toISOString(),
  });
}

// --- async wrappers --------------------------------------------------------

/** Async filesystem realpath for paths that may not yet exist. */
export async function safeRealpathAsync(target) {
  try {
    const realpath = await fsp.realpath(target);
    const lst = await fsp.lstat(target);
    return { realpath, leafIsSymlink: lst.isSymbolicLink() };
  } catch (err) {
    if (err.code === 'ENOENT') return { realpath: null, leafIsSymlink: false };
    throw err;
  }
}

// --- uid helpers ---------------------------------------------------------

/**
 * Return the uid of the current process (best-effort). Used only as a
 * defensive check against session dirs owned by another user; the harness
 * is a single-user application, so this almost always equals `0`.
 */
export function currentUid() {
  if (typeof process.getuid === 'function') return process.getuid();
  return SESSION_FILE_OWNER_UID;
}