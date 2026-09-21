/**
 * Card Generation V2 — GenerationRun 创建与查询（方案 20 §17.1–17.2）。
 */

import { randomUUID } from "node:crypto";
import { and, eq, desc, inArray, sql } from "drizzle-orm";
import { withWorkspaceTransaction } from "../../db/client.ts";
import {
  cardGenerationRunsV2,
  cardGenerationPlansV2,
  cardGenerationCandidatesV2,
  cardGenerationEventsV2,
  cardGenerationRunOutboxV2,
  cardGenerationSemanticSpecsV2,
  cardGenerationInputSnapshotsV2,
} from "@ailearn/shared/db-schema/card-generation-v2";
import {
  sealEvidenceSnapshotsV2,
} from "./evidence-seal-service.ts";
import { notes, noteVersions, noteBlocks } from "@ailearn/shared/db-schema/note";
import {
  createCardGenerationRunRequestV2Schema,
  type CreateCardGenerationRunRequestV2,
} from "@ailearn/shared/card-generation-v2-contracts";
import {
  computeGenerationSemanticSpecHashV2,
  computeGenerationFingerprintV2,
  computeInputSnapshotHashV2,
} from "@ailearn/shared/card-generation-v2-hashing";
import { hashCanonicalV2 } from "@ailearn/shared/hash-canonical-v2";
import { isCardGenerationReviewOpen } from "@ailearn/shared/card-generation-desktop-contracts";
import {
  sanitizeEventPayloadV2,
  CardGenerationV2ServiceError,
  checkSourceOutdated,
  insertEvent,
  readGenerationProgressV2,
  serializeRunPublic,
  serializeCandidatePublic,
  type RunContext,
} from "./helpers.ts";

/** R34/§22.6：解析正整数 env（非法/非正 → 默认值）。 */
function parsePositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw.trim());
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : fallback;
}

const GENERATION_START_IDEMPOTENCY_DOMAIN = "card-generation-v2/idempotency-request";

/**
 * §17.1 / CARD-GEN-START-01：同一幂等键只有在 request payload 完全一致时才可 replay。
 * 老数据缺少 rawRequest 时按冲突处理，避免把未知 payload 当成安全 replay。
 */
function assertGenerationStartReplay(
  existing: typeof cardGenerationRunsV2.$inferSelect,
  requestHash: string,
): { runId: string; status: string } {
  const snapshot = existing.inputSnapshot;
  const rawRequest =
    typeof snapshot === "object" && snapshot !== null && "rawRequest" in snapshot
      ? snapshot.rawRequest
      : undefined;
  const parsed = createCardGenerationRunRequestV2Schema.safeParse(rawRequest);
  if (
    !parsed.success ||
    hashCanonicalV2(GENERATION_START_IDEMPOTENCY_DOMAIN, parsed.data) !== requestHash
  ) {
    throw new CardGenerationV2ServiceError(
      "idempotency_conflict",
      409,
      "幂等键已用于不同的生成请求",
    );
  }
  return { runId: existing.id, status: existing.status };
}

