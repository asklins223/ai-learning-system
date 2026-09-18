/**
 * A2 契约测试（计划 §2.2 验收）：
 * 重试策略的唯一来源是 SQL 函数 ailearn_fail_job——断言 Worker 只保留
 * 用于 claim/reap 的 MAX_ATTEMPTS，并锁定 SQL 函数的返回字段。
 *
 * 如果修改了 SQL 迁移中的默认 max_attempts，必须同时更新 queue.ts 的
 * MAX_ATTEMPTS，否则此测试失败。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MAX_ATTEMPTS } from "../queue.ts";

// 读取 SQL 迁移文件内容
const migrationContent = readFileSync(
  join(
    import.meta.dirname ?? __dirname,
    "..",
    "..",
    "..",
    "..",
    "apps",
    "api",
    "src",
    "db",
    "migrations",
    "0064_ailearn_fail_job_return_record.sql",
  ),
  "utf-8",
);

test("A2 契约：TS MAX_ATTEMPTS 镜像与 SQL max_attempts 默认值一致", () => {
  // SQL: greatest(1, least(coalesce(p_max_attempts, 3), 10))
  // 默认值 3 = TS MAX_ATTEMPTS
  const sqlDefaultMatch = migrationContent.match(/coalesce\(p_max_attempts,\s*(\d+)\)/);
  assert.ok(sqlDefaultMatch, "SQL 迁移中应包含 p_max_attempts 默认值");
  const sqlDefault = parseInt(sqlDefaultMatch[1], 10);
  assert.equal(
    sqlDefault,
    MAX_ATTEMPTS,
    `SQL 默认 max_attempts=${sqlDefault} 与 TS MAX_ATTEMPTS=${MAX_ATTEMPTS} 不一致`,
  );
});

test("A2 契约：SQL 迁移包含 ailearn_fail_job 返回 is_dead 字段", () => {
  assert.ok(
    migrationContent.includes("is_dead"),
    "SQL 迁移 0064 应在 RETURNS TABLE 中包含 is_dead 字段",
  );
});

test("A2 契约：SQL 迁移包含 ailearn_fail_job 返回 scheduled_at 字段", () => {
  assert.ok(
    migrationContent.includes("scheduled_at"),
    "SQL 迁移 0064 应在 RETURNS TABLE 中包含 scheduled_at 字段",
  );
});

test("A2 契约：SQL 迁移包含回滚说明", () => {
  assert.ok(
    migrationContent.includes("回滚"),
    "SQL 迁移 0064 应包含回滚说明（恢复 0031 原始定义）",
  );
});
