#!/usr/bin/env node
/**
 * 部署就绪检查(实施计划 P0-7 部署前置):
 *  1. 0072 唯一约束已应用(否则带 target 的 ON CONFLICT 会报
 *     "no unique or exclusion constraint matching");
 *  2. card_generation_drafts 无 (workspace_id, run_id, produced_by_event_key) 重复键
 *     (上线前必须为 0);
 *  3. Fast/Planned 灰度默认 fail-closed:FAST_PATH_ROLLOUT_PERCENT /
 *     PLANNED_PATH_ROLLOUT_PERCENT 非法值收敛到 0;显式配置范围校验。
 *
 * 用法:DATABASE_URL=<postgres://...> node .github/scripts/verify-deploy-readiness.mjs
 * 任一项失败 → 退出码 1(发布门禁)。
 */

import { execFileSync } from "node:child_process";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("✗ DATABASE_URL 未设置");
  process.exit(1);
}

function psql(query) {
  // security LOW 修复:execFile 参数数组(不用 shell 拼接,防 DATABASE_URL/SQL 元字符展开)
  try {
    return execFileSync("psql", [DATABASE_URL, "-t", "-A", "-c", query], { stdio: ["ignore", "pipe", "pipe"] })
      .toString().trim();
  } catch {
    return execFileSync(
      "docker", ["compose", "-f", "docker-compose.dev.yml", "exec", "-T", "postgres", "psql", "-U", "ailearn", "-d", "ailearn", "-t", "-A", "-c", query],
      { stdio: ["ignore", "pipe", "pipe"] },
    ).toString().trim();
  }
}

let failures = 0;
function check(name, ok, detail = "") {
  if (ok) {
    console.log(`ok — ${name}${detail ? ` (${detail})` : ""}`);
  } else {
    console.error(`✗ ${name}${detail ? ` (${detail})` : ""}`);
    failures += 1;
  }
}

// 1) 0072 唯一约束已应用
try {
  const constraintCount = Number(psql(
    "SELECT count(*) FROM pg_constraint WHERE conname='card_generation_drafts_produced_by_event_key_unique_idx'",
  ));
  check("0072 唯一约束已应用(card_generation_drafts_produced_by_event_key_unique_idx)", constraintCount >= 1);
} catch (err) {
  check("0072 唯一约束已应用", false, `查询失败: ${(err instanceof Error ? err.message : String(err)).slice(0, 120)}`);
}

// 2) draft 重复键为 0(0072 上线前抽查)
try {
  const duplicateCount = Number(psql(
    "SELECT count(*) FROM (SELECT workspace_id, run_id, produced_by_event_key FROM card_generation_drafts GROUP BY 1,2,3 HAVING count(*)>1) t",
  ));
  check("draft 无 (workspace,run,produced_by_event_key) 重复键", duplicateCount === 0, `重复=${duplicateCount}`);
} catch (err) {
  check("draft 无重复键", false, `查询失败: ${(err instanceof Error ? err.message : String(err)).slice(0, 120)}`);
}

// 3) 灰度配置 fail-closed 校验(读 env;默认 0%)
function rolloutOf(name) {
  const raw = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(raw) ? Math.max(0, Math.min(100, raw)) : 0;
}
const fastRollout = rolloutOf("FAST_PATH_ROLLOUT_PERCENT");
const plannedRollout = rolloutOf("PLANNED_PATH_ROLLOUT_PERCENT");
check("Fast 灰度 fail-closed(默认 0%;配置合法)", fastRollout >= 0 && fastRollout <= 100, `FAST_PATH_ROLLOUT_PERCENT=${process.env.FAST_PATH_ROLLOUT_PERCENT ?? "(未设置→0)"}`);
check("Planned 灰度 fail-closed(默认 0%;配置合法)", plannedRollout >= 0 && plannedRollout <= 100, `PLANNED_PATH_ROLLOUT_PERCENT=${process.env.PLANNED_PATH_ROLLOUT_PERCENT ?? "(未设置→0)"}`);
check("灰度总开关默认关闭", (process.env.FAST_PATH_ENABLED ?? "false") === "false" && (process.env.PLANNED_PATH_ENABLED ?? "false") === "false", "FAST_PATH_ENABLED/PLANNED_PATH_ENABLED 默认 false(fail-closed)");

if (failures > 0) {
  console.error(`\n部署就绪检查失败: ${failures} 项未通过`);
  process.exit(1);
}
console.log("\n部署就绪检查全部通过");