export async function createGenerationRunV2(
  ctx: RunContext,
  noteVersionId: string,
  body: CreateCardGenerationRunRequestV2,
  idempotencyKey: string,
): Promise<{ runId: string; status: string }> {
  return withWorkspaceTransaction(ctx, async (tx) => {
    const requestHash = hashCanonicalV2(GENERATION_START_IDEMPOTENCY_DOMAIN, body);
    const existing = await tx
      .select()
      .from(cardGenerationRunsV2)
      .where(and(
        eq(cardGenerationRunsV2.workspaceId, ctx.workspaceId),
        eq(cardGenerationRunsV2.idempotencyKey, idempotencyKey),
      ))
      .limit(1);
    if (existing.length > 0) {
      return assertGenerationStartReplay(existing[0], requestHash);
    }

    // R34/§22.6：workspace 维度生成并发与速率限制（abuse/resource 防护）。
    // advisory lock 串行化同 workspace 的限额检查与 run 创建，防并发绕过。
    await tx.execute(sql`
      SELECT pg_advisory_xact_lock(
        hashtextextended(${`v2-generation-quota:${ctx.workspaceId}`}, 0)
      )
    `);

    // The first lookup is only an optimistic fast path. A concurrent request
    // may have committed while this transaction waited for the workspace lock;
    // re-check before quota work/insert so the unique idempotency key converges
    // to a strict replay instead of surfacing a unique-violation 500.
    const lockedExisting = await tx
      .select()
      .from(cardGenerationRunsV2)
      .where(and(
        eq(cardGenerationRunsV2.workspaceId, ctx.workspaceId),
        eq(cardGenerationRunsV2.idempotencyKey, idempotencyKey),
      ))
      .limit(1);
    if (lockedExisting.length > 0) {
      return assertGenerationStartReplay(lockedExisting[0], requestHash);
    }

    const inFlightLimit = parsePositiveIntEnv("CARD_GENERATION_V2_MAX_INFLIGHT_RUNS", 3);
    const dailyLimit = parsePositiveIntEnv("CARD_GENERATION_V2_DAILY_RUN_LIMIT", 50);
    const inFlightRows = await tx.execute(sql`
      SELECT COUNT(*)::int AS n FROM card_generation_runs_v2
      WHERE workspace_id = ${ctx.workspaceId}
        AND status IN ('queued','source_sealing','planning','authoring','checking')
    `);
    const inFlight = Number((inFlightRows[0] as { n: number }).n ?? 0);
    if (inFlight >= inFlightLimit) {
      throw new CardGenerationV2ServiceError(
        "generation_concurrency_limit",
        429,
        `生成并发已达上限（${inFlightLimit} 个在途 Run），请稍后重试`,
      );
    }
    const dailyRows = await tx.execute(sql`
      SELECT COUNT(*)::int AS n FROM card_generation_runs_v2
      WHERE workspace_id = ${ctx.workspaceId}
        AND created_at >= now() - interval '24 hours'
    `);
    const daily = Number((dailyRows[0] as { n: number }).n ?? 0);
    if (daily >= dailyLimit) {
      throw new CardGenerationV2ServiceError(
        "generation_daily_limit",
        429,
        `生成已达 24 小时上限（${dailyLimit} 次），请明日再试`,
      );
    }

    // 从 noteVersionId 查找版本，再推导 noteId
    const version = await tx.query.noteVersions.findFirst({
      where: eq(noteVersions.id, noteVersionId),
    });
    if (!version) throw new CardGenerationV2ServiceError("note_version_not_found", 404, "笔记版本不存在");
    const noteId = version.noteId;

    const note = await tx.query.notes.findFirst({
      where: and(eq(notes.id, noteId), eq(notes.workspaceId, ctx.workspaceId)),
    });
    if (!note) throw new CardGenerationV2ServiceError("note_not_found", 404, "笔记不存在");

    // 2026-09-20（实走复盘 #5）：一篇笔记同时只允许一批在制的学习卡。
    // 此前配额只落在 workspace 维度（在途数 + 日次数），同一篇笔记可以被反复
    // 点「生成学习卡」，每点一次就多一批候选卡。
    // 但"失败到没法就地重试"的那一批不能把笔记永久锁死：needs_attention 且失败原因
    // 不是质量门禁时，retry 端点自己会拒绝（`not_retryable`），cancel 也判
    // `invalid_state`，于是只剩"重新生成"这一条路——而这条守卫正是拦它的。
    // 判据与 retry 端点保持同一句话：只有 quality_gate_failed 的失败批次仍然算在制。
    //
    // 2026-09-21 真实生成实测修正：这里必须遍历**全部**在制行，不能只看一行。原先
    // `.limit(1)` 取到的是 Postgres 任意给的一行，同篇笔记既有已死批次又有一批还没
    // 审完时，只要先摸到已死那行就放行，结果新旧两批 review_ready 并存——正是用户
    // 抱怨的"旧卡不废弃"。只要还有一行活着就挡住。
    const noteInFlight = await tx
      .select({ id: cardGenerationRunsV2.id, status: cardGenerationRunsV2.status, errorCode: cardGenerationRunsV2.errorCode })
      .from(cardGenerationRunsV2)
      .where(and(
        eq(cardGenerationRunsV2.workspaceId, ctx.workspaceId),
        eq(cardGenerationRunsV2.noteId, noteId),
        inArray(cardGenerationRunsV2.status, [...ACTIVE_GENERATION_RUN_STATUSES]),
      ));
    const liveBatch = noteInFlight.find((run) => !(
      run.status === "needs_attention" && run.errorCode !== "quality_gate_failed"
    ));
    if (liveBatch) {
      throw new CardGenerationV2ServiceError(
        "note_generation_in_flight",
        409,
        "这篇笔记已经有一批学习卡在生成或等待审核，请先处理完那一批",
      );
    }

    /**
     * 本次生成替代的上一个批次。`supersedes_run_id` 列早已存在但生产代码从未
     * 写入，跨 run 的旧候选批次因此永远不会被废弃，列表里新旧两批混在一起。
     */
    const previousActivatedRun = await tx
      .select({ id: cardGenerationRunsV2.id })
      .from(cardGenerationRunsV2)
      .where(and(
        eq(cardGenerationRunsV2.workspaceId, ctx.workspaceId),
        eq(cardGenerationRunsV2.noteId, noteId),
        eq(cardGenerationRunsV2.status, "activated"),
      ))
      .orderBy(desc(cardGenerationRunsV2.updatedAt))
      .limit(1);

    const blocks = await tx.query.noteBlocks.findMany({
      where: eq(noteBlocks.versionId, body.noteVersionId),
      orderBy: (b, { asc }) => [asc(b.ordinal)],
    });

    const blockContents = blocks.map((b) => b.content).join("\n");
    // §9.2: sourceContentHash 只覆盖 block 内容，不含 noteVersionId（transport/source identity 字段排除）
    const sourceContentHash = hashCanonicalV2("card-generation-v2/source-content", {
      blockContents,
    });
    const blockManifestHash = hashCanonicalV2("card-generation-v2/block-manifest", {
      blocks: blocks.map((b) => ({
        blockId: b.id, type: b.type,
        contentHash: hashCanonicalV2("block", { content: b.content }),
      })),
    });
    const assetManifestHash = hashCanonicalV2("card-generation-v2/asset-manifest", { assets: [] });
    const scopeManifestHash = hashCanonicalV2("card-generation-v2/scope-manifest", { scope: body.sourceScope });
    const sourceSnapshotHash = hashCanonicalV2("card-generation-v2/source-snapshot", {
      noteVersionId: body.noteVersionId,
      sourceContentHash, blockManifestHash, assetManifestHash, scopeManifestHash,
    });

    const semanticSpec = {
      version: 2 as const,
      semanticRequest: {
        sourceScope: body.sourceScope,
        learningGoal: body.learningGoal,
        detailThreshold: body.detailThreshold,
        quantity: body.quantity,
        preferredStrategies: body.preferredStrategies,
        feedbackContext: body.feedbackContext,
      },
      policies: {
        plannerPolicyVersion: "planner-v1",
        deterministicGateVersion: "gate-v1",
        evidencePolicyVersion: "evidence-v1",
        targetPolicyVersion: "target-v1",
        cardContractVersion: "learning-card-v2" as const,
        targetSnapshotVersion: "learning-target-snapshot-v2" as const,
        // 2026-08-24：补全四阶段 stageRuntimes——worker 端 sampling(stage) 已按
        // 裸阶段名匹配（providers.ts），此前只种 planner 时 author/critic 三阶段
        // 的 per-run 采样配置会被静默忽略。promptVersion 与 workers
        // card-generation-v2/prompts.ts 的 CARD_GENERATION_V2_PROMPT_VERSION
        // bump 同步；本数组参与 semanticSpecHash，是审计闭包的一部分。
        // 2026-08-24（§4.5）：v3 —— pedagogy 增补中文语义裁决基准（atomicity/
        // 改写式泄题自确定性 gate 降级 soft 后由 Critic 承担 hard 判定）。
        // 2026-09-15（管线评审 H3/M3）：v4 —— planner prompt 补不可信数据边界 +
        // 可用证据 ID 列表（worker prompts.ts CARD_GENERATION_V2_PROMPT_VERSION 同步）。
        // 2026-09-18：v19 —— 三个类级修复（作者不得补充证据未陈述的内容 /
        // front 短术语泄漏的逐词自检 + pedagogy 扩判 / 零卡单一判据）。
        // 2026-09-18（晚）：v20 —— 作者提示词开放 canonicalAnswer 五种形态
        // （ordered_steps/mapping/comparison 此前从未被教过，导致排序/关系练习题
        // 零生成）+ preferredTaskIntents 按知识形态选择（此前模板硬编码 recall）+
        // rubric 覆盖整组答案单元。
        // 2026-09-20：v21 —— 题型（strategy）改由 planner 在整批目标上确定性分配，
        // author 提示按分配到的题型出模板与示例（此前模板与示例都写死 recall，且用户
        // 勾选的 preferredStrategies 从未进入提示，导致整批卡全是同一题型）。
        stageRuntimes: [
          {
            stage: "planner" as const,
            providerId: "system",
            modelSnapshot: "v1",
            deploymentId: "local",
            capabilityFingerprint: "basic",
            promptVersion: "v24",
            sampling: { temperature: 0 },
            outputSchemaVersion: "v2",
          },
          {
            stage: "author" as const,
            providerId: "system",
            modelSnapshot: "v1",
            deploymentId: "local",
            capabilityFingerprint: "basic",
            promptVersion: "v24",
            sampling: { temperature: 0 },
            outputSchemaVersion: "v2",
          },
          {
            stage: "grounding_critic" as const,
            providerId: "system",
            modelSnapshot: "v1",
            deploymentId: "local",
            capabilityFingerprint: "basic",
            promptVersion: "v24",
            sampling: { temperature: 0 },
            outputSchemaVersion: "v2",
          },
          {
            stage: "pedagogy_critic" as const,
            providerId: "system",
            modelSnapshot: "v1",
            deploymentId: "local",
            capabilityFingerprint: "basic",
            promptVersion: "v24",
            sampling: { temperature: 0 },
            outputSchemaVersion: "v2",
          },
        ],
      },
      governancePolicyVersion: "gov-v1",
    };
    const semanticSpecHash = computeGenerationSemanticSpecHashV2(semanticSpec);

    const generationFingerprint = computeGenerationFingerprintV2({
      workspaceId: ctx.workspaceId,
      noteVersionId: body.noteVersionId,
      sourceContentHash, blockManifestHash, assetManifestHash, scopeManifestHash,
      generationSemanticSpecHash: semanticSpecHash,
    });

    const runId = randomUUID();
    const inputSnapshot = {
      version: 2 as const,
      generationRunId: runId,
      workspaceId: ctx.workspaceId,
      idempotencyKey,
      rawRequest: body,
      sourceSnapshot: {
        sourceSnapshotId: randomUUID(),
        noteId, noteVersionId: body.noteVersionId,
        sourceSnapshotHash, sourceContentHash,
        blockManifestHash, assetManifestHash, scopeManifestHash,
      },
      semanticSpecHash, generationFingerprint,
      cardContentEpoch: 1,
    };
    const inputSnapshotHash = computeInputSnapshotHashV2(inputSnapshot);

    await tx.insert(cardGenerationRunsV2).values({
      id: runId,
      workspaceId: ctx.workspaceId,
      userId: ctx.userId,
      noteId, noteVersionId: body.noteVersionId,
      idempotencyKey,
      status: "queued",
      cardContentEpoch: 1,
      semanticSpecHash, inputSnapshotHash, generationFingerprint,
      sourceSnapshotHash, sourceContentHash,
      blockManifestHash, assetManifestHash, scopeManifestHash,
      currentPlanVersion: 0, reviewDraftRevision: 1,
      supersedesRunId: previousActivatedRun[0]?.id ?? null,
      semanticSpec, inputSnapshot,
    });

    await insertEvent(tx, ctx.workspaceId, runId, "card_generation.created", { runId });
    await tx.update(cardGenerationRunsV2)
      .set({ status: "source_sealing", updatedAt: new Date() })
      .where(and(eq(cardGenerationRunsV2.id, runId), eq(cardGenerationRunsV2.workspaceId, ctx.workspaceId)));

    // ── §10.1 step 1-2：Evidence Seal + Semantic Spec / Input Snapshot 闭包 ──
    // source-only evidence seal（§14.1/§14.3，单向闭包：Author 之前 immutable seal）。
    await sealEvidenceSnapshotsV2(tx, {
      workspaceId: ctx.workspaceId,
      runId,
      noteId,
      noteVersionId: body.noteVersionId,
      sourceSnapshotId: inputSnapshot.sourceSnapshot.sourceSnapshotId,
      sourceScope: body.sourceScope,
      blocks: blocks.map((b) => ({
        blockId: b.id,
        type: b.type,
        content: b.content,
        ordinal: b.ordinal,
      })),
    });
    await insertEvent(tx, ctx.workspaceId, runId, "card_generation.evidence_sealed", {
      sourceContentHash,
    });

    // 幂等写入 immutable semantic spec / input snapshot 闭包表（§18.1）。
    await tx.insert(cardGenerationSemanticSpecsV2).values({
      id: randomUUID(),
      workspaceId: ctx.workspaceId,
      semanticSpecHash,
      semanticSpec,
      version: 2,
    }).onConflictDoNothing();
    await tx.insert(cardGenerationInputSnapshotsV2).values({
      id: randomUUID(),
      workspaceId: ctx.workspaceId,
      generationRunId: runId,
      inputSnapshotHash,
      inputSnapshot,
      version: 2,
    }).onConflictDoNothing();

    await insertEvent(tx, ctx.workspaceId, runId, "card_generation.source_sealed", { sourceSnapshotHash });

    // V1 placeholder: 实际 Planner/Author 由 worker 异步执行。
    // 此处将 Run 状态推进到 planning，等待 worker 消费。
    // 方案 20 §10.5 禁止将技术失败伪装成 0 张卡——
    // no_cards_recommended 只能由 Pedagogy Critic 或 Planner 确认后由 worker 写入。
    await tx.update(cardGenerationRunsV2)
      .set({ status: "planning", updatedAt: new Date() })
      .where(and(eq(cardGenerationRunsV2.id, runId), eq(cardGenerationRunsV2.workspaceId, ctx.workspaceId)));

    // 修复：写 planning_started 而非 plan_completed
    // plan_completed 只能由 worker 在 Planner 执行完毕后写入
    await insertEvent(tx, ctx.workspaceId, runId, "card_generation.planning_started", {
      note: "awaiting worker",
    });

    // §17.2: Enqueue worker job for Planner/Author/Critic pipeline
    // W#2（round-5）+ 0163（round-6）：0163 部分唯一约束仅限 plan/post_activation 单例
    // （每 run 该 jobType 恰一个）——重复入队（API 重试/双击）须 ON CONFLICT DO NOTHING，否则抛 unique_violation 500。
    await tx.insert(cardGenerationRunOutboxV2).values({
      workspaceId: ctx.workspaceId,
      runId,
      jobType: "card_generation_plan",
      payload: { runId, workspaceId: ctx.workspaceId, semanticSpecHash },
      status: "pending",
    }).onConflictDoNothing();

    return { runId, status: "planning" };
  });
}

