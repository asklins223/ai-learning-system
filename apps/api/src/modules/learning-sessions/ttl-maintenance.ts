/**
 * Learning Companion TTL 维护（0076/0081/0083 注释承诺的清理落地）。
 *
 * 0076：companion_audit / companion_invitation_ledger 30 天 TTL，到期替换为
 * content-free tombstone（bounded_reason/opaque ids/lease/permit 清空，保留
 * 预算键与终态，tombstoned_at 标记）——不直接 DELETE，审计/预算语义保留。
 * 0081：learning_session_processing_outbox 已处理历史行（processed_at 非空）超期删除。
 * 0083：learning_tutor_action_nonces 过期（expires_at < now - 保留期）删除。
 * 0104：companion_stream_events 终态事件超期删除（事件表不得无限增长）；
 * companion_voice_artifacts pending 超期转 expired（§7.5）。
 *
 * 四张表均 RLS ENABLE+FORCE（workspace_id+user_id 隔离），API 连接
 * （ailearn_api，NOBYPASSRLS）裸查询会被策略拦成 0 行；因此清理统一经
 * 0098 迁移建立的 SECURITY DEFINER 函数执行（migrator owner BYPASSRLS，
 * API 仅 EXECUTE）。由 server.ts 启动定时调用（与 purgeSoftDeletedNotes
 * 同模式：启动先跑一次，之后每 6 小时；每类分批限流避免长事务）。
 */

import { sql } from "drizzle-orm";
import { db } from "../../db/client.ts";
import { logger } from "../../lib/logger.ts";

const AUDIT_TTL_DAYS = 30;
const LEDGER_TTL_DAYS = 30;
const OUTBOX_PROCESSED_TTL_DAYS = 30;
const NONCE_TTL_DAYS = 7;
const BATCH_LIMIT = 200;

export interface LearningTtlMaintenanceResult {
  auditedRows: number;
  ledgerRows: number;
  outboxRows: number;
  nonceRows: number;
  streamEventRows: number;
  expiredVoiceArtifactRows: number;
}

/** 解析 SECURITY DEFINER 函数返回的 count（postgres-js rows 数组）。 */
function parseCount(rows: unknown, fallback = 0): number {
  const first = (rows as Array<Record<string, unknown>> | null)?.[0];
  const value = first?.purged ?? first?.count;
  if (typeof value === "number") return value;
  if (typeof value === "string") return Number(value);
  return fallback;
}

/** companion_audit：超期行替换为 content-free tombstone（不删除行本身）。 */
export async function purgeExpiredCompanionAudit(
  retentionDays = AUDIT_TTL_DAYS,
  limit = BATCH_LIMIT,
): Promise<number> {
  const rows = await db.execute(sql`
    SELECT public.ailearn_purge_companion_audit_ttl(
      ${retentionDays}, ${limit}
    ) AS purged
  `);
  return parseCount(rows);
}

/** companion_invitation_ledger：超期行替换为预算 tombstone（保留预算键与终态）。 */
export async function purgeExpiredInvitationLedger(
  retentionDays = LEDGER_TTL_DAYS,
  limit = BATCH_LIMIT,
): Promise<number> {
  const rows = await db.execute(sql`
    SELECT public.ailearn_purge_invitation_ledger_ttl(
      ${retentionDays}, ${limit}
    ) AS purged
  `);
  return parseCount(rows);
}

/** learning_session_processing_outbox：已处理历史行超期删除。 */
export async function purgeProcessedOutboxRows(
  retentionDays = OUTBOX_PROCESSED_TTL_DAYS,
  limit = BATCH_LIMIT,
): Promise<number> {
  const rows = await db.execute(sql`
    SELECT public.ailearn_purge_processed_outbox_ttl(
      ${retentionDays}, ${limit}
    ) AS purged
  `);
  return parseCount(rows);
}

/** learning_tutor_action_nonces：过期/已消费且超保留期删除。 */
export async function purgeExpiredTutorNonces(
  retentionDays = NONCE_TTL_DAYS,
  limit = BATCH_LIMIT,
): Promise<number> {
  const rows = await db.execute(sql`
    SELECT public.ailearn_purge_tutor_nonces_ttl(
      ${retentionDays}, ${limit}
    ) AS purged
  `);
  return parseCount(rows);
}

/** companion_stream_events：终态事件超期删除（0104 §7.4，分批限流）。 */
export async function purgeExpiredCompanionStreamEvents(
  limit = 500,
): Promise<number> {
  const rows = await db.execute(sql`
    SELECT public.ailearn_purge_companion_stream_events_ttl(${limit}) AS purged
  `);
  return parseCount(rows);
}

/** companion_voice_artifacts：pending 超期转 expired（0104 §7.5）。 */
export async function expirePendingVoiceArtifacts(): Promise<number> {
  const rows = await db.execute(sql`
    SELECT public.ailearn_expire_pending_voice_artifacts() AS purged
  `);
  return parseCount(rows);
}

async function runTtlJob(name: string, job: () => Promise<number>): Promise<number> {
  try {
    return await job();
  } catch (error) {
    // One missing/failed migration must not prevent unrelated TTL classes
    // from being maintained. The next scheduled run retries this class, while
    // the error remains observable in structured logs.
    logger.error({ ttlJob: name, err: error }, "companion TTL job failed");
    return 0;
  }
}

/** 汇总入口：一次运行完成全部清理（每类独立分批，互不影响）。 */
export async function runLearningTtlMaintenance(): Promise<LearningTtlMaintenanceResult> {
  const [auditedRows, ledgerRows, outboxRows, nonceRows, streamEventRows, expiredVoiceArtifactRows] = await Promise.all([
    runTtlJob("companion_audit", purgeExpiredCompanionAudit),
    runTtlJob("invitation_ledger", purgeExpiredInvitationLedger),
    runTtlJob("processing_outbox", purgeProcessedOutboxRows),
    runTtlJob("tutor_nonces", purgeExpiredTutorNonces),
    runTtlJob("companion_stream_events", purgeExpiredCompanionStreamEvents),
    runTtlJob("companion_voice_artifacts", expirePendingVoiceArtifacts),
  ]);
  return { auditedRows, ledgerRows, outboxRows, nonceRows, streamEventRows, expiredVoiceArtifactRows };
}
