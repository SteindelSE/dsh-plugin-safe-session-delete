// SPDX-License-Identifier: AGPL-3.0-or-later
//
// register-bundle.mjs: prove the lifecycle script adds the package
// name to a parent dsh profile's `dsh.profile.bundles` array, is
// idempotent, and refuses to touch manifests that are not dsh
// profiles. No real dsh install is touched; every test builds a
// throwaway directory under the OS temp dir.

import { describe, it, before, after } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(dirname(here));
const scriptPath = join(repoRoot, "scripts", "register-bundle.mjs");

async function writeJson(path, value) {
	await writeFile(path, JSON.stringify(value, null, 2) + "\n", "utf8");
}

async function readJson(path) {
	return JSON.parse(await readFile(path, "utf8"));
}

function runScript(cwd, initCwd) {
	return spawnSync(process.execPath, [scriptPath], {
		cwd,
		env: { ...process.env, INIT_CWD: initCwd ?? cwd },
		encoding: "utf8",
	});
}

describe("register-bundle.mjs", () => {
	let work;
	before(async () => {
		work = await mkdtemp(join(tmpdir(), "dsh-ssd-register-"));
	});
	after(async () => {
		if (work) await rm(work, { recursive: true, force: true });
	});

	it("adds the package name to a parent dsh profile's bundles", async () => {
		const profile = join(work, "profile-add");
		await mkdir(profile, { recursive: true });
		await writeJson(join(profile, "package.json"), {
			name: "dsh-test-profile",
			dsh: { profile: { bundles: ["@deepseek-ai/dsh-base"] } },
		});

		const result = runScript(repoRoot, profile);
		assert.equal(result.status, 0, `script exited non-zero: ${result.stderr}`);
		const after = await readJson(join(profile, "package.json"));
		const bundles = after.dsh.profile.bundles;
		assert.ok(
			bundles.includes("dsh-plugin-safe-session-delete"),
			`bundles did not include package name: ${JSON.stringify(bundles)}`,
		);
		// Pre-existing entries preserved.
		assert.ok(
			bundles.includes("@deepseek-ai/dsh-base"),
			`bundles lost pre-existing entry: ${JSON.stringify(bundles)}`,
		);
	});

	it("is idempotent on a second run", async () => {
		const profile = join(work, "profile-idem");
		await mkdir(profile, { recursive: true });
		await writeJson(join(profile, "package.json"), {
			name: "dsh-test-profile",
			dsh: { profile: { bundles: ["dsh-plugin-safe-session-delete"] } },
		});

		const first = runScript(repoRoot, profile);
		assert.equal(first.status, 0, `first run failed: ${first.stderr}`);
		const second = runScript(repoRoot, profile);
		assert.equal(second.status, 0, `second run failed: ${second.stderr}`);
		const after = await readJson(join(profile, "package.json"));
		const count = after.dsh.profile.bundles.filter(
			(name) => name === "dsh-plugin-safe-session-delete",
		).length;
		assert.equal(count, 1, `bundle registered twice: ${JSON.stringify(after.dsh.profile.bundles)}`);
	});

	it("preserves unrelated dsh fields", async () => {
		const profile = join(work, "profile-fields");
		await mkdir(profile, { recursive: true });
		await writeJson(join(profile, "package.json"), {
			name: "dsh-test-profile",
			version: "0.0.0",
			private: true,
			dsh: {
				profile: {
					bundles: ["@deepseek-ai/dsh-base"],
					patchReload: "live",
				},
				client: { inject: [], platform: "web" },
			},
			dependencies: { "@deepseek-ai/dsh-base": "0.2.0-rc.2" },
		});

		const result = runScript(repoRoot, profile);
		assert.equal(result.status, 0, `script failed: ${result.stderr}`);
		const after = await readJson(join(profile, "package.json"));
		assert.equal(after.version, "0.0.0");
		assert.equal(after.private, true);
		assert.equal(after.dsh.profile.patchReload, "live");
		assert.deepEqual(after.dsh.client, { inject: [], platform: "web" });
		assert.equal(after.dependencies["@deepseek-ai/dsh-base"], "0.2.0-rc.2");
		assert.ok(after.dsh.profile.bundles.includes("dsh-plugin-safe-session-delete"));
	});

	it("does not touch a non-dsh manifest under INIT_CWD", async () => {
		const profile = join(work, "profile-none");
		await mkdir(profile, { recursive: true });
		const original = { name: "some-random-package", version: "1.0.0" };
		await writeJson(join(profile, "package.json"), original);

		const result = runScript(repoRoot, profile);
		// The script may exit 0 with a hint pointing at some other
		// dsh-shaped parent on the walk-up path, or it may exit 0
		// without doing anything — either way the test profile's
		// manifest must be byte-identical to what we wrote.
		assert.equal(result.status, 0, `script should exit 0: ${result.stderr}`);
		const after = await readJson(join(profile, "package.json"));
		assert.deepEqual(after, original, "non-dsh manifest under INIT_CWD must not be rewritten");
	});

	it("exits 0 and prints a hint when dsh.profile.bundles is missing", async () => {
		const profile = join(work, "profile-no-bundles");
		await mkdir(profile, { recursive: true });
		await writeJson(join(profile, "package.json"), {
			name: "dsh-test-profile",
			dsh: { profile: { patchReload: "live" } },
		});

		const result = runScript(repoRoot, profile);
		assert.equal(result.status, 0, `script should exit 0: ${result.stderr}`);
		assert.ok(
			result.stderr.includes("dsh.profile.bundles") || result.stdout.includes("dsh.profile.bundles"),
			`expected hint to be printed; got stdout=${result.stdout} stderr=${result.stderr}`,
		);
		const after = await readJson(join(profile, "package.json"));
		// Unchanged.
		assert.equal(after.dsh.profile.patchReload, "live");
		assert.equal(after.dsh.profile.bundles, undefined);
	});
});
