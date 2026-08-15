/**
 * 方案 20 §15.7 / §17.5 / C31 — Evidence Redaction 服务（R34）。
 *
 * "合规删除采用内容清除 + 审计 tombstone，不伪造历史"（§15.7）。
 * redaction 语义（C31 redaction 侧）：
 * 1. 幂等：同 (workspace, snapshot, scope) 已 redact → 返回同 tombstone；
 * 2. 写 `evidence_redactions_v2` tombstone（redaction_revision 单调递增，
 *    tombstoneHash 确定性闭包）；
 * 3. **eligibility 前移**：`evidence_eligibility_states_v2` → status='revoked'、
 *    eligibility_epoch+1、restricted_reason/restricted_at——已绑定该证据的
 *    Objective 的 PREPARE（§16.2 fail closed）与激活（§13.1 evidence_revoked）
 *    即刻拒绝，0 canonical side effects（C31："redaction 先锁=epoch 前移且
 *    0 canonical Commit"）；
 * 4. 事件 `evidence.redacted`（审计闭包）。
 *
 * 注意：内容本体（evidence_snapshots_v2 等）物理保留（FK RESTRICT，不级联），
 * 由 TTL/内容清除流程另行处理；本服务保证"不可再被正式链路消费"。
 */

import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { withWorkspaceTransaction } from "../../db/client.ts";
import type { ApiTransaction } from "../../db/client.ts";
import { hashCanonicalV2 } from "@ailearn/shared/hash-canonical-v2";
import {
  CardGenerationV2ServiceError,
  type RunContext,
} from "./helpers.ts";

export type EvidenceRedactionScopeV2 =
  | "quote_content"
  | "extracted_text"
  | "asset"
  | "all_content";

export interface RecordEvidenceRedactionInputV2 {
  evidenceSnapshotId: string;
  scope: EvidenceRedactionScopeV2;
  reasonCode: string;
}

export interface EvidenceRedactionResultV2 {
  redactionId: string;
  evidenceSnapshotId: string;
  redactionRevision: number;
  scope: EvidenceRedactionScopeV2;
  reasonCode: string;
  tombstoneHash: string;
  eligibilityStatus: "revoked";
  eligibilityEpoch: number;
  replayed: boolean;
}

function computeTombstoneHash(input: {
  workspaceId: string;
  evidenceSnapshotId: string;
  scope: string;
  reasonCode: string;
  redactionRevision: number;
}): string {
  return hashCanonicalV2("evidence-redaction-tombstone-v1", {
    workspaceId: input.workspaceId,
    evidenceSnapshotId: input.evidenceSnapshotId,
    scope: input.scope,
    reasonCode: input.reasonCode,
    redactionRevision: input.redactionRevision,
  });
}

