import { createHash } from "node:crypto";
import {
  and,
  asc,
  count,
  desc,
  eq,
  inArray,
  notInArray,
  sql,
} from "drizzle-orm";
import {
  CardGenerationRunStatus,
  CardGenerationStage,
  CardGenerationUnitKind,
  CARD_GENERATION_IMAGE_WINDOW,
  CARD_GENERATION_MAP_WINDOW,
  CARD_GENERATION_MAX_BLOCKS,
  CARD_GENERATION_MAX_IMAGES,
  CARD_GENERATION_MAX_SOURCE_CHARS,
  JobResourceClass,
  JobStatus,
  JobType,
  MAX_PENDING_JOBS_PER_WORKSPACE,
  isCardGenerationV2Enabled,
} from "@ailearn/shared";
import { withWorkspaceTransaction, type ApiTransaction } from "../../db/client.ts";
import {
  cardGenerationEvents,
  cardGenerationRuns,
  cardGenerationUnits,
  type CardGenerationAssetManifestEntry,
  type CardGenerationBlockManifestEntry,
  type CardGenerationExclusionPolicy,
} from "../../db/schema/card-generation.ts";
import { learningCards } from "../../db/schema/card.ts";
import { jobs } from "../../db/schema/job.ts";
import { noteBlocks, noteImageAssets, notes, noteVersions } from "../../db/schema/note.ts";
import type {
  ContinueWithExclusionsInput,
  CreateCardGenerationRunInput,
} from "./schema.ts";

const LEGACY_PIPELINE_VERSION = "card-generation-v2-m1";
const TEXT_PIPELINE_VERSION = "card-generation-v2-m5";
const LEGACY_PROMPT_BUNDLE_VERSION = "legacy-card-v1";
const TEXT_PROMPT_BUNDLE_VERSION = "map-candidate-v1+deck-plan-v1";
const IMAGE_PROMPT_BUNDLE_VERSION =
  "map-candidate-v1+image-understanding-v1+deck-plan-v1";
const TERMINAL_STATUSES = [
  CardGenerationRunStatus.PARTIAL_READY,
  CardGenerationRunStatus.SUCCEEDED,
  CardGenerationRunStatus.CANCELLED,
  CardGenerationRunStatus.SUPERSEDED,
] as const;
const CANCELLABLE_STATUSES = new Set<string>([
  CardGenerationRunStatus.QUEUED,
  CardGenerationRunStatus.PLANNING,
  CardGenerationRunStatus.AWAITING_ASSETS,
  CardGenerationRunStatus.MAPPING,
  CardGenerationRunStatus.REDUCING,
  CardGenerationRunStatus.RENDERING,
  CardGenerationRunStatus.VALIDATING,
  CardGenerationRunStatus.PUBLISHING,
]);

type GenerationRunRow = typeof cardGenerationRuns.$inferSelect;

export class CardGenerationServiceError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, statusCode: number, message: string) {
    super(message);
    this.name = "CardGenerationServiceError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export type CardGenerationRunView = {
  runId: string;
  noteId: string;
  noteVersionId: string;
  status: string;
  stage: string;
  stateVersion: number;
  sequence: number;
  sourceSnapshot: {
    noteVersionId: string;
    versionNo: number;
    contentHash: string;
  };
  progress: { completed: number; total: number; unit: string };
  coverage: {
    sourceUnitsCompleted: number;
    sourceUnitsTotal: number;
    imagesCompleted: number;
    imagesTotal: number;
    sourceCoverageBps: number | null;
    imageCoverageBps: number | null;
  };
  warnings: Array<{ code: string; details?: Record<string, unknown> }>;
  actions: {
    retryable: boolean;
    cancellable: boolean;
    canContinueWithExclusions: boolean;
  };
  result: { cardId: string | null; cardSetId: string | null } | null;
  error: { code: string; retryable: boolean } | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
};

export type CardGenerationRunAccepted = {
  runId: string;
  status: string;
  sourceSnapshot: { noteVersionId: string; versionNo: number; contentHash: string };
  canContinueEditing: true;
};

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function hashJson(value: unknown): string {
  return sha256(JSON.stringify(value));
}

export function buildGenerationManifests(
  blocks: Array<{ id: string; ordinal: number; type: string; content: string; imageAssetId?: string | null }>,
  assetHashById: ReadonlyMap<string, string> = new Map(),
): {
  blockManifest: CardGenerationBlockManifestEntry[];
  assetManifest: CardGenerationAssetManifestEntry[];
  blockManifestHash: string;
  assetManifestHash: string;
} {
  const ordered = [...blocks].sort((a, b) => a.ordinal - b.ordinal || a.id.localeCompare(b.id));
  const blockManifest = ordered.map((block) => ({
    blockId: block.id,
    ordinal: block.ordinal,
    type: block.type,
    contentHash: sha256(block.content),
  }));
  const assetManifest = ordered
    .filter((block) => block.type === "image")
    .map((block) => ({
      blockId: block.id,
      ordinal: block.ordinal,
      sourceHash: block.imageAssetId
        ? assetHashById.get(block.imageAssetId) ?? sha256(block.content)
        : sha256(block.content),
      ...(block.imageAssetId ? { assetId: block.imageAssetId } : {}),
    }));
  return {
    blockManifest,
    assetManifest,
    blockManifestHash: hashJson(blockManifest),
    assetManifestHash: hashJson(assetManifest),
  };
}

export function buildGenerationFingerprint(input: {
  workspaceId: string;
  noteId: string;
  noteVersionId: string;
  titleSnapshot: string;
  sourceContentHash: string;
  blockManifestHash: string;
  assetManifestHash: string;
  pipelineVersion?: string;
}): string {
  const { pipelineVersion = LEGACY_PIPELINE_VERSION, ...snapshot } = input;
  return hashJson({
    contract: "card-generation-fingerprint-v2",
    pipelineVersion,
    ...snapshot,
  });
}

function iso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

