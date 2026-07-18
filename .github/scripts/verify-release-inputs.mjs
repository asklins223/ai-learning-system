#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import {
  inspectExactReleaseTags,
  inspectVersionCopies,
  loadVersionSource,
  PACKAGE_ROOTS,
  parseReleaseTag,
} from "./version-contract.mjs";

const requiredFiles = [
  ".github/workflows/ci.yml",
  "docker-compose.yml",
  "docker-compose.dev.yml",
  "infra/postgres/init.sql",
  "infra/postgres/apply-roles.sh",
  "infra/postgres/roles.sql",
  "apps/api/Dockerfile",
  "apps/api/package.json",
  "apps/api/package-lock.json",
  "apps/web/Dockerfile",
  "apps/web/package.json",
  "apps/web/package-lock.json",
  "workers/ai-worker/Dockerfile",
  "workers/ai-worker/package.json",
  "workers/ai-worker/package-lock.json",
  "packages/db/package.json",
  "packages/db/package-lock.json",
  "packages/shared/package.json",
  "packages/shared/package-lock.json",
  "README.md",
  "release/version.json",
  "release/release-manifest.schema.json",
  ".github/scripts/release-manifest-contract.mjs",
  ".github/scripts/release-manifest-contract.test.mjs",
  ".github/scripts/version-contract.mjs",
  ".github/scripts/version-contract.test.mjs",
  ".github/scripts/verify-worker-smoke.mjs",
  "apps/api/src/db/migrations/meta/_journal.json",
];

const packageRoots = PACKAGE_ROOTS;
const manifestSchemaPath = "release/release-manifest.schema.json";
const requiredManifestFields = [
  "schemaVersion",
  "version",
  "tag",
  "commit",
  "sourceDateEpoch",
  "nodeVersion",
  "generatedAt",
  "migration",
  "images",
  "tests",
  "aiQuality",
  "approvals",
];

const ciWorkflow = readFileSync(".github/workflows/ci.yml", "utf8");
if (!ciWorkflow.includes("run: node .github/scripts/release-manifest-contract.mjs")) {
  fail("CI must invoke the exact-tag release manifest verifier");
}

function fail(message) {
  console.error(`release input verification failed: ${message}`);
  process.exitCode = 1;
}

const status = execFileSync(
  "git",
  ["status", "--porcelain=v1", "--untracked-files=all"],
  { encoding: "utf8" },
).trim();

if (status) {
  fail(`checkout is not clean:\n${status}`);
}

for (const file of requiredFiles) {
  if (!existsSync(file) || !statSync(file).isFile()) {
    fail(`required file is missing: ${file}`);
    continue;
  }

  try {
    execFileSync("git", ["ls-files", "--error-unmatch", file], {
      stdio: "ignore",
    });
  } catch {
    fail(`required file is not tracked by Git: ${file}`);
  }
}

