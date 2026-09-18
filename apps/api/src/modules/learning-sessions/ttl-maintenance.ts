/**
 * Learning Companion TTL 维护（0076/0083 注释承诺的清理落地）。
 *
 * 0076：companion_audit / companion_invitation_ledger 30 天 TTL，到期替换为
 * content-free tombstone（bounded_reason/opaque ids/lease/permit 清空，保留
 * 预算键与终态，tombstoned_at 标记）——不直接 DELETE，审计/预算语义保留。
 * 0104：companion_stream_events 终态事件超期删除（事件表不得无限增长）；
 * companion_voice_artifacts pending 超期转 expired（§7.5）。
 *
 * 相关表均 RLS ENABLE+FORCE（workspace_id+user_id 隔离），API 连接
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
const BATCH_LIMIT = 200;

// W5：ai_audit_log 无保留策略 → 追加 90 天保留清理（依赖迁移 0156）。
const AI_AUDIT_TTL_DAYS = 90;
const AI_AUDIT_BATCH = 1000;
const AI_AUDIT_MAX_BATCH_ROUNDS = 50;
// WN-4：companion_proactive_deliveries 超期行清理（依赖迁移，num 待迁移作者定）。
const PROACTIVE_BATCH = 1000;
const PROACTIVE_MAX_BATCH_ROUNDS = 20;
// W#6：companion_voice_artifacts 清理单批上限（0159 改单批，显式传参）。
const VOICE_ARTIFACT_BATCH = 200;
// 单批清理由外层循环重复调用；TS 侧 expirePendingVoiceArtifacts 也采用相同的
// 分批语义，批间提交以避免单次长事务。
// （与 purgeOldAiAuditLog/purgeExpiredProactiveDeliveries 一致的“返回 < batch 即停”
// 分批语义），每次调用独立事务。
const VOICE_ARTIFACT_MAX_BATCH_ROUNDS = 50;
// 其余单批 TTL job（companion_audit /
// invitation_ledger / companion_stream_events）
// 与 purgeOldAiAuditLog 等一致的“返回 < batch 即停”分批语义。batch 为 200/500，
// 轮次上限与 ai_audit_log 对齐（50），消除每 6h 单批排水病态慢的积压。
const GEN_BATCH_MAX_ROUNDS = 50;

export interface LearningTtlMaintenanceResult {
  auditedRows: number;
  ledgerRows: number;
  streamEventRows: number;
  expiredVoiceArtifactRows: number;
  /** W5：ai_audit_log 清理（90 天保留，分批）中被删除的行数。 */
  aiAuditLogRows: number;
  /** WN-4：companion_proactive_deliveries 超期行清理中被删除的行数。 */
  proactiveDeliveryRows: number;
}

/** 解析 SECURITY DEFINER 函数返回的 count（postgres-js rows 数组）。 */
function parseCount(rows: unknown, fallback = 0): number {
  const first = (rows as Array<Record<string, unknown>> | null)?.[0];
  const value = first?.purged ?? first?.count;
  if (typeof value === "number") return value;
  if (typeof value === "string") return Number(value);
  return fallback;
}

/**
 * 检测约定 SECURITY DEFINER 清理函数是否已由迁移创建。
 * 依赖的新函数（ai_audit_log / proactive_deliveries）可能尚未随迁移落地
 * （迁移由另一子代理编写），此处用 pg_proc 存在性检查兜底，避免在迁移应用
 * 前清理循环崩溃；函数缺失时记 warning 并跳过该类，迁移应用后自动恢复。
 */
async function functionExists(procName: string): Promise<boolean> {
  const rows = await db.execute(sql`
    SELECT 1 AS ok FROM pg_catalog.pg_proc
    WHERE proname = ${procName}
    LIMIT 1
  `);
  return rows.length > 0;
}

/**
 * 通用“返回 < batch 即停”分批循环（0159 单批函数适配，round-4 F1）。
 * 每批独立事务（DRY run 逻辑）；达到轮次上限或某批返回 < batch 时停止。
 * 与 purgeOldAiAuditLog / purgeExpiredProactiveDeliveries / etc. 的既有模式一致，
 * 消除单批 job 每 6h 只清一个 batch 的病态慢排水。
 */
async function runBatchLoop(
  batch: number,
  maxRounds: number,
  call: () => Promise<number>,
): Promise<number> {
  let total = 0;
  for (let round = 0; round < maxRounds; round++) {
    const purged = await call();
    total += purged;
    if (purged < batch) break;
  }
  return total;
}

/** companion_audit：超期行替换为 content-free tombstone（不删除行本身）。
 * F1：0159 单批函数 → 外层分批循环（返回 < limit 即停，至多半数轮），
 * 每批独立事务（函数内一次 DELETE/tombstone），消除 6h 单批病态慢排水。
 */
export async function purgeExpiredCompanionAudit(
  retentionDays = AUDIT_TTL_DAYS,
  limit = BATCH_LIMIT,
): Promise<number> {
  return runBatchLoop(limit, GEN_BATCH_MAX_ROUNDS, async () => {
    const rows = await db.execute(sql`
      SELECT public.ailearn_purge_companion_audit_ttl(
        ${retentionDays}, ${limit}
      ) AS purged
    `);
    return parseCount(rows);
  });
}

/** companion_invitation_ledger：超期行替换为预算 tombstone（保留预算键与终态）。
 * F1：同 companion_audit 补齐外层分批循环。
 */