export async function getGenerationRunV2(ctx: RunContext, runId: string) {
  return withWorkspaceTransaction(ctx, async (tx) => {
    const rows = await tx.select().from(cardGenerationRunsV2)
      .where(and(eq(cardGenerationRunsV2.id, runId), eq(cardGenerationRunsV2.workspaceId, ctx.workspaceId)))
      .limit(1);
    if (rows.length === 0) return null;
    // 进度只在单 run 读取时聚合：这是生成工作台与笔记页订阅后重读的那一条，
    // 列表接口（active runs）不带，避免每次房间刷新都多打一遍候选表。
    const progress = await readGenerationProgressV2(
      tx, ctx.workspaceId, runId, rows[0].currentPlanVersion,
    );
    return serializeRunPublic(rows[0], tx, progress);
  });
}

const ACTIVE_GENERATION_RUN_STATUSES = [
  "queued",
  "source_sealing",
  "planning",
  "authoring",
  "checking",
  "review_ready",
  "needs_attention",
  "activating",
] as const;

/** Owner-only recovery query for Room/Desk; terminal runs are not resumable. */
export async function listActiveGenerationRunsV2(ctx: RunContext) {
  return withWorkspaceTransaction(ctx, async (tx) => {
    const rows = await tx.select().from(cardGenerationRunsV2)
      .where(and(
        eq(cardGenerationRunsV2.workspaceId, ctx.workspaceId),
        inArray(cardGenerationRunsV2.status, [...ACTIVE_GENERATION_RUN_STATUSES]),
      ))
      .orderBy(desc(cardGenerationRunsV2.updatedAt))
      .limit(20);
    return Promise.all(rows.map((row) => serializeRunPublic(row, tx)));
  });
}

