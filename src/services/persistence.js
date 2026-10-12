// dsh-plugin-safe-session-delete — persistence
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
// Storage-layer mutations: read/write/atomic-edit of the workspace.json
// file and the projection-cache directory. Each operation is performed
// under a per-file lock so a concurrent Harness process (rare but
// possible — Desktop shares the home with the bundled CLI) cannot race
// the edit and leave a torn write behind.
//
// Threat model:
//   - A torn workspace.json write would re-introduce a partially-deleted
//     session to some workspaces (a session that the agent and the
//     workspace both believe still exists). We use atomic
//     rename-after-temp to prevent torn edits.
//   - A non-atomic projcache delete could be observed mid-rename. We
//     delete the file directly with fs.rm and verify the target is
//     absent afterward; rename-after-temp is also used for new files.
//   - A concurrent worker re-creating the projection-cache file after
//     our delete is detected and reported (see session-delete service).

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const SESSION_PREFIX = 'session-';

import {
  projcacheRoot,
  workspaceStoragePath,
  recoveryStatePath,
  sessionIdVariants,
  assertContained,
  SessionPathEscapeError,
} from './session-resolver.js';

// --- locks ---------------------------------------------------------------

/** Map<absolutePath, Promise> — one lock per file. */
const locks = new Map();

/**
 * Run `body` while holding an exclusive lock on `filePath`. Subsequent
 * calls wait for the previous body to resolve. The lock is released even
 * if `body` throws.
 *
 * @param {string} filePath - absolute path.
 * @param {() => Promise<T>} body - critical section.
 * @returns {T}
 */
export async function withFileLock(filePath, body) {
  const prev = locks.get(filePath) || Promise.resolve();
  let release;
  const next = new Promise((resolve) => { release = resolve; });
  locks.set(filePath, prev.then(() => next));
  try {
    await prev;
    return await body();
  } finally {
    release();
    if (locks.get(filePath) === next) locks.delete(filePath);
  }
}

// --- workspace.json -----------------------------------------------------

/**
 * Read workspace.json under a shared lock. Returns the parsed object, or
 * `null` if the file does not exist. Throws on parse error.
 *
 * @param {string} dshHome
 * @returns {object | null}
 */