export async function purgeExpiredInvitationLedger(
  retentionDays = LEDGER_TTL_DAYS,
  limit = BATCH_LIMIT,
): Promise<number> {
  return runBatchLoop(limit, GEN_BATCH_MAX_ROUNDS, async () => {
    const rows = await db.execute(sql`
      SELECT public.ailearn_purge_invitation_ledger_ttl(
        ${retentionDays}, ${limit}
      ) AS purged
    `);
    return parseCount(rows);
  });
}

/** companion_stream_events：终态事件超期删除（0104 §7.4，分批限流）。
 * F1：补齐外层分批循环（默认批 500）。
 */
export async function purgeExpiredCompanionStreamEvents(
  limit = 500,
): Promise<number> {
  return runBatchLoop(limit, GEN_BATCH_MAX_ROUNDS, async () => {
    const rows = await db.execute(sql`
      SELECT public.ailearn_purge_companion_stream_events_ttl(${limit}) AS purged
    `);
    return parseCount(rows);
  });
}

/** companion_voice_artifacts：pending 超期转 expired（0104 §7.5，0159 改单批）。
 * 显式传参 `p_limit`（0159 保留 DEFAULT 200 但仍显式传值更稳，避免签名缺省值被
 * 未来改动破坏，修复第三轮 W#6）；与 0156/0157 一致的 `functionExists` 兜底，
 * 函数未落地时跳过而非崩溃。
 */
export async function expirePendingVoiceArtifacts(
  limit = VOICE_ARTIFACT_BATCH,
): Promise<number> {
  if (!(await functionExists("ailearn_expire_pending_voice_artifacts"))) {
    logger.warn("ailearn_expire_pending_voice_artifacts not present — voice artifact expiry skipped");
    return 0;
  }
  let total = 0;
  for (let round = 0; round < VOICE_ARTIFACT_MAX_BATCH_ROUNDS; round++) {
    const rows = await db.execute(sql`
      SELECT public.ailearn_expire_pending_voice_artifacts(${limit}) AS purged
    `);
    const purged = parseCount(rows);
    total += purged;
    if (purged < limit) break;
  }
  return total;
}

/**
 * W5：ai_audit_log 保留策略 — 删除超过 retention 天的行（纯 append-only 审计日志
 * 不得无界增长）。分批循环直到某批返回 < batch（已清空）或达到轮次上限，避免长事务。
 *
 * 依赖迁移：`ailearn_purge_old_ai_audit_log(retention_days int, batch int)`
 * SECURITY DEFINER 函数（migrator owner BYPASSRLS，删 ai_audit_log 的
 * out-of-retention 行，返回删除行数）。函数未落地时存在性检查兜底跳过。
 */
export async function purgeOldAiAuditLog(
  retentionDays = AI_AUDIT_TTL_DAYS,
  batch = AI_AUDIT_BATCH,
): Promise<number> {
  if (!(await functionExists("ailearn_purge_old_ai_audit_log"))) {
    logger.warn("ailearn_purge_old_ai_audit_log not present — ai_audit_log retention skipped");
    return 0;
  }
  let total = 0;
  for (let round = 0; round < AI_AUDIT_MAX_BATCH_ROUNDS; round++) {
    const rows = await db.execute(sql`
      SELECT public.ailearn_purge_old_ai_audit_log(
        ${retentionDays}, ${batch}
      ) AS purged
    `);
    const deleted = parseCount(rows);
    total += deleted;
    if (deleted < batch) break;
  }
  return total;
}

/**
 * WN-4：companion_proactive_deliveries 清理 — 删除 expires_at < now() 的超期行
 * （pending/expired 等终端行目前只增不删）。分批循环避免长事务。
 *
 * 依赖迁移：`ailearn_purge_expired_proactive_deliveries(batch int)`
 * SECURITY DEFINER 函数（删除 companion_proactive_deliveries 中
 * expires_at < now() 的行，返回删除行数）。函数未落地时存在性检查兜底跳过。
 */
export async function purgeExpiredProactiveDeliveries(
  batch = PROACTIVE_BATCH,
): Promise<number> {
  if (!(await functionExists("ailearn_purge_expired_proactive_deliveries"))) {
    logger.warn("ailearn_purge_expired_proactive_deliveries not present — proactive delivery cleanup skipped");
    return 0;
  }
  let total = 0;
  for (let round = 0; round < PROACTIVE_MAX_BATCH_ROUNDS; round++) {
    const rows = await db.execute(sql`
      SELECT public.ailearn_purge_expired_proactive_deliveries(${batch}) AS purged
    `);
    const deleted = parseCount(rows);
    total += deleted;
    if (deleted < batch) break;
  }
  return total;
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
  const [
    auditedRows, ledgerRows, streamEventRows,
    expiredVoiceArtifactRows, aiAuditLogRows, proactiveDeliveryRows,
  ] = await Promise.all([
    runTtlJob("companion_audit", purgeExpiredCompanionAudit),
    runTtlJob("invitation_ledger", purgeExpiredInvitationLedger),
    runTtlJob("companion_stream_events", purgeExpiredCompanionStreamEvents),
    runTtlJob("companion_voice_artifacts", expirePendingVoiceArtifacts),
    runTtlJob("ai_audit_log", purgeOldAiAuditLog), // W5：ai_audit_log 90 天保留
    runTtlJob("proactive_deliveries", purgeExpiredProactiveDeliveries), // WN-4
  ]);
  return {
    auditedRows,
    ledgerRows,
    streamEventRows,
    expiredVoiceArtifactRows,
    aiAuditLogRows,
    proactiveDeliveryRows,
  };
}