/** 事务内实现（供服务与测试复用）。 */
export async function recordEvidenceRedactionInTx(
  tx: ApiTransaction,
  ctx: RunContext,
  input: RecordEvidenceRedactionInputV2,
): Promise<EvidenceRedactionResultV2> {
  // 1. snapshot 必须属于该 workspace（跨租户防护）
  const snapRows = await tx.execute(sql`
    SELECT evidence_snapshot_id FROM public.evidence_snapshots_v2
    WHERE evidence_snapshot_id = ${input.evidenceSnapshotId}
      AND workspace_id = ${ctx.workspaceId}
    LIMIT 1
  `);
  if (snapRows.length === 0) {
    throw new CardGenerationV2ServiceError(
      "evidence_snapshot_not_found",
      404,
      "证据快照不存在或不属于当前 workspace",
    );
  }

  // 2. 幂等：同 (workspace, snapshot, scope) 已有 tombstone → 重放
  const existingRows = await tx.execute(sql`
    SELECT redaction_revision, tombstone_hash FROM public.evidence_redactions_v2
    WHERE workspace_id = ${ctx.workspaceId}
      AND evidence_snapshot_id = ${input.evidenceSnapshotId}
      AND scope = ${input.scope}
    ORDER BY redaction_revision DESC LIMIT 1
  `);
  if (existingRows.length > 0) {
    const row = existingRows[0] as { redaction_revision: number; tombstone_hash: string };
    const eligRows = await tx.execute(sql`
      SELECT eligibility_epoch FROM public.evidence_eligibility_states_v2
      WHERE workspace_id = ${ctx.workspaceId}
        AND evidence_snapshot_id = ${input.evidenceSnapshotId}
      LIMIT 1
    `);
    return {
      redactionId: randomUUID(),
      evidenceSnapshotId: input.evidenceSnapshotId,
      redactionRevision: Number(row.redaction_revision),
      scope: input.scope,
      reasonCode: input.reasonCode,
      tombstoneHash: String(row.tombstone_hash),
      eligibilityStatus: "revoked",
      eligibilityEpoch: Number((eligRows[0] as { eligibility_epoch: number })?.eligibility_epoch ?? 1),
      replayed: true,
    };
  }

  // 3. 写 tombstone（revision 单调递增）
  const revRows = await tx.execute(sql`
    SELECT COUNT(*)::int AS n FROM public.evidence_redactions_v2
    WHERE workspace_id = ${ctx.workspaceId} AND evidence_snapshot_id = ${input.evidenceSnapshotId}
  `);
  const redactionRevision = Number((revRows[0] as { n: number }).n ?? 0) + 1;
  const tombstoneHash = computeTombstoneHash({
    workspaceId: ctx.workspaceId,
    evidenceSnapshotId: input.evidenceSnapshotId,
    scope: input.scope,
    reasonCode: input.reasonCode,
    redactionRevision,
  });
  const redactionId = randomUUID();
  await tx.execute(sql`
    INSERT INTO public.evidence_redactions_v2
      (id, workspace_id, evidence_snapshot_id, redaction_revision, scope, reason_code, redacted_at, tombstone_hash)
    VALUES (${redactionId}, ${ctx.workspaceId}, ${input.evidenceSnapshotId},
            ${redactionRevision}, ${input.scope}, ${input.reasonCode}, now(), ${tombstoneHash})
  `);

  // 4. eligibility 前移：usable → revoked，epoch+1（fencing 在途消费）
  const eligRows = await tx.execute(sql`
    UPDATE public.evidence_eligibility_states_v2
    SET status = 'revoked',
        eligibility_epoch = eligibility_epoch + 1,
        restricted_reason = ${`redaction:${input.scope}:${input.reasonCode}`},
        restricted_at = now(),
        updated_at = now()
    WHERE workspace_id = ${ctx.workspaceId}
      AND evidence_snapshot_id = ${input.evidenceSnapshotId}
    RETURNING eligibility_epoch
  `);
  const eligibilityEpoch = eligRows.length > 0
    ? Number((eligRows[0] as { eligibility_epoch: number }).eligibility_epoch)
    : 1;

  // 审计闭包 = tombstone 行 + eligibility 变化本身（card_generation_events_v2
  // 的 run_id NOT NULL + FK 不适合承载非 run 事件；C31 两路审计由这两处构成）。

  return {
    redactionId,
    evidenceSnapshotId: input.evidenceSnapshotId,
    redactionRevision,
    scope: input.scope,
    reasonCode: input.reasonCode,
    tombstoneHash,
    eligibilityStatus: "revoked",
    eligibilityEpoch,
    replayed: false,
  };
}

/** §15.7 正式 redaction 入口（workspace 事务）。 */
export async function recordEvidenceRedactionV2(
  ctx: RunContext,
  input: RecordEvidenceRedactionInputV2,
  _idempotencyKey: string,
): Promise<EvidenceRedactionResultV2> {
  return withWorkspaceTransaction(ctx, (tx) =>
    recordEvidenceRedactionInTx(tx, ctx, input));
}