async function toRunView(
  tx: ApiTransaction,
  run: GenerationRunRow,
): Promise<CardGenerationRunView> {
  const version = await tx.query.noteVersions.findFirst({
    columns: { versionNo: true },
    where: and(
      eq(noteVersions.id, run.noteVersionId),
      eq(noteVersions.workspaceId, run.workspaceId),
    ),
  });
  if (!version) {
    throw new CardGenerationServiceError("source_snapshot_missing", 409, "生成快照已不存在");
  }

  const warnings: CardGenerationRunView["warnings"] = [];
  const executionMode = run.providerSnapshot.executionMode;
  const textPipeline = executionMode === "text_v2" || executionMode === "multimodal_v2";
  const failedCheckpoints = run.status === CardGenerationRunStatus.NEEDS_ATTENTION
    ? await tx.query.cardGenerationUnits.findMany({
        where: and(
          eq(cardGenerationUnits.workspaceId, run.workspaceId),
          eq(cardGenerationUnits.runId, run.id),
          inArray(cardGenerationUnits.status, ["terminal_failed", "retryable_failed"]),
        ),
        orderBy: [asc(cardGenerationUnits.ordinal)],
      })
    : [];
  const failedUnitDetails = failedCheckpoints.map((unit) => ({
    unitId: unit.id,
    kind: unit.kind,
    ordinal: unit.ordinal,
    status: unit.status,
    errorCode: unit.errorCode,
    ...(unit.kind === CardGenerationUnitKind.IMAGE
      ? {
          imageAssetId: unit.inputManifest.imageAssetId ?? null,
          imageBlockId: unit.inputManifest.imageBlockId ?? null,
        }
      : {}),
  }));
  const excludableImageUnits = failedCheckpoints.filter(
    (unit) =>
      unit.kind === CardGenerationUnitKind.IMAGE
      && unit.status === "terminal_failed"
      && typeof unit.inputManifest.imageAssetId === "string"
      && typeof unit.inputManifest.imageBlockId === "string",
  );
  const latestNoteFence = run.status === CardGenerationRunStatus.NEEDS_ATTENTION
    ? await tx.query.notes.findFirst({
        columns: {
          cardGenerationEpoch: true,
          latestGenerationRunId: true,
        },
        where: and(
          eq(notes.id, run.noteId),
          eq(notes.workspaceId, run.workspaceId),
        ),
      })
    : null;
  if (!textPipeline && (run.sourceCoverageBps === null || run.imageCoverageBps === null)) {
    warnings.push({ code: "coverage_unmeasured", details: { bridge: "legacy_generator" } });
  }
  if (!textPipeline && run.requiredImages > 0) {
    warnings.push({
      code: "image_pipeline_not_active",
      details: { requiredImages: run.requiredImages },
    });
  }
  if (failedUnitDetails.length > 0) {
    warnings.push({
      code: "generation_units_failed",
      details: { units: failedUnitDetails },
    });
  }
  if (run.exclusionPolicy?.mode === "explicit_image_exclusions_v1") {
    warnings.push({
      code: "partial_coverage",
      details: {
        sourceRunId: run.exclusionPolicy.sourceRunId,
        excludedImageCount: run.exclusionPolicy.excludedUnits.length,
        excludedUnitIds: run.exclusionPolicy.excludedUnits.map((unit) => unit.sourceUnitId),
        excludedImages: run.exclusionPolicy.excludedUnits.map((unit) => ({
          imageAssetId: unit.imageAssetId,
          imageBlockId: unit.imageBlockId,
          reason: unit.errorCode ?? "image_analysis_failed",
        })),
        imagesCompleted: run.completedImages,
        imagesTotal: run.requiredImages,
        imageCoverageBps: run.imageCoverageBps,
        policyAdjustedImageCoverageBps:
          Number(run.coverageReport.policyAdjustedImageCoverageBps ?? 0),
      },
    });
  }

  const terminal = TERMINAL_STATUSES.includes(run.status as (typeof TERMINAL_STATUSES)[number]);
  const progressComplete =
    run.status === CardGenerationRunStatus.SUCCEEDED
    || run.status === CardGenerationRunStatus.PARTIAL_READY;
  const result = run.resultCardId || run.resultCardSetId
    ? { cardId: run.resultCardId, cardSetId: run.resultCardSetId }
    : null;

  return {
    runId: run.id,
    noteId: run.noteId,
    noteVersionId: run.noteVersionId,
    status: run.status,
    stage: run.stage,
    stateVersion: run.stateVersion,
    sequence: Math.max(0, run.nextEventSequence - 1),
    sourceSnapshot: {
      noteVersionId: run.noteVersionId,
      versionNo: version.versionNo,
      contentHash: run.sourceContentHash,
    },
    progress: {
      completed: textPipeline ? run.completedUnits : progressComplete ? 1 : 0,
      total: textPipeline ? run.requiredUnits : 1,
      unit: textPipeline ? "source_units" : "legacy_job",
    },
    coverage: {
      sourceUnitsCompleted: run.completedUnits,
      sourceUnitsTotal: run.requiredUnits,
      imagesCompleted: run.completedImages,
      imagesTotal: run.requiredImages,
      sourceCoverageBps: run.sourceCoverageBps,
      imageCoverageBps: run.imageCoverageBps,
    },
    warnings,
    actions: {
      retryable: run.status === CardGenerationRunStatus.NEEDS_ATTENTION && run.retryable,
      cancellable: CANCELLABLE_STATUSES.has(run.status),
      canContinueWithExclusions:
        run.status === CardGenerationRunStatus.NEEDS_ATTENTION
        && executionMode === "multimodal_v2"
        && excludableImageUnits.length > 0
        && latestNoteFence?.cardGenerationEpoch === run.generationEpoch
        && latestNoteFence.latestGenerationRunId === run.id,
    },
    result,
    error: run.errorCode ? { code: run.errorCode, retryable: run.retryable } : null,
    createdAt: run.createdAt.toISOString(),
    startedAt: iso(run.startedAt),
    finishedAt: terminal || run.finishedAt ? iso(run.finishedAt) : null,
  };
}

async function getRunRowForWorkspace(
  tx: ApiTransaction,
  runId: string,
  workspaceId: string,
): Promise<GenerationRunRow | null> {
  return await tx.query.cardGenerationRuns.findFirst({
    where: and(
      eq(cardGenerationRuns.id, runId),
      eq(cardGenerationRuns.workspaceId, workspaceId),
    ),
  }) ?? null;
}

function assertPendingQuota(pendingCount: number): void {
  if (pendingCount >= MAX_PENDING_JOBS_PER_WORKSPACE) {
    throw new CardGenerationServiceError(
      "job_quota_exceeded",
      429,
      "当前后台任务较多，请稍后重试",
    );
  }
}

function legacyJobValues(input: {
  workspaceId: string;
  userId: string;
  noteVersionId: string;
  runId: string;
  idempotencyKey: string;
  oldCardId?: string;
}) {
  return {
    type: JobType.GENERATE_CARD,
    workspaceId: input.workspaceId,
    requestedBy: input.userId,
    payload: {
      noteVersionId: input.noteVersionId,
      generationRunId: input.runId,
      userId: input.userId,
      ...(input.oldCardId ? { oldCardId: input.oldCardId } : {}),
    },
    status: JobStatus.PENDING,
    generationRunId: input.runId,
    stage: CardGenerationStage.LEGACY_GENERATE,
    priority: 50,
    resourceClass: JobResourceClass.CARD_FOREGROUND,
    idempotencyKey: input.idempotencyKey,
  } as const;
}

function plannerJobValues(input: {
  workspaceId: string;
  userId: string;
  noteVersionId: string;
  runId: string;
  unitId: string;
}) {
  return {
    type: JobType.PLAN_CARD_GENERATION,
    workspaceId: input.workspaceId,
    requestedBy: input.userId,
    payload: {
      noteVersionId: input.noteVersionId,
      generationRunId: input.runId,
      generationUnitId: input.unitId,
      userId: input.userId,
    },
    status: JobStatus.PENDING,
    generationRunId: input.runId,
    generationUnitId: input.unitId,
    stage: CardGenerationStage.PLANNER,
    priority: 80,
    resourceClass: JobResourceClass.CARD_FOREGROUND,
    idempotencyKey: `generation-run:${input.runId}:planner:0`,
  } as const;
}