/**
 * The note's most recent run, whatever its status. A feedback-carrying
 * regeneration has to name the run it is answering, and nothing else in the
 * desktop projection says which run that was once it has finished.
 */
export async function getLatestGenerationRunForNoteV2(ctx: RunContext, noteId: string) {
  return withWorkspaceTransaction(ctx, async (tx) => {
    const rows = await tx.select().from(cardGenerationRunsV2)
      .where(and(
        eq(cardGenerationRunsV2.workspaceId, ctx.workspaceId),
        eq(cardGenerationRunsV2.noteId, noteId),
      ))
      .orderBy(desc(cardGenerationRunsV2.updatedAt))
      .limit(1);
    if (rows.length === 0) return null;
    return serializeRunPublic(rows[0], tx);
  });
}

export async function getGenerationRunPlanV2(ctx: RunContext, runId: string) {
  return withWorkspaceTransaction(ctx, async (tx) => {
    const runRows = await tx.select().from(cardGenerationRunsV2)
      .where(and(eq(cardGenerationRunsV2.id, runId), eq(cardGenerationRunsV2.workspaceId, ctx.workspaceId)))
      .limit(1);
    if (runRows.length === 0) return null;

    const planRows = await tx.select().from(cardGenerationPlansV2)
      .where(and(
        eq(cardGenerationPlansV2.runId, runId),
        eq(cardGenerationPlansV2.workspaceId, ctx.workspaceId),
        eq(cardGenerationPlansV2.planVersion, runRows[0].currentPlanVersion),
      ))
      .limit(1);
    if (planRows.length === 0) return null;

    const p = planRows[0];
    return {
      version: 2 as const,
      runId: p.runId,
      inputSnapshotHash: p.inputSnapshotHash,
      cardContentEpoch: p.cardContentEpoch,
      planRevisionId: p.planRevisionId,
      planVersion: p.planVersion,
      previousPlanRevisionId: p.previousPlanRevisionId,
      result: p.result,
      atomDecisions: p.atomDecisions,
      planHash: p.planHash,
    };
  });
}

