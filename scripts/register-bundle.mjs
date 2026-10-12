#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Auto-register this package as an active bundle in the parent
// profile's `package.json`. Runs as a `prepare` lifecycle hook so
// `dsh plugin --profile <name> add <spec>` is a one-command
// install for end users: pnpm installs the package, this hook
// adds the name to `dsh.profile.bundles`, and the next browser
// refresh loads the bundle.
//
// The script is idempotent, lock-free, and writes the profile
// manifest atomically. It never deletes or rewrites anything it
// does not own. If anything looks off (no parent profile, no
// dsh field, malformed JSON) it prints a short hint to stderr
// and exits 0 so a blocked lifecycle does not fail the user's
// install outright.

import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ownPackageJson = await readFile(resolve(here, "..", "package.json"), "utf8");
const own = JSON.parse(ownPackageJson);
const ownName = own.name;

if (typeof ownName !== "string" || ownName.length === 0) {
	process.stderr.write("safe-session-delete: register-bundle: package.json has no name; skipping\n");
	process.exit(0);
}

// The profile's `package.json` lives in the directory the user
// ran `pnpm add` from. pnpm exposes that as `INIT_CWD` (npm's
// convention, also honored by pnpm). Fall back to walking up
// from our own install dir until we find a `package.json` with
// a `dsh` field.
function candidateProfileDirs() {
	const seen = new Set();
	const fromEnv = process.env.INIT_CWD;
	if (typeof fromEnv === "string" && fromEnv.length > 0) seen.add(resolve(fromEnv));
	let cursor = resolve(here, "..");
	for (let i = 0; i < 8; i += 1) {
		seen.add(cursor);
		const parent = dirname(cursor);
		if (parent === cursor) break;
		cursor = parent;
	}
	return [...seen];
}

let profileDir = null;
let profileManifest = null;
for (const candidate of candidateProfileDirs()) {
	const pkgPath = join(candidate, "package.json");
	if (!existsSync(pkgPath)) continue;
	let parsed;
	try {
		parsed = JSON.parse(await readFile(pkgPath, "utf8"));
	} catch {
		continue;
	}
	if (parsed && typeof parsed === "object" && parsed.dsh && typeof parsed.dsh === "object") {
		profileDir = candidate;
		profileManifest = parsed;
		break;
	}
}

if (profileDir === null) {
	process.stderr.write(
		`safe-session-delete: no parent dsh profile found (searched ${candidateProfileDirs().length} candidates from ${here}); ` +
		`install via the dsh web UI's Plugins page or run \`dsh plugin --profile <name> add <spec>\` from a profile directory.\n`,
	);
	process.exit(0);
}

const profileBundles = profileManifest.dsh.profile?.bundles;
if (!Array.isArray(profileBundles)) {
	process.stderr.write(
		`safe-session-delete: profile at ${profileDir} has no dsh.profile.bundles array; ` +
		`re-initialize the profile with \`dsh plugin --profile <name> add <some-existing-bundle>\` and retry.\n`,
	);
	process.exit(0);
}

if (profileBundles.includes(ownName)) {
	// Already registered; nothing to do.
	process.exit(0);
}

const next = {
	...profileManifest,
	dsh: {
		...profileManifest.dsh,
		profile: {
			...profileManifest.dsh.profile,
			bundles: [...profileBundles, ownName],
		},
	},
};

const serialized = JSON.stringify(next, null, 2) + "\n";
const target = join(profileDir, "package.json");
const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
await writeFile(tmp, serialized, { mode: 0o600 });
const { rename } = await import("node:fs/promises");
await rename(tmp, target);

process.stdout.write(`safe-session-delete: registered ${ownName} in ${target}\n`);
