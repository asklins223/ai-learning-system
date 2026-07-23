import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const migration = readFileSync(
  new URL("../db/migrations/0039_sec01_policy_catalog_repair.sql", import.meta.url),
  "utf8",
);
const journal = JSON.parse(readFileSync(
  new URL("../db/migrations/meta/_journal.json", import.meta.url),
  "utf8",
)) as {
  entries: Array<{
    idx: number;
    tag: string;
    breakpoints: boolean;
  }>;
};

const TARGET_TABLES = [
  "workspaces",
  "workspace_members",
  "invite_codes",
  "sources",
  "source_segments",
  "notes",
  "note_versions",
  "note_blocks",
  "learning_cards",
  "card_key_points",
  "evidences",
  "validation_questions",
  "search_documents",
  "ai_artifacts",
  "ai_audit_log",
  "benchmark_reports",
  "benchmark_labels",
  "evidence_overrides",
  "validation_events",
  "review_schedules",
  "understanding_events",
  "jobs",
  "review_attempts",
  "onboarding_states",
] as const;

function quotedValues(body: string): string[] {
  return [...body.matchAll(/'([^']+)'/g)].map((match) => match[1]);
}

function withoutLineComments(sql: string): string {
  return sql.replaceAll(/^\s*--.*$/gm, "");
}

test("0039 repairs only the explicit public SEC-01/SEC-02 policy catalog", () => {
  const targetManifest = migration.match(
    /target_tables constant text\[\] := ARRAY\[(?<body>[\s\S]*?)\];/,
  );
  assert.ok(targetManifest?.groups?.body, "0039 must declare its target-table manifest");
  assert.deepEqual(
    quotedValues(targetManifest.groups.body).sort(),
    [...TARGET_TABLES].sort(),
  );

  const policyManifest = migration.match(
    /expected_policy_keys constant text\[\] := ARRAY\[(?<body>[\s\S]*?)\];/,
  );
  assert.ok(policyManifest?.groups?.body, "0039 must declare its exact policy manifest");
  const policyKeys = quotedValues(policyManifest.groups.body);
  assert.equal(policyKeys.length, 66);
  assert.equal(new Set(policyKeys).size, 66);
  assert.equal(policyKeys.filter((key) => key.endsWith("_guard")).length, 36);
  assert.equal(policyKeys.filter((key) => !key.endsWith("_guard")).length, 30);
  assert.ok(policyKeys.every((key) => (
    TARGET_TABLES.includes(key.slice(0, key.indexOf(".")) as typeof TARGET_TABLES[number])
  )));

  const executableSql = withoutLineComments(migration);
  assert.doesNotMatch(
    executableSql,
    /\bFROM\s+(?:pg_catalog\.)?pg_policy\b/i,
    "policy DDL must not be catalog-driven",
  );
  assert.doesNotMatch(executableSql, /\bpolname\s+LIKE\b/i);
  assert.doesNotMatch(executableSql, /\bpolpermissive\s*=\s*false\b/i);
  assert.doesNotMatch(executableSql, /\bON\s+%s\b/i);

  const policyDdlStatements = [
    ...executableSql.matchAll(
      /\b(?:DROP\s+POLICY\s+IF\s+EXISTS|CREATE\s+POLICY)\b[\s\S]*?(?=;)/gi,
    ),
  ].map((match) => match[0]);
  assert.ok(policyDdlStatements.length > 0);
  for (const statement of policyDdlStatements) {
    assert.match(
      statement,
      /\bON\s+public\.(?:"[a-z_]+"|%I)/i,
      `unscoped policy DDL: ${statement}`,
    );
  }

  assert.doesNotMatch(
    executableSql,
    /\b(?:ENABLE|DISABLE|FORCE|NO\s+FORCE)\s+ROW\s+LEVEL\s+SECURITY\b/i,
    "0039 must remain expansion-only",
  );
  assert.match(executableSql, /guard_count <> 36 OR admission_count <> 30/);
  assert.match(executableSql, /policy\.roles IS DISTINCT FROM ARRAY\['public'\]::name\[\]/);
});

test("Drizzle journal applies the expansion-only catalog repair after 0038", () => {
  assert.deepEqual(journal.entries.at(-1), {
    idx: 39,
    version: "7",
    when: 1786338200000,
    tag: "0039_sec01_policy_catalog_repair",
    breakpoints: true,
  });
});
