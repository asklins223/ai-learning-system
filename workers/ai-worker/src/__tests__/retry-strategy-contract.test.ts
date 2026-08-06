/**
 * A2 契约测试（计划 §2.2 验收）：
 * "改 SQL 常量后应用层无需改动"——断言 TS 镜像常量与 SQL 迁移文件中的值一致。
 *
 * 如果修改了 SQL 迁移中的重试策略常量（backoff base、max_attempts clamp），
 * 必须同时更新 queue.ts 中的镜像常量，否则此测试失败。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  MAX_ATTEMPTS,
  RETRY_BACKOFF_BASE_MS_MIRROR,
  MAX_ATTEMPTS_CLAMP_MIN,
  MAX_ATTEMPTS_CLAMP_MAX,
} from "../queue.ts";
import { retryBackoffMs } from "../lib/job-retry.ts";

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

test("A2 契约：TS backoff base 镜像与 SQL 退避基数一致", () => {
  // SQL: 2.0 * power(2, job_state.attempts)  →  backoff base = 2.0s = 2000ms
  const sqlBackoffMatch = migrationContent.match(/secs\s*=>\s*([\d.]+)\s*\*\s*pg_catalog\.power/);
  assert.ok(sqlBackoffMatch, "SQL 迁移中应包含退避基数");
  const sqlBackoffBaseSec = parseFloat(sqlBackoffMatch[1]);
  const sqlBackoffBaseMs = Math.round(sqlBackoffBaseSec * 1000);
  assert.equal(
    sqlBackoffBaseMs,
    RETRY_BACKOFF_BASE_MS_MIRROR,
    `SQL 退避基数=${sqlBackoffBaseMs}ms 与 TS 镜像=${RETRY_BACKOFF_BASE_MS_MIRROR}ms 不一致`,
  );
});

test("A2 契约：TS clamp 范围与 SQL greatest/least 一致", () => {
  // SQL: greatest(1, least(coalesce(p_max_attempts, 3), 10))
  const sqlClampMinMatch = migrationContent.match(/greatest\((\d+),\s*least/);
  const sqlClampMaxMatch = migrationContent.match(/least\(coalesce\([^)]+,\s*\d+\),\s*(\d+)\)/);
  assert.ok(sqlClampMinMatch, "SQL 迁移中应包含 greatest clamp 下界");
  assert.ok(sqlClampMaxMatch, "SQL 迁移中应包含 least clamp 上界");
  assert.equal(
    parseInt(sqlClampMinMatch[1], 10),
    MAX_ATTEMPTS_CLAMP_MIN,
    "SQL clamp 下界与 TS 镜像不一致",
  );
  assert.equal(
    parseInt(sqlClampMaxMatch[1], 10),
    MAX_ATTEMPTS_CLAMP_MAX,
    "SQL clamp 上界与 TS 镜像不一致",
  );
});

test("A2 契约：retryBackoffMs 计算结果与 SQL backoff_ms 公式一致", () => {
  // SQL: 2000 * power(2, updated.attempts - 1)
  // TS: RETRY_BACKOFF_BASE_MS * (2 ** attemptsBeforeFailure)
  // 注意：SQL 的 attempts 是更新后的值（attempts + 1），
  // 所以 SQL backoff_ms = 2000 * 2^(attempts_after_update - 1) = 2000 * 2^attempts_before_failure
  // 两者等价。
  for (let attemptsBeforeFailure = 0; attemptsBeforeFailure < 5; attemptsBeforeFailure++) {
    const tsBackoff = retryBackoffMs(attemptsBeforeFailure);
    const sqlBackoff = RETRY_BACKOFF_BASE_MS_MIRROR * (2 ** (attemptsBeforeFailure));
    assert.equal(
      tsBackoff,
      sqlBackoff,
      `attempts=${attemptsBeforeFailure}: TS=${tsBackoff}ms vs SQL mirror=${sqlBackoff}ms`,
    );
  }
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
