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
} from "../../db/schema/card-generation-v2.ts";
import {
  sealEvidenceSnapshotsV2,
} from "./evidence-seal-service.ts";
import { notes, noteVersions, noteBlocks } from "../../db/schema/note.ts";
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
import {
  sanitizeEventPayloadV2,
  CardGenerationV2ServiceError,
  insertEvent,
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
        stageRuntimes: [
          {
            stage: "planner" as const,
            providerId: "system",
            modelSnapshot: "v1",
            deploymentId: "local",
            capabilityFingerprint: "basic",
            promptVersion: "v2",
            sampling: { temperature: 0 },
            outputSchemaVersion: "v2",
          },
          {
            stage: "author" as const,
            providerId: "system",
            modelSnapshot: "v1",
            deploymentId: "local",
            capabilityFingerprint: "basic",
            promptVersion: "v2",
            sampling: { temperature: 0 },
            outputSchemaVersion: "v2",
          },
          {
            stage: "grounding_critic" as const,
            providerId: "system",
            modelSnapshot: "v1",
            deploymentId: "local",
            capabilityFingerprint: "basic",
            promptVersion: "v2",
            sampling: { temperature: 0 },
            outputSchemaVersion: "v2",
          },
          {
            stage: "pedagogy_critic" as const,
            providerId: "system",
            modelSnapshot: "v1",
            deploymentId: "local",
            capabilityFingerprint: "basic",
            promptVersion: "v2",
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
    return serializeRunPublic(rows[0], tx);
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
    if (run.status !== "review_ready") {
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
