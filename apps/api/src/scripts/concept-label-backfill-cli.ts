/**
 * Plan 23 W1-05：concept_label backfill CLI（幂等、dry-run 默认）。
 *
 * 用法：
 *   tsx src/scripts/concept-label-backfill-cli.ts --workspace <workspaceId>            # dry-run
 *   tsx src/scripts/concept-label-backfill-cli.ts --workspace <workspaceId> --apply
 *   tsx src/scripts/concept-label-backfill-cli.ts --all --dry-run
 *
 * 背景：生成合同此前缺 conceptLabel，learning_objective_revisions_v2.concept_label
 * 恒为 NULL，前端"标题=摘要"。生成端修复后，存量行用确定性派生规则
 * （concept-label.ts）回填：只处理 concept_label IS NULL 的行，天然幂等。
 * 派生只基于公开字段（objective_statement/public_summary），不触碰 private payload。
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import { withWorkspaceTransaction, type ApiTransaction } from "../db/client.ts";
import { learningObjectiveRevisionsV2 } from "../db/schema/card-generation-v2.ts";
import { deriveConceptLabel } from "../modules/card-generation-v2/concept-label.ts";

const SYSTEM_USER = "00000000-0000-0000-0000-000000000000";

interface BackfillItem {
  objectiveId: string;
  objectiveRevisionId: string;
  revision: number;
  derivedLabel: string;
}

async function planBackfill(tx: ApiTransaction): Promise<BackfillItem[]> {
  const rows = await tx
    .select({
      objectiveId: learningObjectiveRevisionsV2.objectiveId,
      objectiveRevisionId: learningObjectiveRevisionsV2.objectiveRevisionId,
      revision: learningObjectiveRevisionsV2.revision,
      objectiveStatement: learningObjectiveRevisionsV2.objectiveStatement,
      publicSummary: learningObjectiveRevisionsV2.publicSummary,
    })
    .from(learningObjectiveRevisionsV2)
    .where(isNull(learningObjectiveRevisionsV2.conceptLabel));

  return rows.map((r) => ({
    objectiveId: r.objectiveId,
    objectiveRevisionId: r.objectiveRevisionId,
    revision: r.revision,
    derivedLabel: deriveConceptLabel({
      objectiveStatement: r.objectiveStatement,
      publicSummary: r.publicSummary,
    }),
  }));
}

async function main() {
  const args = process.argv.slice(2);
  const wsArg = args.find((a) => a.startsWith("--workspace="))?.split("=")[1];
  const all = args.includes("--all");
  const apply = args.includes("--apply");

  if (!wsArg && !all) {
    console.error("用法：--workspace <id> 或 --all；--apply 表示落库，默认 dry-run");
    process.exit(2);
  }

  const workspaceIds = all
    ? await withWorkspaceTransaction(
        { workspaceId: "00000000-0000-0000-0000-000000000000", userId: SYSTEM_USER },
        async (tx) => {
          const rows = await tx
            .selectDistinct({ workspaceId: learningObjectiveRevisionsV2.workspaceId })
            .from(learningObjectiveRevisionsV2)
            .where(isNull(learningObjectiveRevisionsV2.conceptLabel));
          return rows.map((r) => r.workspaceId);
        },
      )
    : [wsArg as string];

  let totalUpdated = 0;
  for (const workspaceId of workspaceIds) {
    const receipt = await withWorkspaceTransaction(
      { workspaceId, userId: SYSTEM_USER },
      async (tx) => {
        const items = await planBackfill(tx);
        const derivable = items.filter((i) => i.derivedLabel.length >= 4);
        let updated = 0;
        if (apply) {
          if (derivable.length > 0) {
            // revision 行受不可变触发器保护（append-only）；回填是运维一次性补写，
            // 需要表属主权限临时禁用触发器，完成后立即恢复。
            await tx.execute(sql`ALTER TABLE learning_objective_revisions_v2 DISABLE TRIGGER lo_v2_rev_no_update`);
          }
          try {
            for (const item of derivable) {
              const result = await tx
                .update(learningObjectiveRevisionsV2)
                .set({ conceptLabel: item.derivedLabel })
                .where(and(
                  eq(learningObjectiveRevisionsV2.objectiveRevisionId, item.objectiveRevisionId),
                  eq(learningObjectiveRevisionsV2.workspaceId, workspaceId),
                  isNull(learningObjectiveRevisionsV2.conceptLabel),
                ))
                .returning({ id: learningObjectiveRevisionsV2.id });
              updated += result.length;
            }
          } finally {
            if (derivable.length > 0) {
              await tx.execute(sql`ALTER TABLE learning_objective_revisions_v2 ENABLE TRIGGER lo_v2_rev_no_update`);
            }
          }
        }
        return {
          workspaceId,
          dryRun: !apply,
          scanned: items.length,
          derivable: derivable.length,
          updated,
          undecipherable: items
            .filter((i) => i.derivedLabel.length < 4)
            .map((i) => ({ objectiveId: i.objectiveId, revision: i.revision })),
          detail: derivable.map((i) => ({
            objectiveId: i.objectiveId,
            revision: i.revision,
            conceptLabel: i.derivedLabel,
          })),
        };
      },
    );
    totalUpdated += receipt.updated;
    console.log(JSON.stringify(receipt, null, 2));
  }
  console.log(`\n${apply ? "applied" : "dry-run"}: total updated = ${totalUpdated}`);
  // postgres.js 连接池会保持事件循环存活，CLI 必须显式退出。
  process.exit(0);
}

try {
  await main();
} catch (error) {
  console.error("backfill failed:", error);
  process.exit(1);
}
