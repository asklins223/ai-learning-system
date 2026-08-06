/**
 * P0-2 无漂移检查：预算契约口径一致性校验（plan §9-1 / §5.0 P0-2）。
 *
 * 预算口径（2026-08-04 设计变更）：
 *   - 角色级 maxTurns / maxToolCalls 仅常量保留（DEFAULT_ROLE_BUDGETS），
 *     不再作执行检查（budget.ts 的 isRoleTurnsExhausted 恒 false、
 *     checkRoleBudget 为空实现、reserveTurn/reserveToolCall 不抛错）；
 *   - 防死循环由 run 级预算兜底：maxProviderCalls(60) / runDeadline /
 *     token 上限（createDefaultRunBudget）+ 自旋检测。
 *
 * 本脚本防两类漂移：
 *   1. 有人重新引入"角色级 maxTurns/maxToolCalls 执行上限"（回到旧口径）；
 *   2. 有人修改 run 级预算关键数值但未同步文档（plan §9-1 与 §4.1）。
 *
 * 用法：node .github/scripts/verify-budget-contract.mjs（集成在 make verify）。
 */

import { readFile } from "node:fs/promises";

const root = new URL("../..", import.meta.url).pathname;

async function read(relativePath) {
  return readFile(`${root}${relativePath}`, "utf8");
}

const failures = [];

function check(label, ok, detail = "") {
  if (!ok) failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
  else console.log(`ok — ${label}`);
}

// ─── 1. budget.ts：角色级 maxTurns/maxToolCalls 不作执行检查 ────────────
const budgetSource = await read("workers/ai-worker/src/agent/budget.ts");

check(
  "budget.ts 保留 2026-08-04 设计决策注释",
  budgetSource.includes("设计决策（2026-08-04）：不再对单个角色设置 maxTurns 执行上限"),
  "找不到设计决策注释，预算口径可能被回滚",
);
check(
  "isRoleTurnsExhausted 恒为 false（角色级 maxTurns 无执行检查）",
  /isRoleTurnsExhausted\(_role: AgentRole\): boolean \{\s*return false;\s*\}/.test(budgetSource),
  "isRoleTurnsExhausted 不再是恒 false 实现，角色级上限可能被重新启用",
);
check(
  "checkRoleBudget 为空实现（角色级 maxToolCalls 无执行检查）",
  /checkRoleBudget\(_role: AgentRole\): void \{\s*\/\/ 角色级执行上限已移除/.test(budgetSource),
  "checkRoleBudget 不再是空实现",
);

// ─── 2. contracts.ts：常量保留 + run 级兜底数值 ────────────────────────
const contractsSource = await read("packages/shared/src/card-agent-contracts.ts");

// 角色级常量：generation_supervisor 16/40（仅常量，非执行上限）
const supervisorRoleMatch = contractsSource.match(
  /\[AgentRole\.GENERATION_SUPERVISOR\]: \{ maxTurns: (\d+), maxToolCalls: (\d+), maxConcurrent: \d+ \}/,
);
check(
  "DEFAULT_ROLE_BUDGETS 保留 generation_supervisor 常量（16/40）",
  !!supervisorRoleMatch && supervisorRoleMatch[1] === "16" && supervisorRoleMatch[2] === "40",
  `实际为 maxTurns=${supervisorRoleMatch?.[1]}, maxToolCalls=${supervisorRoleMatch?.[2]}`,
);

// run 级兜底数值
check(
  "createDefaultRunBudget.maxProviderCalls = 60",
  /maxProviderCalls: 60/.test(contractsSource),
);
check(
  "createDefaultRunBudget.maxInputTokens = 2_000_000",
  /maxInputTokens: 2_000_000/.test(contractsSource),
);
check(
  "createDefaultRunBudget.maxOutputTokens = 500_000",
  /maxOutputTokens: 500_000/.test(contractsSource),
);

// ─── 3. 文档同步（plan §9-1 口径表述） ─────────────────────────────────
const planSource = await read("docs/plans/learning-card-generation-perf-quality-optimization.md");
check(
  "实施计划 §9-1 保留正确预算口径",
  planSource.includes("不对角色级 maxTurns/maxToolCalls 作执行检查")
    && planSource.includes("maxProviderCalls`(60)")
    && planSource.includes("createDefaultRunBudget"),
  "实施计划 §9-1 口径被改写或丢失",
);

if (failures.length > 0) {
  console.error("\n预算契约漂移检查失败：");
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}

console.log("\n预算契约口径一致（无漂移）");
