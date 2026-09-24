/**
 * LearningRun processing outbox 消费（§13.5 唯一执行主链 P2 版）。
 *
 * 在 API 进程内轮询 learning_run_processing_outbox，按命令驱动：
 * - assessment_requested：
 *   - source=deterministic_declared_unable → 确定性报告 completed →
 *     写 commit_requested（canonical_unable 路径）；
 *   - source=assessment_critic（text/voice）→ 调用真 Critic（run-critic）；
 *     全部 covered 且无提示暴露 → demonstrated → commit_requested；
 *     提示暴露 → practice_completed（0 canonical/schedule）；
 *     部分覆盖 → checkpoint(partial)；Critic 不可用/输出非法 → fail
 *     closed not_assessable（绝不猜"掌握"）。
 * - commit_requested：
 *   - 校验 phase/epoch；按 private contract 的 schedulingAuthorization
 *     消费/创建 review_schedules，发布恰好一个
 *     canonical_learning_event_outbox envelope，写 run.result 并 completed。
 *     disposition 由命令 payload 决定（unable_evidence | mastery_evidence）。
 *
 * 幂等：outbox scope key 唯一 + 命令处理前检查当前行状态（重复 tick 不重复
 * 写结果）。答案正文不进入本模块任何队列/事件 payload（Critic 输入只在本
 * 进程内存构造）。
 */

import { and, eq, gte, inArray, sql, desc } from "drizzle-orm";
import type { StructuredTaskKind } from "./run-structured.ts";
import { isDeterministicStructuredPayload } from "./run-structured.ts";
import { uncoveredFacets } from "./run-result-facets.ts";
import { db, resolveApiStatementTimeoutMs, withWorkspaceTransaction } from "../../db/client.ts";
import {
  canonicalLearningEventOutbox,
  learningAssessments,
  learningArtifacts,
  learningRunEvents,
  learningRunPrivateContracts,
  learningRunProcessingOutbox,
  learningRuns,
  learningTasks,
  learningTaskVariants,
} from "@ailearn/shared/db-schema/learning-runs";
import {
  evidenceEligibilityStatesV2,
  evidenceSnapshotsV2,
  initialValidationRemindersV2,
  learningObjectivesV2,
  learningObjectiveRevisionsV2,
} from "@ailearn/shared/db-schema/card-generation-v2";
import { noteBlocks } from "@ailearn/shared/db-schema/note";
import { reviewSchedules } from "@ailearn/shared/db-schema/evidence";
import {
  calculateDiscreteV2Schedule,
} from "@ailearn/shared";
import { backfillPresentationHistory } from "./run-service.ts";
// 方案 16 §20：run_result 埋点（尽力而为，独立小事务）。
import { insertLearningMetricEvent } from "../observability/learning-metrics.ts";
import { learningMetricEvents } from "@ailearn/shared/db-schema/learning-metrics";
import type { CanonicalLearningEventEnvelopeV1, LearningRunResultV1, LearningRunReturnTargetV1, SchedulingAuthorizationV1 } from "@ailearn/shared";
import { sha256Hex } from "@ailearn/shared/content-hash";
import {
  CriticOutputError,
  CriticUnavailableError,
  createOpenAICompatibleCritic,
  flattenAnswerUnits,
  materializeCriticEvidenceRefs,
  type CriticInput,
  type CriticTransport,
  type RubricVerdictOutput,
} from "./run-critic.ts";
import { loadFrozenTargetSnapshotV2 } from "../card-generation-v2/target-snapshot-adapter.ts";
import { insertDomainEvents } from "../card-generation-v2/helpers.ts";
import { materializeCanonicalChangeSet, materializePracticeChangeSet } from "../understanding/projection-service.ts";

/** 从严格 V2 run.origin 取目标 ID。 */
function originObjectiveId(origin: unknown): string {
  if (origin && typeof origin === "object") {
    const objectiveId = (origin as { objectiveId?: unknown }).objectiveId;
    if (typeof objectiveId === "string") return objectiveId;
  }
  return "00000000-0000-0000-0000-000000000000";
}