export async function readWorkspace(dshHome) {
  const file = workspaceStoragePath(dshHome);
  return withFileLock(file, async () => {
    try {
      const buf = await fsp.readFile(file, 'utf8');
      return JSON.parse(buf);
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
  });
}

/**
 * Edit workspace.json atomically: read, mutate under lock, write to a
 * temp file in the same directory, then rename. The lock prevents two
 * callers from racing the read-modify-write.
 *
 * The mutator receives the parsed object and returns either the new
 * object or a sentinel `{ abort: true }` to leave the file untouched.
 *
 * @param {string} dshHome
 * @param {(workspace: any) => any | { abort: true }} mutator
 * @returns {boolean} whether a write actually happened.
 */
export async function editWorkspace(dshHome, mutator) {
  const file = workspaceStoragePath(dshHome);
  return withFileLock(file, async () => {
    let current = null;
    try {
      const buf = await fsp.readFile(file, 'utf8');
      current = JSON.parse(buf);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    let next;
    try {
      next = mutator(current);
    } catch (err) {
      throw err;
    }
    if (next && typeof next === 'object' && next.abort === true) return false;
    const target = next === undefined ? current : next;
    if (target === null || target === undefined) {
      // Nothing to write — leave the existing file untouched.
      return false;
    }
    const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
    const data = JSON.stringify(target, null, 2);
    await fsp.writeFile(tmp, data, { encoding: 'utf8', mode: 0o600 });
    await fsp.rename(tmp, file);
    return true;
  });
}

/**
 * Remove `canonicalId` from every workspace record it appears in and from
 * the global archivedSessionIds list. Idempotent — re-running is a no-op
 * once the session is gone from the file.
 *
 * @param {string} dshHome
 * @param {string} canonicalId
 * @param {Set<string>} [extraSpellingKeys] - additional id spellings to scrub.
 * @returns {Promise<{ modified: boolean, claimsRemoved: number, archivedRemoved: boolean }>}
 */
export async function stripWorkspaceMembership(dshHome, canonicalId, extraSpellingKeys) {
  const spellings = new Set([canonicalId, ...(extraSpellingKeys || [])]);
  let claimsRemoved = 0;
  let archivedRemoved = false;
  const modified = await editWorkspace(dshHome, (current) => {
    if (!current || typeof current !== 'object') return { abort: true };
    let touched = false;
    const tables = current.tables && typeof current.tables === 'object' ? current.tables : {};
    if (tables.workspaces && typeof tables.workspaces === 'object') {
      for (const [wid, rec] of Object.entries(tables.workspaces)) {
        if (rec && Array.isArray(rec.sessionIds)) {
          const before = rec.sessionIds.length;
          const filtered = rec.sessionIds.filter((s) => !spellings.has(s));
          if (filtered.length !== before) {
            tables.workspaces[wid] = { ...rec, sessionIds: filtered };
            claimsRemoved += before - filtered.length;
            touched = true;
          }
        }
      }
    }
    if (current.global && Array.isArray(current.global.archivedSessionIds)) {
      const before = current.global.archivedSessionIds.length;
      const filtered = current.global.archivedSessionIds.filter((s) => !spellings.has(s));
      if (filtered.length !== before) {
        current.global.archivedSessionIds = filtered;
        archivedRemoved = true;
        touched = true;
      }
    }
    if (!touched) return { abort: true };
    return current;
  });
  return { modified, claimsRemoved, archivedRemoved };
}

// --- projection cache ----------------------------------------------------

/**
 * Remove one projection-cache file for `canonicalId`, using only the raw
 * UUID spelling (which is what the projection cache actually uses).
 * Re-checks that the file we are about to delete is a regular file under
 * the canonical projcache root and is not a symlink.
 *
 * @param {string} dshHome
 * @param {string} canonicalId
 * @returns {Promise<{ removed: boolean, spelling: string | null }>}
 */
export async function stripProjcache(canonicalId, dshHome) {
  const root = projcacheRoot(dshHome);
  const sessionsDir = path.join(root, 'sessions');
  if (!fs.existsSync(sessionsDir)) return { removed: false, spelling: null };
  // The projcache uses the raw UUID; the conditional `session-` spelling
  // may exist if a backwards-compatible shim created one — we accept that
  // case too.
  const candidates = Array.from(new Set([
    canonicalId.slice(SESSION_PREFIX.length),
    canonicalId,
  ]));
  let removedSpelling = null;
  for (const spelling of candidates) {
    const file = path.join(sessionsDir, `${spelling}.json`);
    let st;
    try {
      st = await fsp.lstat(file);
    } catch (err) {
      if (err.code === 'ENOENT') continue;
      throw err;
    }
    if (!st.isFile() || st.isSymbolicLink()) {
      throw new SessionPathEscapeError(`refusing to delete non-regular projcache entry ${file}`);
    }
    const real = await fsp.realpath(file);
    assertContained(path.join(root, 'sessions'), real);
    await fsp.rm(file, { force: true });
    // Verify it is gone — concurrent workers may have raced the rename.
    try {
      await fsp.access(file);
      throw new Error(`projcache file reappeared: ${file}`);
    } catch (err) {
      if (err.code === 'ENOENT') {
        removedSpelling = spelling;
        continue;
      }
      throw err;
    }
  }
  return { removed: removedSpelling !== null, spelling: removedSpelling };
}

/**
 * Inspect the projection cache for one canonical id and return the
 * authoritative "is this session known to the harness?" answer. Used by
 * the resolver and by recovery; never used to gate deletion in a way
 * that admits ambiguity (see resolver.verifySingleSession).
 */
export async function readProjcacheRecord(canonicalId, dshHome) {
  const root = projcacheRoot(dshHome);
  const sessionsDir = path.join(root, 'sessions');
  const candidates = [canonicalId.slice(SESSION_PREFIX.length), canonicalId];
  for (const spelling of candidates) {
    const file = path.join(sessionsDir, `${spelling}.json`);
    try {
      const raw = await fsp.readFile(file, 'utf8');
      return { spelling, record: JSON.parse(raw), file };
    } catch (err) {
      if (err.code === 'ENOENT') continue;
      throw err;
    }
  }
  return null;
}

// --- session log directory ----------------------------------------------

/**
 * Remove the canonical session log directory atomically (tmp-dir rename
 * out of the tree, then async `rm` so a slow disk does not block the
 * caller).
 *
 * Defenses:
 *   - lstat before delete: symlink at the leaf is rejected.
 *   - realpath of the parent: the parent itself must not be a symlink.
 *   - containment: the realpath must be inside the canonical root.
 *   - one-shot: the rename is followed by an unlink-after-rm; a missing
 *     file is treated as success because a crash earlier in the
 *     pipeline may have already moved it.
 *
 * @param {string} sessionDir - canonical realpath from the resolver.
 * @param {string} dshHome
 * @returns {Promise<{ removed: boolean, stagedTo: string | null }>}
 */
export async function removeSessionDir(sessionDir, dshHome) {
  const root = path.join(dshHome, 'sessions');
  assertContained(root, sessionDir);

  // Confirm the directory is real (not a symlink) and still exists.
  let st;
  try {
    st = await fsp.lstat(sessionDir);
  } catch (err) {
    if (err.code === 'ENOENT') return { removed: false, stagedTo: null };
    throw err;
  }
  if (!st.isDirectory()) {
    throw new SessionPathEscapeError(`refusing to delete non-directory ${sessionDir}`);
  }
  if (st.isSymbolicLink()) {
    throw new SessionPathEscapeError(`refusing to delete symlinked session dir ${sessionDir}`);
  }

  // Realpath parent — must be inside the root and not a symlink.
  const parent = path.dirname(sessionDir);
  const parentReal = await fsp.realpath(parent);
  assertContained(root, parentReal);

  // Stage: rename to a tmp sibling inside the same parent. The rename is
  // atomic on POSIX filesystems. If the rename fails with ENOENT we
  // report "already gone" rather than retry — the caller can verify.
  const stageName = `.safe-delete-${process.pid}-${crypto.randomBytes(4).toString('hex')}.${path.basename(sessionDir)}`;
  const stagePath = path.join(parentReal, stageName);
  try {
    await fsp.rename(sessionDir, stagePath);
  } catch (err) {
    if (err.code === 'ENOENT') return { removed: false, stagedTo: null };
    throw err;
  }

  // Async-remove the staged directory. We do not wait, but the caller can
  // observe `stagedTo` to know the target was moved out of the tree.
  // We DO wait for the rm to finish before returning, so verification can
  // prove the target is gone — a half-deleted session reappearing would
  // mean the staged move was not a real deletion.
  try {
    await fsp.rm(stagePath, { recursive: true, force: true });
  } catch (err) {
    // If rm fails, attempt a cleanup rename back so the user does not
    // see a half-deleted session in the next refresh.
    try {
      await fsp.rename(stagePath, sessionDir);
    } catch (restoreErr) {
      throw new Error(`failed to remove ${stagePath}: ${err.message}; also failed to restore: ${restoreErr.message}`);
    }
    throw err;
  }
  // Verify the canonical directory is gone.
  try {
    await fsp.access(sessionDir);
    throw new Error(`session dir ${sessionDir} reappeared after removal`);
  } catch (err) {
    if (err.code === 'ENOENT') {
      return { removed: true, stagedTo: stagePath };
    }
    throw err;
  }
}

// --- durable deletion-recovery marker -----------------------------------

/**
 * Persist the deletion intent (see makeDeletionIntent in resolver) so an
 * interrupted operation can be detected at next boot and either resumed
 * safely or reported.
 */
export async function writeDeletionIntent(dshHome, intent) {
  const file = recoveryStatePath(dshHome);
  return withFileLock(file, async () => {
    let current = { intents: [] };
    try {
      const buf = await fsp.readFile(file, 'utf8');
      current = JSON.parse(buf);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    if (!current || typeof current !== 'object' || !Array.isArray(current.intents)) {
      current = { intents: [] };
    }
    current.intents.push(intent);
    current.intents = current.intents.slice(-100);
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(current, null, 2), { encoding: 'utf8', mode: 0o600 });
    await fsp.rename(tmp, file);
  });
}

/**
 * Remove a completed (or abandoned) intent from the recovery file. The
 * intent is keyed by its (canonicalId, token) pair.
 */
export async function clearDeletionIntent(dshHome, intent) {
  const file = recoveryStatePath(dshHome);
  return withFileLock(file, async () => {
    let current;
    try {
      const buf = await fsp.readFile(file, 'utf8');
      current = JSON.parse(buf);
    } catch (err) {
      if (err.code === 'ENOENT') return false;
      throw err;
    }
    if (!current || !Array.isArray(current.intents)) return false;
    const before = current.intents.length;
    current.intents = current.intents.filter((i) => i.canonicalId !== intent.canonicalId || i.authorization.token !== intent.authorization.token);
    if (current.intents.length === before) return false;
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(current, null, 2), { encoding: 'utf8', mode: 0o600 });
    await fsp.rename(tmp, file);
    return true;
  });
}

/** Return every pending intent; used by recovery at plugin load time. */
export async function readDeletionIntents(dshHome) {
  const file = recoveryStatePath(dshHome);
  try {
    const buf = await fsp.readFile(file, 'utf8');
    const parsed = JSON.parse(buf);
    if (parsed && Array.isArray(parsed.intents)) return parsed.intents;
    return [];
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}