export async function getGenerationRunCandidatesV2(ctx: RunContext, runId: string) {
  return withWorkspaceTransaction(ctx, async (tx) => {
    const runRows = await tx.select({ id: cardGenerationRunsV2.id })
      .from(cardGenerationRunsV2)
      .where(and(eq(cardGenerationRunsV2.id, runId), eq(cardGenerationRunsV2.workspaceId, ctx.workspaceId)))
      .limit(1);
    if (runRows.length === 0) return null;

    const all = await tx.select().from(cardGenerationCandidatesV2)
      .where(and(
        eq(cardGenerationCandidatesV2.runId, runId),
        eq(cardGenerationCandidatesV2.workspaceId, ctx.workspaceId),
      ))
      .orderBy(desc(cardGenerationCandidatesV2.revision));

    const seen = new Set<string>();
    const latest = all.filter((c) => {
      if (seen.has(c.candidateId)) return false;
      seen.add(c.candidateId);
      return true;
    });

    return latest.map(serializeCandidatePublic);
  });
}

export async function getGenerationRunEventsV2(ctx: RunContext, runId: string, afterSeq = 0) {
  return withWorkspaceTransaction(ctx, async (tx) => {
    const events = await tx.select().from(cardGenerationEventsV2)
      .where(and(
        eq(cardGenerationEventsV2.runId, runId),
        eq(cardGenerationEventsV2.workspaceId, ctx.workspaceId),
        sql`${cardGenerationEventsV2.eventSeq} > ${afterSeq}`,
      ))
      .orderBy(cardGenerationEventsV2.eventSeq)
      .limit(100);

    return events.map((e) => ({
      eventSeq: e.eventSeq,
      eventType: e.eventType,
      // §17.1/§22.3：SSE/事件流 payload 白名单裁剪，私有内容字段不透传。
      payload: sanitizeEventPayloadV2(e.payload as Record<string, unknown>),
      createdAt: e.createdAt.toISOString(),
    }));
  });
}