/** 从 outbox payload 里安全读字符串参数（payload 是 jsonb，形状不可信）。 */
function readPayloadString(payload: unknown, key: string): string {
  if (payload && typeof payload === "object") {
    const value = (payload as Record<string, unknown>)[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return "";
}

let criticTransport: CriticTransport | null = null;
function getCriticTransport(): CriticTransport {
  if (criticTransport === null) {
    criticTransport = createOpenAICompatibleCritic();
  }
  return criticTransport;
}

/**
 * 测试钩子（设计 P1-16，2026-09-15 审计）：惰性单例此前**既不能重置也不能注入**
 * ——单测只能走真实 transport（或整模块 mock，等于测 mock 路径）。传入 null 即清空
 * 单例（下次调用重新按 env 构造），传入 transport 即注入替身。
 */
export function setCriticTransportForTests(transport: CriticTransport | null): void {
  criticTransport = transport;
}

const LEASE_SECONDS = 120;

export interface ProcessingTickResult {
  processed: number;
  failed: number;
}

/**
 * 让轮询循环立刻再跑一次（2026-09-20 实走复盘 #6）。
 *
 * 打分 outbox 此前固定 10 秒一跳，用户提交后**平均要干等 5 秒**才有人开始处理，
 * 而那段时间界面上只有一行字。提交是明确的事件，没必要让轮询节奏决定用户体感：
 * 事务提交后喊一声，循环立刻跑下一轮；10 秒轮询退化成兜底（进程重启、漏喊、
 * 失败退避时仍能自愈）。
 *
 * 注册方是 `server.ts` 的循环本体——它才知道自己的定时器在哪。未注册时调用是
 * 空操作（测试与集成脚本自己驱动 tick，不需要这条路径）。
 */
let processingWaker: (() => void) | null = null;

export function setLearningRunProcessingWaker(waker: (() => void) | null): void {
  processingWaker = waker;
}

export function wakeLearningRunProcessing(): void {
  processingWaker?.();
}

export async function runLearningRunProcessingTick(
  workerId: string,
  maxCommands: number,
): Promise<ProcessingTickResult> {
  // B#1/R1（round-3 审计）：原实现一次 claim 至多 maxCommands 行、全部打同一
  // lease_expires_at（now+120s），而批内严格串行且 assessment 分支做事务外
  // Critic HTTP（数十秒）——批内靠后行很可能在轮到前租约已过期，另一实例
  // 会重领并重跑同一命令（重复计费 + 重复副作用）。0150 的 mark 带 lease CAS
  // 只防迟一拍实例的“置位覆盖”，不防重复执行。
  // 改为逐条领取（p_max=1）：每条在其处理前才被 claim，租约在处理的时点是
  // 新鲜的（120s），即使前面若干条耗时超长也不会波及后续行。claim 内部
  // FOR UPDATE SKIP LOCKED + 租约条件保证并发安全；租约过期被其它实例重领的
  // 行，本实例后续 mark/release 的 lease_owner CAS 会正确失效（no-op）。
  let processed = 0;
  let failed = 0;

  while (processed + failed < maxCommands) {
    const now = new Date();
    const claimedRows = await db.execute(sql`
      SELECT * FROM public.ailearn_claim_run_processing(
        ${workerId}, ${LEASE_SECONDS * 1000}, 1, ${now.toISOString()}
      )
    `);
    const claimed = (claimedRows as unknown) as ClaimedCommand[];
    if (claimed.length === 0) break;
    const row = claimed[0];

    try {
      await processClaimedCommand(row, workerId);
      processed += 1;
    } catch (err) {
      // 2026-08-15（§13.2 recoverable_error）：业务可恢复错误不再无限重试
      // （tick failed 循环），而是把 Run 置为 recoverable_error + failure
      // （用户可 retry_assessment/retry_commit/retry_prepare 或 end）。
      // Critic 网络失败已在事务外 fail closed（not_assessable，不走到这里）。
      failed += 1;
      // M6（2026-08-24 审查）：内部错误详情（Postgres 驱动/约束名/内部路径）
      // 只进服务端日志；事件 payload 只带稳定的 stage/code，绝不原样经 SSE
      // 推给客户端。
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[run-tick] command failed run=${row.run_id} type=${row.command_type}: ${message.slice(0, 500)}\n`);
      const stage = row.command_type === "commit_requested" ? "commit"
        : row.command_type === "assessment_requested" ? "assessment"
        : "prepare";
      const failureCode = stage === "prepare"
        ? "planner_unavailable"
        : stage === "assessment"
          ? "assessment_timeout"
          : "commit_conflict";
      const assessmentId = readPayloadString(row.payload, "assessmentId");
      const settledAt = new Date();
      try {
        await withWorkspaceTransaction(
          { workspaceId: row.workspace_id, userId: row.user_id },
          async (tx) => {
            const settle = await tx.update(learningRuns)
              .set({
                phase: "recoverable_error",
                failure: { stage, code: failureCode, retryable: true },
                revision: sql`revision + 1`,
                updatedAt: settledAt,
              })
              .where(and(
                eq(learningRuns.id, row.run_id),
                eq(learningRuns.workspaceId, row.workspace_id),
                eq(learningRuns.userId, row.user_id),
                inArray(learningRuns.phase, ["preparing", "assessing", "committing"]),
              ))
              .returning({ id: learningRuns.id });
            // H1（2026-08-24 审查）：assessment 的失败必须落到 assessment 行自身。
            // 此前只改 run.phase，assessment 停在 running（Critic 写回事务回滚时）
            // 或退回 queued（prepare 事务整体回滚时），而 retry_assessment 只认
            // status='failed' → 重试恒 409，run 永久卡在 recoverable_error。
            // 只有真正把 run 置为 recoverable_error 的那次 CAS 才收尾 assessment
            // （run 已被并发 end/结算推进时不越权改写）。
            if (assessmentId && settle.length > 0) {
              await tx.update(learningAssessments)
                .set({ status: "failed", rubricResults: [], trustClass: null, reportHash: null, updatedAt: settledAt })
                .where(and(
                  eq(learningAssessments.id, assessmentId),
                  eq(learningAssessments.runId, row.run_id),
                  inArray(learningAssessments.status, ["queued", "running"]),
                ));
            }
            // 稳定 P0-4（2026-09-15 审计）：事件只在**真正**把 run 置为
            // recoverable_error 时写。此前 appendRunEvent 无 settle.length 门控——
            // CAS 更新 0 行（run 已是 completed / 已被并发结算）时事件照写，
            // 给已完成的 run 留下脏的 recoverable_error 事件序列。
            if (settle.length > 0) {
              await appendRunEvent(tx, {
                id: row.id,
                runId: row.run_id,
                taskId: row.task_id,
                artifactId: row.artifact_id,
                workspaceId: row.workspace_id,
                userId: row.user_id,
                commandType: row.command_type,
                payload: row.payload as Record<string, unknown>,
              }, "learning_run.recoverable_error", { stage, code: failureCode }, settledAt);
            }
          },
        );
      } catch (settleErr) {
        process.stderr.write(`[run-tick] recoverable settle failed for run=${row.run_id}: ${settleErr instanceof Error ? settleErr.message : "unknown"}\n`);
      }
      // 停止该 outbox 行重试（用户 retry 动作重新入队）。
      // PERF-B8：mark 增加 lease CAS（0150），传 workerId 防租约过期后的
      // 慢一拍实例对已由他人处理的行置位。
      await db.execute(sql`
        SELECT public.ailearn_mark_run_processing_processed(${row.id}, ${workerId}, now())
      `).catch((markErr) => {
        // L9（2026-08-24 审查）：mark 失败不再静默——幂等兜底仍在（重放靠状态
        // 检查），但必须留日志，否则 outbox 行会一直可重领。
        process.stderr.write(`[run-tick] mark processed failed id=${row.id} run=${row.run_id}: ${markErr instanceof Error ? markErr.message : "unknown"}\n`);
      });
    }
  }
  return { processed, failed };
}

interface ClaimedCommand {
  id: string;
  run_id: string;
  task_id: string;
  artifact_id: string | null;
  workspace_id: string;
  user_id: string;
  command_type: string;
  payload: unknown;
  idempotency_key: string;
}

async function processClaimedCommand(row: ClaimedCommand, workerId: string): Promise<void> {
  // 直接用 claim 返回字段（RLS 下 ailearn_api 不能跨 workspace 重读 outbox 行）。
  const typed: CommandRow = {
    id: row.id,
    runId: row.run_id,
    taskId: row.task_id,
    artifactId: row.artifact_id,
    workspaceId: row.workspace_id,
    userId: row.user_id,
    commandType: row.command_type,
    payload: row.payload as Record<string, unknown>,
  };
  // 连接池纪律（2026-08-14）：Critic HTTP 调用（数十秒）绝不能在 DB 事务内
  // 执行——事务持有连接会耗尽连接池（并发评估时 SSE/队列请求 26-55s 等待
  // 甚至 500）。三阶段：事务内读+标记 → 事务外 HTTP → 事务内写。
  // 同理（2026-08-16）：P8 LLM 记忆候选生成也是网络调用，由 processCommitCommand
  // 返回延后描述，事务提交后再在新事务中刷新——不钉住结算事务连接。
  const outcome = await withWorkspaceTransaction(
    { workspaceId: row.workspace_id, userId: row.user_id },
    async (tx) => {
      if (row.command_type === "assessment_requested") {
        return {
          criticContext: await processAssessmentCommand(tx, typed),
          proactiveDefer: null,
        };
      }
      if (row.command_type === "commit_requested") {
        return {
          criticContext: null,
          proactiveDefer: await processCommitCommand(tx, typed),
        };
      }
      return { criticContext: null, proactiveDefer: null };
    },
  );
  const { criticContext, proactiveDefer } = outcome;

  if (criticContext) {
    // 事务外：真 Critic 调用（不持有任何 DB 连接）。
    process.stderr.write(`[run-tick] calling critic for assessment=${criticContext.assessmentId}\n`);
    let verdicts: RubricVerdictOutput[];
    try {
      verdicts = await getCriticTransport().assess(criticContext.input);
    } catch (err) {
      // 2026-08-15：Critic 不可用/输出非法（含 provider 网络失败）必须在
      // 事务外直接 fail closed → not_assessable（0 副作用），而不是冒泡让
      // tick 记 failed 无限重试——否则 Run 永远卡在 assessing。
      if (err instanceof CriticUnavailableError || err instanceof CriticOutputError) {
        process.stderr.write(`[run-tick] critic fail-closed for assessment=${criticContext.assessmentId}: ${err.message}\n`);
        await withWorkspaceTransaction(
          { workspaceId: row.workspace_id, userId: row.user_id },
          (tx) => failClosedNotAssessable(
            tx,
            typed,
            criticContext.assessmentId,
            new Date(),
            criticContext.runtimeEpoch,
            classifyFailClosedReason(err.message),
          ),
        );
        return;
      }
      throw err;
    }
    process.stderr.write(`[run-tick] critic verdicts=${verdicts.length} for assessment=${criticContext.assessmentId}\n`);
    await withWorkspaceTransaction(
      { workspaceId: row.workspace_id, userId: row.user_id },
      (tx) => finishCriticAssessmentWrite(tx, typed, criticContext, verdicts),
    );
    process.stderr.write(`[run-tick] critic write-back done for assessment=${criticContext.assessmentId}\n`);
  }

  // 稳定 P0-4（2026-09-15 审计）：成功 mark 此前是**裸 await**——mark 抖动会
  // 冒泡进上面 :132 的 catch-all，把一条已成功处理的命令记成 failed，并（在修复
  // 前）给已 completed 的 run 写 recoverable_error 事件。与失败路径 (:204-210)
  // 对齐：mark 失败只记日志。命令本身幂等（重放靠状态检查），租约到期后行会被
  // 重新领取，不会丢副作用。
  //
  // 设计 P1-11（2026-09-15 审计）：mark 必须**先于**下面的 P8 记忆候选生成——
  // 此前顺序相反，而上面的注释却写着"不阻塞后续标记/埋点"（代码与注释矛盾）。
  // 后果：一次挂起的个性化 LLM 调用（当时无 AbortSignal，只受 300s 共享超时约束）
  // 会让这条 outbox 行的完成被推迟最多 5 分钟/条，直接拖慢整条 tick 串行链。
  await db.execute(sql`
    SELECT public.ailearn_mark_run_processing_processed(${row.id}, ${workerId}, now())
  `).catch((markErr) => {
    process.stderr.write(`[run-tick] mark processed failed id=${row.id} run=${row.run_id}: ${markErr instanceof Error ? markErr.message : "unknown"}\n`);
  });

  // 方案 16 §20：run_result 埋点（completed + result 才记；幂等去重）。
  await recordRunOutcomeMetric({ workspaceId: row.workspace_id, userId: row.user_id }, row.run_id);

  // 事务已提交且命令已标记完成：P8 LLM 记忆候选生成（含 upsert）在独立事务执行，
  // 不持有结算事务的连接。函数内部 fail-open 静默降级（自带 try/catch），
  // 且此刻标记已落库——即便它失败/被关停打断，也只是这一次个性化候选缺失，
  // 不会让已完成的命令被重放。
  if (proactiveDefer) {
    const { flushDeferredProactiveMemoryCandidates } = await import(
      "../companion-conversation/proactive-hook.ts"
    );
    await flushDeferredProactiveMemoryCandidates(proactiveDefer);
  }
}

/**
 * §20 run_result：run 进入 completed 且有 result 时记 outcome/scheduleImpact/
 * activeSecondsUsed（funnel 末端）。独立小事务 + 幂等（同 run 只记一次）+
 * 静默容错——埋点失败绝不回滚结算。
 */
async function recordRunOutcomeMetric(
  scope: { workspaceId: string; userId: string },
  runId: string,
): Promise<void> {
  try {
    await withWorkspaceTransaction(scope, async (tx) => {
      const already = await tx
        .select({ id: learningMetricEvents.id })
        .from(learningMetricEvents)
        .where(and(
          eq(learningMetricEvents.workspaceId, scope.workspaceId),
          eq(learningMetricEvents.userId, scope.userId),
          eq(learningMetricEvents.runId, runId),
          eq(learningMetricEvents.eventType, "run_result"),
        ))
        .limit(1);
      if (already[0]) return;
      const runs = await tx
        .select()
        .from(learningRuns)
        .where(and(
          eq(learningRuns.id, runId),
          eq(learningRuns.workspaceId, scope.workspaceId),
          eq(learningRuns.userId, scope.userId),
        ))
        .limit(1);
      const run = runs[0];
      if (!run || run.phase !== "completed" || !run.result) return;
      const result = run.result as { outcome?: string; scheduleImpact?: unknown };
      await insertLearningMetricEvent(tx, scope, {
        eventType: "run_result",
        runId,
        origin: run.origin,
        goal: run.goal,
        outcome: result.outcome,
        scheduleImpact: result.scheduleImpact,
        activeSecondsUsed: run.activeSecondsUsed,
      });
    });
  } catch (error) {
    process.stderr.write(
      `[metrics] drop run_result for run=${runId} (best-effort): ${error instanceof Error ? error.message : String(error)}
`,
    );
  }
}

interface CommandRow {
  id: string;
  runId: string;
  taskId: string;
  artifactId: string | null;
  workspaceId: string;
  userId: string;
  commandType: string;
  payload: Record<string, unknown>;
}

/**
 * §12.5 的补充额度是**单槽**：id 恒为 `supplement:1`，补充任务恒占 sequence 2
 * （planFollowupTask 写死，且结算侧 H3 只按"至多两个 assessment"收敛）。所以
 * 用过一次之后绝不能再次签发——2026-09-23 实测：第二次点"继续补充证据"直接撞
 * learning_tasks_run_sequence_unique，run 侧看到的是一个裸 500。
 */
const SUPPLEMENT_FOLLOWUP_ID = "supplement:1";

/**
 * 审计 F28：`not_assessable` 的原因码，与 `packages/shared` 的
 * `LearningRunPublicV1["checkpoint"]["reasonCode"]` 同集合。
 */
type CheckpointReasonCode = "no_frozen_evidence" | "critic_unavailable" | "input_incomplete";

/** 该 run 还能不能被签发一次补充证据；已用过则返回空数组（按钮消失）。 */
async function supplementOffer(
  tx: Parameters<Parameters<typeof withWorkspaceTransaction>[1]>[0],
  runId: string,
  reasonCode?: CheckpointReasonCode,
): Promise<string[]> {
  // 审计 F28：系统侧缺冻结证据时，「继续补充证据」是一条注定再次失败的按钮——
  // 缺的是结算闸要拿来做比对的原文证据，用户再写一段话也补不上（实机：两题各
  // 39 毫秒空判，第二次连按钮都消失了）。所以这一种原因下不签发它。
  if (reasonCode === "no_frozen_evidence") return [];
  const used = await tx
    .select({ id: learningTasks.id })
    .from(learningTasks)
    .where(and(eq(learningTasks.runId, runId), gte(learningTasks.sequence, 2)))
    .limit(1);
  return used.length > 0 ? [] : [SUPPLEMENT_FOLLOWUP_ID];
}

/**
 * 审计 F28：把 `not_assessable` 的原因从自由文本收敛成可判定的码。
 *
 * 结算闸（`task rubric has no frozen evidence`）与通道故障以前都只留下一句
 * 「判不出结论」，界面因此把它们说成同一件事，并给出同一条注定无效的出路。
 * 判据按消息前缀匹配——抛错处就是这两句（`:826` 与 `commit fail-closed: …`），
 * 这里不做模糊猜测：不匹配的一律归 `input_incomplete`（也就是"这次提交本身
 * 不足以判定"），不编造系统侧原因。
 */
function classifyFailClosedReason(message: string): CheckpointReasonCode {
  if (message.startsWith("task rubric has no frozen evidence")) return "no_frozen_evidence";
  // 同一族：任务闭包漏掉必选评分点，效果与"该评分点没有证据"完全一样——
  // 用户提交多少字都补不上。
  if (message.startsWith("task closure omits required rubric")) return "no_frozen_evidence";
  if (message.startsWith("commit fail-closed:")) return "no_frozen_evidence";
  if (message.startsWith("empty answer text") || message.startsWith("task not found")) return "input_incomplete";
  return "critic_unavailable";
}

async function processAssessmentCommand(
  tx: Parameters<Parameters<typeof withWorkspaceTransaction>[1]>[0],
  command: CommandRow,
): Promise<CriticAssessmentContext | null> {
  const assessmentId = String(command.payload.assessmentId ?? "");
  if (!assessmentId) return null; // 幂等缺参：标记处理完不重试。
  const assessmentRows = await tx
    .select()
    .from(learningAssessments)
    .where(and(eq(learningAssessments.id, assessmentId), eq(learningAssessments.runId, command.runId)))
    .limit(1);
  const assessment = assessmentRows[0];
  if (!assessment) { process.stderr.write("[run-tick] no assessment row\n"); return null; }
  if (assessment.status !== "queued") { process.stderr.write(`[run-tick] assessment status=${assessment.status} (not queued)`); return null; } // 已处理（重放）。

  // deterministic_structured 虽没有事务外 HTTP，仍会读取 private solution 并写
  // assessment/run。与 end(abandonLockedEvidence) 抢同一 run 行锁，避免两者
  // 并发时用过期 phase/revision 将已经结束的 Run 覆盖成 checkpoint/completed。
  const runRows = await tx
    .select()
    .from(learningRuns)
    .where(eq(learningRuns.id, command.runId))
    .limit(1)
    .for("update");
  const run = runRows[0];
  if (!run) { process.stderr.write("[run-tick] no run row\n"); return null; }
  // end 已前移 epoch：迟到评估保留报告但无副作用。
  if (run.phase !== "assessing") { process.stderr.write(`[run-tick] run phase=${run.phase} (not assessing)`); return null; }

  const at = new Date();
  await tx.update(learningAssessments)
    .set({ status: "running", updatedAt: at })
    .where(eq(learningAssessments.id, assessmentId));

  if (assessment.source === "deterministic_declared_unable") {
    await finishDeclaredUnableAssessment(tx, command, assessmentId, run, at);
    return null;
  }

  if (assessment.source === "deterministic_structured") {
    // P4：确定性评估（private solution 对比）。读 solution 失败 fail closed。
    try {
      await finishStructuredAssessment(tx, command, assessmentId, run, at);
    } catch (err) {
      if (err instanceof CriticOutputError) {
        const reportHash = sha256Hex(`fail-closed:${assessmentId}:structured:${err.message}`);
        const reasonCode = classifyFailClosedReason(err.message);
        await tx.update(learningAssessments)
          .set({ status: "not_assessable", rubricResults: [], trustClass: null, reportHash, updatedAt: at })
          .where(eq(learningAssessments.id, assessmentId));
        await appendRunEvent(tx, command, "learning_assessment.not_assessable", { assessmentId, reasonCode }, at);
        await tx.update(learningRuns)
          .set({
            phase: "checkpoint",
            checkpoint: {
              kind: "not_assessable",
              allowedFollowupIds: await supplementOffer(tx, command.runId, reasonCode),
              reasonCode,
            },
            revision: run.revision + 1,
            updatedAt: at,
          })
          .where(eq(learningRuns.id, command.runId));
        return null;
      }
      throw err;
    }
    return null;
  }

  // assessment_critic：事务内只读输入与标记；HTTP 调用由调用方在事务外执行。
  try {
    return await prepareCriticAssessment(tx, command, assessmentId, run, at);
  } catch (err) {
    if (err instanceof CriticUnavailableError || err instanceof CriticOutputError) {
      // 与 HTTP 分支（:315）同一条 dev 可观测性：此前只有那条打日志，prepare
      // 分支静默 fail closed，于是"每题都 not_assessable"在 API 日志里读不出
      // 任何原因（2026-09-23 定位补充任务的 500 只能去翻 postgres 日志）。
      process.stderr.write(`[run-tick] critic input fail-closed for assessment=${assessmentId}: ${err.message}\n`);
      await failClosedNotAssessable(
        tx,
        command,
        assessmentId,
        at,
        undefined,
        classifyFailClosedReason(err.message),
      );
      return null;
    }
    throw err;
  }
}

/**
 * Critic 不可用/输出非法时的 fail-closed 结算：not_assessable（0 正负副作用）。
 * 供事务内（prepare 阶段）与事务外（Critic HTTP 调用失败）两处复用；
 * revision 用原子自增，避免并发 stale。
 */
async function failClosedNotAssessable(
  tx: Parameters<Parameters<typeof withWorkspaceTransaction>[1]>[0],
  command: CommandRow,
  assessmentId: string,
  at: Date = new Date(),
  expectedRuntimeEpoch?: number,
  reasonCode: CheckpointReasonCode = "critic_unavailable",
): Promise<void> {
  // Critic HTTP 在事务外完成。写回前必须与 end(abandonLockedEvidence)
  // 争夺同一 run row lock，避免迟到的失败结算把已结束 run 改回 checkpoint。
  const runRows = await tx
    .select({ phase: learningRuns.phase, runtimeEpoch: learningRuns.runtimeEpoch })
    .from(learningRuns)
    .where(eq(learningRuns.id, command.runId))
    .limit(1)
    .for("update");
  const run = runRows[0];
  if (
    !run
    || run.phase !== "assessing"
    || (expectedRuntimeEpoch !== undefined && run.runtimeEpoch !== expectedRuntimeEpoch)
  ) {
    await tx.update(learningAssessments)
      .set({ status: "failed", rubricResults: [], trustClass: null, reportHash: null, updatedAt: at })
      .where(and(
        eq(learningAssessments.id, assessmentId),
        eq(learningAssessments.status, "running"),
      ));
    return;
  }
  const reportHash = sha256Hex(`fail-closed:${assessmentId}:critic-unavailable:v1`);
  await tx.update(learningAssessments)
    .set({ status: "not_assessable", rubricResults: [], trustClass: null, reportHash, updatedAt: at })
    .where(eq(learningAssessments.id, assessmentId));
  await appendRunEvent(tx, command, "learning_assessment.not_assessable", { assessmentId, reasonCode }, at);
  await tx.update(learningRuns)
    .set({
      phase: "checkpoint",
      checkpoint: {
        kind: "not_assessable",
        allowedFollowupIds: await supplementOffer(tx, command.runId, reasonCode),
        reasonCode,
      },
      revision: sql`revision + 1`,
      updatedAt: at,
    })
    .where(eq(learningRuns.id, command.runId));
}

interface CriticAssessmentContext {
  assessmentId: string;
  at: Date;
  input: CriticInput;
  hintExposure: boolean;
  variantCeiling: string | null;
  returnTarget: unknown;
  runtimeEpoch: number;
}

/** 事务内准备 Critic 评估：读输入、提示暴露和 Variant 上限。 */
async function prepareCriticAssessment(
  tx: Parameters<Parameters<typeof withWorkspaceTransaction>[1]>[0],
  command: CommandRow,
  assessmentId: string,
  run: {
    id: string;
    revision: number;
    runtimeEpoch: number;
    eventCursor: number;
    returnTarget: unknown;
  },
  at: Date,
): Promise<CriticAssessmentContext> {
  const input = await gatherCriticInput(tx, command);
  // 提示暴露仍只能按 practice 结算，但要保留逐 rubric 的诊断反馈，不能跳过
  // Critic 而把用户的回答一律写成空结果。
  const hintExposure = await hasHintExposure(tx, command.runId);
  const variantCeiling = await readVariantCeiling(tx, command.artifactId);
  process.stderr.write(`[run-tick] prepare ok for assessment=${assessmentId}\n`);
  return {
    assessmentId,
    at,
    input,
    hintExposure,
    variantCeiling,
    returnTarget: run.returnTarget,
    runtimeEpoch: run.runtimeEpoch,
  };
}

/** 事务内写入 Critic verdicts（HTTP 已在事务外完成）。 */
async function finishCriticAssessmentWrite(
  tx: Parameters<Parameters<typeof withWorkspaceTransaction>[1]>[0],
  command: CommandRow,
  context: CriticAssessmentContext,
  verdicts: ReturnType<ReturnType<typeof createOpenAICompatibleCritic>["assess"]> extends Promise<infer T> ? T : never,
): Promise<void> {
  const {
    assessmentId,
    at,
    input,
    hintExposure: hintExposureAtPrepare,
    variantCeiling,
    returnTarget,
    runtimeEpoch,
  } = context;
  // 与 end(abandonLockedEvidence) 串行：若 end 先赢，迟到的 Critic 结果只能
  // 将 assessment 收尾为 failed，绝不重开 run 或写入 canonical commit。
  const runRows = await tx
    .select()
    .from(learningRuns)
    .where(eq(learningRuns.id, command.runId))
    .limit(1)
    .for("update");
  const runRow = runRows[0];
  if (runRow?.phase !== "assessing" || runRow.runtimeEpoch !== runtimeEpoch) {
    await tx.update(learningAssessments)
      .set({ status: "failed", rubricResults: [], trustClass: null, reportHash: null, updatedAt: at })
      .where(and(
        eq(learningAssessments.id, assessmentId),
        eq(learningAssessments.status, "running"),
      ));
    return;
  }
  // 防御性二次读取：即使未来放宽 assessing 期间的辅助动作，也不会让晚到的
  // hint 把独立作答误记为正式掌握。
  const hintExposure = hintExposureAtPrepare || await hasHintExposure(tx, command.runId);
  const allCovered = verdicts.length > 0 && verdicts.every((v) => v.verdict === "covered");

  // §7.7 上限钳制：评估结果与提交 Variant 的 templateTrustCeiling 取最小。
  // practice/diagnostic/facet ceiling 的 Variant 即使全对也绝不能达 mastery——
  // 否则 practice Run 换模态（switch_variant 到 standby）即可绕过上限。
  const ceilingOrder = ["practice_only", "diagnostic_only", "facet_eligible", "mastery_eligible"] as const;
  const evaluated = hintExposure
    ? "practice_only"
    : allCovered
      ? "mastery_eligible"
      : "facet_eligible";
  // 未知 ceiling（含 not_assessable 或脏数据）一律钳到 practice_only（fail closed）。
  const ceiling = ceilingOrder.includes(variantCeiling as (typeof ceilingOrder)[number])
    ? (variantCeiling as (typeof ceilingOrder)[number])
    : "practice_only";
  const trustClass = ceilingOrder[Math.min(
    ceilingOrder.indexOf(evaluated),
    ceilingOrder.indexOf(ceiling),
  )];

  const rubricResults = verdicts.map((v) => ({
    rubricItemId: v.rubricItemId,
    facet: input.v2?.assessedRubricUnits.find((unit) => unit.rubricUnitId === v.rubricItemId)?.facet
      ?? input.intent,
    verdict: v.verdict,
    userFacingReason: v.userFacingReason,
  }));
  const reportHash = sha256Hex(JSON.stringify({ assessmentId, verdicts, hintExposure, variantCeiling }));
  await tx.update(learningAssessments)
    .set({ status: "completed", rubricResults, trustClass, reportHash, updatedAt: at })
    .where(eq(learningAssessments.id, assessmentId));
  await appendRunEvent(tx, command, "learning_assessment.completed", { assessmentId }, at);

  if (hintExposure || !allCovered || trustClass === "practice_only" || trustClass === "diagnostic_only") {
    // 提示暴露 / 部分覆盖 / ceiling 钳制为 practice 或 diagnostic：
    // 均不进入 canonical Commit。
    if (hintExposure || trustClass === "practice_only" || trustClass === "diagnostic_only") {
      const result: LearningRunResultV1 = {
        outcome: "practice_completed",
        demonstratedFacets: [],
        // 缺口按真实判定来。此前这里无条件写 [input.intent]，于是四条 rubric 全
        // covered 的作答也会结算成「还需补上：回忆」——结算页同屏摆着四行
        // 「说清了」和一句「你欠着回忆」，用户读到的是自相矛盾（31 号文档 P1）。
        // 结构化那条分支（:1108）早就是按 verdict 来的，这里是漏改的那一条。
        // demonstratedFacets 仍留空：练习不买掌握证据，这是合同边界，不是 bug。
        gapFacets: uncoveredFacets(rubricResults) as never,
        scheduleImpact: {
          kind: "none",
          reasonCode: trustClass === "diagnostic_only" ? "diagnostic_only" : "practice_only",
        },
        returnTarget: returnTarget as LearningRunReturnTargetV1,
      };
      await tx.update(learningRuns)
        .set({ phase: "completed", result: result as never, revision: runRow.revision + 1, updatedAt: at })
        .where(eq(learningRuns.id, command.runId));
      await appendRunEvent(tx, command, "learning_run.completed", {}, at);
    // §7.8：结算回填 presentation_history（outcome/exposed，按 runId 幂等）。
    await backfillPresentationHistory(tx, { runId: command.runId, outcome: result.outcome });
      // P6 Journey：真实首轮结算事件驱动旅程推进（JourneyReducer 唯一写步进）。
      await hookJourneyOnRunCompleted(tx, command, {
        runId: command.runId,
        result: result as unknown as Record<string, unknown>,
      }, at);
      return;
    }
    await tx.update(learningRuns)
      .set({
        phase: "checkpoint",
        checkpoint: { kind: "partial", allowedFollowupIds: await supplementOffer(tx, command.runId) },
        revision: runRow.revision + 1,
        updatedAt: at,
      })
      .where(eq(learningRuns.id, command.runId));
    return;
  }

  // 全部 covered 且无 exposure → demonstrated：进入 Commit（canonical）。
  await tx.update(learningRuns)
    .set({ phase: "committing", revision: runRow.revision + 1, updatedAt: at })
    .where(eq(learningRuns.id, command.runId));
  await tx.insert(learningRunProcessingOutbox).values({
    runId: command.runId,
    taskId: command.taskId,
    artifactId: command.artifactId,
    workspaceId: command.workspaceId,
    userId: command.userId,
    commandType: "commit_requested",
    payload: { assessmentId, disposition: "mastery_evidence", runtimeEpoch: runRow.runtimeEpoch },
    idempotencyKey: `commit:${assessmentId}`,
    availableAt: at,
    createdAt: at,
    updatedAt: at,
  });
}

/** 收集 Critic 输入：答案正文 + 题面 + claim + 证据引用 + rubric 目标。 */
async function gatherCriticInput(
  tx: Parameters<Parameters<typeof withWorkspaceTransaction>[1]>[0],
  command: CommandRow,
): Promise<CriticInput> {
  // 并行读取相互独立的资源（artifact / task），缩短处理路径耗时。
  const [artifactRows, taskRows] = await Promise.all([
    tx
      .select()
      .from(learningArtifacts)
      .where(eq(learningArtifacts.id, command.artifactId ?? ""))
      .limit(1),
    tx
      .select()
      .from(learningTasks)
      .where(and(eq(learningTasks.id, command.taskId), eq(learningTasks.runId, command.runId)))
      .limit(1),
  ]);
  const artifact = artifactRows[0];
  const payload = (artifact?.payload ?? {}) as { kind?: string; text?: string; confirmedTranscript?: string };
  const answerText = payload.kind === "voice"
    ? (payload.confirmedTranscript ?? "").trim()
    : (payload.text ?? "").trim();
  if (answerText.length === 0) throw new CriticOutputError("empty answer text");

  const task = taskRows[0];
  if (!task) throw new CriticOutputError("task not found");

  const variantRows = await tx
    .select()
    .from(learningTaskVariants)
    .where(eq(learningTaskVariants.id, artifact?.variantId ?? ""))
    .limit(1);
  const variant = variantRows[0];
  const rubricTargetIds = Array.isArray(variant?.rubricTargetIds)
    ? (variant.rubricTargetIds as string[])
    : [];
  if (rubricTargetIds.length === 0) throw new CriticOutputError("no rubric targets");
  if (new Set(rubricTargetIds).size !== rubricTargetIds.length) {
    throw new CriticOutputError("duplicate rubric targets in task closure");
  }

  const snapshot = await loadFrozenTargetSnapshotV2(tx, command.workspaceId, command.runId);
  if (!snapshot) throw new CriticOutputError("V2 run missing frozen snapshot");
  const canon = snapshot.target;
  const answerUnits = flattenAnswerUnits(canon.canonicalAnswer);
  const rubricById = new Map(canon.scoringRubric.units.map((unit) => [unit.rubricUnitId, unit]));
  const assessedRubricUnits = rubricTargetIds.map((rubricTargetId) => {
    const unit = rubricById.get(rubricTargetId);
    if (!unit) throw new CriticOutputError(`task closure references unknown rubric: ${rubricTargetId}`);
    return {
      rubricUnitId: unit.rubricUnitId,
      criterion: unit.criterion,
      facet: unit.facet,
      required: unit.required,
    };
  });
  const closureTargetIds = new Set(rubricTargetIds);
  for (const requiredUnit of canon.scoringRubric.units.filter((unit) => unit.required)) {
    if (!closureTargetIds.has(requiredUnit.rubricUnitId)) {
      throw new CriticOutputError(`task closure omits required rubric: ${requiredUnit.rubricUnitId}`);
    }
  }
  const assessedEvidence = canon.evidence.filter((e) =>
    e.targetUnit.kind === "rubric" && rubricTargetIds.includes(e.targetUnit.rubricUnitId),
  );
  for (const rubricTargetId of rubricTargetIds) {
    if (!assessedEvidence.some((e) =>
      e.targetUnit.kind === "rubric" && e.targetUnit.rubricUnitId === rubricTargetId,
    )) {
      throw new CriticOutputError(`task rubric has no frozen evidence: ${rubricTargetId}`);
    }
  }
  const evidenceSnapshotIds = [...new Set(assessedEvidence.map((e) => e.evidenceSnapshotId))];
  // drizzle + postgres-js 对 UUID 数组参数存在已知序列化边界；snapshot id 来自
  // 已冻结且校验过的 binding，使用显式 uuid[] 与 target snapshot adapter 保持一致。
  const evidenceSnapshotIdsLiteral = `{${evidenceSnapshotIds.join(",")}}`;
  const evidenceRows = await tx
    .select({
      evidenceSnapshotId: evidenceSnapshotsV2.evidenceSnapshotId,
      evidenceSnapshotHash: evidenceSnapshotsV2.evidenceSnapshotHash,
      quoteHash: evidenceSnapshotsV2.quoteHash,
      blockContentHash: evidenceSnapshotsV2.blockContentHash,
      startOffset: evidenceSnapshotsV2.startOffset,
      endOffset: evidenceSnapshotsV2.endOffset,
      blockContent: noteBlocks.content,
    })
    .from(evidenceSnapshotsV2)
    .innerJoin(evidenceEligibilityStatesV2, and(
      eq(evidenceEligibilityStatesV2.workspaceId, evidenceSnapshotsV2.workspaceId),
      eq(evidenceEligibilityStatesV2.evidenceSnapshotId, evidenceSnapshotsV2.evidenceSnapshotId),
    ))
    .innerJoin(noteBlocks, and(
      eq(noteBlocks.workspaceId, evidenceSnapshotsV2.workspaceId),
      eq(noteBlocks.id, evidenceSnapshotsV2.blockId),
    ))
    .where(and(
      eq(evidenceSnapshotsV2.workspaceId, command.workspaceId),
      eq(evidenceEligibilityStatesV2.status, "usable"),
      sql`${evidenceSnapshotsV2.evidenceSnapshotId} = ANY(${evidenceSnapshotIdsLiteral}::uuid[])`,
    ));
  const evidenceRefs = materializeCriticEvidenceRefs(assessedEvidence, evidenceRows);
  return {
    taskPrompt: task.prompt,
    claim: canon.objectiveStatement,
    evidenceQuotes: evidenceRefs.map((e) => e.preview),
    answerText,
    intent: task.intent,
    rubricTargetIds,
    v2: {
      objectiveStatement: canon.objectiveStatement,
      canonicalAnswerUnits: answerUnits,
      assessedRubricUnits,
      evidenceRefs,
      taskIntent: task.intent,
      taskPrompt: task.prompt,
      interactionFamily: typeof variant?.interaction === "object" && variant.interaction && "kind" in variant.interaction
        ? String((variant.interaction as { kind: string }).kind)
        : "unknown",
      publicPayloadHash: variant?.publicPayloadHash ?? null,
      artifactText: answerText,
      semanticTargetFingerprint: canon.semanticTargetFingerprint,
      targetRevisionHash: canon.targetRevisionHash,
      snapshotHash: snapshot.snapshotHash,
      criticVersion: "critic-snapshot-v2.1",
    },
  };
}

async function hasHintExposure(
  tx: Parameters<Parameters<typeof withWorkspaceTransaction>[1]>[0],
  runId: string,
): Promise<boolean> {
  const rows = await tx
    .select({ id: learningRunEvents.id })
    .from(learningRunEvents)
    .where(and(
      eq(learningRunEvents.runId, runId),
      eq(learningRunEvents.eventType, "learning_task.hint_requested"),
    ))
    .limit(1);
  return rows.length > 0;
}

/** 提交 Artifact 的 Variant ceiling（§7.7 上限钳制的权威输入）。 */
async function readVariantCeiling(
  tx: Parameters<Parameters<typeof withWorkspaceTransaction>[1]>[0],
  artifactId: string | null,
): Promise<string | null> {
  if (!artifactId) return null;
  const artifactRows = await tx
    .select({ variantId: learningArtifacts.variantId })
    .from(learningArtifacts)
    .where(eq(learningArtifacts.id, artifactId))
    .limit(1);
  const variantId = artifactRows[0]?.variantId;
  if (!variantId) return null;
  const variantRows = await tx
    .select({ templateTrustCeiling: learningTaskVariants.templateTrustCeiling })
    .from(learningTaskVariants)
    .where(eq(learningTaskVariants.id, variantId))
    .limit(1);
  return variantRows[0]?.templateTrustCeiling ?? null;
}

// ─── P4 deterministic_structured 评估 ────────────────────────────────────

/**
 * private solutions 读取连接串（worker 角色，按设计绕过 RLS 读私解）。
 *
 * L2（2026-08-24 审查）：此前生产环境缺 env 时会静默连本地
 * postgres://…@127.0.0.1:5432（开发默认值），把结构题评估静默降级为
 * fail-closed；且回落 DATABASE_URL_API 时该角色对 private 表无 SELECT，
 * 同样只会得到 not_assessable。现在：生产环境只接受显式 env（缺失即
 * fail fast，与 db/client.ts 的 DATABASE_URL_API 纪律一致）；非生产环境
 * 保留本地默认，但回落到 API 角色时打告警。
 */
function resolveStructuredSolutionConnectionString(): string {
  const workerUrl = process.env.DATABASE_URL_WORKER?.trim();
  if (workerUrl) return workerUrl;
  const apiUrl = process.env.DATABASE_URL_API?.trim();
  if (apiUrl) {
    if (process.env.NODE_ENV === "production") {
      process.stderr.write(
        "[run-tick] DATABASE_URL_WORKER 未配置：回落 DATABASE_URL_API，该角色无 private solution SELECT 权限——结构题评估将 fail closed\n",
      );
    }
    return apiUrl;
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error("DATABASE_URL_WORKER (or DATABASE_URL_API) is required when NODE_ENV=production");
  }
  return "postgres://ailearn:ailearn_dev@127.0.0.1:5432/ailearn";
}

/** private solutions 读取连接：worker 角色（RLS 豁免）；dev fallback 用 API 连接。 */
import postgres from "postgres";
import { practiceTrailEventOutbox } from "@ailearn/shared/db-schema/learning-runs";

const structuredSolutionSql = postgres(
  resolveStructuredSolutionConnectionString(),
  {
    max: 2,
    // 空闲自动断开：tick 长驻进程中不累积连接；测试进程可在连接回收后退出。
    idle_timeout: 30,
    connect_timeout: 10,
    // 稳定 P1-2（2026-09-15 审计）：此前该池无语句超时，一条挂起的
    // private-solution 读会钉住 tick 的整条串行链（server.ts 的 tick 是
    // 单个 setTimeout 链，无总预算）。给出确定上界。
    connection: { statement_timeout: resolveApiStatementTimeoutMs() },
  },
);

/** 显式关闭 worker 只读连接（graceful shutdown / 测试 after 调用）。 */
export async function closeStructuredSolutionSql(): Promise<void> {
  await structuredSolutionSql.end({ timeout: 2 }).catch(() => {});
}

/** P4：确定性评估 → verdicts → practice 结算（0 canonical/schedule）。 */
async function finishStructuredAssessment(
  tx: Parameters<Parameters<typeof withWorkspaceTransaction>[1]>[0],
  command: CommandRow,
  assessmentId: string,
  run: { id: string; revision: number; runtimeEpoch: number; eventCursor: number },
  at: Date,
): Promise<void> {
  const artifactRows = await tx
    .select()
    .from(learningArtifacts)
    .where(eq(learningArtifacts.id, command.artifactId ?? ""))
    .limit(1);
  const artifact = artifactRows[0];
  const payload = (artifact?.payload ?? {}) as Record<string, unknown>;
  const payloadKind = payload.kind;
  /**
   * 这张表**必须**与路由共用同一个真相（`isDeterministicStructuredPayload`）。
   *
   * 2026-09-21 实机踩到：路由那一侧已经改用了共用表，这里却还留着一份**逐字枚举**，
   * 于是 choice / true_false / matching 三种客观题载荷走到这里就 fail closed →
   * `not_assessable` + `checkpoint`，界面上是一屏「等待下一步 / 正在准备下一步」，
   * 用户点完选项后彻底卡住（截图与 `learning_assessments` 双证据）。
   * 这正是复盘 §7 记过的同一个失效形状：链路看起来通了，最后一公里静默降级。
   */
  if (typeof payloadKind !== "string" || !isDeterministicStructuredPayload(payloadKind)) {
    throw new CriticOutputError("structured assessment: unsupported payload kind");
  }

  const taskRows = await tx
    .select({ intent: learningTasks.intent })
    .from(learningTasks)
    .where(and(eq(learningTasks.id, command.taskId), eq(learningTasks.runId, command.runId)))
    .limit(1);
  const task = taskRows[0];
  if (!task) throw new CriticOutputError("structured assessment: task not found");

  // private solution：worker 角色读（api 角色对该表无 SELECT，§16.1 隔离）。
  // 权限/连接类错误同样 fail closed（不重试风暴），绝不带着半读状态评估。
  let solution: Record<string, unknown> | null = null;
  try {
    const solutionRows = await structuredSolutionSql`
      SELECT s.solution
      FROM learning_task_private_solutions s
      JOIN learning_task_variants v ON v.id = s.variant_id
      WHERE v.id = ${artifact?.variantId ?? ""} AND v.workspace_id = ${command.workspaceId}
      LIMIT 1
    `;
    solution = (solutionRows[0]?.solution ?? null) as Record<string, unknown> | null;
  } catch (err) {
    throw new CriticOutputError(
      `structured assessment: solution not readable (${err instanceof Error ? err.message.slice(0, 80) : "unknown"})`,
    );
  }
  if (!solution) throw new CriticOutputError("structured assessment: solution not readable");

  const { assessStructuredPayload, assessStructuredBundlePayload } = await import("./run-structured.ts");
  // §5.3/§12.3 structured_bundle：一次 Assessment 评估整个 bundle Artifact
  // （逐 part 确定性对比，取最低 verdict；part 缺失/伪造在提交层已拒绝）。
  const assessment = payloadKind === "structured_bundle"
    ? assessStructuredBundlePayload(payload, solution)
    : assessStructuredPayload(payloadKind as StructuredTaskKind, payload, solution);

  const rubricTargetIds = Array.isArray(solution.rubricTargetIds)
    ? (solution.rubricTargetIds as string[])
    : [];
  const rubricResults = rubricTargetIds.map((rubricItemId) => ({
    rubricItemId,
    facet: task.intent,
    verdict: assessment.verdict,
    userFacingReason: assessment.userFacingReason,
  }));
  const reportHash = sha256Hex(JSON.stringify({ assessmentId, payloadKind, verdict: assessment.verdict }));
  // §7.7：ceiling 从 qualification 数据推导（V1 无记录 → practice 上限）。
  // facet_eligible 且全部 covered → facet_evidence Commit（canonical facet
  // observation + 0 schedule，§13.6）；其余 → practice 结算。
  const ceiling = await readVariantCeiling(tx, command.artifactId);
  const facetEligible = ceiling === "facet_eligible" && assessment.verdict === "covered";
  await tx.update(learningAssessments)
    .set({
      status: "completed",
      rubricResults,
      trustClass: facetEligible ? "facet_eligible" : "practice_only",
      reportHash,
      updatedAt: at,
    })
    .where(eq(learningAssessments.id, assessmentId));
  await appendRunEvent(tx, command, "learning_assessment.completed", { assessmentId }, at);

  if (facetEligible) {
    // facet_evidence Commit：canonical facet observation，0 schedule。
    const runForCommit = (await tx
    .select({ revision: learningRuns.revision, runtimeEpoch: learningRuns.runtimeEpoch })
      .from(learningRuns)
      .where(eq(learningRuns.id, command.runId))
      .limit(1))[0];
    await tx.update(learningRuns)
      .set({ phase: "committing", revision: (runForCommit?.revision ?? 0) + 1, updatedAt: at })
      .where(eq(learningRuns.id, command.runId));
    await tx.insert(learningRunProcessingOutbox).values({
      runId: command.runId,
      taskId: command.taskId,
      artifactId: command.artifactId,
      workspaceId: command.workspaceId,
      userId: command.userId,
      commandType: "commit_requested",
      payload: { assessmentId, disposition: "facet_evidence", runtimeEpoch: runForCommit?.runtimeEpoch },
      idempotencyKey: `commit:structured:facet:${assessmentId}`,
      availableAt: at,
      createdAt: at,
      updatedAt: at,
    });
    return;
  }

  // practice 结算：0 canonical / 0 schedule；发布恰好一个 practice trail event。
  // §16.2：每个无 canonical Commit 的 Run 最多一个聚合 practice event
  // （UNIQUE(run_id, scope)）；同 Run 后续 task 的轨迹并入同一事件，不新插。
  const runRow = (await tx
    .select({ origin: learningRuns.origin, returnTarget: learningRuns.returnTarget })
    .from(learningRuns)
    .where(eq(learningRuns.id, command.runId))
    .limit(1))[0];
    const keyPointId = originObjectiveId(runRow?.origin);
  const practiceEventId = `practice:${sha256Hex(`${command.runId}:structured`).slice(0, 24)}`;
  await tx.insert(practiceTrailEventOutbox).values({
    practiceEventId,
    workspaceId: command.workspaceId,
    userId: command.userId,
    runId: command.runId,
    scope: "official_user",
    event: {
      version: 1,
      practiceEventId,
      eventHash: sha256Hex(`event:${practiceEventId}`),
      workspaceId: command.workspaceId,
      userId: command.userId,
      runId: command.runId,
      taskIds: [command.taskId],
      keyPointId,
      targetFingerprint: "",
      artifactIds: command.artifactId ? [command.artifactId] : [],
      scope: "official_user",
      reasons: ["practice_task"],
      occurredAt: at.toISOString(),
      expiresAt: null,
    } as never,
    status: "pending",
    createdAt: at,
  }).onConflictDoNothing();
  // P7：practice trail 应用（同一幂等事务物化 change set；官方 scope 显式）。
  await materializePracticeChangeSet(tx, {
    workspaceId: command.workspaceId,
    userId: command.userId,
  }, {
    runId: command.runId,
    practiceEventId,
    keyPointId,
    artifactIds: command.artifactId ? [command.artifactId] : [],
    trailScope: "official_user",
  }, at);

  const result: LearningRunResultV1 = {
    outcome: "practice_completed",
    demonstratedFacets: [],
    gapFacets: assessment.verdict === "covered" ? [] : [task.intent as never],
    scheduleImpact: { kind: "none", reasonCode: "practice_only" },
    returnTarget: runRow?.returnTarget as never,
  };
  await tx.update(learningRuns)
    .set({ phase: "completed", result: result as never, revision: run.revision + 1, updatedAt: at })
    .where(eq(learningRuns.id, command.runId));
  await appendRunEvent(tx, command, "learning_run.completed", {}, at);
    // §7.8：结算回填 presentation_history（outcome/exposed，按 runId 幂等）。
    await backfillPresentationHistory(tx, { runId: command.runId, outcome: result.outcome });
  // P6 Journey：practice 结算事件（不产 schedule，旅程停在 first_schedule 等待）。
  await hookJourneyOnRunCompleted(tx, command, {
    runId: command.runId,
    result: result as unknown as Record<string, unknown>,
  }, at);
}

async function finishDeclaredUnableAssessment(
  tx: Parameters<Parameters<typeof withWorkspaceTransaction>[1]>[0],
  command: CommandRow,
  assessmentId: string,
  run: { id: string; revision: number; runtimeEpoch: number },
  at: Date,
): Promise<void> {
  // 确定性报告：确认"用户声明不会"这一事实，不对 rubric 覆盖度做生成式判断。
  const report = {
    assessmentId,
    source: "deterministic_declared_unable",
    artifactId: command.artifactId,
    reasonCode: "user_declared_unable",
    decidedAt: at.toISOString(),
  };
  const reportHash = sha256Hex(JSON.stringify(report));
  await tx.update(learningAssessments)
    .set({ status: "completed", rubricResults: [], trustClass: null, reportHash, updatedAt: at })
    .where(eq(learningAssessments.id, assessmentId));
  await appendRunEvent(tx, command, "learning_assessment.completed", { assessmentId }, at);
  // 进入 Commit（内部 outbox 驱动）。
  await tx.update(learningRuns)
    .set({ phase: "committing", revision: run.revision + 1, updatedAt: at })
    .where(eq(learningRuns.id, command.runId));
  await tx.insert(learningRunProcessingOutbox).values({
    runId: command.runId,
    taskId: command.taskId,
    artifactId: command.artifactId,
    workspaceId: command.workspaceId,
    userId: command.userId,
    commandType: "commit_requested",
    payload: { assessmentId, disposition: "unable_evidence", runtimeEpoch: run.runtimeEpoch },
    idempotencyKey: `commit:${assessmentId}`,
    availableAt: at,
    createdAt: at,
    updatedAt: at,
  });
}

/**
 * §16.7 V2 Commit epoch 复验：objective lifecycle epoch + 全部 evidence
 * eligibility epoch（按稳定 evidence id 顺序锁定）。任何 restricted/revoked
 * 或 epoch 漂移 → fail closed，不产 canonical/schedule。
 */
async function revalidateV2CommitEpochs(
  tx: Parameters<Parameters<typeof withWorkspaceTransaction>[1]>[0],
  command: CommandRow,
  contract: { workspaceId: string; expectedObjectiveLifecycleEpoch: number | null },
): Promise<void> {
  const snapshot = await loadFrozenTargetSnapshotV2(tx, contract.workspaceId, command.runId);
  if (!snapshot) throw new CriticOutputError("V2 run missing frozen snapshot during commit");

  const objRows = await tx
    .select({ lifecycle: learningObjectivesV2.lifecycle, lifecycleEpoch: learningObjectivesV2.lifecycleEpoch })
    .from(learningObjectivesV2)
    .where(and(
      eq(learningObjectivesV2.workspaceId, contract.workspaceId),
      eq(learningObjectivesV2.objectiveId, snapshot.target.objectiveId),
    ))
    .limit(1);
  const obj = objRows[0];
  if (!obj || obj.lifecycle !== "active") {
    throw new CriticOutputError("commit fail-closed: objective lifecycle no longer active");
  }
  if (contract.expectedObjectiveLifecycleEpoch !== null
      && obj.lifecycleEpoch !== contract.expectedObjectiveLifecycleEpoch) {
    throw new CriticOutputError("commit fail-closed: objective lifecycle epoch drift");
  }

  const evidence = [...snapshot.target.evidence].sort((a, b) => a.evidenceSnapshotId.localeCompare(b.evidenceSnapshotId));
  if (evidence.length === 0) return;
  // 批量锁定全部 evidence 行（一次 round-trip），按 evidenceSnapshotId 稳定排序
  // 保持锁顺序一致，避免逐条 SELECT ... FOR UPDATE 的 N 次往返与锁持有时间延长。
  const evidenceIds = evidence.map((e) => e.evidenceSnapshotId);
  const evRows = await tx
    .select({
      evidenceSnapshotId: evidenceEligibilityStatesV2.evidenceSnapshotId,
      status: evidenceEligibilityStatesV2.status,
      eligibilityEpoch: evidenceEligibilityStatesV2.eligibilityEpoch,
    })
    .from(evidenceEligibilityStatesV2)
    .where(and(
      eq(evidenceEligibilityStatesV2.workspaceId, contract.workspaceId),
      inArray(evidenceEligibilityStatesV2.evidenceSnapshotId, evidenceIds),
    ))
    .for("update")
    .orderBy(evidenceEligibilityStatesV2.evidenceSnapshotId);
  const byEvidenceId = new Map(evRows.map((r) => [r.evidenceSnapshotId, r]));
  for (const e of evidence) {
    const row = byEvidenceId.get(e.evidenceSnapshotId);
    if (!row || row.status !== "usable") {
      throw new CriticOutputError(`commit fail-closed: evidence ${e.evidenceSnapshotId} not usable`);
    }
    if (row.eligibilityEpoch !== e.expectedEvidenceEligibilityEpoch) {
      throw new CriticOutputError(`commit fail-closed: evidence ${e.evidenceSnapshotId} epoch drift`);
    }
  }
}

/**
 * Commit 门禁拒绝的统一收尾（H2，2026-08-24 审查）。
 *
 * 任何「这条 Commit 不能结算」的判定都必须把 run 从 committing 移到可恢复的
 * checkpoint(not_assessable)（用户出口：finish_without_commit / end），而不是
 * 裸 return null 让 run 永久停在 committing。CAS 绑定 phase + runtimeEpoch：
 * 并发的 end(abandonLockedEvidence) 先赢时这里安全 no-op。
 */
async function settleCommitRejection(
  tx: Parameters<Parameters<typeof withWorkspaceTransaction>[1]>[0],
  command: CommandRow,
  run: { revision: number; runtimeEpoch: number },
  reason: string,
): Promise<null> {
  const at = new Date();
  const reasonCode = classifyFailClosedReason(reason);
  await tx.update(learningRuns)
    .set({
      phase: "checkpoint",
      checkpoint: {
        kind: "not_assessable",
        allowedFollowupIds: await supplementOffer(tx, command.runId, reasonCode),
        reasonCode,
      },
      revision: run.revision + 1,
      updatedAt: at,
    })
    .where(and(
      eq(learningRuns.id, command.runId),
      eq(learningRuns.workspaceId, command.workspaceId),
      eq(learningRuns.userId, command.userId),
      eq(learningRuns.phase, "committing"),
      eq(learningRuns.runtimeEpoch, run.runtimeEpoch),
    ));
  await appendRunEvent(tx, command, "learning_commit.failed", { reason }, at);
  return null;
}

async function processCommitCommand(
  tx: Parameters<Parameters<typeof withWorkspaceTransaction>[1]>[0],
  command: CommandRow,
): Promise<import("../companion-conversation/proactive-hook.ts").ProactiveMemoryDeferInput | null> {
  // Lock the run before reading phase/epoch.  end/abandon takes the same row
  // lock, so a late commit either observes the terminal phase or wins the
  // serialization before the user's end operation; it can never write after
  // end has committed.
  const runRows = await tx
    .select()
    .from(learningRuns)
    .where(and(
      eq(learningRuns.id, command.runId),
      eq(learningRuns.workspaceId, command.workspaceId),
      eq(learningRuns.userId, command.userId),
    ))
    .limit(1)
    .for("update");
  const run = runRows[0];
  if (!run) return null;
  if (run.phase !== "committing") return null; // 已提交或已 end。
  const expectedRuntimeEpoch = command.payload.runtimeEpoch;
  // Commit payloads are produced by the current assessment/retry paths and
  // must carry the epoch they observed. Missing epoch is not a legacy case we
  // need to preserve before launch; fail closed so an untrusted/stale payload
  // can never commit against a later run incarnation.
  if (typeof expectedRuntimeEpoch !== "number" || run.runtimeEpoch !== expectedRuntimeEpoch) {
    return null;
  }

  // §16.4 防火墙：sandbox Run 无论评估结果如何都强制 sandbox_only——
  // 0 canonical envelope、0 official schedule、最多带 TTL 的 sandbox trail。
  if (run.sandboxNamespaceId) {
    await finishSandboxCommit(tx, command, run, new Date());
    return null;
  }

  const contractRows = await tx
    .select()
    .from(learningRunPrivateContracts)
    .where(and(
      eq(learningRunPrivateContracts.runId, command.runId),
      eq(learningRunPrivateContracts.workspaceId, command.workspaceId),
      eq(learningRunPrivateContracts.userId, command.userId),
    ))
    .limit(1);
  const contract = contractRows[0];
  // H2（2026-08-24 审查）：以下所有「拒绝结算」都必须留下收尾状态，绝不裸
  // return null——裸 return 会让 run 永久停在 committing（outbox 行随即被标记
  // processed，无任何后续驱动）。
  if (!contract) return settleCommitRejection(tx, command, run, "missing_contract");

  // §16.7 V2 Commit：复验同一 target 闭包（objective lifecycle epoch + 全部
  // evidence eligibility epoch）。Trusted Commit 只在该闭包仍匹配且 evidence
  // 全 usable 时才可能产 canonical / 恰一 successor。
  if (contract.snapshotHash) {
    await revalidateV2CommitEpochs(tx, command, contract);
  }

  // H3（2026-08-24 审查）：结算必须绑定「本次 Commit 的那一条 assessment」：
  // payload.assessmentId 是权威引用（全部入队点都写它），command.taskId 是
  // 同一条命令的 task 闭包。此前只按 run + status='completed' 取第一行且无
  // ORDER BY——activate_followup 产生第二个 assessment 后，结算会引用任意旧
  // assessment 的 reportHash/trustClass/rubricResults 构造 canonical envelope。
  const requestedAssessmentId = readPayloadString(command.payload, "assessmentId");
  const assessmentRows = await tx
    .select()
    .from(learningAssessments)
    .where(and(
      eq(learningAssessments.runId, command.runId),
      eq(learningAssessments.workspaceId, command.workspaceId),
      eq(learningAssessments.userId, command.userId),
      eq(learningAssessments.status, "completed"),
      eq(learningAssessments.taskId, command.taskId),
      ...(requestedAssessmentId ? [eq(learningAssessments.id, requestedAssessmentId)] : []),
    ))
    .orderBy(desc(learningAssessments.createdAt))
    .limit(1);
  const assessment = assessmentRows[0];
  if (!assessment) return settleCommitRejection(tx, command, run, "assessment_not_found");
  // 命令行的 artifact 与 assessment 的 artifact 必须一致，否则 canonical 事实
  // 会把 A 的作答与 B 的评估拼在一起（同 H3 的弱引用类别）。
  if (command.artifactId && assessment.artifactId !== command.artifactId) {
    return settleCommitRejection(tx, command, run, "artifact_assessment_mismatch");
  }

  // 按命令 disposition 分派：mastery_evidence（demonstrated）、
  // facet_evidence（partial 结算：只写允许的 facet）、unable_evidence。
  const disposition = String(command.payload.disposition ?? "unable_evidence");
  const isCanonicalEvidence = disposition === "mastery_evidence" || disposition === "facet_evidence";
  const isDemonstrated = disposition === "mastery_evidence";
  const artifactRows = command.artifactId
    ? await tx.select().from(learningArtifacts).where(and(
        eq(learningArtifacts.id, command.artifactId),
        eq(learningArtifacts.workspaceId, command.workspaceId),
      )).limit(1)
    : [];
  const artifact = artifactRows[0];
  const payload = (artifact?.payload ?? {}) as { kind?: string };
  if (isCanonicalEvidence) {
    // demonstrated 只来自 assessment_critic 且 trustClass=mastery_eligible；
    // facet_evidence 允许 mastery_eligible 或 facet_eligible（§6.4 partial）。
    if (payload.kind === "declared_unable") {
      return settleCommitRejection(tx, command, run, "artifact_kind_mismatch");
    }
    const allowedTrust = isDemonstrated
      ? ["mastery_eligible"]
      : ["mastery_eligible", "facet_eligible"];
    // H2：trustClass 门禁此前裸 return null（与 ceiling 门禁不对称），
    // practice_only/diagnostic_only/null 的 assessment 会把 run 永久留在 committing。
    if (assessment.trustClass === null || !allowedTrust.includes(assessment.trustClass)) {
      return settleCommitRejection(tx, command, run, "trust_class_not_eligible");
    }
    // §7.7 防御纵深：提交 Variant 的 ceiling 必须允许对应等级——
    // practice/diagnostic ceiling 的 Variant 绝不产 canonical。
    const ceiling = await readVariantCeiling(tx, command.artifactId);
    const allowedCeilings = isDemonstrated
      ? ["mastery_eligible"]
      : ["mastery_eligible", "facet_eligible"];
    if (ceiling === null || !allowedCeilings.includes(ceiling)) {
      return settleCommitRejection(tx, command, run, "variant_ceiling_not_eligible");
    }
  } else if (payload.kind !== "declared_unable") {
    return settleCommitRejection(tx, command, run, "unable_artifact_mismatch");
  }

  const at = new Date();
  const authorization = contract.schedulingAuthorization as SchedulingAuthorizationV1;
  const objectiveId = originObjectiveId(run.origin);
  // facet_evidence（partial 结算）按同一授权路径消费/创建 schedule——
  // §6.4：partial 允许写 facet，调度授权不因部分覆盖而作废。
  const scheduleImpact = isCanonicalEvidence
    ? await applyDemonstratedSchedule(tx, command, authorization, at, disposition)
    : await applyUnableSchedule(tx, command, authorization, at);

  // 发布恰好一个 canonical envelope（§16.2 unique commitId/canonicalEventId）。
  const commitId = crypto.randomUUID();
  const factKind = isCanonicalEvidence
    ? (authorization.kind === "consume_pending" ? "scheduled_review" : "initial_validation")
    : "canonical_unable";
  const factDisposition: "mastery_evidence" | "facet_evidence" | "unable_evidence" =
    disposition === "mastery_evidence"
      ? "mastery_evidence"
      : disposition === "facet_evidence"
        ? "facet_evidence"
        : "unable_evidence";
  const canonicalEventId = `canonical:${sha256Hex(`${factKind}:${command.runId}:${assessment.id}`).slice(0, 24)}`;
  const envelope: CanonicalLearningEventEnvelopeV1 = {
    version: 1,
    canonicalEventId,
    eventHash: sha256Hex(JSON.stringify({
      canonicalEventId,
      commitId,
      runId: command.runId,
      keyPointId: objectiveId,
      fact: { kind: factKind, disposition: factDisposition },
    })),
    commitId,
    workspaceId: command.workspaceId,
    userId: command.userId,
    runId: command.runId,
    taskIds: [command.taskId],
    artifactIds: command.artifactId ? [command.artifactId] : ["00000000-0000-0000-0000-000000000000"],
    keyPointId: objectiveId,
    targetFingerprint: contract.targetFingerprint,
    fact: {
      kind: factKind,
      factId: `${factKind}:${assessment.id}`,
      disposition: factDisposition,
    },
    assessments: isCanonicalEvidence
      ? [{
          source: "assessment_critic",
          assessmentId: assessment.id,
          reportHash: assessment.reportHash ?? "",
          trustClass: factDisposition === "mastery_evidence" ? "mastery_eligible" : "facet_eligible",
        }]
      : [{
          source: "deterministic_declared_unable",
          assessmentId: assessment.id,
          reportHash: assessment.reportHash ?? "",
        }],
    occurredAt: at.toISOString(),
  };
  await tx.insert(canonicalLearningEventOutbox).values({
    commitId,
    canonicalEventId,
    workspaceId: command.workspaceId,
    userId: command.userId,
    runId: command.runId,
    envelope: envelope as never,
    status: "pending",
    createdAt: at,
  });
  // P7：Projector 在同一幂等事务物化 immutable change set + 前移 checkpoint。
  const projectionResult = await materializeCanonicalChangeSet(tx, {
    workspaceId: command.workspaceId,
    userId: command.userId,
  }, envelope, command.runId, at);

  const rubricFacets = (Array.isArray(assessment.rubricResults)
    ? (assessment.rubricResults as Array<{ facet?: string; verdict?: string }>)
    : []);
  const coveredFacets = rubricFacets
    .filter((item) => item.verdict === "covered")
    .map((item) => item.facet)
    .filter((facet): facet is string => typeof facet === "string" && facet.length > 0);
  const gapFacets = rubricFacets
    .filter((item) => item.verdict !== "covered")
    .map((item) => item.facet)
    .filter((facet): facet is string => typeof facet === "string" && facet.length > 0);

  const result: LearningRunResultV1 = isDemonstrated
    ? {
        outcome: "demonstrated",
        // M10（2026-08-24 审查）：没有 covered facet 记录时不得伪造 ["explain"]
        // ——那会污染理解投影与漏斗指标。空数组是唯一的诚实用法。
        demonstratedFacets: coveredFacets as never,
        gapFacets: [] as never,
        scheduleImpact,
        returnTarget: run.returnTarget as LearningRunReturnTargetV1,
        projection: projectionResult?.toCheckpointToken
          ? {
              baselineCheckpoint: {
                version: 1,
                workspaceId: command.workspaceId,
                userId: command.userId,
                token: projectionResult.toCheckpointToken,
                capturedAt: at.toISOString(),
              },
              sourceChange: { kind: "canonical", canonicalEventId: envelope.canonicalEventId },
              changeSetId: projectionResult.changeSetId,
            }
          : undefined,
      }
    : factDisposition === "facet_evidence"
      ? {
          outcome: "partial",
          demonstratedFacets: coveredFacets as never,
          gapFacets: gapFacets as never,
          scheduleImpact,
          returnTarget: run.returnTarget as LearningRunReturnTargetV1,
          projection: projectionResult?.toCheckpointToken
            ? {
                baselineCheckpoint: {
                  version: 1,
                  workspaceId: command.workspaceId,
                  userId: command.userId,
                  token: projectionResult.toCheckpointToken,
                  capturedAt: at.toISOString(),
                },
                sourceChange: { kind: "canonical", canonicalEventId: envelope.canonicalEventId },
                changeSetId: projectionResult.changeSetId,
              }
            : undefined,
        }
      : {
          outcome: "declared_unable",
          demonstratedFacets: [],
          gapFacets: [],
          scheduleImpact,
          returnTarget: run.returnTarget as LearningRunReturnTargetV1,
          projection: projectionResult?.toCheckpointToken
            ? {
                baselineCheckpoint: {
                  version: 1,
                  workspaceId: command.workspaceId,
                  userId: command.userId,
                  token: projectionResult.toCheckpointToken,
                  capturedAt: at.toISOString(),
                },
                sourceChange: { kind: "canonical", canonicalEventId: envelope.canonicalEventId },
                changeSetId: projectionResult.changeSetId,
              }
            : undefined,
        };
  await tx.update(learningRuns)
    .set({ phase: "completed", result: result as never, revision: run.revision + 1, updatedAt: at })
    .where(and(
      eq(learningRuns.id, command.runId),
      eq(learningRuns.workspaceId, command.workspaceId),
      eq(learningRuns.userId, command.userId),
      eq(learningRuns.phase, "committing"),
      eq(learningRuns.runtimeEpoch, run.runtimeEpoch),
    ));
  await appendRunEvent(tx, command, "learning_commit.completed", { commitId }, at);
  await appendRunEvent(tx, command, "learning_run.completed", {}, at);
  // §17.3：trusted first Commit（V2 run 且 canonical/mastery_evidence）→ 将
  // pending/ready 的 Initial Validation Reminder 标 completed 并幂等发领域事件
  // （同一 Commit 事务内；重复 commit 因 reminder 已 completed 而幂等）。
  if (contract.snapshotHash && isDemonstrated) {
    const completedReminders = await tx.update(initialValidationRemindersV2)
      .set({ status: "completed", updatedAt: at })
      .where(and(
        eq(initialValidationRemindersV2.workspaceId, command.workspaceId),
        eq(initialValidationRemindersV2.userId, command.userId),
        eq(initialValidationRemindersV2.objectiveId, objectiveId),
        inArray(initialValidationRemindersV2.status, ["pending", "ready"]),
      ))
      .returning({
        reminderId: initialValidationRemindersV2.reminderId,
        reminderRevision: initialValidationRemindersV2.reminderRevision,
      });
    await insertDomainEvents(tx, command.workspaceId, completedReminders.map((r) => ({
      eventType: "initial_validation_reminder.completed",
      aggregateKind: "reminder",
      aggregateId: r.reminderId,
      aggregateRevision: r.reminderRevision,
      payload: {
        objectiveId,
        runId: command.runId,
        commitId,
        factKind,
      },
      idempotencyKey: `completed:${commitId}:${r.reminderId}`,
    })));
  }
  // §7.8：结算回填 presentation_history（outcome/exposed，按 runId 幂等）。
  await backfillPresentationHistory(tx, { runId: command.runId, outcome: result.outcome });
  // P6 Journey：canonical 结算事件（含 scheduleImpact）驱动旅程完成。
  await hookJourneyOnRunCompleted(tx, command, {
    runId: command.runId,
    result: result as unknown as Record<string, unknown>,
  }, at);
  // P8 Orchestrator：确定性 Policy 判定后 durable deliver（事务内）+ LLM
  // 记忆候选生成（延后到事务提交后，避免网络调用钉住结算事务连接）。
  return await (await import("../companion-conversation/proactive-hook.ts")).hookProactiveOnRunCompleted(
    tx,
    { workspaceId: command.workspaceId, userId: command.userId },
    {
      runId: command.runId,
      outcome: result.outcome,
      trustOutcome: result.outcome,
      // Plan 23 CS-05：Pet/Companion 不再用 claim/summary 拼标题。
      // 从 Objective revision 查 conceptLabel 作为学习卡标签。
      keyPointClaim: await (async () => {
        try {
          const revRows = await tx
            .select({ conceptLabel: learningObjectiveRevisionsV2.conceptLabel })
            .from(learningObjectiveRevisionsV2)
            .where(and(
              eq(learningObjectiveRevisionsV2.workspaceId, command.workspaceId),
              eq(learningObjectiveRevisionsV2.objectiveId, objectiveId),
            ))
            .orderBy(desc(learningObjectiveRevisionsV2.revision))
            .limit(1);
          return revRows[0]?.conceptLabel ?? "";
        } catch {
          return "";
        }
      })(),
      scheduleImpact: result.scheduleImpact.kind,
    },
    at,
  );
}

/** sandbox Commit 收尾：sandbox trail（scope=sandbox + TTL）+ 0 canonical/schedule。 */
async function finishSandboxCommit(
  tx: Parameters<Parameters<typeof withWorkspaceTransaction>[1]>[0],
  command: CommandRow,
  run: { id: string; revision: number; runtimeEpoch: number; sandboxNamespaceId: string | null; returnTarget: unknown },
  at: Date,
): Promise<void> {
  const practiceEventId = `sandbox:${sha256Hex(`${command.runId}:sandbox`).slice(0, 24)}`;
  const runRows = await tx
    .select({ origin: learningRuns.origin })
    .from(learningRuns)
    .where(eq(learningRuns.id, command.runId))
    .limit(1);
    const keyPointId = originObjectiveId(runRows[0]?.origin);
  await tx.insert(practiceTrailEventOutbox).values({
    practiceEventId,
    workspaceId: command.workspaceId,
    userId: command.userId,
    runId: command.runId,
    scope: "sandbox",
    event: {
      version: 1,
      practiceEventId,
      eventHash: sha256Hex(`event:${practiceEventId}`),
      workspaceId: command.workspaceId,
      userId: command.userId,
      runId: command.runId,
      taskIds: [command.taskId],
      keyPointId,
      targetFingerprint: "",
      artifactIds: command.artifactId ? [command.artifactId] : [],
      scope: "sandbox",
      reasons: ["sandbox"],
      occurredAt: at.toISOString(),
      // TTL：sandbox trail 默认 24 小时过期（§16.4）。
      expiresAt: new Date(at.getTime() + 24 * 60 * 60 * 1000).toISOString(),
    } as never,
    status: "pending",
    createdAt: at,
  }).onConflictDoNothing();
  const result: LearningRunResultV1 = {
    outcome: "practice_completed",
    demonstratedFacets: [],
    gapFacets: [],
    scheduleImpact: { kind: "none", reasonCode: "sandbox" },
    returnTarget: run.returnTarget as never,
  };
  await tx.update(learningRuns)
    .set({ phase: "completed", result: result as never, revision: run.revision + 1, updatedAt: at })
    .where(and(
      eq(learningRuns.id, command.runId),
      eq(learningRuns.workspaceId, command.workspaceId),
      eq(learningRuns.userId, command.userId),
      eq(learningRuns.phase, "committing"),
      eq(learningRuns.runtimeEpoch, run.runtimeEpoch),
    ));
  await appendRunEvent(tx, command, "learning_run.completed", {}, at);
    // §7.8：结算回填 presentation_history（outcome/exposed，按 runId 幂等）。
    await backfillPresentationHistory(tx, { runId: command.runId, outcome: result.outcome });
}

/** P6：Run 完成事件 → 当前 workspace 的 active Journey（Reducer 幂等推进）。 */
async function hookJourneyOnRunCompleted(
  tx: Parameters<Parameters<typeof withWorkspaceTransaction>[1]>[0],
  command: CommandRow,
  payload: Record<string, unknown>,
  at: Date,
): Promise<void> {
  // 同事务原子：Run 结算与 Journey 推进同时成功或整体回滚；失败时 outbox
  // 命令重试（处理幂等），最终一致。绝不在事务内吞错（吞错会造成结算成功
  // 而旅程停滞的不一致态）。
  const { findActiveJourney, applyJourneyDomainEvent } = await import("../companion-journey/journey-service.ts");
  const journey = await findActiveJourney(tx, {
    workspaceId: command.workspaceId,
    userId: command.userId,
  });
  if (!journey) return;
  await applyJourneyDomainEvent(tx, {
    workspaceId: command.workspaceId,
    userId: command.userId,
  }, {
    journeyId: journey.journeyId,
    domainEventId: `run.completed:${command.runId}`,
    eventType: "learning_run.completed",
    payload,
  }, at);
}

/** demonstrated 的 schedule 处理：按 discrete-v2 推进。 */
async function applyDemonstratedSchedule(
  tx: Parameters<Parameters<typeof withWorkspaceTransaction>[1]>[0],
  command: CommandRow,
  authorization: SchedulingAuthorizationV1,
  at: Date,
  disposition?: string,
): Promise<LearningRunResultV1["scheduleImpact"]> {
  // §13.6：facet_evidence（partial/结构化 facet 结算）0 schedule effect——
  // 不消费 pending、不创建 successor（canonical facet observation 照常发布）。
  if (disposition === "facet_evidence") {
    return { kind: "none", reasonCode: "facet_only" };
  }
  // 证据存在性：cardKeyPoints.quote 读取已退役。可走到 Commit 的
  // canonical run 必然已通过 V2 evidence closure 复验（revalidateV2CommitEpochs
  // 要求全部 usable，fail closed），故 hard evidence 恒成立（P2 保守口径）。
  const hasHardEvidence = true;

  if (authorization.kind === "create_initial") {
    const decision = calculateDiscreteV2Schedule({
      currentIntervalDays: 1,
      outcome: "correct",
      hasValidServerQuestion: true,
      hasHardEvidence,
      now: at,
      unassistedEligibleAfter: null,
    });
    await tx.insert(reviewSchedules).values({
      workspaceId: command.workspaceId,
      userId: command.userId,
      // V2 objective 维度：subjectType="card" + subjectId=objectiveId（§29.4
      // 惯例；与 surface-service/card-service 读取端一致）。
      subjectType: "card",
      subjectId: authorization.keyPointId,
      status: "pending",
      nextReviewAt: decision.nextReviewAt,
      intervalDays: decision.afterIntervalDays,
      generation: 1,
      policyVersion: decision.policyVersion,
      reasonCode: decision.reasonCode,
      createdAt: at,
      updatedAt: at,
    });
    return { kind: "created", dueAt: decision.nextReviewAt.toISOString(), policyReason: "demonstrated" };
  }
  if (authorization.kind === "consume_pending") {
    const currentRows = await tx
      .select({ intervalDays: reviewSchedules.intervalDays })
      .from(reviewSchedules)
      .where(and(
        eq(reviewSchedules.id, authorization.scheduleId),
        eq(reviewSchedules.workspaceId, command.workspaceId),
        eq(reviewSchedules.userId, command.userId),
      ))
      .limit(1);
    const decision = calculateDiscreteV2Schedule({
      currentIntervalDays: currentRows[0]?.intervalDays ?? 1,
      outcome: "correct",
      hasValidServerQuestion: true,
      hasHardEvidence,
      now: at,
      unassistedEligibleAfter: null,
    });
    const consumed = await tx
      .update(reviewSchedules)
      .set({ status: "completed", lastReviewAt: at, updatedAt: at })
      .where(and(
        eq(reviewSchedules.id, authorization.scheduleId),
        eq(reviewSchedules.workspaceId, command.workspaceId),
        eq(reviewSchedules.userId, command.userId),
        eq(reviewSchedules.generation, authorization.scheduleGeneration),
        eq(reviewSchedules.status, "pending"),
      ))
      .returning({ id: reviewSchedules.id });
    if (consumed.length === 0) {
      // generation 已变化：0 schedule 副作用（不猜）。
      return { kind: "none", reasonCode: "stale" };
    }
    await tx.insert(reviewSchedules).values({
      workspaceId: command.workspaceId,
      userId: command.userId,
      subjectType: "card",
      subjectId: authorization.keyPointId,
      status: "pending",
      nextReviewAt: decision.nextReviewAt,
      intervalDays: decision.afterIntervalDays,
      generation: authorization.scheduleGeneration + 1,
      supersedesScheduleId: authorization.scheduleId,
      policyVersion: decision.policyVersion,
      reasonCode: decision.reasonCode,
      createdAt: at,
      updatedAt: at,
    });
    return {
      kind: "rescheduled",
      dueAt: decision.nextReviewAt.toISOString(),
      consumedScheduleId: authorization.scheduleId,
      policyReason: "demonstrated",
    };
  }
  const reasonCode = authorization.kind === "record_only" ? "record_only" : authorization.reasonCode;
  return { kind: "none", reasonCode: (reasonCode ?? "not_authorized") as never };
}

/** declared_unable 的 schedule 处理：按 discrete-v2 创建/消费 successor。 */
async function applyUnableSchedule(
  tx: Parameters<Parameters<typeof withWorkspaceTransaction>[1]>[0],
  command: CommandRow,
  authorization: SchedulingAuthorizationV1,
  at: Date,
): Promise<LearningRunResultV1["scheduleImpact"]> {
  const calculateUnableDecision = (currentIntervalDays: number) => calculateDiscreteV2Schedule({
    currentIntervalDays,
    outcome: "unable",
    hasValidServerQuestion: true,
    hasHardEvidence: true,
    now: at,
    unassistedEligibleAfter: null,
  });
  if (authorization.kind === "create_initial") {
    const decision = calculateUnableDecision(1);
    await tx.insert(reviewSchedules).values({
      workspaceId: command.workspaceId,
      userId: command.userId,
      subjectType: "card",
      subjectId: authorization.keyPointId,
      status: "pending",
      nextReviewAt: decision.nextReviewAt,
      intervalDays: decision.afterIntervalDays,
      generation: 1,
      policyVersion: decision.policyVersion,
      reasonCode: decision.reasonCode,
      createdAt: at,
      updatedAt: at,
    });
    return { kind: "created", dueAt: decision.nextReviewAt.toISOString(), policyReason: "declared_unable" };
  }
  if (authorization.kind === "consume_pending") {
    const currentRows = await tx
      .select({ intervalDays: reviewSchedules.intervalDays })
      .from(reviewSchedules)
      .where(and(
        eq(reviewSchedules.id, authorization.scheduleId),
        eq(reviewSchedules.workspaceId, command.workspaceId),
        eq(reviewSchedules.userId, command.userId),
      ))
      .limit(1);
    const decision = calculateUnableDecision(currentRows[0]?.intervalDays ?? 1);
    const consumed = await tx
      .update(reviewSchedules)
      .set({ status: "completed", lastReviewAt: at, updatedAt: at })
      .where(and(
        eq(reviewSchedules.id, authorization.scheduleId),
        eq(reviewSchedules.workspaceId, command.workspaceId),
        eq(reviewSchedules.userId, command.userId),
        eq(reviewSchedules.generation, authorization.scheduleGeneration),
        eq(reviewSchedules.status, "pending"),
      ))
      .returning({ id: reviewSchedules.id });
    if (consumed.length === 0) {
      // generation 已变化：0 schedule 副作用（不猜）。
      return { kind: "none", reasonCode: "stale" };
    }
    await tx.insert(reviewSchedules).values({
      workspaceId: command.workspaceId,
      userId: command.userId,
      subjectType: "card",
      subjectId: authorization.keyPointId,
      status: "pending",
      nextReviewAt: decision.nextReviewAt,
      intervalDays: decision.afterIntervalDays,
      generation: authorization.scheduleGeneration + 1,
      supersedesScheduleId: authorization.scheduleId,
      policyVersion: decision.policyVersion,
      reasonCode: decision.reasonCode,
      createdAt: at,
      updatedAt: at,
    });
    return {
      kind: "rescheduled",
      dueAt: decision.nextReviewAt.toISOString(),
      consumedScheduleId: authorization.scheduleId,
      policyReason: "declared_unable",
    };
  }
  // record_only / no_effect：0 schedule 副作用。
  const reasonCode = authorization.kind === "record_only" ? "record_only" : authorization.reasonCode;
  return {
    kind: "none",
    reasonCode: (reasonCode ?? "not_authorized") as never,
  };
}

async function appendRunEvent(
  tx: Parameters<Parameters<typeof withWorkspaceTransaction>[1]>[0],
  command: CommandRow,
  eventType: string,
  payload: Record<string, unknown>,
  at: Date,
): Promise<void> {
  // Y5（round-3 审计）：此处每事件 3 往返（select cursor → insert event → update
  // cursor）。已评估合并为单条原子 CTE（UPDATE learning_runs SET event_cursor=
  // event_cursor+1 ... RETURNING 后 INSERT），可省 2 往返。但：
  //  - appendRunEvent 仅在每条 outbox command 处理/可恢复失败路径调用（非每任务/每
  //    e action 的高频热路径），合并的绝对收益有限；
  //  - CTE 需 raw SQL，且要跨 RLS（learningRuns/learningRunEvents 均为事件序列原子
  //    递增），并对"run 行缺失"的孤儿插入边界语义有改变（现行为：run 缺失仍插
  //    sequence=1 事件、update no-op；CTE 会因 UPDATE 0 行而不插）。
  //  权衡后保持 3 往返语义不变（正确性优先，涉及事件序列一致性的边界行为不改）。
  const runRows = await tx.select({ eventCursor: learningRuns.eventCursor }).from(learningRuns)
    .where(eq(learningRuns.id, command.runId)).limit(1);
  const cursor = runRows[0]?.eventCursor ?? 0;
  await tx.insert(learningRunEvents).values({
    runId: command.runId,
    workspaceId: command.workspaceId,
    userId: command.userId,
    sequence: cursor + 1,
    eventType: eventType as never,
    payload: payload as never,
    occurredAt: at,
  });
  await tx.update(learningRuns)
    .set({ eventCursor: cursor + 1, updatedAt: at })
    .where(eq(learningRuns.id, command.runId));
}

// CommandRow 事件写入辅助。
