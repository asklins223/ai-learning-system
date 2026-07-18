#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";

const requiredFiles = [
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
  ".github/scripts/verify-worker-smoke.mjs",
  "apps/api/src/db/migrations/meta/_journal.json",
];

const packageRoots = [
  "apps/api",
  "apps/web",
  "workers/ai-worker",
  "packages/db",
  "packages/shared",
];

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