function generationUnitJobValues(input: {
  workspaceId: string;
  userId: string;
  noteVersionId: string;
  runId: string;
  unit: typeof cardGenerationUnits.$inferSelect;
}) {
  const descriptor = input.unit.kind === CardGenerationUnitKind.PLANNER
    ? {
        type: JobType.PLAN_CARD_GENERATION,
        stage: CardGenerationStage.PLANNER,
        priority: 80,
        resourceClass: JobResourceClass.CARD_FOREGROUND,
      }
    : input.unit.kind === CardGenerationUnitKind.TEXT_MAP
      ? {
          type: JobType.MAP_CARD_GENERATION,
          stage: CardGenerationStage.TEXT_MAP,
          priority: 40,
          resourceClass: JobResourceClass.CARD_MAP,
        }
      : input.unit.kind === CardGenerationUnitKind.IMAGE
        ? {
            type: JobType.ANALYZE_CARD_IMAGE,
            stage: CardGenerationStage.IMAGE_ANALYSIS,
            priority: 45,
            resourceClass: JobResourceClass.VISION,
          }
      : input.unit.kind === CardGenerationUnitKind.SECTION_REDUCE
        ? {
            type: JobType.REDUCE_CARD_GENERATION,
            stage: CardGenerationStage.SECTION_REDUCE,
            priority: 70,
            resourceClass: JobResourceClass.CARD_FOREGROUND,
          }
        : input.unit.kind === CardGenerationUnitKind.DECK_PLAN
          ? {
              type: JobType.PLAN_CARD_SET,
              stage: CardGenerationStage.DECK_PLAN,
              priority: 75,
              resourceClass: JobResourceClass.CARD_FOREGROUND,
            }
          : input.unit.kind === CardGenerationUnitKind.CARD_RENDER
            ? {
                type: JobType.RENDER_CARD_GENERATION,
                stage: CardGenerationStage.CARD_RENDER,
                priority: 65,
                resourceClass: JobResourceClass.CARD_FOREGROUND,
              }
        : input.unit.kind === CardGenerationUnitKind.PUBLISH
          ? {
              type: JobType.PUBLISH_CARD_GENERATION,
              stage: CardGenerationStage.PUBLISH,
              priority: 80,
              resourceClass: JobResourceClass.CARD_FOREGROUND,
            }
          : null;
  if (!descriptor) {
    throw new CardGenerationServiceError(
      "generation_unit_not_retryable",
      409,
      "当前失败步骤不能通过此接口重试",
    );
  }
  return {
    ...descriptor,
    workspaceId: input.workspaceId,
    requestedBy: input.userId,
    payload: {
      noteVersionId: input.noteVersionId,
      generationRunId: input.runId,
      generationUnitId: input.unit.id,
      userId: input.userId,
    },
    status: JobStatus.PENDING,
    generationRunId: input.runId,
    generationUnitId: input.unit.id,
    idempotencyKey:
      `generation-run:${input.runId}:unit:${input.unit.id}:attempt:${input.unit.attempts + 1}`,
  } as const;
}

