#!/usr/bin/env node

import {
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
export const REPOSITORY_ROOT = resolve(dirname(SCRIPT_PATH), "../..");
export const VERSION_SOURCE_PATH = "release/version.json";
export const PACKAGE_ROOTS = [
  "apps/api",
  "workers/ai-worker",
  "packages/shared",
];

const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const RELEASE_TAG_PATTERN =
  /^v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))(?:-(rc\.[1-9]\d*))?$/;
const README_VERSION_MARKERS = [
  {
    name: "当前版本 text",
    pattern: /当前版本：`v([^`]+)`/g,
    versionGroup: 1,
    replace(readme, version) {
      return readme.replace(this.pattern, `当前版本：\`v${version}\``);
    },
  },
  {
    name: "Version badge",
    pattern: /(https:\/\/img\.shields\.io\/badge\/version-v)((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))(-[^)\s]+\.svg)/g,
    versionGroup: 2,
    replace(readme, version) {
      return readme.replace(this.pattern, `$1${version}$3`);
    },
  },
];

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function relative(root, path) {
  return path.slice(root.length + 1);
}

function serializeJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function writeFileAtomically(path, contents) {
  const temporaryDirectory = mkdtempSync(join(dirname(path), ".version-sync-"));
  const temporaryPath = join(temporaryDirectory, "next");
  try {
    writeFileSync(temporaryPath, contents, "utf8");
    renameSync(temporaryPath, path);
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function findReadmeVersionMarkers(readme) {
  return README_VERSION_MARKERS.flatMap((marker) =>
    Array.from(readme.matchAll(marker.pattern), (match) => ({
      marker,
      version: match[marker.versionGroup],
    })),
  );
}

export function validateVersion(value) {
  if (typeof value !== "string" || !VERSION_PATTERN.test(value)) {
    throw new Error(`version must be a stable MAJOR.MINOR.PATCH value, got ${JSON.stringify(value)}`);
  }
  return value;
}

export function loadVersionSource(root = REPOSITORY_ROOT) {
  const source = readJson(join(root, VERSION_SOURCE_PATH));
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    throw new Error(`${VERSION_SOURCE_PATH} must contain one JSON object`);
  }
  const keys = Object.keys(source).sort();
  if (keys.length !== 1 || keys[0] !== "version") {
    throw new Error(`${VERSION_SOURCE_PATH} must contain only the manually maintained version field`);
  }
  return validateVersion(source.version);
}

export function inspectVersionCopies(root = REPOSITORY_ROOT, version = loadVersionSource(root)) {
  const issues = [];

  for (const packageRoot of PACKAGE_ROOTS) {
    const packagePath = join(root, packageRoot, "package.json");
    try {
      const packageJson = readJson(packagePath);
      if (packageJson.version !== version) {
        issues.push(`${relative(root, packagePath)} version is ${JSON.stringify(packageJson.version)}, expected ${version}`);
      }
    } catch (error) {
      issues.push(`${relative(root, packagePath)} could not be read: ${error instanceof Error ? error.message : error}`);
    }

    const lockPath = join(root, packageRoot, "package-lock.json");
    try {
      const lock = readJson(lockPath);
      if (lock.version !== version) {
        issues.push(`${relative(root, lockPath)} top-level version is ${JSON.stringify(lock.version)}, expected ${version}`);
      }
      if (!lock.packages || !lock.packages[""]) {
        issues.push(`${relative(root, lockPath)} has no packages[""] root metadata`);
      } else if (lock.packages[""].version !== version) {
        issues.push(`${relative(root, lockPath)} packages[""].version is ${JSON.stringify(lock.packages[""].version)}, expected ${version}`);
      }
    } catch (error) {
      issues.push(`${relative(root, lockPath)} could not be read: ${error instanceof Error ? error.message : error}`);
    }
  }

  try {
    const readme = readFileSync(join(root, "README.md"), "utf8");
    const markers = findReadmeVersionMarkers(readme);
    if (markers.length !== 1) {
      issues.push(`README.md must contain exactly one supported version marker, found ${markers.length}`);
    } else if (markers[0].version !== version) {
      issues.push(`README.md ${markers[0].marker.name} is ${JSON.stringify(markers[0].version)}, expected ${version}`);
    }
  } catch (error) {
    issues.push(`README.md could not be read: ${error instanceof Error ? error.message : error}`);
  }

  return issues;
}

export function syncVersionCopies(root = REPOSITORY_ROOT, version = loadVersionSource(root)) {
  const changed = [];

  for (const packageRoot of PACKAGE_ROOTS) {
    const packagePath = join(root, packageRoot, "package.json");
    const packageJson = readJson(packagePath);
    packageJson.version = version;
    const packageContents = serializeJson(packageJson);
    if (readFileSync(packagePath, "utf8") !== packageContents) {
      writeFileAtomically(packagePath, packageContents);
      changed.push(relative(root, packagePath));
    }

    const lockPath = join(root, packageRoot, "package-lock.json");
    const lock = readJson(lockPath);
    if (!lock.packages || !lock.packages[""]) {
      throw new Error(`${relative(root, lockPath)} has no packages[""] root metadata`);
    }
    lock.version = version;
    lock.packages[""].version = version;
    const lockContents = serializeJson(lock);
    if (readFileSync(lockPath, "utf8") !== lockContents) {
      writeFileAtomically(lockPath, lockContents);
      changed.push(relative(root, lockPath));
    }
  }

  const readmePath = join(root, "README.md");
  const readme = readFileSync(readmePath, "utf8");
  const markers = findReadmeVersionMarkers(readme);
  if (markers.length !== 1) {
    throw new Error(`README.md must contain exactly one supported version marker before synchronization, found ${markers.length}`);
  }
  const nextReadme = markers[0].marker.replace(readme, version);
  if (readme !== nextReadme) {
    writeFileAtomically(readmePath, nextReadme);
    changed.push("README.md");
  }

  return changed;
}

export function parseReleaseTag(name) {
  const match = RELEASE_TAG_PATTERN.exec(name);
  return match ? { version: match[1], prerelease: match[2] ?? null } : null;
}

export function inspectExactReleaseTags(version, tags) {
  validateVersion(version);
  const issues = [];
  for (const tag of tags) {
    const parsed = parseReleaseTag(tag.name);
    if (!parsed) continue;
    if (parsed.version !== version) {
      issues.push(`exact release tag ${tag.name} targets version ${parsed.version}, but ${VERSION_SOURCE_PATH} is ${version}`);
    }
    if (tag.objectType !== "tag") {
      issues.push(`exact release tag ${tag.name} must be annotated, got Git object type ${tag.objectType}`);
    }
  }
  return issues;
}

function usage() {
  console.log("Usage: node .github/scripts/version-contract.mjs [--check|--write]");
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    usage();
    return;
  }
  if (args.length > 1 || (args[0] && args[0] !== "--check" && args[0] !== "--write")) {
    usage();
    process.exitCode = 2;
    return;
  }

  const mode = args[0] ?? "--check";
  try {
    const version = loadVersionSource();
    if (mode === "--write") {
      const changed = syncVersionCopies(REPOSITORY_ROOT, version);
      console.log(changed.length > 0
        ? `synchronized ${changed.length} version copies to ${version}`
        : `version copies already synchronized at ${version}`);
    }

    const issues = inspectVersionCopies(REPOSITORY_ROOT, version);
    if (issues.length > 0) {
      for (const issue of issues) console.error(`version contract failed: ${issue}`);
      process.exitCode = 1;
      return;
    }
    console.log(`version contract OK (${version}; ${PACKAGE_ROOTS.length} packages, ${PACKAGE_ROOTS.length} lockfiles, README)`);
  } catch (error) {
    console.error(`version contract failed: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_PATH) {
  main();
}
