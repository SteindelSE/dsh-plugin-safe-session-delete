// dsh-plugin-safe-session-delete — recovery
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
// Helper for the deletion service: given a persisted intent left over by a
// prior crashed plugin run, decide whether the deletion completed and what
// cleanup is still required.
//
// The intent record carries the canonical id, the session directory
// realpath, the projection-cache spellings to scrub, and the workspace
// claims to drop. Recovery is conservative: if the session is still
// referenced anywhere, we refuse to touch it and surface the failure.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  assertContained,
  SessionPathEscapeError,
  sessionsRoot,
} from './session-resolver.js';
import {
  stripWorkspaceMembership,
  stripProjcache,
  removeSessionDir,
  readWorkspace,
} from './persistence.js';

/**
 * Inspect every place an intent references and report whether the
 * deletion is fully complete, partially complete, or still referenced.
 *
 * @param {object} intent
 * @param {string} dshHome
 * @returns {Promise<{
 *   complete: boolean,
 *   logStillPresent: boolean,
 *   projcacheStillPresent: boolean,
 *   workspaceStillReferences: boolean,
 *   sessionDirStillExists: boolean,
 * }>}
 */
export async function recoverySweep(intent, dshHome) {
  if (!intent || typeof intent.canonicalId !== 'string') {
    return { complete: false, logStillPresent: false, projcacheStillPresent: false, workspaceStillReferences: false, sessionDirStillExists: false };
  }
  const canonicalId = intent.canonicalId;

  // 1. workspace.json
  const ws = await readWorkspace(dshHome);
  let workspaceStillReferences = false;
  const tables = ws?.tables || {};
  for (const wid of Object.keys(tables.workspaces || {})) {
    const rec = tables.workspaces[wid];
    if (rec && Array.isArray(rec.sessionIds) && rec.sessionIds.includes(canonicalId)) {
      workspaceStillReferences = true;
      break;
    }
  }
  if (Array.isArray(ws?.global?.archivedSessionIds) && ws.global.archivedSessionIds.includes(canonicalId)) {
    workspaceStillReferences = true;
  }

  // 2. projcache
  const sessionsDir = path.join(dshHome, 'storages', 'session_projcache', 'sessions');
  let projcacheStillPresent = false;
  const spellings = intent.projSpellingKeys && intent.projSpellingKeys.length > 0
    ? intent.projSpellingKeys
    : [canonicalId.slice('session-'.length), canonicalId];
  for (const sp of spellings) {
    try {
      await fsp.access(path.join(sessionsDir, `${sp}.json`));
      projcacheStillPresent = true;
      break;
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }

  // 3. session log dir
  const sessionDir = intent.sessionDir;
  let sessionDirStillExists = false;
  if (typeof sessionDir === 'string') {
    try {
      const st = await fsp.lstat(sessionDir);
      if (st.isSymbolicLink()) {
        throw new SessionPathEscapeError(`refusing to inspect symlinked session dir ${sessionDir}`);
      }
      if (st.isDirectory()) sessionDirStillExists = true;
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }

  const complete = !workspaceStillReferences && !projcacheStillPresent && !sessionDirStillExists;

  return {
    complete,
    workspaceStillReferences,
    projcacheStillPresent,
    sessionDirStillExists,
    logStillPresent: sessionDirStillExists,
  };
}