let releaseVersion = null;
try {
  releaseVersion = loadVersionSource();
  for (const issue of inspectVersionCopies(process.cwd(), releaseVersion)) {
    fail(issue);
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

try {
  const schema = JSON.parse(readFileSync(manifestSchemaPath, "utf8"));
  if (schema.$schema !== "https://json-schema.org/draft/2020-12/schema") {
    fail(`${manifestSchemaPath} must use JSON Schema draft 2020-12`);
  }
  if (schema.type !== "object" || schema.additionalProperties !== false) {
    fail(`${manifestSchemaPath} root must be a closed object schema`);
  }
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  for (const field of requiredManifestFields) {
    if (!required.has(field) || !schema.properties?.[field]) {
      fail(`${manifestSchemaPath} must require and define ${field}`);
    }
  }
  if (schema.properties?.version?.const !== undefined) {
    fail(`${manifestSchemaPath} must not duplicate the manually maintained release version as a const`);
  }
  for (const image of ["api", "web", "worker"]) {
    if (!schema.properties?.images?.required?.includes(image)) {
      fail(`${manifestSchemaPath} must require images.${image}`);
    }
  }
  for (const field of ["buildRunId", "builtAt", "deploymentEnvironment", "observedAt", "observedDigest", "evidence"]) {
    if (!schema.$defs?.imageProvenance?.required?.includes(field)) {
      fail(`${manifestSchemaPath} must require image provenance ${field}`);
    }
  }
  if (schema.$defs?.sha256?.pattern !== "^sha256:[0-9a-f]{64}$") {
    fail(`${manifestSchemaPath} must require canonical sha256 digests`);
  }
  if (schema.$defs?.gate?.properties?.evidence?.minItems !== 1) {
    fail(`${manifestSchemaPath} must require evidence for every test gate`);
  }
  for (const gate of [
    "unit",
    "integration",
    "e2e",
    "coverage",
    "dependencyScan",
    "secretScan",
    "containerScan",
  ]) {
    if (!schema.$defs?.tests?.required?.includes(gate)) {
      fail(`${manifestSchemaPath} must require tests.${gate}`);
    }
  }
  for (const field of [
    "datasetVersion",
    "datasetDigest",
    "sampleCount",
    "labelVersion",
    "scorerCommit",
    "promptVersion",
    "provider",
    "runs",
    "runResults",
    "metrics",
    "costUsd",
    "evidence",
  ]) {
    if (!schema.$defs?.aiQuality?.required?.includes(field)) {
      fail(`${manifestSchemaPath} must require aiQuality.${field}`);
    }
  }
  if (schema.$defs?.aiQuality?.properties?.runResults?.minItems !== 2) {
    fail(`${manifestSchemaPath} must require at least two AIQ runResults`);
  }
  if (schema.$defs?.aiQuality?.properties?.sampleCount?.minimum !== 30) {
    fail(`${manifestSchemaPath} must require at least 30 AIQ samples`);
  }
  for (const field of ["runId", "completedAt", "metrics", "evidence"]) {
    if (!schema.$defs?.aiRunResult?.required?.includes(field)) {
      fail(`${manifestSchemaPath} must require aiQuality.runResults[].${field}`);
    }
  }
  if (schema.$defs?.aiQuality?.properties?.costUsd?.maximum !== 10) {
    fail(`${manifestSchemaPath} must cap aiQuality.costUsd at 10`);
  }
  for (const approver of ["owner", "securityDataReviewer"]) {
    if (!schema.properties?.approvals?.required?.includes(approver)) {
      fail(`${manifestSchemaPath} must require approvals.${approver}`);
    }
  }
} catch (error) {
  fail(`${manifestSchemaPath} could not be verified: ${error instanceof Error ? error.message : error}`);
}

if (releaseVersion) {
  const exactTagNames = execFileSync("git", ["tag", "--points-at", "HEAD"], {
    encoding: "utf8",
  })
    .split("\n")
    .map((tag) => tag.trim())
    .filter(Boolean);
  const exactTags = exactTagNames.map((name) => ({
    name,
    objectType: execFileSync("git", ["cat-file", "-t", `refs/tags/${name}`], {
      encoding: "utf8",
    }).trim(),
  }));
  for (const issue of inspectExactReleaseTags(releaseVersion, exactTags)) {
    fail(issue);
  }
  if (
    process.env.GITHUB_REF_TYPE === "tag"
  ) {
    const githubTag = process.env.GITHUB_REF_NAME;
    if (!githubTag || !parseReleaseTag(githubTag)) {
      fail(`GitHub tag ${githubTag ?? "<missing>"} is not a supported stable or rc.N release tag`);
    } else if (!exactTagNames.includes(githubTag)) {
      fail(`GitHub tag ${githubTag} does not point at the checked-out commit`);
    }
  }
}

// npm ci refuses to run when the lockfile root metadata lags behind package.json.
// Check this from Git alone so a release cannot depend on an accidental local
// node_modules tree.
for (const root of packageRoots) {
  const packageJsonPath = join(root, "package.json");
  const lockPath = join(root, "package-lock.json");
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  const lock = JSON.parse(readFileSync(lockPath, "utf8"));
  const lockRoot = lock.packages?.[""];
  if (!lockRoot) {
    fail(`package-lock has no root package metadata: ${lockPath}`);
    continue;
  }
  if (lock.name !== packageJson.name || lock.version !== packageJson.version) {
    fail(`package-lock root metadata does not match package.json: ${root}`);
  }
  if (lockRoot.name !== packageJson.name || lockRoot.version !== packageJson.version) {
    fail(`package-lock packages[""] metadata does not match package.json: ${root}`);
  }
}

const migrationDirectory = "apps/api/src/db/migrations";
const journalPath = join(migrationDirectory, "meta", "_journal.json");
const journal = JSON.parse(readFileSync(journalPath, "utf8"));
const entries = journal.entries;

if (!Array.isArray(entries) || entries.length === 0) {
  fail("migration journal has no entries");
} else {
  const tags = new Set();

  for (const [position, entry] of entries.entries()) {
    if (entry.idx !== position) {
      fail(
        `migration journal idx is not contiguous at position ${position}: ${entry.idx}`,
      );
    }
    if (typeof entry.tag !== "string" || !/^\d{4}_[a-z0-9_]+$/.test(entry.tag)) {
      fail(`invalid migration tag at position ${position}: ${entry.tag}`);
      continue;
    }
    if (tags.has(entry.tag)) {
      fail(`duplicate migration journal tag: ${entry.tag}`);
      continue;
    }
    tags.add(entry.tag);

    const sqlFile = join(migrationDirectory, `${entry.tag}.sql`);
    if (!existsSync(sqlFile)) {
      fail(`journal entry has no SQL file: ${sqlFile}`);
      continue;
    }
    try {
      execFileSync("git", ["ls-files", "--error-unmatch", sqlFile], {
        stdio: "ignore",
      });
    } catch {
      fail(`migration SQL is not tracked by Git: ${sqlFile}`);
    }
  }

  const sqlTags = readdirSync(migrationDirectory)
    .filter((file) => file.endsWith(".sql"))
    .map((file) => basename(file, ".sql"));

  for (const tag of sqlTags) {
    if (!tags.has(tag)) {
      fail(`migration SQL is missing from the journal: ${tag}.sql`);
    }
  }

  if (sqlTags.length !== tags.size) {
    fail(
      `migration journal/SQL count mismatch: ${tags.size} entries, ${sqlTags.length} files`,
    );
  }
}

if (!process.exitCode) {
  console.log(`release inputs OK (${entries.length} migrations)`);
}
