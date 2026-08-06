/**
 * esbuild script — bundles the Electron main process and preload script
 * into CJS files that Electron can load directly.
 *
 * Usage:
 *   node esbuild.mjs          — one-shot build
 *   node esbuild.mjs --watch  — watch mode (rebuild on file change)
 */

import * as esbuild from "esbuild";
import * as path from "node:path";

const root = path.resolve(import.meta.dirname);
const watch = process.argv.includes("--watch");

/**
 * Banner: must delete ELECTRON_RUN_AS_NODE before any require("electron")
 * call runs.  When this env var is set, Electron runs as plain Node.js
 * and require("electron") returns a path string instead of the API.
 */
const banner = {
  js: `delete process.env.ELECTRON_RUN_AS_NODE;`,
};

/** @type {import('esbuild').BuildOptions} */
const baseOptions = {
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  sourcemap: true,
  external: ["electron", "electron-log"],
};

// Build configs for all three entry points.
const configs = [
  // Main process — needs banner to delete ELECTRON_RUN_AS_NODE.
  {
    ...baseOptions,
    banner,
    entryPoints: [path.join(root, "src", "main.ts")],
    outfile: path.join(root, "dist", "main.cjs"),
  },
  // Preload script — same reason as main.
  {
    ...baseOptions,
    banner,
    entryPoints: [path.join(root, "src", "preload.ts")],
    outfile: path.join(root, "dist", "preload.cjs"),
  },
  // Web worker — no banner (runs in a utility process, not Electron main).
  {
    ...baseOptions,
    entryPoints: [path.join(root, "src", "web-worker.ts")],
    outfile: path.join(root, "dist", "web-worker.cjs"),
  },
];

if (watch) {
  // Watch mode: rebuild all entry points on file change.
  const contexts = [];
  for (const config of configs) {
    const ctx = await esbuild.context(config);
    await ctx.watch();
    contexts.push(ctx);
  }
  console.log("✓ Watching for changes (main + preload + web-worker)…");
} else {
  // One-shot build.
  for (const config of configs) {
    await esbuild.build(config);
  }
  console.log("✓ Electron main + preload + web-worker bundled to dist/");
}
