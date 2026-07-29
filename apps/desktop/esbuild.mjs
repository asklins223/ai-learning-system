/**
 * esbuild script — bundles the Electron main process and preload script
 * into CJS files that Electron can load directly.
 */

import * as esbuild from "esbuild";
import * as path from "node:path";

const root = path.resolve(import.meta.dirname);

/** @type {import('esbuild').BuildOptions} */
const baseOptions = {
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  sourcemap: true,
  external: ["electron", "electron-log"],
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
