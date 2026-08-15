// 清理指定 star_map E2E Run（含级联表），使幂等键槽位回到 clean state。
// 用法：node cleanup-e2e-run.mjs <runId>   （从 apps/api 目录运行）
import postgres from "postgres";

const runId = process.argv[2];
if (!runId) {
  console.error("usage: node cleanup-e2e-run.mjs <runId>");
  process.exit(1);
}
const sql = postgres(process.env.DATABASE_URL_API ?? "postgres://ailearn:ailearn_dev@127.0.0.1:5432/ailearn", { max: 2 });

const run = await sql`SELECT id, workspace_id, user_id FROM learning_runs WHERE id = ${runId}`;
if (run.length === 0) {
  console.error("run not found");
  process.exit(1);
}
const { workspace_id: workspaceId, user_id: userId } = run[0];

// 候选表 + 其 run 外键列（只处理确实存在的列）。
const candidates = [
  "understanding_change_sets", "canonical_learning_event_outbox", "practice_trail_event_outbox",
  "learning_run_processing_outbox", "learning_assessments", "learning_artifacts",
  "learning_task_private_solutions", "learning_task_safety_reports", "learning_task_disclosure_profiles",
  "learning_task_variants", "learning_tasks", "learning_run_private_contracts", "learning_run_events",
  "learning_run_action_ledger", "learning_run_idempotency",
];
const withRunId = [];
for (const table of candidates) {
  const cols = await sql`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = ${table} AND column_name = 'run_id'
  `;
  if (cols.length > 0) withRunId.push(table);
}
console.log("tables with run_id:", withRunId.join(", "));

await sql.begin(async (tx) => {
  await tx`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
  await tx`SELECT set_config('app.user_id', ${userId}, true)`;
  for (const table of withRunId) {
    await tx`DELETE FROM ${tx(table)} WHERE run_id = ${runId}`;
  }
  await tx`DELETE FROM learning_runs WHERE id = ${runId}`;
});
console.log("cleaned", runId);
await sql.end();
