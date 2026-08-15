/**
 * E17 backfill 入口脚本（ops 用）：对指定 workspace 执行旧 Session 拆 Run。
 *
 * 用法：DATABASE_URL=... WORKSPACE_ID=<uuid> node --import tsx \
 *   src/scripts/backfill-legacy-sessions.ts
 * 幂等可重复运行；输出对账报告（迁移/跳过/孤儿计数）。不设 WORKSPACE_ID 时
 * 遍历全部 workspace（谨慎）。
 */

import postgres from "postgres";
import { withWorkspaceTransaction, closeDatabase } from "../db/client.ts";
import { backfillLegacySessionsToRuns, verifyLegacyRunReconciliation } from "../modules/learning-runs/legacy-backfill.ts";

const target = process.env.WORKSPACE_ID?.trim();

const sql = postgres(
  process.env.DATABASE_URL_API ??
    process.env.DATABASE_URL ??
    "postgres://ailearn:ailearn_dev@127.0.0.1:5432/ailearn",
  { max: 2 },
);

async function runFor(workspaceId: string): Promise<void> {
  const ownerRows = await sql`SELECT DISTINCT owner_id FROM workspaces WHERE id = ${workspaceId}`;
  const userId = String(ownerRows[0]?.owner_id ?? "");
  if (!userId) {
    console.log(`workspace ${workspaceId}: skipped (no owner)`);
    return;
  }
  const report = await withWorkspaceTransaction({ workspaceId, userId }, (tx) =>
    backfillLegacySessionsToRuns(tx, workspaceId),
  );
  const reconciliation = await withWorkspaceTransaction({ workspaceId, userId }, (tx) =>
    verifyLegacyRunReconciliation(tx, workspaceId),
  );
  console.log(`workspace ${workspaceId}:`, JSON.stringify({ ...report, ...reconciliation }));
}

async function main(): Promise<void> {
  const workspaceIds = target
    ? [target]
    : (await sql`SELECT id FROM workspaces ORDER BY created_at`).map((r) => String(r.id));
  for (const workspaceId of workspaceIds) {
    await runFor(workspaceId);
  }
  await sql.end({ timeout: 2 });
  await closeDatabase();
}

main().catch((err) => {
  console.error("backfill failed:", err);
  process.exitCode = 1;
});
