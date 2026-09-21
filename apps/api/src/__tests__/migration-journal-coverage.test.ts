/**
 * 迁移清单覆盖不变量。
 *
 * 起因（2026-09-20 实测）：`0234_card_hint_pair.sql` 在磁盘上存在，但没有登记进
 * `meta/_journal.json`。`src/db/migrate.ts:34-53` 的 `readMigrationFilesLocal`
 * 以 journal entries 为**唯一清单来源**（`journal.entries.map(...)` 再去
 * `readFileSync(<tag>.sql)`），所以未登记的文件连被打开的机会都没有——迁移器报
 * "all applied"，而 `hints` 列根本不存在，最终表现为 `GET /export/workspace`
 * 对任何工作区都返回 500（drizzle schema 声明了该列，`select()` 全列时炸）。
 *
 * 这条测试不需要数据库，跑在默认 `npm test` 里，把"文件与清单必须一一对应"
 * 变成机器约束。注意它刻意不读 `MIGRATIONS_FOLDER`：CI 用该变量指向截断的
 * 基线目录，而这里要校验的是仓库里那份权威清单。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";

const MIGRATIONS_DIR = resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "../db/migrations",
);

interface JournalEntry {
  idx: number;
  when: number;
  tag: string;
  breakpoints?: boolean;
}

function readJournal(): JournalEntry[] {
  const path = resolve(MIGRATIONS_DIR, "meta", "_journal.json");
  assert.ok(existsSync(path), `找不到 journal：${path}`);
  const parsed = JSON.parse(readFileSync(path, "utf8")) as { entries: JournalEntry[] };
  return parsed.entries;
}

function readSqlFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .map((name) => basename(name, ".sql"))
    .sort();
}

function numericPrefix(tag: string): number {
  const match = /^(\d+)_/.exec(tag);
  assert.ok(match, `迁移文件名缺少 4 位数字前缀：${tag}`);
  return Number(match[1]);
}

describe("迁移清单覆盖（migrations/*.sql ↔ meta/_journal.json）", () => {
  const entries = readJournal();
  const files = readSqlFiles();
  const tags = entries.map((entry) => entry.tag);

  it("每个 .sql 文件都必须登记进 journal（未登记=永远不会被应用）", () => {
    const missing = files.filter((file) => !tags.includes(file));
    assert.deepEqual(
      missing,
      [],
      `以下迁移文件存在但未登记进 meta/_journal.json，migrate.ts 永远不会应用它们：` +
        `${missing.join(", ")}。补一条 {idx,version,when,tag,breakpoints} 条目。`,
    );
  });

  it("journal 每个条目都必须有对应的 .sql 文件（否则迁移器读文件时抛错）", () => {
    const orphan = tags.filter((tag) => !files.includes(tag));
    assert.deepEqual(
      orphan,
      [],
      `journal 引用了不存在的迁移文件：${orphan.join(", ")}。` +
        `migrate.ts 会对它们 readFileSync → ENOENT，整条迁移管线中断。`,
    );
  });

  it("idx 必须连续且从 0 开始", () => {
    entries.forEach((entry, position) => {
      assert.equal(entry.idx, position, `journal 第 ${position} 项 idx=${entry.idx}，应连续`);
    });
  });

  it("tag 不得重复", () => {
    const dupes = tags.filter((tag, i) => tags.indexOf(tag) !== i);
    assert.deepEqual(dupes, [], `journal 里 tag 重复：${[...new Set(dupes)].join(", ")}`);
  });

  it("journal 顺序必须与文件名数字前缀顺序一致（迁移器按 journal 顺序执行）", () => {
    const prefixes = entries.map((entry) => numericPrefix(entry.tag));
    const outOfOrder = prefixes
      .map((value, i) => (i > 0 && value < prefixes[i - 1] ? entries[i].tag : null))
      .filter((tag): tag is string => tag !== null);
    assert.deepEqual(
      outOfOrder,
      [],
      `以下迁移的数字前缀比前一条小，会被按错误顺序执行：${outOfOrder.join(", ")}`,
    );
  });

  it("迁移文件必须非空且用 statement-breakpoint 或单语句", () => {
    for (const tag of tags) {
      const content = readFileSync(resolve(MIGRATIONS_DIR, `${tag}.sql`), "utf8");
      const statements = content
        .split("--> statement-breakpoint")
        .map((part) => part.trim())
        .filter((part) => part.length > 0);
      assert.ok(
        statements.length >= 1,
        `迁移 ${tag}.sql 没有任何可执行语句（migrate.ts 会过滤空串后 tx.unsafe([])）`,
      );
    }
  });
});
