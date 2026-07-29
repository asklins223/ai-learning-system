/**
 * esbuild script — bundles the Electron main process and preload script
 * into CJS files that Electron can load directly.
 */

import * as esbuild from "esbuild";
import * as path from "node:path";

const root = path.resolve(import.meta.dirname);

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
  banner,
};

// Build main process.
await esbuild.build({
  ...baseOptions,
  entryPoints: [path.join(root, "src", "main.ts")],
  outfile: path.join(root, "dist", "main.cjs"),
});

// Build preload script.
await esbuild.build({
  ...baseOptions,
  entryPoints: [path.join(root, "src", "preload.ts")],
  outfile: path.join(root, "dist", "preload.cjs"),
});

console.log("✓ Electron main + preload bundled to dist/");
