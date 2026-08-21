/**
 * 无漂移检查：Learning Agent 预算契约口径一致性校验。
 *
 * packages/db 与旧 Generation Supervisor budget.ts 已在重构中删除；当前
 * 可执行的预算实现位于 workers/ai-worker/src/learning-agent/budget.ts，
 * 因此门禁只校验仍存在且被运行时使用的 Learning 预算边界。
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

// ─── 当前 Learning Agent 预算边界 ──────────────────────────────────────
const budgetSource = await read("workers/ai-worker/src/learning-agent/budget.ts");

check("Learning Session Supervisor turns = 8", /maxSessionSupervisorTurns: 8/.test(budgetSource));
check("trusted 内容性动态 follow-up = 0", /trustedContentFollowUp: 0/.test(budgetSource));
check(
  "每条路线 Encounter 范围为 2..5",
  /routeEncounterMin: 2/.test(budgetSource) && /routeEncounterMax: 5/.test(budgetSource),
);
check("单次 Agent turn deadline = 120s", /turnDeadlineMs: 120_000/.test(budgetSource));
check(
  "Session Supervisor turn cap is enforced",
  /role === "session_supervisor"/.test(budgetSource)
    && /maxSessionSupervisorTurns/.test(budgetSource)
    && /LearningBudgetExhaustedError/.test(budgetSource),
);

if (failures.length > 0) {
  console.error("\n预算契约漂移检查失败：");
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}

console.log("\nLearning 预算契约口径一致（无漂移）");
