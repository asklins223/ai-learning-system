import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const migration = readFileSync(
  new URL("../db/migrations/0218_companion_agent_reasoning_handles.sql", import.meta.url),
  "utf8",
);
const journal = readFileSync(
  new URL("../db/migrations/meta/_journal.json", import.meta.url),
  "utf8",
);

test("0218 is journaled and adds reasoning handles to the Agent tool-call ledger", () => {
  assert.match(journal, /"idx": 218/);
  assert.match(journal, /"tag": "0218_companion_agent_reasoning_handles"/);
  assert.match(
    migration,
    /ALTER TABLE public\.companion_agent_tool_calls\s+ADD COLUMN IF NOT EXISTS reasoning_handles jsonb/,
  );
});

test("0218 is idempotent and keeps the column nullable for pre-existing rows", () => {
  // 幂等：重复执行不得报错（IF NOT EXISTS + DROP CONSTRAINT IF EXISTS）。
  assert.match(migration, /ADD COLUMN IF NOT EXISTS reasoning_handles jsonb;/);
  assert.match(migration, /DROP CONSTRAINT IF EXISTS companion_agent_tool_calls_reasoning_handles_check/);
  // 可空是刻意的：0218 之前创建的待确认提案没有句柄，调用方必须能区分
  // 「无句柄」与「空数组」，因此不能 NOT NULL / DEFAULT '[]'。
  assert.doesNotMatch(migration, /reasoning_handles jsonb[^;]*NOT NULL/);
  assert.doesNotMatch(migration, /reasoning_handles jsonb[^;]*DEFAULT/);
});

test("0218 constrains the column to an array so the read path can trust the shape", () => {
  assert.match(
    migration,
    /CHECK \(reasoning_handles IS NULL OR jsonb_typeof\(reasoning_handles\) = 'array'\)/,
  );
});

test("0218 documents the plaintext-thinking privacy boundary on the column", () => {
  assert.match(migration, /COMMENT ON COLUMN public\.companion_agent_tool_calls\.reasoning_handles/);
  assert.match(migration, /明文/);
});
