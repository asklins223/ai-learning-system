/**
 * Plan 23 W2-05：Objective Origin backfill CLI（幂等、dry-run 默认）。
 *
 * 用法：
 *   tsx src/scripts/origin-backfill-cli.ts --workspace <workspaceId> --dry-run
 *   tsx src/scripts/origin-backfill-cli.ts --workspace <workspaceId> --apply
 *   tsx src/scripts/origin-backfill-cli.ts --all --dry-run
 *
 * 只升级可证明的 Note/Source lineage（§21.3，禁止猜测）；输出审计 receipt。
 */
import { withWorkspaceTransaction } from "../db/client.ts";
import {
  planObjectiveOriginBackfill,
  executeObjectiveOriginBackfill,
} from "../modules/learning-objectives/origin-migration.ts";
import { learningObjectivesV2 } from "../db/schema/card-generation-v2.ts";

const SYSTEM_USER = "00000000-0000-0000-0000-000000000000";

async function main() {
  const args = process.argv.slice(2);
  const wsArg = args.find((a) => a.startsWith("--workspace="))?.split("=")[1];
  const all = args.includes("--all");
  const dryRun = !args.includes("--apply");

  if (!wsArg && !all) {
    console.error("用法：--workspace <id> 或 --all；--apply 表示落库，默认 dry-run");
    process.exit(2);
  }

  const workspaceIds = all
    ? await withWorkspaceTransaction({ workspaceId: "00000000-0000-0000-0000-000000000000", userId: SYSTEM_USER }, async (tx) => {
        const rows = await tx
          .selectDistinct({ workspaceId: learningObjectivesV2.workspaceId })
          .from(learningObjectivesV2);
        return rows.map((r) => r.workspaceId);
      })
    : [wsArg as string];

  // --all 时的 workspace 枚举在无上下文 RLS 下不可行（superuser 可），
  // 直接列出后逐个处理。
  for (const workspaceId of workspaceIds) {
    const receipt = await withWorkspaceTransaction(
      { workspaceId, userId: SYSTEM_USER },
      async (tx) => {
        if (dryRun) {
          const plan = await planObjectiveOriginBackfill(tx, workspaceId);
          return {
            workspaceId,
            dryRun: true,
            planned: plan.items.length,
            created: 0,
            skippedExisting: 0,
            missing: plan.counts.missing,
            ambiguous: plan.counts.ambiguous,
            failed: 0,
            failedItems: [],
            detail: plan.items.map((i) => ({
              objectiveId: i.objectiveId,
              category: i.category,
              source: i.source,
              reason: i.reason,
            })),
          };
        }
        return executeObjectiveOriginBackfill(tx, workspaceId, { dryRun: false });
      },
    );
    console.log(JSON.stringify(receipt, null, 2));
  }
}

await main();
