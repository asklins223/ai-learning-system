/**
 * Orchestrator 最小接线（文档 16 §10.2/§14.3 P8 版）。
 *
 * Run 完成事件 → 确定性 Policy Engine 判定 → 通过后 durable deliver 入队
 * （kind=system_event、dedupeKey=run.completed:runId、TTL 有界）。同一事务
 * 内执行（与 Journey 推进一致：失败整体回滚由 outbox 命令重试）。
 */

import type { ApiTransaction } from "../../db/client.ts";
import { resolveAssessmentCriticConfig } from "../../lib/assessment-critic-config.ts";
import { sql } from "drizzle-orm";
import {
  evaluateDismissalFeedback,
  evaluateProactivePolicy,
  isWithinQuietHours,
} from "@ailearn/shared/companion-proactive-policy";
import { deliver } from "./delivery-service.ts";

// PERF-WN: Intl.DateTimeFormat 构造带时区数据，开销可观且每次调用都重建。
// 按 timezone 记忆化复用；时区来自账号设置（有限 IANA 集合），加容量上限
// 防不可信输入导致 Map 无界增长。
export interface ProactiveMemoryDeferInput {
  scope: { workspaceId: string; userId: string };
  runId: string;
  outcome: string;
  trustOutcome: string;
  keyPointClaim: string;
  scheduleImpact: string;
  now: Date;
  /** 22 方案 §9.7/§11.5：个性化文案延迟生成所需的记忆快照。 */
  topMemories?: string[];
}

/**
 * 事务提交后刷新延迟的 LLM 记忆候选（P8）。LLM 网络调用不持有任何 DB 连接：
 * 先生成候选，成功后在新事务里 upsert 记忆（失败静默降级，不影响确定性闭环）。
 */
export async function flushDeferredProactiveMemoryCandidates(
  defer: ProactiveMemoryDeferInput,
): Promise<void> {
  try {
    const { generateMemoryCandidates } = await import("./proactive-generator.ts");
    const { upsertMemory } = await import("./memory-service.ts");
    const { withWorkspaceTransaction } = await import("../../db/client.ts");
    const generated = await generateMemoryCandidates({
      outcome: defer.outcome,
      trustOutcome: defer.trustOutcome,
      keyPointClaim: defer.keyPointClaim,
      scheduleImpact: defer.scheduleImpact,
    });
    if (!generated) return;
    const { scope } = defer;
    // upsert 在独立事务内执行（不再持有结算事务的连接）。
    await withWorkspaceTransaction(scope, async (tx) => {
      await upsertMemory(tx, scope, {
        kind: "learning_context",
        content: generated.learningContext,
        sourceEventId: `run.completed:${defer.runId}`,
        candidate: true,
      }, defer.now);
      if (generated.interactionNote) {
        await upsertMemory(tx, scope, {
          kind: "interaction_note",
          content: generated.interactionNote,
          sourceEventId: `run.completed:${defer.runId}:note`,
          candidate: true,
        }, defer.now);
      }
    });
  } catch (err) {
    // 生成/写入失败不阻塞确定性交付（fail-open 观察性降级）。
    const { logger } = await import("../../lib/logger.ts");
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), runId: defer.runId },
      "memory candidate generation skipped",
    );
  }

  // 22 方案 §9.7/§11.5：个性化主动文案异步生成 + 2s 超时 + 回退模板。
  // delivery 已在事务内以模板文案入队；此处异步生成成功后更新 text 字段。
  // §11.5：同一提醒类型 24h 内最多个性化 1 次——通过检查最近 24h 是否已有
  // 个性化文案覆盖（payload_ref->>'text' 不等于模板文案）来控制频率。
  if (defer.topMemories && defer.topMemories.length > 0) {
    try {
      const { withWorkspaceTransaction } = await import("../../db/client.ts");
      const { sql } = await import("drizzle-orm");
      // §11.5 频率限制：检查最近 24h 是否已有个性化文案（text 被覆盖过）。
      let alreadyPersonalized = false;
      try {
        const personalizedCheck = await withWorkspaceTransaction(defer.scope, async (tx) => {
          const rows = await tx.execute<{ n: string }>(sql`
            SELECT count(*)::int AS n FROM assistant_deliveries
            WHERE workspace_id = ${defer.scope.workspaceId}
              AND user_id = ${defer.scope.userId}
              AND kind = 'system_event'
              AND created_at > now() - interval '24 hours'
              AND payload_ref->>'text' IS NOT NULL
              AND payload_ref->>'text' <> '刚才的学习已完成，要继续吗？'
          `);
          return Number((Array.isArray(rows) ? rows : [])[0]?.n ?? 0);
        });
        alreadyPersonalized = personalizedCheck > 0;
      } catch {
        // 频率检查失败不阻塞个性化生成（fail-open，最多多一次个性化文案）。
      }
      if (alreadyPersonalized) {
        // 24h 内已个性化过，跳过本次个性化，保留模板文案。
        const { logger } = await import("../../lib/logger.ts");
        logger.info(
          { runId: defer.runId },
          "personalized proactive text skipped: 24h limit reached",
        );
      } else {
        const personalizedText = await generatePersonalizedProactiveText({
          runId: defer.runId,
          topMemories: defer.topMemories,
          outcome: defer.outcome,
          keyPointClaim: defer.keyPointClaim,
        });
        if (personalizedText) {
          // 在独立事务中更新已入队 delivery 的 text 字段。
          await withWorkspaceTransaction(defer.scope, async (tx) => {
            await tx.execute(sql`
              UPDATE assistant_deliveries
              SET payload_ref = jsonb_set(
                payload_ref,
                '{text}',
                ${JSON.stringify(personalizedText)}::jsonb
              )
              WHERE workspace_id = ${defer.scope.workspaceId}
                AND user_id = ${defer.scope.userId}
                AND dedupe_key = ${`run.completed:${defer.runId}`}
            `);
          });
        }
      }
    } catch (err) {
      // 个性化文案生成失败不阻塞已入队的模板文案。
      const { logger } = await import("../../lib/logger.ts");
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), runId: defer.runId },
        "personalized proactive text generation skipped",
      );
    }
  }
}