export async function createCardGenerationRun(
  context: { workspaceId: string; userId: string },
  input: CreateCardGenerationRunInput & { oldCardId?: string },
): Promise<CardGenerationRunAccepted> {
  return withWorkspaceTransaction(context, async (tx) => {
    // Keep the queue advisory lock outermost: the worker publish path already
    // holds this lock before it locks run/note rows.
    await tx.execute(sql`
      SELECT pg_advisory_xact_lock(
        hashtextextended(${`job-quota:${context.workspaceId}`}, 0)
      )
    `);

    const replay = await tx.query.cardGenerationRuns.findFirst({
      where: and(
        eq(cardGenerationRuns.workspaceId, context.workspaceId),
        eq(cardGenerationRuns.requestIdempotencyKey, input.idempotencyKey),
      ),
    });
    if (replay) {
      if (replay.noteVersionId !== input.noteVersionId || replay.requestedBy !== context.userId) {
        throw new CardGenerationServiceError(
          "idempotency_key_reused",
          409,
          "幂等键已被另一请求使用",
        );
      }
      const replayView = await toRunView(tx, replay);
      return {
        runId: replay.id,
        status: replay.status,
        sourceSnapshot: replayView.sourceSnapshot,
        canContinueEditing: true,
      };
    }

    const candidateVersion = await tx.query.noteVersions.findFirst({
      columns: { id: true, noteId: true },
      where: and(
        eq(noteVersions.id, input.noteVersionId),
        eq(noteVersions.workspaceId, context.workspaceId),
      ),
    });
    if (!candidateVersion) {
      throw new CardGenerationServiceError("note_version_not_found", 404, "笔记版本不存在");
    }

    // Fixed row-lock order for all snapshot writers: note, then version.
    const [note] = await tx
      .select()
      .from(notes)
      .where(and(
        eq(notes.id, candidateVersion.noteId),
        eq(notes.workspaceId, context.workspaceId),
        sql`${notes.deletedAt} IS NULL`,
      ))
      .for("update");
    if (!note) {
      throw new CardGenerationServiceError("note_not_found", 404, "笔记不存在");
    }

    const [version] = await tx
      .select()
      .from(noteVersions)
      .where(and(
        eq(noteVersions.id, input.noteVersionId),
        eq(noteVersions.noteId, note.id),
        eq(noteVersions.workspaceId, context.workspaceId),
      ))
      .for("update");
    if (!version) {
      throw new CardGenerationServiceError("note_version_not_found", 404, "笔记版本不存在");
    }

    const blocks = await tx.query.noteBlocks.findMany({
      where: and(
        eq(noteBlocks.versionId, version.id),
        eq(noteBlocks.workspaceId, context.workspaceId),
      ),
      orderBy: [asc(noteBlocks.ordinal)],
    });
    if (blocks.length === 0) {
      throw new CardGenerationServiceError("empty_note", 422, "笔记没有可生成的内容");
    }

    const imageAssetIds = [...new Set(blocks
      .filter((block) => block.type === "image" && block.imageAssetId)
      .map((block) => block.imageAssetId!))];
    const imageAssets = imageAssetIds.length > 0
      ? await tx.query.noteImageAssets.findMany({
          where: and(
            eq(noteImageAssets.workspaceId, context.workspaceId),
            inArray(noteImageAssets.id, imageAssetIds),
          ),
        })
      : [];
    const activeImageAssets = imageAssets.filter((asset) => asset.status === "ready" && !asset.deletedAt);
    const assetHashById = new Map(activeImageAssets.map((asset) => [asset.id, asset.sha256]));
    const imageBlocks = blocks.filter((block) => block.type === "image");
    if (imageBlocks.some((block) => !block.imageAssetId || !assetHashById.has(block.imageAssetId))) {
      throw new CardGenerationServiceError(
        "image_asset_unresolved",
        422,
        "笔记包含尚未注册为图片资产的图片，请重新上传后再生成",
      );
    }
    const manifests = buildGenerationManifests(blocks, assetHashById);
    const textSourceChars = blocks
      .filter((block) => block.type !== "image")
      .reduce((total, block) => total + block.content.length, 0);
    const executionMode = isCardGenerationV2Enabled()
      ? manifests.assetManifest.length > 0 ? "multimodal_v2" : "text_v2"
      : "legacy_bridge";
    const pipelineVersion = executionMode === "text_v2" || executionMode === "multimodal_v2"
      ? TEXT_PIPELINE_VERSION
      : LEGACY_PIPELINE_VERSION;
    // 显式的 input_limit_exceeded 同样适用于 legacy_bridge：M6 已移除 legacy
    // handler 的 12k 静默截断，若回滚路径不做预检，一篇 500k 字符的笔记会变成
    // 单次无上限的 provider 请求（G3 只禁止"静默"降级，不禁止显式失败）。
    if (
      blocks.length > CARD_GENERATION_MAX_BLOCKS
      || textSourceChars > CARD_GENERATION_MAX_SOURCE_CHARS
      || manifests.assetManifest.length > CARD_GENERATION_MAX_IMAGES
    ) {
      throw new CardGenerationServiceError(
        "input_limit_exceeded",
        422,
        "生成输入超出产品配额，请拆分笔记后重试",
      );
    }
    const generationFingerprint = buildGenerationFingerprint({
      workspaceId: context.workspaceId,
      noteId: note.id,
      noteVersionId: version.id,
      titleSnapshot: note.title,
      sourceContentHash: version.contentHash,
      blockManifestHash: manifests.blockManifestHash,
      assetManifestHash: manifests.assetManifestHash,
      pipelineVersion,
    });

    const active = await tx.query.cardGenerationRuns.findFirst({
      where: and(
        eq(cardGenerationRuns.workspaceId, context.workspaceId),
        eq(cardGenerationRuns.noteVersionId, version.id),
        eq(cardGenerationRuns.generationFingerprint, generationFingerprint),
        notInArray(cardGenerationRuns.status, [...TERMINAL_STATUSES]),
      ),
      orderBy: [desc(cardGenerationRuns.createdAt)],
    });
    if (active) {
      const activeView = await toRunView(tx, active);
      return {
        runId: active.id,
        status: active.status,
        sourceSnapshot: activeView.sourceSnapshot,
        canContinueEditing: true,
      };
    }

    const pendingRows = await tx
      .select({ count: count() })
      .from(jobs)
      .where(and(
        eq(jobs.workspaceId, context.workspaceId),
        eq(jobs.status, JobStatus.PENDING),
      ));
    assertPendingQuota(Number(pendingRows[0]?.count ?? 0));

    const now = new Date();
    if (!version.sealedAt) {
      await tx
        .update(noteVersions)
        .set({ sealedAt: now, sealedReason: "card_generation_v2" })
        .where(and(
          eq(noteVersions.id, version.id),
          eq(noteVersions.workspaceId, context.workspaceId),
          sql`${noteVersions.sealedAt} IS NULL`,
        ));
    }

    const generationEpoch = note.cardGenerationEpoch + 1;
    const [run] = await tx
      .insert(cardGenerationRuns)
      .values({
        workspaceId: context.workspaceId,
        noteId: note.id,
        noteVersionId: version.id,
        requestedBy: context.userId,
        requestIdempotencyKey: input.idempotencyKey,
        generationFingerprint,
        generationEpoch,
        supersedesRunId: note.latestGenerationRunId,
        titleSnapshot: note.title,
        sourceContentHash: version.contentHash,
        blockManifestHash: manifests.blockManifestHash,
        assetManifestHash: manifests.assetManifestHash,
        blockManifest: manifests.blockManifest,
        assetManifest: manifests.assetManifest,
        pipelineVersion,
        promptBundleVersion: executionMode === "multimodal_v2"
          ? IMAGE_PROMPT_BUNDLE_VERSION
          : executionMode === "text_v2" ? TEXT_PROMPT_BUNDLE_VERSION
          : LEGACY_PROMPT_BUNDLE_VERSION,
        providerSnapshot: {
          executionMode,
          ...(executionMode !== "legacy_bridge" ? {
            capabilityPolicy: "conservative-32k-v1",
            mapPromptVersion: TEXT_PROMPT_BUNDLE_VERSION,
          } : {}),
          ...(input.oldCardId ? { oldCardId: input.oldCardId } : {}),
        },
        governancePolicyVersion: "workspace-policy-snapshot-v1",
        status: CardGenerationRunStatus.QUEUED,
        stage: CardGenerationStage.QUEUED,
        stateVersion: 1,
        nextEventSequence: 2,
        retryable: true,
        requiredUnits: executionMode !== "legacy_bridge" ? 0 : manifests.blockManifest.length,
        completedUnits: 0,
        requiredImages: imageAssetIds.length,
        completedImages: 0,
        sourceCoverageBps: executionMode !== "legacy_bridge" ? 0 : null,
        imageCoverageBps: executionMode !== "legacy_bridge"
          ? imageAssetIds.length === 0 ? 10_000 : 0
          : null,
        coverageReport: executionMode !== "legacy_bridge"
          ? { measurement: "planned", plannerVersion: null }
          : { measurement: "unmeasured", bridge: "legacy_generator" },
      })
      .returning();

    await tx
      .update(notes)
      .set({
        cardGenerationEpoch: generationEpoch,
        latestGenerationRunId: run.id,
        updatedAt: now,
      })
      .where(and(eq(notes.id, note.id), eq(notes.workspaceId, context.workspaceId)));

    await tx.insert(cardGenerationEvents).values({
      runId: run.id,
      workspaceId: context.workspaceId,
      sequence: 1,
      stage: CardGenerationStage.SNAPSHOT,
      state: CardGenerationRunStatus.QUEUED,
      completed: manifests.blockManifest.length,
      total: manifests.blockManifest.length,
      unit: "blocks",
      messageCode: "source_snapshot_sealed",
      safeDetails: {
        versionNo: version.versionNo,
        blockCount: manifests.blockManifest.length,
        imageCount: imageAssetIds.length,
      },
      createdAt: now,
    });

    let job: typeof jobs.$inferSelect;
    if (executionMode !== "legacy_bridge") {
      const [plannerUnit] = await tx
        .insert(cardGenerationUnits)
        .values({
          workspaceId: context.workspaceId,
          runId: run.id,
          kind: CardGenerationUnitKind.PLANNER,
          level: 0,
          ordinal: 0,
          unitKey: `planner:${run.generationFingerprint}`,
          pipelineVersion,
          required: true,
          inputManifest: {},
          inputHash: run.generationFingerprint,
          tokenEstimate: 0,
          status: "pending",
          scheduledAt: now,
        })
        .returning();
      [job] = await tx
        .insert(jobs)
        .values(plannerJobValues({
          workspaceId: context.workspaceId,
          userId: context.userId,
          noteVersionId: version.id,
          runId: run.id,
          unitId: plannerUnit.id,
        }))
        .returning();
    } else {
      [job] = await tx
        .insert(jobs)
        .values(legacyJobValues({
          workspaceId: context.workspaceId,
          userId: context.userId,
          noteVersionId: version.id,
          runId: run.id,
          idempotencyKey: `generation-run:${run.id}:legacy:1`,
          oldCardId: input.oldCardId,
        }))
        .returning();
    }

    await tx
      .update(cardGenerationRuns)
      .set({ legacyJobId: job.id, updatedAt: now })
      .where(and(
        eq(cardGenerationRuns.id, run.id),
        eq(cardGenerationRuns.workspaceId, context.workspaceId),
      ));

    return {
      runId: run.id,
      status: run.status,
      sourceSnapshot: {
        noteVersionId: version.id,
        versionNo: version.versionNo,
        contentHash: version.contentHash,
      },
      canContinueEditing: true,
    };
  });
}

/**
 * Derive a new run from a strict failure after the owner explicitly excludes
 * one or more failed images. The sealed snapshot remains unchanged; the
 * exclusion policy is a separate, immutable input to the derived fingerprint.
 */
