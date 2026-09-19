/**
 * 0228 交互车道保留（2026-09-19 伴星回复慢排查）。
 *
 * claim 函数必须做到三件事，缺一件交互对话就仍可能排在 110s 级后台 job 后面：
 * 1. 旧签名 (integer, integer) 被删除（全仓唯一调用方同批切换）；
 * 2. 后台名额过滤存在，且交互类在过滤里全数放行；
 * 3. 排序仍是 interactive_ai 第一梯队（0044 语义），并回传 resource_class
 *    供 worker 统计在跑后台数。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const migration = readFileSync(
  new URL("../db/migrations/0228_claim_jobs_interactive_reserve.sql", import.meta.url),
  "utf8",
);

test("0228 删除旧的 (integer, integer) 签名，避免留下无调用方的重载", () => {
  assert.match(migration, /DROP FUNCTION IF EXISTS public\.ailearn_claim_jobs\(integer, integer\)/);
});

test("0228 新签名接收后台名额并回传 resource_class", () => {
  assert.match(migration, /p_background_limit integer/);
  assert.match(migration, /resource_class text\s*\)/);
  assert.match(migration, /claimed\.resource_class/);
});

test("0228 后台按名额过滤、交互类全数放行", () => {
  assert.match(
    migration,
    /WHERE ranked\.is_interactive\s+OR ranked\.class_rank <= parameters\.background_limit/,
  );
});

test("0228 保留 0044 的交互优先排序与类型兜底优先级", () => {
  assert.match(migration, /WHEN j\.resource_class = 'interactive_ai' THEN 1000/);
  assert.match(migration, /WHEN 'evaluate_validation' THEN 100/);
  assert.match(migration, /WHEN 'parse_source' THEN 70/);
  assert.match(migration, /WHEN 'generate_card' THEN 50/);
  assert.match(migration, /WHEN 'align_evidence' THEN 10/);
});

test("0228 安全合同不变：SECURITY DEFINER + 固定 search_path + worker 独占 EXECUTE", () => {
  assert.match(migration, /SECURITY DEFINER/);
  assert.match(migration, /SET search_path = pg_catalog, public/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.ailearn_claim_jobs\(integer, integer, integer\)/);
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.ailearn_claim_jobs\(integer, integer, integer\)\s+FROM ailearn_api/);
});