export async function closeGenerationRunV2(ctx: RunContext, runId: string, expectedReviewDraftRevision: number) {
  return withWorkspaceTransaction(ctx, async (tx) => {
    const runRows = await tx.select().from(cardGenerationRunsV2)
      .where(and(eq(cardGenerationRunsV2.id, runId), eq(cardGenerationRunsV2.workspaceId, ctx.workspaceId)))
      .limit(1);
    if (runRows.length === 0) return null;

    const run = runRows[0];
    // 审核开放态即可结束审核。needs_attention 的 run 也归审核页所有，用户决定
    // 一张都不要之后必须能把这次审核收尾，否则它只能永远挂在恢复态里。
    if (!isCardGenerationReviewOpen(run.status)) {
      throw new CardGenerationV2ServiceError("invalid_state", 409, "只有 review_ready 状态的运行可以关闭");
    }
    if (run.reviewDraftRevision !== expectedReviewDraftRevision) {
      throw new CardGenerationV2ServiceError("stale_review_draft", 409, "审核草稿已变更，请刷新");
    }

    // Mark all undecided candidates as rejected
    await tx.update(cardGenerationCandidatesV2)
      .set({ reviewDecision: "reject", reviewReasonCode: "user_closed_without_activation", updatedAt: new Date() })
      .where(and(
        eq(cardGenerationCandidatesV2.runId, runId),
        eq(cardGenerationCandidatesV2.workspaceId, ctx.workspaceId),
        eq(cardGenerationCandidatesV2.reviewDecision, "undecided"),
      ));

    const closedRows = await tx.update(cardGenerationRunsV2)
      .set({
        status: "closed_without_activation",
        reviewDraftRevision: run.reviewDraftRevision + 1,
        updatedAt: new Date(),
      })
      .where(and(
        eq(cardGenerationRunsV2.id, runId),
        eq(cardGenerationRunsV2.workspaceId, ctx.workspaceId),
        // CAS：确保并发 close 不覆盖彼此（方案 20 §17.1）
        eq(cardGenerationRunsV2.reviewDraftRevision, expectedReviewDraftRevision),
      ))
      .returning({ id: cardGenerationRunsV2.id, reviewDraftRevision: cardGenerationRunsV2.reviewDraftRevision });

    if (closedRows.length === 0) {
      throw new CardGenerationV2ServiceError("stale_review_draft", 409, "审核草稿已变更，请刷新");
    }

    await insertEvent(tx, ctx.workspaceId, runId, "card_generation.closed_without_activation", {});

    return {
      runId,
      status: "closed_without_activation",
      reviewDraftRevision: closedRows[0].reviewDraftRevision,
    };
  });
}