export async function continueCardGenerationRunWithExclusions(
  context: { workspaceId: string; userId: string },
  sourceRunId: string,
  input: ContinueWithExclusionsInput,
): Promise<CardGenerationRunAccepted | null> {
  return withWorkspaceTransaction(context, async (tx) => {
    await tx
      .select({ id: jobs.id })
      .from(jobs)
      .where(and(
        eq(jobs.workspaceId, context.workspaceId),
        eq(jobs.generationRunId, sourceRunId),
        inArray(jobs.status, [JobStatus.PENDING, JobStatus.RUNNING]),
      ))
      .orderBy(asc(jobs.id))
      .for("update");
    await tx.execute(sql`
      SELECT pg_advisory_xact_lock(
        hashtextextended(${`job-quota:${context.workspaceId}`}, 0)
      )
    `);

    const normalizedUnitIds = [...input.excludedUnitIds].sort();
    const replay = await tx.query.cardGenerationRuns.findFirst({
      where: and(
        eq(cardGenerationRuns.workspaceId, context.workspaceId),
        eq(cardGenerationRuns.requestIdempotencyKey, input.idempotencyKey),
      ),
    });
    if (replay) {
      const policy = replay.exclusionPolicy;
      const replayUnitIds = [...(
        policy?.requestedUnitIds
        ?? policy?.excludedUnits.map((unit) => unit.sourceUnitId)
        ?? []
      )].sort();
      if (
        replay.requestedBy !== context.userId
        || policy?.mode !== "explicit_image_exclusions_v1"
        || policy.sourceRunId !== sourceRunId
        || normalizedUnitIds.length !== replayUnitIds.length
        || normalizedUnitIds.some((unitId, index) => unitId !== replayUnitIds[index])
      ) {
        throw new CardGenerationServiceError(
          "idempotency_key_reused",
          409,
          "幂等键已被另一请求使用",
        );
      }
      const replayView = await toRunView(tx, replay);
      return {
        runId: replay.id,
        status: replay.status,
        sourceSnapshot: replayView.sourceSnapshot,
        canContinueEditing: true,
      };
    }

    const [sourceRun] = await tx
      .select()
      .from(cardGenerationRuns)
      .where(and(
        eq(cardGenerationRuns.id, sourceRunId),
        eq(cardGenerationRuns.workspaceId, context.workspaceId),
      ))
      .for("update");
    if (!sourceRun) return null;
    if (
      sourceRun.status !== CardGenerationRunStatus.NEEDS_ATTENTION
      || sourceRun.providerSnapshot.executionMode !== "multimodal_v2"
    ) {
      throw new CardGenerationServiceError(
        "run_exclusions_not_available",
        409,
        "当前任务没有可显式排除的失败图片",
      );
    }

    const [note] = await tx
      .select({
        id: notes.id,
        generationEpoch: notes.cardGenerationEpoch,
        latestGenerationRunId: notes.latestGenerationRunId,
      })
      .from(notes)
      .where(and(
        eq(notes.id, sourceRun.noteId),
        eq(notes.workspaceId, context.workspaceId),
        sql`${notes.deletedAt} IS NULL`,
      ))
      .for("update");
    if (
      !note
      || note.generationEpoch !== sourceRun.generationEpoch
      || note.latestGenerationRunId !== sourceRun.id
    ) {
      throw new CardGenerationServiceError(
        "stale_generation_epoch",
        409,
        "该任务已被更新请求取代",
      );
    }

    const failedImageUnits = await tx
      .select()
      .from(cardGenerationUnits)
      .where(and(
        eq(cardGenerationUnits.workspaceId, context.workspaceId),
        eq(cardGenerationUnits.runId, sourceRun.id),
        inArray(cardGenerationUnits.id, normalizedUnitIds),
      ))
      .orderBy(asc(cardGenerationUnits.ordinal), asc(cardGenerationUnits.id))
      .for("update");
    if (
      failedImageUnits.length !== normalizedUnitIds.length
      || failedImageUnits.some((unit) =>
        unit.kind !== CardGenerationUnitKind.IMAGE
        || unit.status !== "terminal_failed"
        || !unit.required
        || !unit.inputManifest.imageAssetId
        || !unit.inputManifest.imageBlockId)
    ) {
      throw new CardGenerationServiceError(
        "invalid_exclusion_units",
        422,
        "只能排除当前任务中已确定失败的必需图片",
      );
    }
    const inheritedExclusions = sourceRun.exclusionPolicy?.mode === "explicit_image_exclusions_v1"
      ? sourceRun.exclusionPolicy.excludedUnits
      : [];
    const exclusionsByAssetId = new Map(
      inheritedExclusions.map((unit) => [unit.imageAssetId, unit]),
    );
    for (const unit of failedImageUnits) {
      exclusionsByAssetId.set(unit.inputManifest.imageAssetId!, {
        sourceUnitId: unit.id,
        kind: "image",
        inputHash: unit.inputHash,
        imageAssetId: unit.inputManifest.imageAssetId!,
        imageBlockId: unit.inputManifest.imageBlockId!,
        errorCode: unit.errorCode,
      });
    }
    const cumulativeExclusions = [...exclusionsByAssetId.values()].sort((a, b) =>
      a.imageAssetId.localeCompare(b.imageAssetId)
      || a.imageBlockId.localeCompare(b.imageBlockId));
    if (
      sourceRun.requiredUnits === 0
      && cumulativeExclusions.length >= sourceRun.requiredImages
    ) {
      throw new CardGenerationServiceError(
        "no_remaining_generation_input",
        422,
        "排除这些图片后没有可用于生成学习卡的内容",
      );
    }

    const now = new Date();
    const exclusionPolicy: CardGenerationExclusionPolicy = {
      mode: "explicit_image_exclusions_v1",
      sourceRunId: sourceRun.id,
      requestedBy: context.userId,
      requestedAt: now.toISOString(),
      requestedUnitIds: normalizedUnitIds,
      excludedUnits: cumulativeExclusions,
    };
    const rootGenerationFingerprint =
      typeof sourceRun.providerSnapshot.rootGenerationFingerprint === "string"
        ? sourceRun.providerSnapshot.rootGenerationFingerprint
        : sourceRun.generationFingerprint;
    const generationFingerprint = hashJson({
      contract: "card-generation-partial-derivation-v1",
      rootGenerationFingerprint,
      excludedImageInputs: exclusionPolicy.excludedUnits
        .map((unit) => ({
          inputHash: unit.inputHash,
          imageAssetId: unit.imageAssetId,
          imageBlockId: unit.imageBlockId,
        }))
        .sort((a, b) =>
          a.imageAssetId.localeCompare(b.imageAssetId)
          || a.imageBlockId.localeCompare(b.imageBlockId)),
    });

    const pendingRows = await tx
      .select({ count: count() })
      .from(jobs)
      .where(and(
        eq(jobs.workspaceId, context.workspaceId),
        eq(jobs.status, JobStatus.PENDING),
        sql`${jobs.generationRunId} IS DISTINCT FROM ${sourceRun.id}`,
      ));
    assertPendingQuota(Number(pendingRows[0]?.count ?? 0));

    const generationEpoch = note.generationEpoch + 1;
    const [derivedRun] = await tx
      .insert(cardGenerationRuns)
      .values({
        workspaceId: context.workspaceId,
        noteId: sourceRun.noteId,
        noteVersionId: sourceRun.noteVersionId,
        requestedBy: context.userId,
        requestIdempotencyKey: input.idempotencyKey,
        generationFingerprint,
        generationEpoch,
        supersedesRunId: sourceRun.id,
        titleSnapshot: sourceRun.titleSnapshot,
        sourceContentHash: sourceRun.sourceContentHash,
        blockManifestHash: sourceRun.blockManifestHash,
        assetManifestHash: sourceRun.assetManifestHash,
        blockManifest: sourceRun.blockManifest,
        assetManifest: sourceRun.assetManifest,
        pipelineVersion: sourceRun.pipelineVersion,
        promptBundleVersion: sourceRun.promptBundleVersion,
        providerSnapshot: {
          ...sourceRun.providerSnapshot,
          partialPolicy: exclusionPolicy.mode,
          sourceRunId: sourceRun.id,
          rootGenerationFingerprint,
        },
        governancePolicyVersion: sourceRun.governancePolicyVersion,
        status: CardGenerationRunStatus.QUEUED,
        stage: CardGenerationStage.QUEUED,
        stateVersion: 1,
        nextEventSequence: 2,
        retryable: true,
        requiredUnits: 0,
        completedUnits: 0,
        failedUnits: 0,
        requiredImages: sourceRun.requiredImages,
        completedImages: 0,
        sourceCoverageBps: 0,
        imageCoverageBps: sourceRun.requiredImages === 0 ? 10_000 : 0,
        coverageReport: {
          measurement: "planned",
          plannerVersion: null,
          resultCompleteness: "partial",
          originalRequiredImages: sourceRun.requiredImages,
          policyAdjustedImageCoverageBps:
            sourceRun.requiredImages === exclusionPolicy.excludedUnits.length
              ? 10_000
              : 0,
          excludedImages: exclusionPolicy.excludedUnits.map((unit) => ({
            sourceUnitId: unit.sourceUnitId,
            imageAssetId: unit.imageAssetId,
            imageBlockId: unit.imageBlockId,
            reason: unit.errorCode ?? "image_analysis_failed",
          })),
        },
        exclusionPolicy,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    if (!derivedRun) {
      throw new CardGenerationServiceError(
        "generation_derivation_failed",
        500,
        "无法创建派生生成任务",
      );
    }

    const [plannerUnit] = await tx
      .insert(cardGenerationUnits)
      .values({
        workspaceId: context.workspaceId,
        runId: derivedRun.id,
        kind: CardGenerationUnitKind.PLANNER,
        level: 0,
        ordinal: 0,
        unitKey: `planner:${derivedRun.generationFingerprint}`,
        pipelineVersion: derivedRun.pipelineVersion,
        required: true,
        inputManifest: {},
        inputHash: derivedRun.generationFingerprint,
        tokenEstimate: 0,
        status: "pending",
        scheduledAt: now,
      })
      .returning();
    if (!plannerUnit) {
      throw new CardGenerationServiceError(
        "generation_checkpoint_missing",
        500,
        "无法创建派生生成检查点",
      );
    }
    const [plannerJob] = await tx
      .insert(jobs)
      .values(plannerJobValues({
        workspaceId: context.workspaceId,
        userId: context.userId,
        noteVersionId: sourceRun.noteVersionId,
        runId: derivedRun.id,
        unitId: plannerUnit.id,
      }))
      .returning();
    if (!plannerJob) {
      throw new CardGenerationServiceError(
        "generation_job_missing",
        500,
        "无法创建派生生成任务",
      );
    }

    await tx
      .update(cardGenerationRuns)
      .set({
        legacyJobId: plannerJob.id,
        updatedAt: now,
      })
      .where(and(
        eq(cardGenerationRuns.id, derivedRun.id),
        eq(cardGenerationRuns.workspaceId, context.workspaceId),
      ));
    await tx
      .update(cardGenerationRuns)
      .set({
        status: CardGenerationRunStatus.SUPERSEDED,
        stage: CardGenerationStage.COMPLETE,
        stateVersion: sourceRun.stateVersion + 1,
        nextEventSequence: sourceRun.nextEventSequence + 1,
        errorCode: "continued_with_exclusions",
        retryable: false,
        updatedAt: now,
        finishedAt: now,
      })
      .where(and(
        eq(cardGenerationRuns.id, sourceRun.id),
        eq(cardGenerationRuns.workspaceId, context.workspaceId),
        eq(cardGenerationRuns.stateVersion, sourceRun.stateVersion),
      ));
    await tx
      .update(jobs)
      .set({
        status: JobStatus.DEAD,
        lastError: "generation_superseded_by_partial_run",
        leaseToken: null,
        finishedAt: now,
      })
      .where(and(
        eq(jobs.workspaceId, context.workspaceId),
        eq(jobs.generationRunId, sourceRun.id),
        inArray(jobs.status, [JobStatus.PENDING, JobStatus.RUNNING]),
      ));
    await tx
      .update(cardGenerationUnits)
      .set({ status: "superseded", finishedAt: now, updatedAt: now })
      .where(and(
        eq(cardGenerationUnits.workspaceId, context.workspaceId),
        eq(cardGenerationUnits.runId, sourceRun.id),
        notInArray(cardGenerationUnits.status, [
          "succeeded",
          "terminal_failed",
          "cancelled",
          "superseded",
        ]),
      ));
    await tx
      .update(notes)
      .set({
        cardGenerationEpoch: generationEpoch,
        latestGenerationRunId: derivedRun.id,
        updatedAt: now,
      })
      .where(and(
        eq(notes.id, sourceRun.noteId),
        eq(notes.workspaceId, context.workspaceId),
      ));

    await tx.insert(cardGenerationEvents).values([
      {
        runId: sourceRun.id,
        workspaceId: context.workspaceId,
        sequence: sourceRun.nextEventSequence,
        stage: CardGenerationStage.COMPLETE,
        state: CardGenerationRunStatus.SUPERSEDED,
        completed: sourceRun.completedImages,
        total: sourceRun.requiredImages,
        unit: "images",
        messageCode: "generation_continued_with_exclusions",
        safeDetails: {
          derivedRunId: derivedRun.id,
          newlyExcludedImageCount: failedImageUnits.length,
          excludedImageCount: exclusionPolicy.excludedUnits.length,
        },
        createdAt: now,
      },
      {
        runId: derivedRun.id,
        workspaceId: context.workspaceId,
        sequence: 1,
        stage: CardGenerationStage.SNAPSHOT,
        state: CardGenerationRunStatus.QUEUED,
        completed: 0,
        total: 1,
        unit: "run",
        messageCode: "partial_generation_derived",
        safeDetails: {
          sourceRunId: sourceRun.id,
          newlyExcludedImageCount: failedImageUnits.length,
          excludedImageCount: exclusionPolicy.excludedUnits.length,
        },
        createdAt: now,
      },
    ]);

    const version = await tx.query.noteVersions.findFirst({
      columns: { versionNo: true },
      where: and(
        eq(noteVersions.id, sourceRun.noteVersionId),
        eq(noteVersions.workspaceId, context.workspaceId),
      ),
    });
    if (!version) {
      throw new CardGenerationServiceError(
        "source_snapshot_missing",
        409,
        "生成快照已不存在",
      );
    }
    return {
      runId: derivedRun.id,
      status: derivedRun.status,
      sourceSnapshot: {
        noteVersionId: sourceRun.noteVersionId,
        versionNo: version.versionNo,
        contentHash: sourceRun.sourceContentHash,
      },
      canContinueEditing: true,
    };
  });
}

export async function getCardGenerationRun(
  context: { workspaceId: string; userId: string },
  runId: string,
): Promise<CardGenerationRunView | null> {
  return withWorkspaceTransaction(context, async (tx) => {
    const run = await getRunRowForWorkspace(tx, runId, context.workspaceId);
    return run ? toRunView(tx, run) : null;
  });
}

export async function getLatestCardGenerationRun(
  context: { workspaceId: string; userId: string },
  noteVersionId: string,
): Promise<CardGenerationRunView | null> {
  return withWorkspaceTransaction(context, async (tx) => {
    const version = await tx.query.noteVersions.findFirst({
      columns: { id: true },
      where: and(
        eq(noteVersions.id, noteVersionId),
        eq(noteVersions.workspaceId, context.workspaceId),
      ),
    });
    if (!version) {
      throw new CardGenerationServiceError("note_version_not_found", 404, "笔记版本不存在");
    }
    const run = await tx.query.cardGenerationRuns.findFirst({
      where: and(
        eq(cardGenerationRuns.workspaceId, context.workspaceId),
        eq(cardGenerationRuns.noteVersionId, noteVersionId),
      ),
      orderBy: [desc(cardGenerationRuns.generationEpoch)],
    });
    return run ? toRunView(tx, run) : null;
  });
}

export async function listCardGenerationEvents(
  context: { workspaceId: string; userId: string },
  runId: string,
  after: number,
) {
  return withWorkspaceTransaction(context, async (tx) => {
    const run = await getRunRowForWorkspace(tx, runId, context.workspaceId);
    if (!run) return null;
    const rows = await tx.query.cardGenerationEvents.findMany({
      where: and(
        eq(cardGenerationEvents.workspaceId, context.workspaceId),
        eq(cardGenerationEvents.runId, runId),
        sql`${cardGenerationEvents.sequence} > ${after}`,
      ),
      orderBy: [asc(cardGenerationEvents.sequence)],
      limit: 200,
    });
    return {
      items: rows.map((event) => ({
        sequence: event.sequence,
        stage: event.stage,
        state: event.state,
        completed: event.completed,
        total: event.total,
        unit: event.unit,
        messageCode: event.messageCode,
        safeDetails: event.safeDetails,
        createdAt: event.createdAt.toISOString(),
      })),
      nextSequence: rows.at(-1)?.sequence ?? after,
    };
  });
}

export async function cancelCardGenerationRun(
  context: { workspaceId: string; userId: string },
  runId: string,
): Promise<CardGenerationRunView | null> {
  return withWorkspaceTransaction(context, async (tx) => {
    // Worker order is job lease -> workspace advisory lock -> run. Match it
    // here so cancellation cannot deadlock a worker entering its publish fence.
    await tx
      .select({ id: jobs.id })
      .from(jobs)
      .where(and(
        eq(jobs.workspaceId, context.workspaceId),
        eq(jobs.generationRunId, runId),
        inArray(jobs.status, [JobStatus.PENDING, JobStatus.RUNNING]),
      ))
      .orderBy(asc(jobs.id))
      .for("update");
    await tx.execute(sql`
      SELECT pg_advisory_xact_lock(
        hashtextextended(${`job-quota:${context.workspaceId}`}, 0)
      )
    `);
    const [run] = await tx
      .select()
      .from(cardGenerationRuns)
      .where(and(
        eq(cardGenerationRuns.id, runId),
        eq(cardGenerationRuns.workspaceId, context.workspaceId),
      ))
      .for("update");
    if (!run) return null;
    if (!CANCELLABLE_STATUSES.has(run.status)) return toRunView(tx, run);

    const now = new Date();
    const [updated] = await tx
      .update(cardGenerationRuns)
      .set({
        status: CardGenerationRunStatus.CANCELLED,
        stage: CardGenerationStage.COMPLETE,
        stateVersion: run.stateVersion + 1,
        nextEventSequence: run.nextEventSequence + 1,
        errorCode: "user_cancelled",
        retryable: false,
        cancelRequestedAt: now,
        updatedAt: now,
        finishedAt: now,
      })
      .where(and(
        eq(cardGenerationRuns.id, run.id),
        eq(cardGenerationRuns.workspaceId, context.workspaceId),
        eq(cardGenerationRuns.stateVersion, run.stateVersion),
      ))
      .returning();

    await tx.insert(cardGenerationEvents).values({
      runId: run.id,
      workspaceId: context.workspaceId,
      sequence: run.nextEventSequence,
      stage: CardGenerationStage.COMPLETE,
      state: CardGenerationRunStatus.CANCELLED,
      completed: 0,
      total: 1,
      unit: "run",
      messageCode: "user_cancelled",
      safeDetails: {},
      createdAt: now,
    });

    // Revoking the lease makes every late worker side effect fail its fence.
    await tx
      .update(jobs)
      .set({
        status: JobStatus.DEAD,
        lastError: "generation_cancelled",
        leaseToken: null,
        finishedAt: now,
      })
      .where(and(
        eq(jobs.workspaceId, context.workspaceId),
        eq(jobs.generationRunId, run.id),
        inArray(jobs.status, [JobStatus.PENDING, JobStatus.RUNNING]),
      ));

    await tx
      .update(cardGenerationUnits)
      .set({ status: "cancelled", finishedAt: now, updatedAt: now })
      .where(and(
        eq(cardGenerationUnits.workspaceId, context.workspaceId),
        eq(cardGenerationUnits.runId, run.id),
        notInArray(cardGenerationUnits.status, ["succeeded", "cancelled", "superseded"]),
      ));

    return toRunView(tx, updated);
  });
}

export async function retryCardGenerationRun(
  context: { workspaceId: string; userId: string },
  runId: string,
): Promise<CardGenerationRunView | null> {
  return withWorkspaceTransaction(context, async (tx) => {
    await tx.execute(sql`
      SELECT pg_advisory_xact_lock(
        hashtextextended(${`job-quota:${context.workspaceId}`}, 0)
      )
    `);
    const [run] = await tx
      .select()
      .from(cardGenerationRuns)
      .where(and(
        eq(cardGenerationRuns.id, runId),
        eq(cardGenerationRuns.workspaceId, context.workspaceId),
      ))
      .for("update");
    if (!run) return null;
    if (run.status !== CardGenerationRunStatus.NEEDS_ATTENTION || !run.retryable) {
      throw new CardGenerationServiceError("run_not_retryable", 409, "当前任务不可重试");
    }

    const [note] = await tx
      .select({
        epoch: notes.cardGenerationEpoch,
        latestRunId: notes.latestGenerationRunId,
      })
      .from(notes)
      .where(and(eq(notes.id, run.noteId), eq(notes.workspaceId, context.workspaceId)))
      .for("update");
    if (!note || note.epoch !== run.generationEpoch || note.latestRunId !== run.id) {
      throw new CardGenerationServiceError("stale_generation_epoch", 409, "该任务已被更新请求取代");
    }

    const pendingRows = await tx
      .select({ count: count() })
      .from(jobs)
      .where(and(eq(jobs.workspaceId, context.workspaceId), eq(jobs.status, JobStatus.PENDING)));
    assertPendingQuota(Number(pendingRows[0]?.count ?? 0));

    if (
      run.providerSnapshot.executionMode === "text_v2"
      || run.providerSnapshot.executionMode === "multimodal_v2"
    ) {
      const failedCheckpoints = await tx
        .select()
        .from(cardGenerationUnits)
        .where(and(
          eq(cardGenerationUnits.workspaceId, context.workspaceId),
          eq(cardGenerationUnits.runId, run.id),
          inArray(cardGenerationUnits.status, [
            "terminal_failed",
            "retryable_failed",
            "pending",
          ]),
          sql`(${cardGenerationUnits.status} <> 'pending' OR ${cardGenerationUnits.scheduledAt} IS NULL)`,
        ))
        .orderBy(
          sql`CASE ${cardGenerationUnits.status}
            WHEN 'terminal_failed' THEN 0
            WHEN 'retryable_failed' THEN 1
            ELSE 2
          END`,
          asc(cardGenerationUnits.ordinal),
        )
        .for("update");
      if (failedCheckpoints.length === 0) {
        throw new CardGenerationServiceError(
          "generation_checkpoint_missing",
          409,
          "没有可恢复的生成检查点",
        );
      }
      const now = new Date();
      // 方案 §4.4：一次重试恢复全部失败检查点。窗口约束仍然生效——超出
      // 窗口的单元只重置为可调度状态（scheduledAt=NULL），由 worker 完成
      // 单元后的窗口推进接续投放，不会瞬间占满队列配额。
      const recoveredSourceUnits = failedCheckpoints.reduce((total, checkpoint) =>
        checkpoint.kind === CardGenerationUnitKind.TEXT_MAP && checkpoint.status !== "pending"
          ? total + (checkpoint.inputManifest.spanIds?.length ?? 0)
          : total, 0);
      await tx
        .update(cardGenerationUnits)
        .set({
          status: "pending",
          scheduledAt: null,
          finishedAt: null,
          errorCode: null,
          updatedAt: now,
        })
        .where(and(
          eq(cardGenerationUnits.workspaceId, context.workspaceId),
          inArray(cardGenerationUnits.id, failedCheckpoints.map((checkpoint) => checkpoint.id)),
        ));
      const ofKind = (kind: string) =>
        failedCheckpoints.filter((checkpoint) => checkpoint.kind === kind);
      const toSchedule = [
        ...ofKind(CardGenerationUnitKind.PLANNER),
        ...ofKind(CardGenerationUnitKind.IMAGE).slice(0, CARD_GENERATION_IMAGE_WINDOW),
        ...ofKind(CardGenerationUnitKind.TEXT_MAP).slice(0, CARD_GENERATION_MAP_WINDOW),
        ...ofKind(CardGenerationUnitKind.SECTION_REDUCE),
        ...ofKind(CardGenerationUnitKind.DECK_PLAN),
        ...ofKind(CardGenerationUnitKind.CARD_RENDER),
        ...ofKind(CardGenerationUnitKind.PUBLISH),
      ];
      const primary = toSchedule[0] ?? failedCheckpoints[0]!;
      const target = primary.kind === CardGenerationUnitKind.PLANNER
        ? { status: CardGenerationRunStatus.QUEUED, stage: CardGenerationStage.PLANNER }
        : primary.kind === CardGenerationUnitKind.IMAGE
          ? { status: CardGenerationRunStatus.AWAITING_ASSETS, stage: CardGenerationStage.IMAGE_ANALYSIS }
        : primary.kind === CardGenerationUnitKind.TEXT_MAP
          ? { status: CardGenerationRunStatus.MAPPING, stage: CardGenerationStage.TEXT_MAP }
          : primary.kind === CardGenerationUnitKind.SECTION_REDUCE
            ? { status: CardGenerationRunStatus.REDUCING, stage: CardGenerationStage.SECTION_REDUCE }
            : primary.kind === CardGenerationUnitKind.DECK_PLAN
              ? { status: CardGenerationRunStatus.REDUCING, stage: CardGenerationStage.DECK_PLAN }
              : primary.kind === CardGenerationUnitKind.CARD_RENDER
                ? { status: CardGenerationRunStatus.RENDERING, stage: CardGenerationStage.CARD_RENDER }
            : { status: CardGenerationRunStatus.VALIDATING, stage: CardGenerationStage.GLOBAL_VERIFY };
      const [updated] = await tx
        .update(cardGenerationRuns)
        .set({
          status: target.status,
          stage: target.stage,
          stateVersion: run.stateVersion + 1,
          nextEventSequence: run.nextEventSequence + 1,
          errorCode: null,
          retryable: true,
          failedUnits: Math.max(0, run.failedUnits - recoveredSourceUnits),
          updatedAt: now,
          finishedAt: null,
        })
        .where(and(
          eq(cardGenerationRuns.id, run.id),
          eq(cardGenerationRuns.workspaceId, context.workspaceId),
          eq(cardGenerationRuns.stateVersion, run.stateVersion),
        ))
        .returning();
      await tx.insert(cardGenerationEvents).values({
        runId: run.id,
        workspaceId: context.workspaceId,
        sequence: run.nextEventSequence,
        stage: target.stage,
        state: target.status,
        completed: run.completedUnits,
        total: run.requiredUnits,
        unit: primary.kind === CardGenerationUnitKind.IMAGE ? "images" : "source_units",
        messageCode: "generation_checkpoint_retry_queued",
        safeDetails: {
          retriedUnitCount: failedCheckpoints.length,
          scheduledUnitCount: toSchedule.length,
          unitKinds: [...new Set(failedCheckpoints.map((checkpoint) => checkpoint.kind))],
        },
        createdAt: now,
      });
      let firstRetryJobId: string | null = null;
      for (const checkpoint of toSchedule) {
        const [job] = await tx
          .insert(jobs)
          .values(generationUnitJobValues({
            workspaceId: context.workspaceId,
            userId: context.userId,
            noteVersionId: run.noteVersionId,
            runId: run.id,
            unit: checkpoint,
          }))
          .returning();
        firstRetryJobId ??= job.id;
        await tx
          .update(cardGenerationUnits)
          .set({ scheduledAt: now, updatedAt: now })
          .where(and(
            eq(cardGenerationUnits.id, checkpoint.id),
            eq(cardGenerationUnits.workspaceId, context.workspaceId),
          ));
      }
      if (firstRetryJobId) {
        await tx
          .update(cardGenerationRuns)
          .set({ legacyJobId: firstRetryJobId })
          .where(and(
            eq(cardGenerationRuns.id, run.id),
            eq(cardGenerationRuns.workspaceId, context.workspaceId),
          ));
      }
      return toRunView(tx, updated);
    }

    const now = new Date();
    const nextStateVersion = run.stateVersion + 1;
    const [updated] = await tx
      .update(cardGenerationRuns)
      .set({
        status: CardGenerationRunStatus.QUEUED,
        stage: CardGenerationStage.QUEUED,
        stateVersion: nextStateVersion,
        nextEventSequence: run.nextEventSequence + 1,
        errorCode: null,
        retryable: true,
        updatedAt: now,
        finishedAt: null,
      })
      .where(and(
        eq(cardGenerationRuns.id, run.id),
        eq(cardGenerationRuns.workspaceId, context.workspaceId),
        eq(cardGenerationRuns.stateVersion, run.stateVersion),
      ))
      .returning();

    await tx.insert(cardGenerationEvents).values({
      runId: run.id,
      workspaceId: context.workspaceId,
      sequence: run.nextEventSequence,
      stage: CardGenerationStage.QUEUED,
      state: CardGenerationRunStatus.QUEUED,
      completed: 0,
      total: 1,
      unit: "legacy_job",
      messageCode: "generation_retry_queued",
      safeDetails: { stateVersion: nextStateVersion },
      createdAt: now,
    });

    const [job] = await tx
      .insert(jobs)
      .values(legacyJobValues({
        workspaceId: context.workspaceId,
        userId: context.userId,
        noteVersionId: run.noteVersionId,
        runId: run.id,
        idempotencyKey: `generation-run:${run.id}:retry:${nextStateVersion}`,
        oldCardId: typeof run.providerSnapshot.oldCardId === "string"
          ? run.providerSnapshot.oldCardId
          : undefined,
      }))
      .returning();
    await tx
      .update(cardGenerationRuns)
      .set({ legacyJobId: job.id })
      .where(and(eq(cardGenerationRuns.id, run.id), eq(cardGenerationRuns.workspaceId, context.workspaceId)));

    return toRunView(tx, updated);
  });
}

export async function getLegacyGenerationCompatibility(
  context: { workspaceId: string; userId: string },
  runId: string,
) {
  return withWorkspaceTransaction(context, async (tx) => {
    const run = await getRunRowForWorkspace(tx, runId, context.workspaceId);
    if (!run) return null;
    let fallbackCardId: string | null = run.resultCardId;
    let generatedVersionId: string | null = run.resultCardId ? run.noteVersionId : null;
    if (!fallbackCardId) {
      const [card] = await tx
        .select({ id: learningCards.id, noteVersionId: learningCards.noteVersionId })
        .from(learningCards)
        .innerJoin(noteVersions, eq(noteVersions.id, learningCards.noteVersionId))
        .where(and(
          eq(learningCards.workspaceId, context.workspaceId),
          eq(learningCards.status, "active"),
          eq(noteVersions.noteId, run.noteId),
        ))
        .orderBy(desc(learningCards.createdAt))
        .limit(1);
      fallbackCardId = card?.id ?? null;
      generatedVersionId = card?.noteVersionId ?? null;
    }
    return {
      state: run.status === CardGenerationRunStatus.SUCCEEDED ? "generated" as const : "generating" as const,
      cardId: fallbackCardId,
      jobId: run.legacyJobId,
      generatedVersionId,
      runId: run.id,
    };
  });
}