/**
 * 22 方案 §10.3.4/§11.5：个性化主动提醒文案生成。
 *
 * 调用 LLM 生成简短、自然、不打扰的提醒文案；输入为用户记忆 + 学习上下文。
 * - 2s 超时（§11.5）；
 * - 不编造记忆中没有的事实（§10.3.4）；
 * - 生成的文案必须通过安全校验（不泄露内部 ID）；
 * - 失败/超时返回 null，由调用方回退模板文案。
 */
async function generatePersonalizedProactiveText(input: {
  runId: string;
  topMemories: string[];
  outcome: string;
  keyPointClaim: string;
}): Promise<string | null> {
  // 设计 P0-2（2026-09-15 审计）：收敛到单一解析点（见 lib/assessment-critic-config.ts）。
  // 此前 `?? DASHSCOPE_API_KEY` 在 compose 注入空串时不回退，导致个性化被静默关闭。
  const config = resolveAssessmentCriticConfig();
  if (!config) return null;
  const { url, key, model } = config;

  const memoryBlock = input.topMemories
    .slice(0, 3)
    .map((m, i) => `[记忆${i + 1}] ${m.slice(0, 200)}`)
    .join("\n");

  const prompt = [
    "根据用户记忆和当前学习上下文，生成一条简短、自然、不打扰的提醒。",
    "不要编造记忆中没有的事实。",
    "受提醒类型模板约束：学习完成的提醒。",
    "只输出提醒文案本身，不要输出其他内容。",
    "文案不超过 80 字。",
    "",
    `学习结果：${input.outcome}`,
    // Plan 23 CS-05：keyPointClaim 实际传入的是 Objective conceptLabel（不再用 legacy claim）。
    `学习目标：${input.keyPointClaim.slice(0, 200)}`,
    "",
    "用户记忆：",
    memoryBlock,
  ].join("\n");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2000);
  try {
    const { postJsonToPublicEndpoint } = await import("@ailearn/shared/public-json-http");
    const response = await postJsonToPublicEndpoint(
      url,
      {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      {
        model,
        messages: [
          { role: "system", content: "你是学习伴星的提醒文案生成器，输出简短自然的中文提醒。" },
          { role: "user", content: prompt },
        ],
        stream: false,
      },
      controller.signal,
    );
    const content = (response.body as { choices?: Array<{ message?: { content?: string } }> })
      ?.choices?.[0]?.message?.content?.trim();
    if (!content || content.length > 200) return null;
    // 安全校验：不泄露内部 ID（uuid 格式）
    if (/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(content)) return null;
    return content;
  } catch {
    return null; // 超时/网络失败回退模板文案
  } finally {
    clearTimeout(timeout);
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
): Promise<ProactiveMemoryDeferInput | null> {
  // P8 最小：读取账户真实偏好（介入强度 + 静默时段，方案 16 §10.2/§10.3）；
  // DND/offline 读取账户 presence。四组只读查询相互独立——并行发出，
  // 避免在结算路径上串行 4 个 DB 往返（PERF round-5）。
  const { userCompanionAccountState } = await import("@ailearn/shared/db-schema/companion");
  const { eq } = await import("drizzle-orm");
  const [accountRows, pageRows, shownRows, lastRows, feedbackRows] = await Promise.all([
    tx
      .select({
        presence: userCompanionAccountState.presence,
        globalEnabled: userCompanionAccountState.globalEnabled,
        interventionLevel: userCompanionAccountState.interventionLevel,
        quietHours: userCompanionAccountState.quietHours,
      })
      .from(userCompanionAccountState)
      .where(eq(userCompanionAccountState.userId, scope.userId))
      .limit(1),
    // 正式作答/处理中抑制（§6.5/§9.5/§20.2 Gate）：读最近未过期页面 context
    // （Player 在 formal_answer 期间每 10s 续租，未过期即当前状态）。
    tx.execute<{ interaction_state: string }>(sql`
      SELECT interaction_state FROM assistant_page_contexts
      WHERE workspace_id = ${scope.workspaceId} AND user_id = ${scope.userId}
        AND revoked_at IS NULL AND expires_at > now()
      ORDER BY updated_at DESC LIMIT 1
    `),
    // 频率预算（§10.2 真实执行）：24h 主动 delivery 计数。
    // dedupeKey（run.completed:<runId>）每次全新，cooldown 只看最近主动 delivery。
    tx.execute<{ n: string }>(sql`
      SELECT count(*)::int AS n FROM assistant_deliveries
      WHERE workspace_id = ${scope.workspaceId} AND user_id = ${scope.userId}
        AND kind = 'system_event'
        AND created_at > now() - interval '24 hours'
    `),
    // 最近一次展示时间。
    tx.execute<{ created_at: Date }>(sql`
      SELECT created_at FROM assistant_deliveries
      WHERE workspace_id = ${scope.workspaceId} AND user_id = ${scope.userId}
        AND kind = 'system_event'
      ORDER BY created_at DESC LIMIT 1
    `),
    // 展示反馈（念头管线切片①，2026-09-18）：最近送达过用户的 delivery 状态
    //（未读的 queued/delivered 不构成反馈）。
    tx.execute<{ state: string }>(sql`
      SELECT state FROM assistant_deliveries
      WHERE workspace_id = ${scope.workspaceId} AND user_id = ${scope.userId}
        AND kind = 'system_event'
        AND state IN ('displayed', 'acted', 'dismissed')
        AND created_at > now() - interval '24 hours'
      ORDER BY created_at DESC LIMIT 3
    `),
  ]);
  const presence = accountRows[0]?.presence as { presence?: "online" | "dnd" | "offline" } | null;
  const availability = presence?.presence ?? "online";
  if (accountRows[0] && accountRows[0].globalEnabled === false) {
    return null; // 全局关闭：不打扰。
  }
  // 静默时段（账号级；按 IANA 时区计算本地时间）：时段内抑制全部主动 cue。
  const quietHours = accountRows[0]?.quietHours;
  if (quietHours && isWithinQuietHours(quietHours, now)) {
    return null;
  }
  // 展示反馈进生成（被忽略→降权）：最近 3 条送达的主动提示里 dismiss ≥2 → 本轮沉默。
  const feedbackStates = (Array.isArray(feedbackRows) ? feedbackRows : []).map((row) => row.state);
  if (evaluateDismissalFeedback(feedbackStates).suppress) {
    return null;
  }
  const interventionLevel = accountRows[0]?.interventionLevel ?? "moderate";

  const pageState = pageRows[0]?.interaction_state;
  const formalAnswerInProgress = pageState === "formal_answer" || pageState === "processing";

  const dailyShownTotal = Number(shownRows[0]?.n ?? 0);
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
  if (!decision.allow) return null;

  // 22 方案 §9.7/§11.5：个性化主动文案。
  // 在事务内只读取记忆快照（不调 LLM，避免钉住连接）；
  // 事务提交后由 flushDeferredProactiveMemoryCandidates 异步生成文案并更新 delivery。
  let topMemories: string[] | undefined;
  if (process.env.COMPANION_PROACTIVE_PERSONALIZED_V1 === "true") {
    try {
      const memoryRows = await tx.execute<{ content: string }>(sql`
        SELECT content FROM assistant_memory_items
        WHERE workspace_id = ${scope.workspaceId}
          AND user_id = ${scope.userId}
          AND deleted_at IS NULL
          AND candidate = false
          AND archived_at IS NULL
        ORDER BY pinned DESC, importance DESC, updated_at DESC
        LIMIT 3
      `);
      topMemories = (Array.isArray(memoryRows) ? memoryRows : [])
        .map((row) => row.content)
        .filter((content) => content.length > 0);
      if (topMemories.length === 0) topMemories = undefined;
    } catch {
      topMemories = undefined; // 读取失败不阻塞，后续走模板文案。
    }
  }

  // 模板文案：作为 fallback 先入队，异步生成成功后覆盖。
  const templateText = "刚才的学习已完成，要继续吗？";
  await deliver(tx, scope, {
    assistantSessionId: null,
    kind: "system_event",
    payloadRef: {
      kind: "system_event",
      systemEventId: `run.completed:${input.runId}`,
      text: templateText,
    },
    dedupeKey: `run.completed:${input.runId}`,
    expiresAt: new Date(now.getTime() + 60 * 60 * 1000),
  }, now);

  // P8 模型生成接线：LLM 网络调用不能在结算事务内执行（会钉住连接）。这里
  // 只返回延后所需的输入，由调用方在事务提交后调 flushDeferredProactiveMemoryCandidates。
  if (!input.keyPointClaim && !topMemories) return null;
  return {
    scope,
    runId: input.runId,
    outcome: input.outcome ?? "unknown",
    trustOutcome: input.trustOutcome ?? "unknown",
    keyPointClaim: input.keyPointClaim ?? "",
    scheduleImpact: input.scheduleImpact ?? "none",
    now,
    topMemories,
  };
}
