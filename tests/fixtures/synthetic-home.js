// dsh-plugin-safe-session-delete — synthetic home fixture
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
// A self-contained, isolated `$DSH_HOME` for the test suite. The fixture
// NEVER touches the user's real `~/.dsh` directory. Tests are required to
// build this fixture, run their assertions, and tear it down before
// returning.
//
// The fixture mimics the harness's on-disk layout to the extent the
// plugin cares about:
//   - <root>/sessions/<slug>/session-<uuid>/session.v{1,3,4}.jsonl.zstd
//   - <root>/storages/workspace.json   (a KvTable)
//   - <root>/storages/session_projcache/sessions/<uuid>.json
//   - <root>/storages/safe-session-delete.recovery.json
//   - <root>/profiles/<name>/          (for cross-profile tests)

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

/** Slug encoder mirroring harness behavior: `/` -> `-`, leading and trailing `-` preserved. */
export function slugFor(cwd) {
  // `/home/foo` -> `--home-foo-` (one `-` per `/` edge, slashes become `-`).
  return cwd.replace(/[/\\]/g, '-').replace(/(?<=^|-)\/+|(?:\/)+(?=$|-)/g, '-');
}

/**
 * Create a brand-new synthetic $DSH_HOME. Returns the absolute path and
 * a cleanup function. The cleanup is intentionally aggressive: it
 * recursively removes everything created under the synthetic root.
 */
export function createSyntheticHome() {
  const root = fs.realpathSync.native(os.tmpdir()) + path.sep + `safe-session-delete-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(path.join(root, 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(root, 'storages', 'session_projcache', 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(root, 'profiles'), { recursive: true });
  // Touch workspace.json with an empty shell so subsequent edits have a
  // base to mutate.
  fs.writeFileSync(path.join(root, 'storages', 'workspace.json'), JSON.stringify({
    unit: { name: 'workspace', version: 2 },
    global: { initialized: true, workspaceIds: [], archivedSessionIds: [], pinnedSessionIds: [] },
    tables: { workspaces: {} },
  }, null, 2));
  const cleanup = () => {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* */ }
  };
  return { root, cleanup };
}

/**
 * Add a synthetic session directory under a slug with optional JSONL
 * contents. Returns the canonical session directory path.
 */
export function addSessionDir(root, slug, sessionId, opts) {
  const dir = path.join(root, 'sessions', slug, sessionId);
  fs.mkdirSync(dir, { recursive: true });
  // A locked dummy file to stand in for session.v3.jsonl.zstd.
  if (!opts || opts.skipContents !== true) {
    fs.writeFileSync(path.join(dir, 'session.v3.jsonl.zstd'), `SYNTHETIC:${sessionId}\n`);
  }
  return dir;
}

/**
 * Add a synthetic projection-cache entry under root.
 */
export function addProjcacheEntry(root, canonicalId, opts) {
  const uuid = canonicalId.startsWith('session-') ? canonicalId.slice('session-'.length) : canonicalId;
  const file = path.join(root, 'storages', 'session_projcache', 'sessions', `${uuid}.json`);
  const record = {
    version: 7,
    record: {
      identity: {
        formatVersion: 4,
        createdAt: Date.now(),
        cwd: opts?.cwd || '/synthetic',
        isSeeded: false,
        inheritedEventCount: 0,
      },
      rows: {
        title: {
          ver: 1,
          seq: 1,
          val: opts?.title || 'SYNTHETIC SESSION',
        },
      },
    },
  };
  fs.writeFileSync(file, JSON.stringify(record, null, 2));
  return file;
}

/**
 * Add a synthetic workspace record that references `canonicalId` and
 * returns the workspace id.
 */
export function addWorkspaceMembership(root, cwd, canonicalId, opts) {
  const file = path.join(root, 'storages', 'workspace.json');
  const wsId = crypto.randomUUID();
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  data.tables = data.tables || {};
  data.tables.workspaces = data.tables.workspaces || {};
  data.global = data.global || {};
  data.global.workspaceIds = data.global.workspaceIds || [];
  data.global.workspaceIds.push(wsId);
  data.tables.workspaces[wsId] = {
    path: cwd,
    title: opts?.title || path.basename(cwd),
    sessionIds: opts?.sessionIds || [canonicalId],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  if (opts?.archived) {
    data.global.archivedSessionIds = data.global.archivedSessionIds || [];
    data.global.archivedSessionIds.push(canonicalId);
  }
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  return wsId;
}

/**
 * Mutate the workspace storage under the harness read-modify-write path
 * (atomic rename) to insert a session that should remain untouched by
 * the deletion under test. Used for collateral-damage tests.
 */
export function addIndependentSession(root, opts) {
  const slug = slugFor(opts.cwd || '/synthetic/independent');
  const canonicalId = opts.sessionId || `session-${crypto.randomUUID()}`;
  const dir = addSessionDir(root, slug, canonicalId);
  fs.writeFileSync(path.join(dir, 'INDEPENDENT_LOG'), `INDEPENDENT:${canonicalId}\n`);
  addProjcacheEntry(root, canonicalId, { title: opts.title || 'INDEPENDENT', cwd: opts.cwd });
  addWorkspaceMembership(root, opts.cwd || '/synthetic/independent', canonicalId);
  return { canonicalId, slug, dir };
}

/**
 * Hash every relevant file under root and return a deterministic map. Used
 * to verify collateral-damage: every unrelated record must remain
 * byte-identical before and after a deletion.
 */
export async function snapshotBytes(root) {
  const out = {};
  async function walk(dir) {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile()) {
        const data = await fsp.readFile(p);
        out[p.slice(root.length)] = crypto.createHash('sha256').update(data).digest('hex');
      } else if (e.isSymbolicLink()) {
        out[p.slice(root.length) + ' (symlink)'] = '(symlink)';
      }
    }
  }
  await walk(root);
  return out;
}

/**
 * Hash the on-disk layout to one stable string, used by collateral
 * damage assertions.
 */
export function hashSnapshot(snap) {
  const lines = Object.entries(snap).sort().map(([k, v]) => `${k}\t${v}`);
  return crypto.createHash('sha256').update(lines.join('\n')).digest('hex');
}