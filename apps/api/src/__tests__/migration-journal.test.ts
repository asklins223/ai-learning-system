/**
 * 迁移 journal 一致性守护（2026-09-15 修复的回归测试）。
 *
 * 背景：迁移清单来自 `meta/_journal.json`，而不是目录里的 .sql 文件本身。
 * 手写迁移文件但忘记登记 journal → 该迁移会被 runner **静默忽略**（不报错、不提示），
 * 部署后表现为"sql 文件在仓库里但库里没变化"。0221/0222 就曾如此。
 *
 * 本测试断言三件事：
 * 1. 每个 .sql 文件都在 journal 中登记（tag 对应文件存在）；
 * 2. 每个 journal entry 都有对应文件；
 * 3. idx 从 0 连续递增（runner 按 entries 顺序执行，跳号通常意味着手工编辑出错）。
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const here = fileURLToPath(new URL(".", import.meta.url));
const migrationsDir = resolve(here, "../db/migrations");
const journalPath = resolve(migrationsDir, "meta/_journal.json");

interface Journal {
  entries: Array<{ idx: number; tag: string; when: number }>;
}

function readJournal(): Journal {
  return JSON.parse(readFileSync(journalPath, "utf8")) as Journal;
}

function sqlFiles(): string[] {
  return readdirSync(migrationsDir).filter((name) => name.endsWith(".sql")).sort();
}

describe("migration journal 一致性", () => {
  it("每个 .sql 文件都在 _journal.json 中登记（否则会被 runner 静默忽略）", () => {
    const journalTags = new Set(readJournal().entries.map((entry) => entry.tag));
    const unjournaled = sqlFiles()
      .map((name) => name.replace(/\.sql$/, ""))
      .filter((tag) => !journalTags.has(tag));
    assert.deepEqual(
      unjournaled,
      [],
      `以下迁移文件未登记进 meta/_journal.json，将永远不会被应用：${unjournaled.join(", ")}`,
    );
  });

  it("每个 journal entry 都有对应的 .sql 文件", () => {
    const files = new Set(sqlFiles().map((name) => name.replace(/\.sql$/, "")));
    const missing = readJournal().entries
      .map((entry) => entry.tag)
      .filter((tag) => !files.has(tag));
    assert.deepEqual(missing, [], `journal 中的以下条目缺少 .sql 文件：${missing.join(", ")}`);
  });

  it("idx 从 0 连续递增", () => {
    const idxList = readJournal().entries.map((entry) => entry.idx);
    const expected = idxList.map((_, index) => index);
    assert.deepEqual(idxList, expected, "journal idx 必须从 0 连续递增（runner 按顺序执行）");
  });

  it("journal 条数等于 .sql 文件数", () => {
    assert.equal(readJournal().entries.length, sqlFiles().length);
  });
});
