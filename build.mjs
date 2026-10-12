#!/usr/bin/env node
// dsh-plugin-safe-session-delete — client bundle build script.
//
// Bundles `src/client.entry.js` into `src/client.js` using esbuild. The
// shipped artifact is a single classic script that calls
// `window.__ModuleLoader__.load` with a factory; the harness's Vite-launched
// client module system serves it as `dist/client.js` (see
// `exports["./client"]` in package.json).
//
// Run via `pnpm build` or `node build.mjs`. The `prepare` script in
// package.json also invokes this so the shipped artifact stays in sync
// after a clean install.
//
// Why this script exists (instead of relying on Vite/tsdown):
//   - The harness's client loader expects a single self-contained classic
//     script — exactly what esbuild's `--format=iife` produces.
//   - esbuild is a single Go binary with zero JS infrastructure; installing
//     it through pnpm is cheap and the output is deterministic.
//   - We do not use JSX; the source uses `require("react/jsx-runtime")`
//     explicitly, so esbuild does not need a JSX transform.
//
// Why `react`, `react-dom`, and `@deepseek-ai/*` are external:
//   - The harness's loader provides these modules through its seed graph
//     and the bundle's factory receives them via its `require` parameter.
//   - Inlining them would create a second React / DnD in the same page
//     and break the harness's slot contract.

import { build } from 'esbuild';

const ENTRY = 'src/client.entry.js';
const OUTFILE = 'src/client.js';
const EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/dsh-client-runtime',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-conversation',
  '@deepseek-ai/dsh-client-ui-workspace',
  '@deepseek-ai/dsh-client-ui-layout',
  '@deepseek-ai/cordis',
];

try {
  await build({
    entryPoints: [ENTRY],
    outfile: OUTFILE,
    bundle: true,
    format: 'iife',
    target: 'es2020',
    platform: 'browser',
    minify: false,
    sourcemap: false,
    legalComments: 'inline',
    logLevel: 'info',
    external: EXTERNALS,
  });
  console.log(`built ${OUTFILE}`);
} catch (err) {
  console.error('build failed:', err && err.message ? err.message : err);
  process.exit(1);
}