export async function cancelGenerationRunV2(ctx: RunContext, runId: string) {
  return withWorkspaceTransaction(ctx, async (tx) => {
    const runRows = await tx.select().from(cardGenerationRunsV2)
      .where(and(eq(cardGenerationRunsV2.id, runId), eq(cardGenerationRunsV2.workspaceId, ctx.workspaceId)))
      .limit(1);
    if (runRows.length === 0) return null;

    const run = runRows[0];
    const cancellable = ["queued", "source_sealing", "planning", "authoring", "review_ready"];
    if (!cancellable.includes(run.status)) {
      throw new CardGenerationV2ServiceError("invalid_state", 409, "当前状态不可取消");
    }

    // P12 FIX: CAS update — ensure status hasn't changed concurrently
    const cancelled = await tx.update(cardGenerationRunsV2)
      .set({ status: "cancelled", updatedAt: new Date() })
      .where(and(
        eq(cardGenerationRunsV2.id, runId),
        eq(cardGenerationRunsV2.workspaceId, ctx.workspaceId),
        eq(cardGenerationRunsV2.status, run.status),
      ))
      .returning({ id: cardGenerationRunsV2.id });
    if (cancelled.length === 0) {
      throw new CardGenerationV2ServiceError("stale_run_status", 409, "运行状态已被并发修改，请刷新");
    }

    return { runId, status: "cancelled" };
  });
}

/**
 * 就地重试一次质量门禁失败的 run（2026-09-18，补齐产品缺口）。
 *
 * ## 为什么需要它
 * 当**唯一候选**被 critic 否决（例如 pedagogy 判 `multiple_learning_objectives`）时，
 * 整条 run 会终态化为 `needs_attention`，且没有候选可审核。此前恢复契约只签发
 * `return_note` / `start_new_generation`——用户唯一的出路是**回笔记重开一次全新生成**：
 * 重新封存来源、重跑 planner、重付全部 token（实测一次 25–55s），而失败往往只是
 * critic 的一次判断波动（同一 prompt 的相邻两次运行结论可以不同）。
 *
 * 这个入口让"再试一次"变成一次显式、低成本、用户可见的选择：复用已经封存的来源与
 * 输入快照，只派发一次**重规划**（新 plan revision + supersede 旧候选 + 重新 author），
 * 走的是 worker 早已实现并状态门闩受限的 `card_generation_replan_set` 任务。
 *
 * ## 为什么不是自动重试
 * 契约与既有纪律一致：恢复动作只由服务端签发、由**用户点击**触发。自动重试会把
 * "模型判断波动"变成不可见的 token 消耗，也会掩盖真正的确定性缺陷。
 *
 * ## 守卫（服务端独立校验，不信任投影）
 * - run 必须存在；
 * - status 必须是 `needs_attention`（failed/stale/其它一律拒绝）；
 * - `error_code` 必须是 `quality_gate_failed`（provider/配置类失败重跑没有意义；
 *   实测 `generation_failed` + "missing API key" 会在重试后原样再失败一次）；
 * - 来源不得过期（对着过期来源重跑只会再失败一次）；
 * - 不得已有在飞行的 outbox 任务（双击/并发重试 → 409，避免重复烧 token）。
 */
