/**
 * Orchestrator 最小接线（文档 16 §10.2/§14.3 P8 版）。
 *
 * Run 完成事件 → 确定性 Policy Engine 判定 → 通过后 durable deliver 入队
 * （kind=system_event、dedupeKey=run.completed:runId、TTL 有界）。同一事务
 * 内执行（与 Journey 推进一致：失败整体回滚由 outbox 命令重试）。
 */

import type { ApiTransaction } from "../../db/client.ts";
import { sql } from "drizzle-orm";
import { evaluateProactivePolicy } from "./proactive-policy.ts";
import { deliver } from "./delivery-service.ts";

/**
 * 静默时段判定（方案 16 §10.2）：HH:MM（startLocal/endLocal）+ IANA 时区。
 * 时段按"本地钟面时间"比较，跨午夜（start > end）按环绕处理。
 * 时区解析失败时 fail closed 抑制（宁可少打扰，不可错打扰）。
 */
export function isWithinQuietHours(
  quietHours: { startLocal: string; endLocal: string; timezone: string },
  now: Date,
): boolean {
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: quietHours.timezone,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    const parts = formatter.formatToParts(now);
    const hour = Number(parts.find((part) => part.type === "hour")?.value ?? "0");
    const minute = Number(parts.find((part) => part.type === "minute")?.value ?? "0");
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) return false;
    const currentMinutes = hour * 60 + minute;
    const parseClock = (value: string): number | null => {
      const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
      if (!match) return null;
      const h = Number(match[1]);
      const m = Number(match[2]);
      if (h > 23 || m > 59) return null;
      return h * 60 + m;
    };
    const start = parseClock(quietHours.startLocal);
    const end = parseClock(quietHours.endLocal);
    if (start === null || end === null) return false;
    if (start === end) return true; // 全时段（如 00:00–00:00）
    if (start < end) return currentMinutes >= start && currentMinutes < end;
    // 跨午夜：current >= start 或 current < end
    return currentMinutes >= start || currentMinutes < end;
  } catch {
    return false;
  }
}

export async function hookProactiveOnRunCompleted(
  tx: ApiTransaction,
  scope: { workspaceId: string; userId: string },
  input: {
    runId: string;
    /** 模型生成记忆候选所需的结算摘要（缺省时跳过生成，确定性交付照常）。 */
    outcome?: string;
    trustOutcome?: string;
    keyPointClaim?: string;
    scheduleImpact?: string;
  },
  now: Date = new Date(),
): Promise<void> {
  // P8 最小：读取账户真实偏好（介入强度 + 静默时段，方案 16 §10.2/§10.3）；
  // DND/offline 读取账户 presence。
  const { userCompanionAccountState } = await import("../../db/schema/companion.ts");
  const { eq } = await import("drizzle-orm");
  const accountRows = await tx
    .select({
      presence: userCompanionAccountState.presence,
      globalEnabled: userCompanionAccountState.globalEnabled,
      interventionLevel: userCompanionAccountState.interventionLevel,
      quietHours: userCompanionAccountState.quietHours,
    })
    .from(userCompanionAccountState)
    .where(eq(userCompanionAccountState.userId, scope.userId))
    .limit(1);
  const presence = accountRows[0]?.presence as { presence?: "online" | "dnd" | "offline" } | null;
  const availability = presence?.presence ?? "online";
  if (accountRows[0] && accountRows[0].globalEnabled === false) {
    return; // 全局关闭：不打扰。
  }
  // 静默时段（账号级；按 IANA 时区计算本地时间）：时段内抑制全部主动 cue。
  const quietHours = accountRows[0]?.quietHours;
  if (quietHours && isWithinQuietHours(quietHours, now)) {
    return;
  }
  const interventionLevel = accountRows[0]?.interventionLevel ?? "moderate";

  // 正式作答/处理中抑制（§6.5/§9.5/§20.2 Gate）：读最近未过期页面 context
  // （Player 在 formal_answer 期间每 10s 续租，未过期即当前状态）。
  const pageRows = await tx.execute<{ interaction_state: string }>(sql`
    SELECT interaction_state FROM assistant_page_contexts
    WHERE workspace_id = ${scope.workspaceId} AND user_id = ${scope.userId}
      AND revoked_at IS NULL AND expires_at > now()
    ORDER BY updated_at DESC LIMIT 1
  `);
  const pageState = pageRows[0]?.interaction_state;
  const formalAnswerInProgress = pageState === "formal_answer" || pageState === "processing";

  // 频率预算（§10.2 真实执行）：24h 主动 delivery 计数 + 最近一次展示间隔。
  // dedupeKey（run.completed:<runId>）每次全新，cooldown 只看最近主动 delivery。
  const shownRows = await tx.execute<{ n: string }>(sql`
    SELECT count(*)::int AS n FROM assistant_deliveries
    WHERE workspace_id = ${scope.workspaceId} AND user_id = ${scope.userId}
      AND kind IN ('proactive_cue', 'system_event')
      AND created_at > now() - interval '24 hours'
  `);
  const dailyShownTotal = Number(shownRows[0]?.n ?? 0);
  const lastRows = await tx.execute<{ created_at: Date }>(sql`
    SELECT created_at FROM assistant_deliveries
    WHERE workspace_id = ${scope.workspaceId} AND user_id = ${scope.userId}
      AND kind IN ('proactive_cue', 'system_event')
    ORDER BY created_at DESC LIMIT 1
  `);
  const msSinceLastShown = lastRows[0]
    ? now.getTime() - new Date(lastRows[0].created_at).getTime()
    : null;

  const decision = evaluateProactivePolicy({
    availability,
    interventionLevel,
    formalAnswerInProgress,
    msSinceLastShown,
    // run.completed 每次新 dedupeKey：同 key 冷却不适用（dedupe 语义保留给
    // 可重复事件），频率预算由 dailyShownTotal + msSinceLastShown 承担。
    recentShownCount: 0,
    dailyShownTotal,
    expired: false,
    now: now.getTime(),
  });
  if (!decision.allow) return;

  await deliver(tx, scope, {
    assistantSessionId: null,
    kind: "system_event",
    payloadRef: { kind: "system_event", systemEventId: `run.completed:${input.runId}` },
    dedupeKey: `run.completed:${input.runId}`,
    expiresAt: new Date(now.getTime() + 60 * 60 * 1000),
  }, now);

  // P8 模型生成接线：LLM 生成分层记忆候选（失败静默降级——确定性闭环照常）。
  if (input.keyPointClaim) {
    try {
      const { generateMemoryCandidates } = await import("./proactive-generator.ts");
      const { upsertMemory } = await import("./memory-service.ts");
      const generated = await generateMemoryCandidates({
        outcome: input.outcome ?? "unknown",
        trustOutcome: input.trustOutcome ?? "unknown",
        keyPointClaim: input.keyPointClaim,
        scheduleImpact: input.scheduleImpact ?? "none",
      });
      if (generated) {
        await upsertMemory(tx, scope, {
          kind: "learning_context",
          content: generated.learningContext,
          sourceEventId: `run.completed:${input.runId}`,
          candidate: true,
        }, now);
        if (generated.interactionNote) {
          await upsertMemory(tx, scope, {
            kind: "interaction_note",
            content: generated.interactionNote,
            sourceEventId: `run.completed:${input.runId}:note`,
            candidate: true,
          }, now);
        }
      }
    } catch (err) {
      // 生成/写入失败不阻塞结算事务之外的既有确定性交付（fail-open 观察性降级）。
      const { logger } = await import("../../lib/logger.ts");
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), runId: input.runId },
        "memory candidate generation skipped",
      );
    }
  }
}
