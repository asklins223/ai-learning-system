import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const integrationRoots = [
  "apps/api/src/integration-tests",
  "workers/ai-worker/src/integration-tests",
];

describe("PostgreSQL integration test lifecycle", () => {
  it("closes every locally-created postgres client", () => {
    for (const integrationRoot of integrationRoots) {
      const directory = join(repositoryRoot, integrationRoot);
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;

        const path = join(directory, entry.name);
        const source = readFileSync(path, "utf8");
        const clientDeclarations = [
          ...source.matchAll(/\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*postgres\s*\(/g),
        ];

        for (const declaration of clientDeclarations) {
          const clientName = declaration[1];
          assert.match(
            source,
            new RegExp(`\\b${clientName}\\.end\\s*\\(`),
            `${relative(repositoryRoot, path)} creates ${clientName} without closing it`,
          );
        }
      }
    }
  });

  it("uses postgres.js JSON parameters instead of storing JSON strings", () => {
    for (const integrationRoot of integrationRoots) {
      const directory = join(repositoryRoot, integrationRoot);
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;

        const path = join(directory, entry.name);
        const source = readFileSync(path, "utf8");
        const lines = source.split("\n");
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (!line.includes("${JSON.stringify(")) continue;
          // `::jsonb` casts are explicit JSON storage and are safe.
          if (line.includes("::jsonb")) continue;
          // Non-SQL string building (e.g., URL query) is not a DB JSON insert.
          if (!/\b(INSERT|UPDATE|VALUES|SELECT|DELETE)\b/i.test(line)) continue;
          assert.fail(
            `${relative(repositoryRoot, path)}:${i + 1} inserts serialized JSON instead of a JSON value`,
          );
        }
      }
    }
  });
});