export async function retryGenerationRunV2(ctx: RunContext, runId: string) {
  return withWorkspaceTransaction(ctx, async (tx) => {
    const runRows = await tx.select().from(cardGenerationRunsV2)
      .where(and(eq(cardGenerationRunsV2.id, runId), eq(cardGenerationRunsV2.workspaceId, ctx.workspaceId)))
      .limit(1);
    if (runRows.length === 0) return null;
    const run = runRows[0];

    if (run.status !== "needs_attention") {
      throw new CardGenerationV2ServiceError(
        "invalid_state",
        409,
        "只有需要处理（needs_attention）的运行可以就地重试",
      );
    }
    if (run.errorCode !== "quality_gate_failed") {
      throw new CardGenerationV2ServiceError(
        "not_retryable",
        409,
        "这次失败不是质量门禁造成的，就地重试无法改变结果；请修复配置或重新生成",
      );
    }
    // 来源过期守卫：run 绑定的 note 版本已不是最新 → 重跑只会对着过期内容再产出一批
    // 注定要被 source_outdated 标记的候选，用户应当先回笔记重开一次生成。
    if (await checkSourceOutdated(tx, ctx.workspaceId, run.noteId, run.noteVersionId, run.sourceContentHash)) {
      throw new CardGenerationV2ServiceError(
        "source_outdated",
        409,
        "笔记已有新版本，请回到笔记重新生成",
      );
    }

    // 在飞行的任务守卫：重试期间已有 worker 在跑 → 拒绝，避免同一 run 并发重跑。
    const inFlight = await tx
      .select({ id: cardGenerationRunOutboxV2.id })
      .from(cardGenerationRunOutboxV2)
      .where(and(
        eq(cardGenerationRunOutboxV2.runId, runId),
        eq(cardGenerationRunOutboxV2.workspaceId, ctx.workspaceId),
        inArray(cardGenerationRunOutboxV2.status, ["pending", "processing"]),
      ))
      .limit(1);
    if (inFlight.length > 0) {
      throw new CardGenerationV2ServiceError("retry_in_flight", 409, "这次运行仍在处理中，请稍后再试");
    }

    // CAS：只有仍是 needs_attention 才允许推进，避免与并发动作竞争。
    // 状态回到 checking（工作态）并清掉失败码——用户界面应立即体现"又动起来了"，
    // 而不是继续显示"需要处理"直到 worker 更新。
    const advanced = await tx.update(cardGenerationRunsV2)
      .set({ status: "checking", errorCode: null, errorMessage: null, updatedAt: new Date() })
      .where(and(
        eq(cardGenerationRunsV2.id, runId),
        eq(cardGenerationRunsV2.workspaceId, ctx.workspaceId),
        eq(cardGenerationRunsV2.status, "needs_attention"),
      ))
      .returning({ id: cardGenerationRunsV2.id });
    if (advanced.length === 0) {
      throw new CardGenerationV2ServiceError("stale_run_status", 409, "运行状态已被并发修改，请刷新");
    }

    // 复用既有的 replan 任务：新 plan revision + supersede 旧候选 + 重新 author。
    // 不传 feedbackReasonCodes —— 用户没有给反馈，他只是要求再试一次。
    await tx.insert(cardGenerationRunOutboxV2).values({
      workspaceId: ctx.workspaceId,
      runId,
      jobType: "card_generation_replan_set",
      payload: { runId, workspaceId: ctx.workspaceId },
      status: "pending",
    });

    await insertEvent(tx, ctx.workspaceId, runId, "card_generation.retry_requested", {
      reason: "user_requested_after_quality_gate",
    });

    return { runId, status: "checking" as const };
  });
}
