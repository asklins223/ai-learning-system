import { createHash } from "node:crypto";
import {
  and,
  asc,
  count,
  eq,
  inArray,
  isNull,
  ne,
  or,
  sql,
} from "drizzle-orm";
import {
  CARD_GENERATION_IMAGE_EVIDENCE_MIN_CONFIDENCE_BPS,
  CARD_GENERATION_IMAGE_WINDOW,
  CARD_GENERATION_MAP_WINDOW,
  CardGenerationRunStatus,
  CardGenerationStage,
  CardGenerationUnitKind,
  JobResourceClass,
  JobStatus,
  JobType,
  MAX_PENDING_JOBS_PER_WORKSPACE,
  cardMapInputSchema,
  imageEvidenceRegionSchema,
  safeErrorMessage,
  sanitizeOperationalError,
  type CardMapInput,
} from "@ailearn/shared";
import {
  withWorkerWorkspaceTransaction,
  type WorkerTransaction,
} from "../db.ts";
import * as schema from "../schema/index.ts";
import { createProvider, type ProviderUsage } from "../lib/ai-provider.ts";
import {
  enforcePrivacyGovernanceWithPolicy,
  logAICall,
  resolveAIGovernanceContext,
} from "../lib/governance.ts";
import {
  lockJobLease,
  throwIfJobAborted,
  withJobTransaction,
  type JobLeaseContext,
} from "../lib/job-lease.ts";
import { logger } from "../lib/logger.ts";
import { decideGenerationRunFence } from "../lib/card-generation-run.ts";
import {
  SOURCE_PLANNER_VERSION,
  planSourceUnits,
} from "../lib/source-unit-planner.ts";
import {
  CardMapContractError,
  reduceCandidatePool,
  validateCardMapOutput,
  type ReducibleCandidate,
} from "../lib/card-generation-map-contract.ts";
import {
  planCardSet,
  validateCardSetPlan,
  type CardSetPlan,
} from "../lib/card-set-planner.ts";
import { resolveProviderCallTimeout } from "../lib/handler-timeout-config.ts";
import { runWithAbortBudget } from "../lib/handler-timeout.ts";
import { downloadImageAsset } from "../lib/object-storage.ts";

const TEXT_PIPELINE_VERSION = "card-generation-v2-m5";
const MAP_PROMPT_VERSION = "map-candidate-v1";
const IMAGE_EXTRACTOR_VERSION = "image-insight-v1";
const IMAGE_PROMPT_VERSION = "image-understanding-v1";
const CARD_GENERATION_RENDER_WINDOW = 8;
/** Stable unit error codes surfaced verbatim to the UI (see NoteEditor labels). */
const UNIT_FAILURE_CODE_ALLOWLIST = new Set(["image_content_not_allowed"]);

export interface CardGenerationTextJob {
  id: string;
  workspaceId: string;
  requestedBy: string | null;
  payload: Record<string, unknown>;
  leaseToken: string;
  signal?: AbortSignal;
}

type PipelinePayload = {
  runId: string;
  unitId: string;
  noteVersionId: string;
};

type LockedRun = typeof schema.cardGenerationRuns.$inferSelect;
type LockedUnit = typeof schema.cardGenerationUnits.$inferSelect;

type LockedPipelineState = {
  run: LockedRun;
  unit: LockedUnit;
  decision: "active" | "stale" | "terminal";
};

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function sha256Bytes(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function imageDescription(markdown: string): string | undefined {
  const match = /^!\[([^\]]*)\]\([^)]+\)/.exec(markdown.trim());
  const value = match?.[1]?.replace(/\s+/g, " ").trim();
  if (!value || /^(?:image|img|photo|picture|图片|截图|上传中[.…]*)$/i.test(value)) return undefined;
  return value.slice(0, 500);
}

function hashJson(value: unknown): string {
  return sha256(JSON.stringify(value));
}

type ExplicitImageExclusion = {
  sourceUnitId: string;
  inputHash: string;
  imageAssetId: string;
  imageBlockId: string;
  errorCode: string | null;
};

function explicitImageExclusions(run: LockedRun): ExplicitImageExclusion[] {
  const policy = run.exclusionPolicy as unknown;
  if (policy == null) return [];
  if (
    typeof policy !== "object"
    || !("mode" in policy)
    || policy.mode !== "explicit_image_exclusions_v1"
    || !("excludedUnits" in policy)
    || !Array.isArray(policy.excludedUnits)
    || policy.excludedUnits.length === 0
  ) {
    throw new Error("generation exclusion policy is invalid");
  }
  const exclusions = policy.excludedUnits.map((entry) => {
    if (
      typeof entry !== "object"
      || entry == null
      || !("kind" in entry)
      || entry.kind !== CardGenerationUnitKind.IMAGE
      || !("sourceUnitId" in entry)
      || typeof entry.sourceUnitId !== "string"
      || !("inputHash" in entry)
      || typeof entry.inputHash !== "string"
      || !("imageAssetId" in entry)
      || typeof entry.imageAssetId !== "string"
      || !("imageBlockId" in entry)
      || typeof entry.imageBlockId !== "string"
    ) {
      throw new Error("generation image exclusion entry is invalid");
    }
    return {
      sourceUnitId: entry.sourceUnitId,
      inputHash: entry.inputHash,
      imageAssetId: entry.imageAssetId,
      imageBlockId: entry.imageBlockId,
      errorCode:
        "errorCode" in entry && typeof entry.errorCode === "string"
          ? entry.errorCode
          : null,
    };
  });
  if (new Set(exclusions.map((entry) => entry.imageAssetId)).size !== exclusions.length) {
    throw new Error("generation exclusion policy contains duplicate image assets");
  }
  return exclusions;
}

function isPartialGenerationRun(run: LockedRun): boolean {
  return explicitImageExclusions(run).length > 0;
}

function requiredProcessableImages(run: LockedRun): number {
  const excluded = explicitImageExclusions(run).length;
  if (excluded > run.requiredImages) {
    throw new Error("generation exclusion count exceeds the sealed image manifest");
  }
  return run.requiredImages - excluded;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function pipelinePayload(job: CardGenerationTextJob): PipelinePayload {
  return {
    runId: requireString(job.payload.generationRunId, "generationRunId"),
    unitId: requireString(job.payload.generationUnitId, "generationUnitId"),
    noteVersionId: requireString(job.payload.noteVersionId, "noteVersionId"),
  };
}

function requireAuditUser(job: CardGenerationTextJob): string {
  const userId = requireString(job.requestedBy, "requestedBy");
  if (
    job.payload.userId !== undefined
    && requireString(job.payload.userId, "payload.userId").toLowerCase() !== userId.toLowerCase()
  ) {
    throw new Error("payload userId does not match trusted requestedBy actor");
  }
  return userId;
}

function leaseContext(job: CardGenerationTextJob): JobLeaseContext {
  return {
    id: job.id,
    workspaceId: job.workspaceId,
    requestedBy: job.requestedBy,
    leaseToken: job.leaseToken,
    signal: job.signal,
  };
}

async function appendEvent(
  tx: WorkerTransaction,
  run: LockedRun,
  input: {
    stage: string;
    state: string;
    completed?: number;
    total?: number;
    unit?: string;
    messageCode: string;
    safeDetails?: Record<string, unknown>;
    createdAt: Date;
  },
): Promise<void> {
  await tx.insert(schema.cardGenerationEvents).values({
    runId: run.id,
    workspaceId: run.workspaceId,
    sequence: run.nextEventSequence,
    stage: input.stage,
    state: input.state,
    completed: input.completed,
    total: input.total,
    unit: input.unit,
    messageCode: input.messageCode,
    safeDetails: input.safeDetails ?? {},
    createdAt: input.createdAt,
  });
}

async function markStaleRun(
  tx: WorkerTransaction,
  run: LockedRun,
  currentEpoch: number,
  now: Date,
): Promise<void> {
  await tx
    .update(schema.cardGenerationUnits)
    .set({ status: "superseded", finishedAt: now, updatedAt: now })
    .where(and(
      eq(schema.cardGenerationUnits.workspaceId, run.workspaceId),
      eq(schema.cardGenerationUnits.runId, run.id),
      ne(schema.cardGenerationUnits.status, "succeeded"),
    ));
  const [updated] = await tx
    .update(schema.cardGenerationRuns)
    .set({
      status: CardGenerationRunStatus.SUPERSEDED,
      stage: CardGenerationStage.COMPLETE,
      stateVersion: run.stateVersion + 1,
      nextEventSequence: run.nextEventSequence + 1,
      errorCode: "stale_generation_epoch",
      retryable: false,
      updatedAt: now,
      finishedAt: now,
    })
    .where(and(
      eq(schema.cardGenerationRuns.id, run.id),
      eq(schema.cardGenerationRuns.workspaceId, run.workspaceId),
      eq(schema.cardGenerationRuns.stateVersion, run.stateVersion),
    ))
    .returning({ id: schema.cardGenerationRuns.id });
  if (!updated) throw new Error("generation run supersede CAS failed");
  await appendEvent(tx, run, {
    stage: CardGenerationStage.COMPLETE,
    state: CardGenerationRunStatus.SUPERSEDED,
    completed: run.completedUnits,
    total: run.requiredUnits,
    unit: "source_units",
    messageCode: "stale_generation_epoch",
    safeDetails: { generationEpoch: run.generationEpoch, currentGenerationEpoch: currentEpoch },
    createdAt: now,
  });
}

async function lockPipelineState(
  tx: WorkerTransaction,
  lease: JobLeaseContext,
  payload: PipelinePayload,
  expectedKind: string,
): Promise<LockedPipelineState> {
  await lockJobLease(tx, lease);
  await tx.execute(sql`
    SELECT pg_advisory_xact_lock(
      hashtextextended(${`job-quota:${lease.workspaceId}`}, 0)
    )
  `);
  const [run] = await tx
    .select()
    .from(schema.cardGenerationRuns)
    .where(and(
      eq(schema.cardGenerationRuns.id, payload.runId),
      eq(schema.cardGenerationRuns.workspaceId, lease.workspaceId),
    ))
    .for("update");
  if (!run) throw new Error("generation run was not found in the job workspace");
  if (run.noteVersionId !== payload.noteVersionId) {
    throw new Error("generation run does not match the job note version");
  }
  if (run.pipelineVersion !== TEXT_PIPELINE_VERSION) {
    throw new Error("generation run is not bound to the text v2 pipeline");
  }
  const [note] = await tx
    .select({
      cardGenerationEpoch: schema.notes.cardGenerationEpoch,
      latestGenerationRunId: schema.notes.latestGenerationRunId,
    })
    .from(schema.notes)
    .where(and(
      eq(schema.notes.id, run.noteId),
      eq(schema.notes.workspaceId, lease.workspaceId),
    ));
  if (!note) throw new Error("generation run note was not found in the job workspace");
  const decision = decideGenerationRunFence(
    { id: run.id, status: run.status, generationEpoch: run.generationEpoch },
    {
      cardGenerationEpoch: note.cardGenerationEpoch,
      latestGenerationRunId: note.latestGenerationRunId,
    },
  );
  if (decision === "stale") {
    await markStaleRun(tx, run, note.cardGenerationEpoch, new Date());
  }
  const [unit] = await tx
    .select()
    .from(schema.cardGenerationUnits)
    .where(and(
      eq(schema.cardGenerationUnits.id, payload.unitId),
      eq(schema.cardGenerationUnits.workspaceId, lease.workspaceId),
      eq(schema.cardGenerationUnits.runId, run.id),
    ))
    .for("update");
  if (!unit) throw new Error("generation unit was not found in the job run");
  if (unit.kind !== expectedKind) {
    throw new Error(`generation unit kind mismatch: expected ${expectedKind}`);
  }
  return { run, unit, decision };
}

async function beginPipelineUnit(
  job: CardGenerationTextJob,
  expectedKind: string,
  target: { status: string; stage: string; messageCode: string; progressUnit: string },
): Promise<"active" | "already_succeeded" | "skip"> {
  const payload = pipelinePayload(job);
  const lease = leaseContext(job);
  return withJobTransaction(lease, async (tx) => {
    const locked = await lockPipelineState(tx, lease, payload, expectedKind);
    if (locked.decision !== "active") return "skip";
    if (locked.unit.status === "succeeded") return "already_succeeded";
    if (["terminal_failed", "cancelled", "superseded"].includes(locked.unit.status)) {
      return "skip";
    }
    const now = new Date();
    await tx
      .update(schema.cardGenerationUnits)
      .set({
        status: "running",
        attempts: locked.unit.attempts + 1,
        startedAt: locked.unit.startedAt ?? now,
        finishedAt: null,
        errorCode: null,
        updatedAt: now,
      })
      .where(and(
        eq(schema.cardGenerationUnits.id, locked.unit.id),
        eq(schema.cardGenerationUnits.workspaceId, locked.run.workspaceId),
      ));
    const deferTextStage = expectedKind === CardGenerationUnitKind.TEXT_MAP
      && requiredProcessableImages(locked.run) > locked.run.completedImages;
    if (!deferTextStage && (locked.run.status !== target.status || locked.run.stage !== target.stage)) {
      const [updated] = await tx
        .update(schema.cardGenerationRuns)
        .set({
          status: target.status,
          stage: target.stage,
          stateVersion: locked.run.stateVersion + 1,
          nextEventSequence: locked.run.nextEventSequence + 1,
          errorCode: null,
          retryable: true,
          startedAt: locked.run.startedAt ?? now,
          finishedAt: null,
          updatedAt: now,
        })
        .where(and(
          eq(schema.cardGenerationRuns.id, locked.run.id),
          eq(schema.cardGenerationRuns.workspaceId, locked.run.workspaceId),
          eq(schema.cardGenerationRuns.stateVersion, locked.run.stateVersion),
        ))
        .returning({ id: schema.cardGenerationRuns.id });
      if (!updated) throw new Error("generation run stage CAS failed");
      await appendEvent(tx, locked.run, {
        stage: target.stage,
        state: target.status,
        completed: locked.run.completedUnits,
        total: locked.run.requiredUnits,
        unit: target.progressUnit,
        messageCode: target.messageCode,
        createdAt: now,
      });
    }
    return "active";
  });
}

function providerConfigurationFingerprint(
  providerName: string,
  providerModel: string,
  config: { baseUrl?: string | null; model?: string | null },
): string {
  return hashJson({
    providerName: providerName.toLowerCase(),
    providerModel,
    baseUrl: config.baseUrl?.trim() || null,
    configuredModel: config.model?.trim() || null,
  });
}

type SchedulableUnit = Pick<
  typeof schema.cardGenerationUnits.$inferSelect,
  "id" | "kind" | "attempts"
>;

function jobDescriptorForUnit(unit: SchedulableUnit): {
  type: string;
  stage: string;
  priority: number;
  resourceClass: string;
} {
  if (unit.kind === CardGenerationUnitKind.TEXT_MAP) {
    return {
      type: JobType.MAP_CARD_GENERATION,
      stage: CardGenerationStage.TEXT_MAP,
      priority: 40,
      resourceClass: JobResourceClass.CARD_MAP,
    };
  }
  if (unit.kind === CardGenerationUnitKind.IMAGE) {
    return {
      type: JobType.ANALYZE_CARD_IMAGE,
      stage: CardGenerationStage.IMAGE_ANALYSIS,
      priority: 45,
      resourceClass: JobResourceClass.VISION,
    };
  }
  if (unit.kind === CardGenerationUnitKind.SECTION_REDUCE) {
    return {
      type: JobType.REDUCE_CARD_GENERATION,
      stage: CardGenerationStage.SECTION_REDUCE,
      priority: 70,
      resourceClass: JobResourceClass.CARD_FOREGROUND,
    };
  }
  if (unit.kind === CardGenerationUnitKind.DECK_PLAN) {
    return {
      type: JobType.PLAN_CARD_SET,
      stage: CardGenerationStage.DECK_PLAN,
      priority: 75,
      resourceClass: JobResourceClass.CARD_FOREGROUND,
    };
  }
  if (unit.kind === CardGenerationUnitKind.CARD_RENDER) {
    return {
      type: JobType.RENDER_CARD_GENERATION,
      stage: CardGenerationStage.CARD_RENDER,
      priority: 65,
      resourceClass: JobResourceClass.CARD_FOREGROUND,
    };
  }
  if (unit.kind === CardGenerationUnitKind.PUBLISH) {
    return {
      type: JobType.PUBLISH_CARD_GENERATION,
      stage: CardGenerationStage.PUBLISH,
      priority: 80,
      resourceClass: JobResourceClass.CARD_FOREGROUND,
    };
  }
  throw new Error(`generation unit kind ${unit.kind} cannot be scheduled`);
}

async function availablePendingSlots(tx: WorkerTransaction, workspaceId: string): Promise<number> {
  const [row] = await tx
    .select({ count: count() })
    .from(schema.jobs)
    .where(and(
      eq(schema.jobs.workspaceId, workspaceId),
      eq(schema.jobs.status, JobStatus.PENDING),
    ));
  return Math.max(0, MAX_PENDING_JOBS_PER_WORKSPACE - Number(row?.count ?? 0));
}

async function scheduleUnits(
  tx: WorkerTransaction,
  input: {
    run: LockedRun;
    units: SchedulableUnit[];
    requestedBy: string;
    limit: number;
  },
): Promise<number> {
  const slots = Math.min(input.limit, await availablePendingSlots(tx, input.run.workspaceId));
  const selected = input.units.slice(0, slots);
  const now = new Date();
  for (const unit of selected) {
    const descriptor = jobDescriptorForUnit(unit);
    await tx.insert(schema.jobs).values({
      type: descriptor.type,
      workspaceId: input.run.workspaceId,
      requestedBy: input.requestedBy,
      payload: {
        noteVersionId: input.run.noteVersionId,
        generationRunId: input.run.id,
        generationUnitId: unit.id,
        userId: input.requestedBy,
      },
      status: JobStatus.PENDING,
      generationRunId: input.run.id,
      generationUnitId: unit.id,
      stage: descriptor.stage,
      priority: descriptor.priority,
      resourceClass: descriptor.resourceClass,
      idempotencyKey: `generation-run:${input.run.id}:unit:${unit.id}:attempt:${unit.attempts + 1}`,
      scheduledAt: now,
    });
    await tx
      .update(schema.cardGenerationUnits)
      .set({ scheduledAt: now, updatedAt: now })
      .where(and(
        eq(schema.cardGenerationUnits.id, unit.id),
        eq(schema.cardGenerationUnits.workspaceId, input.run.workspaceId),
      ));
  }
  return selected.length;
}

async function markSchedulerAttention(
  tx: WorkerTransaction,
  run: LockedRun,
  now: Date,
): Promise<void> {
  const [fresh] = await tx
    .select()
    .from(schema.cardGenerationRuns)
    .where(and(
      eq(schema.cardGenerationRuns.id, run.id),
      eq(schema.cardGenerationRuns.workspaceId, run.workspaceId),
    ))
    .for("update");
  if (!fresh || fresh.status === CardGenerationRunStatus.NEEDS_ATTENTION) return;
  await tx
    .update(schema.cardGenerationRuns)
    .set({
      status: CardGenerationRunStatus.NEEDS_ATTENTION,
      stateVersion: fresh.stateVersion + 1,
      nextEventSequence: fresh.nextEventSequence + 1,
      errorCode: "scheduler_capacity",
      retryable: true,
      updatedAt: now,
      finishedAt: now,
    })
    .where(and(
      eq(schema.cardGenerationRuns.id, fresh.id),
      eq(schema.cardGenerationRuns.workspaceId, fresh.workspaceId),
      eq(schema.cardGenerationRuns.stateVersion, fresh.stateVersion),
    ));
  await appendEvent(tx, fresh, {
    stage: fresh.stage,
    state: CardGenerationRunStatus.NEEDS_ATTENTION,
    completed: fresh.completedUnits,
    total: fresh.requiredUnits,
    unit: "source_units",
    messageCode: "scheduler_capacity",
    safeDetails: { retryable: true },
    createdAt: now,
  });
}

export async function runPlanCardGeneration(job: CardGenerationTextJob): Promise<void> {
  requireAuditUser(job);
  const payload = pipelinePayload(job);
  const begin = await beginPipelineUnit(job, CardGenerationUnitKind.PLANNER, {
    status: CardGenerationRunStatus.PLANNING,
    stage: CardGenerationStage.PLANNER,
    messageCode: "source_planning_started",
    progressUnit: "source_units",
  });
  if (begin !== "active") return;

  const snapshot = await withWorkerWorkspaceTransaction(
    { workspaceId: job.workspaceId, userId: job.requestedBy },
    async (tx) => {
      const run = await tx.query.cardGenerationRuns.findFirst({
        where: and(
          eq(schema.cardGenerationRuns.id, payload.runId),
          eq(schema.cardGenerationRuns.workspaceId, job.workspaceId),
        ),
      });
      const version = await tx.query.noteVersions.findFirst({
        where: and(
          eq(schema.noteVersions.id, payload.noteVersionId),
          eq(schema.noteVersions.workspaceId, job.workspaceId),
        ),
      });
      const blocks = await tx.query.noteBlocks.findMany({
        where: and(
          eq(schema.noteBlocks.versionId, payload.noteVersionId),
          eq(schema.noteBlocks.workspaceId, job.workspaceId),
        ),
        orderBy: [asc(schema.noteBlocks.ordinal)],
      });
      if (!run || !version?.sealedAt) throw new Error("generation source snapshot is not sealed");
      const imageAssetIds = [...new Set(blocks
        .filter((block) => block.type === "image" && block.imageAssetId)
        .map((block) => block.imageAssetId!))];
      const imageAssets = imageAssetIds.length > 0
        ? await tx.query.noteImageAssets.findMany({
            where: and(
              eq(schema.noteImageAssets.workspaceId, job.workspaceId),
              inArray(schema.noteImageAssets.id, imageAssetIds),
            ),
        })
        : [];
      const exclusions = explicitImageExclusions(run);
      const failedSourceUnits = exclusions.length > 0
        ? await tx.query.cardGenerationUnits.findMany({
            where: and(
              eq(schema.cardGenerationUnits.workspaceId, job.workspaceId),
              inArray(
                schema.cardGenerationUnits.id,
                exclusions.map((entry) => entry.sourceUnitId),
              ),
            ),
          })
        : [];
      const failedSourceUnitById = new Map(
        failedSourceUnits.map((unit) => [unit.id, unit]),
      );
      if (exclusions.some((entry) => {
        const sourceUnit = failedSourceUnitById.get(entry.sourceUnitId);
        return (
          !sourceUnit
          || sourceUnit.kind !== CardGenerationUnitKind.IMAGE
          || sourceUnit.status !== "terminal_failed"
          || sourceUnit.inputHash !== entry.inputHash
          || sourceUnit.inputManifest.imageAssetId !== entry.imageAssetId
          || sourceUnit.inputManifest.imageBlockId !== entry.imageBlockId
        );
      })) {
        throw new Error("generation exclusion is not backed by a failed image checkpoint");
      }
      return { run, blocks, imageAssets };
    },
  );
  const governance = await resolveAIGovernanceContext(job.workspaceId, job.requestedBy);
  if (!governance.consentOk) {
    throw new Error("AI consent not signed for this workspace");
  }
  const provider = createProvider(governance.providerName, governance.providerConfig);
  const providerFingerprint = providerConfigurationFingerprint(
    governance.providerName,
    provider.modelId,
    governance.providerConfig,
  );
  const plan = planSourceUnits(payload.noteVersionId, snapshot.blocks);
  const allImageBlocks = snapshot.blocks.filter((block) => block.type === "image");
  const imageExclusions = explicitImageExclusions(snapshot.run);
  if (imageExclusions.length > snapshot.imageAssets.length) {
    throw new Error("generation exclusion count exceeds the sealed image snapshot");
  }
  const excludedImageAssetIds = new Set(imageExclusions.map((entry) => entry.imageAssetId));
  for (const exclusion of imageExclusions) {
    const block = allImageBlocks.find((candidate) => candidate.id === exclusion.imageBlockId);
    if (!block || block.imageAssetId !== exclusion.imageAssetId) {
      throw new Error("generation exclusion does not match the sealed image snapshot");
    }
  }
  const imageBlocks = allImageBlocks.filter(
    (block) => !block.imageAssetId || !excludedImageAssetIds.has(block.imageAssetId),
  );
  if (plan.spans.length === 0 && imageBlocks.length === 0) {
    throw new Error("generation source contains no processable units");
  }
  const assetById = new Map(snapshot.imageAssets.map((asset) => [asset.id, asset]));
  if (allImageBlocks.some((block) => !block.imageAssetId || !assetById.has(block.imageAssetId))) {
    throw new Error("generation image block has no resolvable typed asset");
  }
  const manifestByAssetId = new Map(snapshot.run.assetManifest.flatMap((entry) =>
    entry.assetId ? [[entry.assetId, entry] as const] : []));
  for (const asset of snapshot.imageAssets) {
    const manifest = manifestByAssetId.get(asset.id);
    if (!manifest || manifest.sourceHash !== asset.sha256) {
      throw new Error("sealed image asset manifest hash mismatch");
    }
  }
  throwIfJobAborted(leaseContext(job));

  await withJobTransaction(leaseContext(job), async (tx) => {
    const locked = await lockPipelineState(
      tx,
      leaseContext(job),
      payload,
      CardGenerationUnitKind.PLANNER,
    );
    if (locked.decision !== "active" || locked.unit.status === "succeeded") return;
    const now = new Date();
    if (plan.spans.length > 0) {
      await tx.insert(schema.noteEvidenceSpans).values(plan.spans.map((span, ordinal) => ({
        workspaceId: job.workspaceId,
        noteVersionId: payload.noteVersionId,
        blockId: span.blockId,
        unitKey: span.unitKey,
        plannerVersion: plan.plannerVersion,
        ordinal,
        charStart: span.charStart,
        charEnd: span.charEnd,
        textHash: span.textHash,
        sectionPath: span.sectionPath,
        sourceKind: span.kind,
        tokenEstimate: span.tokenEstimate,
        createdAt: now,
      }))).onConflictDoNothing();
    }
    const persistedSpans = plan.spans.length > 0
      ? await tx.query.noteEvidenceSpans.findMany({
          where: and(
            eq(schema.noteEvidenceSpans.workspaceId, job.workspaceId),
            eq(schema.noteEvidenceSpans.noteVersionId, payload.noteVersionId),
            inArray(schema.noteEvidenceSpans.unitKey, plan.spans.map((span) => span.unitKey)),
          ),
        })
      : [];
    const spanByUnitKey = new Map(persistedSpans.map((span) => [span.unitKey, span]));
    if (spanByUnitKey.size !== plan.spans.length) {
      throw new Error("persisted source span manifest is incomplete");
    }
    const mapUnitValues = plan.chunks.map((chunk) => {
      const spans = chunk.unitKeys.map((unitKey) => spanByUnitKey.get(unitKey)!);
      const inputManifest = {
        spanIds: spans.map((span) => span.id),
        spanUnitKeys: chunk.unitKeys,
        sectionKeys: chunk.sectionKeys,
        chunkOrdinal: chunk.ordinal,
      };
      return {
        workspaceId: job.workspaceId,
        runId: locked.run.id,
        parentUnitId: locked.unit.id,
        kind: CardGenerationUnitKind.TEXT_MAP,
        level: 0,
        ordinal: chunk.ordinal,
        unitKey: hashJson({
          pipelineVersion: TEXT_PIPELINE_VERSION,
          promptVersion: MAP_PROMPT_VERSION,
          providerFingerprint,
          spanUnitKeys: chunk.unitKeys,
        }),
        pipelineVersion: TEXT_PIPELINE_VERSION,
        required: true,
        inputManifest,
        inputHash: hashJson(inputManifest),
        tokenEstimate: chunk.tokenEstimate,
        status: "pending",
        createdAt: now,
        updatedAt: now,
      };
    });
    const mapUnits = mapUnitValues.length > 0
      ? await tx.insert(schema.cardGenerationUnits).values(mapUnitValues).returning()
      : [];

    const firstBlockByAssetId = new Map<string, (typeof imageBlocks)[number]>();
    for (const block of imageBlocks) {
      if (block.imageAssetId && !firstBlockByAssetId.has(block.imageAssetId)) {
        firstBlockByAssetId.set(block.imageAssetId, block);
      }
    }
    const imageUnitValues = [...firstBlockByAssetId.entries()].map(([assetId, block], ordinal) => {
      const asset = assetById.get(assetId)!;
      const inputManifest = {
        imageAssetId: asset.id,
        imageBlockId: block.id,
        ...(imageDescription(block.content) ? { userDescription: imageDescription(block.content) } : {}),
      };
      return {
        workspaceId: job.workspaceId,
        runId: locked.run.id,
        parentUnitId: locked.unit.id,
        kind: CardGenerationUnitKind.IMAGE,
        level: 0,
        ordinal,
        unitKey: hashJson({
          pipelineVersion: TEXT_PIPELINE_VERSION,
          extractorVersion: IMAGE_EXTRACTOR_VERSION,
          assetSha256: asset.sha256,
          inputManifest,
        }),
        pipelineVersion: TEXT_PIPELINE_VERSION,
        required: true,
        inputManifest,
        inputHash: hashJson({ assetSha256: asset.sha256, inputManifest }),
        tokenEstimate: 0,
        status: "pending",
        createdAt: now,
        updatedAt: now,
      };
    });
    const imageUnits = imageUnitValues.length > 0
      ? await tx.insert(schema.cardGenerationUnits).values(imageUnitValues).returning()
      : [];
    const requestedBy = requireAuditUser(job);
    const scheduledImages = await scheduleUnits(tx, {
      run: locked.run,
      units: imageUnits,
      requestedBy,
      limit: CARD_GENERATION_IMAGE_WINDOW,
    });
    const scheduledMaps = await scheduleUnits(tx, {
      run: locked.run,
      units: mapUnits,
      requestedBy,
      limit: CARD_GENERATION_MAP_WINDOW,
    });
    if (scheduledImages + scheduledMaps === 0) {
      throw new Error("workspace pending-job quota prevents scheduling the first generation unit");
    }
    await tx
      .update(schema.cardGenerationUnits)
      .set({
        status: "succeeded",
        artifactJson: {
          plannerVersion: plan.plannerVersion,
          sourceUnitCount: plan.spans.length,
          mapChunkCount: plan.chunks.length,
          imageAssetCount: imageUnits.length,
          excludedImageCount: imageExclusions.length,
          mapInputBudgetTokens: plan.mapInputBudgetTokens,
          providerFingerprint,
        },
        artifactHash: hashJson({
          plannerVersion: plan.plannerVersion,
          unitKeys: plan.spans.map((span) => span.unitKey),
          chunks: plan.chunks,
          imageUnitKeys: imageUnits.map((unit) => unit.unitKey),
        }),
        errorCode: null,
        finishedAt: now,
        updatedAt: now,
      })
      .where(and(
        eq(schema.cardGenerationUnits.id, locked.unit.id),
        eq(schema.cardGenerationUnits.workspaceId, job.workspaceId),
      ));
    const providerSnapshot = {
      ...locked.run.providerSnapshot,
      // 保留创建时的 executionMode：派生的 partial run 把全部图片显式排除后
      // 剩余 image unit 为 0，若在此重算会把 multimodal_v2 改写成 text_v2，
      // 污染 runbook §5.2 的 executionMode 分布口径。
      executionMode: locked.run.providerSnapshot.executionMode === "multimodal_v2"
        ? "multimodal_v2"
        : imageUnits.length > 0 ? "multimodal_v2" : "text_v2",
      providerName: governance.providerName.toLowerCase(),
      modelId: provider.modelId,
      visionModelId: provider.visionModelId,
      providerConfigurationFingerprint: providerFingerprint,
      promptVersion: MAP_PROMPT_VERSION,
      plannerVersion: SOURCE_PLANNER_VERSION,
      capability: {
        mapInputBudgetTokens: plan.mapInputBudgetTokens,
        maxSourceUnitTokens: plan.maxSourceUnitTokens,
      },
    };
    const [updated] = await tx
      .update(schema.cardGenerationRuns)
      .set({
        status: imageUnits.length > 0
          ? CardGenerationRunStatus.AWAITING_ASSETS
          : CardGenerationRunStatus.MAPPING,
        stage: imageUnits.length > 0
          ? CardGenerationStage.IMAGE_ANALYSIS
          : CardGenerationStage.TEXT_MAP,
        stateVersion: locked.run.stateVersion + 1,
        nextEventSequence: locked.run.nextEventSequence + 1,
        providerSnapshot,
        requiredUnits: plan.spans.length,
        completedUnits: 0,
        failedUnits: 0,
        requiredImages: snapshot.imageAssets.length,
        completedImages: 0,
        sourceCoverageBps: plan.spans.length === 0 ? 10_000 : 0,
        imageCoverageBps: snapshot.imageAssets.length === 0 ? 10_000 : 0,
        coverageReport: {
          ...locked.run.coverageReport,
          measurement: "exact_primary_units",
          plannerVersion: plan.plannerVersion,
          sourceUnitCount: plan.spans.length,
          mapChunkCount: plan.chunks.length,
          resultCompleteness: imageExclusions.length > 0 ? "partial" : "full",
          excludedImageCount: imageExclusions.length,
          policyAdjustedImageCoverageBps: imageUnits.length === 0 ? 10_000 : 0,
          processedPrimaryUnits: 0,
          noCandidatePrimaryUnits: 0,
          requiredImageSourceUnits: 0,
          completedImageSourceUnits: 0,
          decorativeImages: 0,
        },
        errorCode: null,
        retryable: true,
        updatedAt: now,
      })
      .where(and(
        eq(schema.cardGenerationRuns.id, locked.run.id),
        eq(schema.cardGenerationRuns.workspaceId, job.workspaceId),
        eq(schema.cardGenerationRuns.stateVersion, locked.run.stateVersion),
      ))
      .returning({ id: schema.cardGenerationRuns.id });
    if (!updated) throw new Error("generation planner completion CAS failed");
    await appendEvent(tx, locked.run, {
      stage: imageUnits.length > 0
        ? CardGenerationStage.IMAGE_ANALYSIS
        : CardGenerationStage.TEXT_MAP,
      state: imageUnits.length > 0
        ? CardGenerationRunStatus.AWAITING_ASSETS
        : CardGenerationRunStatus.MAPPING,
      completed: 0,
      total: imageUnits.length > 0 ? imageUnits.length : plan.spans.length,
      unit: imageUnits.length > 0 ? "images" : "source_units",
      messageCode: "source_plan_created",
      safeDetails: {
        plannerVersion: plan.plannerVersion,
        sourceUnitCount: plan.spans.length,
        mapChunkCount: plan.chunks.length,
        imageAssetCount: imageUnits.length,
        excludedImageCount: imageExclusions.length,
        scheduledImageJobs: scheduledImages,
        scheduledMapJobs: scheduledMaps,
      },
      createdAt: now,
    });
  });
}

type MapMaterial = {
  run: LockedRun;
  unit: LockedUnit;
  input: CardMapInput;
  /**
   * Provider 输入使用紧凑别名(u1..uN)而不是 span UUID:coverage 契约要求
   * 模型逐个回显 refId,36 字符的 UUID 会把输出 token 放大一个数量级,
   * 既拖慢生成又提高超时/契约违约概率。持久化前在服务端译回真实 span ID。
   */
  spanIdByRefId: Map<string, string>;
};

async function loadMapMaterial(
  job: CardGenerationTextJob,
  payload: PipelinePayload,
): Promise<MapMaterial> {
  return withWorkerWorkspaceTransaction(
    { workspaceId: job.workspaceId, userId: job.requestedBy },
    async (tx) => {
      const run = await tx.query.cardGenerationRuns.findFirst({
        where: and(
          eq(schema.cardGenerationRuns.id, payload.runId),
          eq(schema.cardGenerationRuns.workspaceId, job.workspaceId),
        ),
      });
      const unit = await tx.query.cardGenerationUnits.findFirst({
        where: and(
          eq(schema.cardGenerationUnits.id, payload.unitId),
          eq(schema.cardGenerationUnits.workspaceId, job.workspaceId),
          eq(schema.cardGenerationUnits.runId, payload.runId),
        ),
      });
      if (!run || !unit) throw new Error("map checkpoint disappeared");
      const spanIds = unit.inputManifest.spanIds ?? [];
      if (spanIds.length === 0) throw new Error("map unit has an empty span manifest");
      const spans = await tx.query.noteEvidenceSpans.findMany({
        where: and(
          eq(schema.noteEvidenceSpans.workspaceId, job.workspaceId),
          eq(schema.noteEvidenceSpans.noteVersionId, payload.noteVersionId),
          inArray(schema.noteEvidenceSpans.id, spanIds),
        ),
      });
      const blockIds = [...new Set(spans.map((span) => span.blockId))];
      const blocks = await tx.query.noteBlocks.findMany({
        where: and(
          eq(schema.noteBlocks.workspaceId, job.workspaceId),
          eq(schema.noteBlocks.versionId, payload.noteVersionId),
          inArray(schema.noteBlocks.id, blockIds),
        ),
      });
      const spanById = new Map(spans.map((span) => [span.id, span]));
      const blockById = new Map(blocks.map((block) => [block.id, block]));
      const spanIdByRefId = new Map<string, string>();
      const evidenceUnits = spanIds.map((spanId, index) => {
        const span = spanById.get(spanId);
        const block = span ? blockById.get(span.blockId) : undefined;
        if (!span || !block) throw new Error("map span manifest cannot be resolved");
        const exactText = block.content.slice(span.charStart, span.charEnd);
        if (sha256(exactText) !== span.textHash) {
          throw new Error("sealed text span hash mismatch");
        }
        const refId = `u${index + 1}`;
        spanIdByRefId.set(refId, span.id);
        return {
          refId,
          kind: span.sourceKind as "text" | "list" | "code",
          text: exactText,
          sectionPath: span.sectionPath,
          contextOnly: false,
        };
      });
      return {
        run,
        unit,
        input: cardMapInputSchema.parse({ noteTitle: run.titleSnapshot, evidenceUnits }),
        spanIdByRefId,
      };
    },
  );
}

function assertProviderSnapshot(
  run: LockedRun,
  input: {
    providerName: string;
    modelId: string;
    providerFingerprint: string;
  },
): void {
  const snapshot = run.providerSnapshot as Record<string, unknown>;
  if (
    snapshot.providerName !== input.providerName.toLowerCase()
    || snapshot.modelId !== input.modelId
    || snapshot.providerConfigurationFingerprint !== input.providerFingerprint
  ) {
    throw new Error("provider snapshot mismatch; the configured provider changed after planning");
  }
}

async function ensureReduceScheduled(
  tx: WorkerTransaction,
  run: LockedRun,
  requestedBy: string,
): Promise<boolean> {
  const mapUnits = await tx.query.cardGenerationUnits.findMany({
    where: and(
      eq(schema.cardGenerationUnits.workspaceId, run.workspaceId),
      eq(schema.cardGenerationUnits.runId, run.id),
      inArray(schema.cardGenerationUnits.kind, [
        CardGenerationUnitKind.TEXT_MAP,
        CardGenerationUnitKind.IMAGE,
      ]),
      eq(schema.cardGenerationUnits.required, true),
    ),
  });
  const unfinishedMapUnits = mapUnits.filter((unit) => unit.status !== "succeeded");
  if (unfinishedMapUnits.length > 0) {
    // 方案 §7.5/G5: one failed unit must never freeze its siblings. The run
    // only settles into needs_attention once no map/image checkpoint is
    // pending, running, or awaiting an automatic queue retry, so that every
    // failure is surfaced (and can be retried) in a single batch.
    if (unfinishedMapUnits.every((unit) => unit.status === "terminal_failed")) {
      await markGenerationPhaseSettled(tx, run, unfinishedMapUnits.length);
    }
    return true;
  }
  let reduceUnit = await tx.query.cardGenerationUnits.findFirst({
    where: and(
      eq(schema.cardGenerationUnits.workspaceId, run.workspaceId),
      eq(schema.cardGenerationUnits.runId, run.id),
      eq(schema.cardGenerationUnits.kind, CardGenerationUnitKind.SECTION_REDUCE),
    ),
  });
  if (!reduceUnit) {
    const [created] = await tx
      .insert(schema.cardGenerationUnits)
      .values({
        workspaceId: run.workspaceId,
        runId: run.id,
        kind: CardGenerationUnitKind.SECTION_REDUCE,
        level: 0,
        ordinal: 0,
        unitKey: hashJson({ runId: run.id, kind: CardGenerationUnitKind.SECTION_REDUCE }),
        pipelineVersion: TEXT_PIPELINE_VERSION,
        required: true,
        inputManifest: {},
        inputHash: hashJson({ runId: run.id, stage: CardGenerationStage.SECTION_REDUCE }),
        tokenEstimate: 0,
        status: "pending",
      })
      .returning();
    reduceUnit = created;
  }
  if (reduceUnit.scheduledAt) return true;
  return await scheduleUnits(tx, {
    run,
    units: [reduceUnit],
    requestedBy,
    limit: 1,
  }) === 1;
}

/**
 * 方案 §7.5/G5: settle the map/image phase into needs_attention only after
 * every checkpoint reached a final state. Uses a fresh FOR UPDATE read like
 * markSchedulerAttention so a concurrent completion cannot be overwritten.
 */
async function markGenerationPhaseSettled(
  tx: WorkerTransaction,
  run: LockedRun,
  failedUnitCount: number,
): Promise<void> {
  const [fresh] = await tx
    .select()
    .from(schema.cardGenerationRuns)
    .where(and(
      eq(schema.cardGenerationRuns.id, run.id),
      eq(schema.cardGenerationRuns.workspaceId, run.workspaceId),
    ))
    .for("update");
  if (!fresh) return;
  const untouchableStatuses: string[] = [
    CardGenerationRunStatus.NEEDS_ATTENTION,
    CardGenerationRunStatus.SUCCEEDED,
    CardGenerationRunStatus.PARTIAL_READY,
    CardGenerationRunStatus.CANCELLED,
    CardGenerationRunStatus.SUPERSEDED,
  ];
  if (untouchableStatuses.includes(fresh.status)) return;
  const now = new Date();
  const [updated] = await tx
    .update(schema.cardGenerationRuns)
    .set({
      status: CardGenerationRunStatus.NEEDS_ATTENTION,
      stateVersion: fresh.stateVersion + 1,
      nextEventSequence: fresh.nextEventSequence + 1,
      errorCode: fresh.errorCode ?? "generation_units_failed",
      // Manual checkpoint retry is always safe (units are idempotent); the
      // auto-retry classification only governs queue behaviour.
      retryable: true,
      updatedAt: now,
      finishedAt: now,
    })
    .where(and(
      eq(schema.cardGenerationRuns.id, fresh.id),
      eq(schema.cardGenerationRuns.workspaceId, fresh.workspaceId),
      eq(schema.cardGenerationRuns.stateVersion, fresh.stateVersion),
    ))
    .returning({ id: schema.cardGenerationRuns.id });
  if (!updated) throw new Error("generation phase settle CAS failed");
  await appendEvent(tx, fresh, {
    stage: fresh.stage,
    state: CardGenerationRunStatus.NEEDS_ATTENTION,
    completed: fresh.completedUnits,
    total: fresh.requiredUnits,
    unit: "source_units",
    messageCode: "generation_units_failed",
    safeDetails: { failedUnitCount, retryable: true },
    createdAt: now,
  });
}

async function advanceMapWindow(
  tx: WorkerTransaction,
  run: LockedRun,
  requestedBy: string,
  currentJobId: string,
): Promise<boolean> {
  const activeJobs = await tx
    .select({ count: count() })
    .from(schema.jobs)
    .where(and(
      eq(schema.jobs.workspaceId, run.workspaceId),
      eq(schema.jobs.generationRunId, run.id),
      eq(schema.jobs.type, JobType.MAP_CARD_GENERATION),
      inArray(schema.jobs.status, [JobStatus.PENDING, JobStatus.RUNNING]),
      ne(schema.jobs.id, currentJobId),
    ));
  const activeCount = Number(activeJobs[0]?.count ?? 0);
  const unscheduled = await tx.query.cardGenerationUnits.findMany({
    where: and(
      eq(schema.cardGenerationUnits.workspaceId, run.workspaceId),
      eq(schema.cardGenerationUnits.runId, run.id),
      eq(schema.cardGenerationUnits.kind, CardGenerationUnitKind.TEXT_MAP),
      eq(schema.cardGenerationUnits.status, "pending"),
      isNull(schema.cardGenerationUnits.scheduledAt),
    ),
    orderBy: [asc(schema.cardGenerationUnits.ordinal)],
    limit: Math.max(0, CARD_GENERATION_MAP_WINDOW - activeCount),
  });
  if (unscheduled.length > 0) {
    const requested = Math.max(0, CARD_GENERATION_MAP_WINDOW - activeCount);
    const scheduled = await scheduleUnits(tx, { run, units: unscheduled, requestedBy, limit: requested });
    if (scheduled === 0) return false;
  }
  return ensureReduceScheduled(tx, run, requestedBy);
}

async function advanceImageWindow(
  tx: WorkerTransaction,
  run: LockedRun,
  requestedBy: string,
  currentJobId: string,
): Promise<boolean> {
  const activeJobs = await tx
    .select({ count: count() })
    .from(schema.jobs)
    .where(and(
      eq(schema.jobs.workspaceId, run.workspaceId),
      eq(schema.jobs.generationRunId, run.id),
      eq(schema.jobs.type, JobType.ANALYZE_CARD_IMAGE),
      inArray(schema.jobs.status, [JobStatus.PENDING, JobStatus.RUNNING]),
      ne(schema.jobs.id, currentJobId),
    ));
  const activeCount = Number(activeJobs[0]?.count ?? 0);
  const unscheduled = await tx.query.cardGenerationUnits.findMany({
    where: and(
      eq(schema.cardGenerationUnits.workspaceId, run.workspaceId),
      eq(schema.cardGenerationUnits.runId, run.id),
      eq(schema.cardGenerationUnits.kind, CardGenerationUnitKind.IMAGE),
      eq(schema.cardGenerationUnits.status, "pending"),
      isNull(schema.cardGenerationUnits.scheduledAt),
    ),
    orderBy: [asc(schema.cardGenerationUnits.ordinal)],
    limit: Math.max(0, CARD_GENERATION_IMAGE_WINDOW - activeCount),
  });
  if (unscheduled.length > 0) {
    const requested = Math.max(0, CARD_GENERATION_IMAGE_WINDOW - activeCount);
    const scheduled = await scheduleUnits(tx, { run, units: unscheduled, requestedBy, limit: requested });
    if (scheduled === 0) return false;
  }
  return ensureReduceScheduled(tx, run, requestedBy);
}

type ImageMaterial = {
  run: LockedRun;
  unit: LockedUnit;
  asset: typeof schema.noteImageAssets.$inferSelect;
  block: typeof schema.noteBlocks.$inferSelect;
};

async function loadImageMaterial(
  job: CardGenerationTextJob,
  payload: PipelinePayload,
): Promise<ImageMaterial> {
  return withWorkerWorkspaceTransaction(
    { workspaceId: job.workspaceId, userId: job.requestedBy },
    async (tx) => {
      const run = await tx.query.cardGenerationRuns.findFirst({
        where: and(
          eq(schema.cardGenerationRuns.id, payload.runId),
          eq(schema.cardGenerationRuns.workspaceId, job.workspaceId),
        ),
      });
      const unit = await tx.query.cardGenerationUnits.findFirst({
        where: and(
          eq(schema.cardGenerationUnits.id, payload.unitId),
          eq(schema.cardGenerationUnits.workspaceId, job.workspaceId),
          eq(schema.cardGenerationUnits.runId, payload.runId),
        ),
      });
      const assetId = unit?.inputManifest.imageAssetId;
      const blockId = unit?.inputManifest.imageBlockId;
      if (!run || !unit || !assetId || !blockId) {
        throw new Error("image checkpoint manifest cannot be resolved");
      }
      const asset = await tx.query.noteImageAssets.findFirst({
        where: and(
          eq(schema.noteImageAssets.id, assetId),
          eq(schema.noteImageAssets.workspaceId, job.workspaceId),
        ),
      });
      const block = await tx.query.noteBlocks.findFirst({
        where: and(
          eq(schema.noteBlocks.id, blockId),
          eq(schema.noteBlocks.versionId, payload.noteVersionId),
          eq(schema.noteBlocks.workspaceId, job.workspaceId),
        ),
      });
      if (
        !asset
        || asset.status !== "ready"
        || asset.deletedAt
        || !block
        || block.type !== "image"
        || block.imageAssetId !== asset.id
      ) {
        throw new Error("image checkpoint typed asset binding is invalid");
      }
      return { run, unit, asset, block };
    },
  );
}

function imageInsightCacheKey(
  material: ImageMaterial,
  visionModelId: string,
): string {
  return hashJson({
    workspaceId: material.run.workspaceId,
    assetSha256: material.asset.sha256,
    extractorVersion: IMAGE_EXTRACTOR_VERSION,
    visionModelId,
    promptVersion: IMAGE_PROMPT_VERSION,
    governancePolicyVersion: material.run.governancePolicyVersion,
  });
}

async function markImageInsightFailed(
  job: CardGenerationTextJob,
  payload: PipelinePayload,
  insightId: string,
  errorCode: string,
): Promise<void> {
  await withJobTransaction(leaseContext(job), async (tx) => {
    const locked = await lockPipelineState(tx, leaseContext(job), payload, CardGenerationUnitKind.IMAGE);
    if (locked.decision !== "active") return;
    const now = new Date();
    await tx
      .update(schema.noteImageInsights)
      .set({ status: "failed", errorCode, updatedAt: now, finishedAt: now })
      .where(and(
        eq(schema.noteImageInsights.id, insightId),
        eq(schema.noteImageInsights.workspaceId, job.workspaceId),
        ne(schema.noteImageInsights.status, "succeeded"),
      ));
  });
}

export async function runAnalyzeCardImage(job: CardGenerationTextJob): Promise<void> {
  const auditUserId = requireAuditUser(job);
  const payload = pipelinePayload(job);
  const begin = await beginPipelineUnit(job, CardGenerationUnitKind.IMAGE, {
    status: CardGenerationRunStatus.AWAITING_ASSETS,
    stage: CardGenerationStage.IMAGE_ANALYSIS,
    messageCode: "image_analysis_started",
    progressUnit: "images",
  });
  if (begin === "skip") return;
  if (begin === "already_succeeded") {
    await withJobTransaction(leaseContext(job), async (tx) => {
      const locked = await lockPipelineState(tx, leaseContext(job), payload, CardGenerationUnitKind.IMAGE);
      if (locked.decision !== "active") return;
      if (!await advanceImageWindow(tx, locked.run, auditUserId, job.id)) {
        await markSchedulerAttention(tx, locked.run, new Date());
      }
    });
    return;
  }

  const material = await loadImageMaterial(job, payload);
  const governance = await resolveAIGovernanceContext(job.workspaceId, auditUserId);
  if (!governance.consentOk) throw new Error("AI consent not signed for this workspace");
  const provider = createProvider(governance.providerName, governance.providerConfig);
  const providerFingerprint = providerConfigurationFingerprint(
    governance.providerName,
    provider.modelId,
    governance.providerConfig,
  );
  assertProviderSnapshot(material.run, {
    providerName: governance.providerName,
    modelId: provider.modelId,
    providerFingerprint,
  });
  if (material.run.providerSnapshot.visionModelId !== provider.visionModelId) {
    throw new Error("vision provider snapshot mismatch; configuration changed after planning");
  }
  const cacheKey = imageInsightCacheKey(material, provider.visionModelId);

  const claimed = await withJobTransaction(leaseContext(job), async (tx) => {
    const locked = await lockPipelineState(tx, leaseContext(job), payload, CardGenerationUnitKind.IMAGE);
    if (locked.decision !== "active") return null;
    const existing = await tx.query.noteImageInsights.findFirst({
      where: and(
        eq(schema.noteImageInsights.workspaceId, job.workspaceId),
        eq(schema.noteImageInsights.imageAssetId, material.asset.id),
        eq(schema.noteImageInsights.cacheKey, cacheKey),
      ),
    });
    if (existing?.status === "succeeded") return { insight: existing, analyze: false } as const;
    const now = new Date();
    if (existing?.status === "running" && now.getTime() - existing.updatedAt.getTime() < 120_000) {
      throw new Error("image insight is already being analyzed");
    }
    if (existing) {
      const [insight] = await tx
        .update(schema.noteImageInsights)
        .set({
          status: "running",
          attempts: existing.attempts + 1,
          errorCode: null,
          updatedAt: now,
          finishedAt: null,
        })
        .where(and(
          eq(schema.noteImageInsights.id, existing.id),
          eq(schema.noteImageInsights.workspaceId, job.workspaceId),
          ne(schema.noteImageInsights.status, "succeeded"),
        ))
        .returning();
      if (!insight) throw new Error("image insight claim CAS failed");
      return { insight, analyze: true } as const;
    }
    const [insight] = await tx
      .insert(schema.noteImageInsights)
      .values({
        workspaceId: job.workspaceId,
        imageAssetId: material.asset.id,
        cacheKey,
        extractorVersion: IMAGE_EXTRACTOR_VERSION,
        visionModelId: provider.visionModelId,
        promptVersion: IMAGE_PROMPT_VERSION,
        governancePolicyVersion: material.run.governancePolicyVersion,
        status: "running",
        attempts: 1,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing({
        target: [
          schema.noteImageInsights.workspaceId,
          schema.noteImageInsights.imageAssetId,
          schema.noteImageInsights.cacheKey,
        ],
      })
      .returning();
    if (insight) return { insight, analyze: true } as const;
    const raced = await tx.query.noteImageInsights.findFirst({
      where: and(
        eq(schema.noteImageInsights.workspaceId, job.workspaceId),
        eq(schema.noteImageInsights.imageAssetId, material.asset.id),
        eq(schema.noteImageInsights.cacheKey, cacheKey),
      ),
    });
    if (raced?.status === "succeeded") return { insight: raced, analyze: false } as const;
    throw new Error("image insight is already being analyzed");
  });
  if (!claimed) return;

  let insight = claimed.insight;
  let analysisCalled = false;
  let analysisDurationMs = 0;
  let analysisUsage: ProviderUsage | null = null;
  if (claimed.analyze) {
    try {
      // 方案 §7.3: image bytes may only leave the workspace after the owner
      // explicitly authorized sendImageContent. Fail fast with a stable,
      // user-recoverable code instead of burning three provider retries on a
      // policy decision ("not configured" marks it non-retryable for the
      // queue; the run itself stays manually retryable).
      if (
        governance.providerName.toLowerCase() !== "mock"
        && !governance.policy.sendImageContent
      ) {
        throw Object.assign(
          new Error("workspace image content policy is not configured (sendImageContent=false)"),
          { code: "image_content_not_allowed" },
        );
      }
      const downloaded = await downloadImageAsset(material.asset.objectKey);
      if (
        downloaded.body.length !== material.asset.byteSize
        || downloaded.contentType !== material.asset.mimeType
        || sha256Bytes(downloaded.body) !== material.asset.sha256
      ) {
        throw new Error("immutable image object metadata or hash mismatch");
      }
      const governed = enforcePrivacyGovernanceWithPolicy(
        governance.policy,
        job.workspaceId,
        ["image_content"],
        {
          userDescription: material.unit.inputManifest.userDescription ?? null,
          mimeType: material.asset.mimeType,
          width: material.asset.width,
          height: material.asset.height,
        },
        governance.providerName,
      );
      if (!governed.allowed) throw new Error(governed.reason ?? "AI privacy governance blocked image content");
      const sanitizedDescription = typeof governed.sanitizedData.userDescription === "string"
        ? governed.sanitizedData.userDescription
        : undefined;
      const startedAt = Date.now();
      analysisCalled = true;
      const output = await runWithAbortBudget(
        (signal) => provider.analyzeImage({
          body: downloaded.body,
          mimeType: material.asset.mimeType as "image/png" | "image/jpeg" | "image/gif" | "image/webp",
          width: material.asset.width,
          height: material.asset.height,
          sha256: material.asset.sha256,
          ...(sanitizedDescription ? { userDescription: sanitizedDescription } : {}),
        }, signal),
        job.signal,
        resolveProviderCallTimeout(JobType.ANALYZE_CARD_IMAGE),
        (error) => logger.warn(
          { runId: payload.runId, unitId: payload.unitId, error: sanitizeOperationalError(error) },
          "late image-analysis provider result ignored",
        ),
      );
      analysisDurationMs = Date.now() - startedAt;
      analysisUsage = provider.getLastUsage();
      if (output.unresolvedReason) {
        await markImageInsightFailed(job, payload, insight.id, `image_unresolved_${output.unresolvedReason}`);
        throw new Error(`image unresolved: ${output.unresolvedReason}`);
      }
      if (output.promptInjectionDetected) {
        await markImageInsightFailed(job, payload, insight.id, "image_prompt_injection_detected");
        throw new Error("image prompt injection detected; derived evidence was rejected");
      }
      const hardOcr = output.ocr.filter((item) =>
        Math.round(item.confidence * 10_000) >= CARD_GENERATION_IMAGE_EVIDENCE_MIN_CONFIDENCE_BPS);
      const hardFacts = output.facts.filter((item) =>
        Math.round(item.confidence * 10_000) >= CARD_GENERATION_IMAGE_EVIDENCE_MIN_CONFIDENCE_BPS);
      // 方案 §7.4: a readable image whose OCR/structured facts stay below the
      // hard-evidence confidence floor is caption-soft — it counts as
      // processed, produces no key-point evidence, and must NOT fail the run.
      // Only unresolved/injection cases above remain hard failures.
      const captionSoft = !output.decorative && hardOcr.length === 0 && hardFacts.length === 0;
      insight = await withJobTransaction(leaseContext(job), async (tx) => {
        const locked = await lockPipelineState(tx, leaseContext(job), payload, CardGenerationUnitKind.IMAGE);
        if (locked.decision !== "active") throw new Error("image result became stale before persistence");
        const now = new Date();
        const artifactHash = hashJson(output);
        const [persisted] = await tx
          .update(schema.noteImageInsights)
          .set({
            status: "succeeded",
            contentType: output.contentType,
            caption: output.caption,
            ocrJson: output.ocr,
            factsJson: output.facts,
            safetyJson: {
              decorative: output.decorative,
              captionSoft,
              promptInjectionDetected: output.promptInjectionDetected,
              safetyFlags: output.safetyFlags,
            },
            artifactHash,
            errorCode: null,
            updatedAt: now,
            finishedAt: now,
          })
          .where(and(
            eq(schema.noteImageInsights.id, insight.id),
            eq(schema.noteImageInsights.workspaceId, job.workspaceId),
            eq(schema.noteImageInsights.status, "running"),
          ))
          .returning();
        if (!persisted) throw new Error("image insight completion CAS failed");
        const evidenceValues = [
          ...hardOcr.map((item, ordinal) => ({
            workspaceId: job.workspaceId,
            imageInsightId: persisted.id,
            imageAssetId: material.asset.id,
            unitKey: hashJson({ kind: "image_ocr", ordinal, text: item.text, region: item.region }),
            ordinal,
            sourceKind: "image_ocr",
            text: item.text,
            textHash: sha256(item.text),
            region: item.region,
            confidenceBps: Math.round(item.confidence * 10_000),
            evidenceLevel: "image_ocr_exact",
            required: true,
            createdAt: now,
          })),
          ...hardFacts.map((item, factOrdinal) => {
            const ordinal = hardOcr.length + factOrdinal;
            return {
              workspaceId: job.workspaceId,
              imageInsightId: persisted.id,
              imageAssetId: material.asset.id,
              unitKey: hashJson({ kind: "image_fact", ordinal, text: item.text, region: item.region }),
              ordinal,
              sourceKind: "image_fact",
              text: item.text,
              textHash: sha256(item.text),
              region: item.region,
              confidenceBps: Math.round(item.confidence * 10_000),
              evidenceLevel: "image_structured",
              required: true,
              createdAt: now,
            };
          }),
        ];
        if (evidenceValues.length > 0) {
          await tx.insert(schema.noteImageEvidenceUnits).values(evidenceValues);
        }
        return persisted;
      });
    } catch (error) {
      if (analysisCalled) {
        await logAICall({
          workspaceId: job.workspaceId,
          userId: auditUserId,
          jobId: job.id,
          provider: provider.id,
          modelId: provider.visionModelId,
          operation: "image_understanding",
          dataCategories: ["image_content"],
          dataSizeBytes: material.asset.byteSize,
          costTokens: analysisUsage?.totalTokens ?? null,
          durationMs: analysisDurationMs,
          status: "failure",
          errorMessage: safeErrorMessage(error),
        });
      }
      await markImageInsightFailed(job, payload, insight.id, sanitizeOperationalError(error).category)
        .catch(() => undefined);
      throw error;
    }
  }

  const imageEvidenceUnits = await withWorkerWorkspaceTransaction(
    { workspaceId: job.workspaceId, userId: job.requestedBy },
    (tx) => tx.query.noteImageEvidenceUnits.findMany({
      where: and(
        eq(schema.noteImageEvidenceUnits.workspaceId, job.workspaceId),
        eq(schema.noteImageEvidenceUnits.imageInsightId, insight.id),
        eq(schema.noteImageEvidenceUnits.required, true),
      ),
      orderBy: [asc(schema.noteImageEvidenceUnits.ordinal)],
    }),
  );
  // 与文本 Map 同理:紧凑别名(i1..iN)代替 UUID,压缩模型必须回显的
  // 输出 token;落库前译回真实 image evidence unit ID。
  const imageEvidenceUnitIdByRefId = new Map<string, string>(
    imageEvidenceUnits.map((unit, index) => [`i${index + 1}`, unit.id]),
  );
  const resolveImageEvidenceUnitId = (refId: string): string => {
    const unitId = imageEvidenceUnitIdByRefId.get(refId);
    if (!unitId) {
      throw new CardMapContractError(
        "map_unknown_evidence_ref",
        `alias ${refId} is not in the image evidence manifest`,
      );
    }
    return unitId;
  };
  const providerInput = imageEvidenceUnits.length > 0
    ? cardMapInputSchema.parse({
        noteTitle: material.run.titleSnapshot,
        evidenceUnits: imageEvidenceUnits.map((unit, index) => ({
          refId: `i${index + 1}`,
          kind: unit.sourceKind,
          text: unit.text,
          sectionPath: [material.run.titleSnapshot, "图片"],
          contextOnly: false,
        })),
      })
    : null;
  let validated: ReturnType<typeof validateCardMapOutput> | null = null;
  let mapOutput: Awaited<ReturnType<typeof provider.extractCardCandidates>> | null = null;
  let mapDurationMs = 0;
  let mapUsage: ProviderUsage | null = null;
  if (providerInput) {
    const governed = enforcePrivacyGovernanceWithPolicy(
      governance.policy,
      job.workspaceId,
      ["image_insight"],
      providerInput,
      governance.providerName,
    );
    if (!governed.allowed) throw new Error(governed.reason ?? "AI privacy governance blocked image insight");
    const safeInput = cardMapInputSchema.parse(governed.sanitizedData);
    const startedAt = Date.now();
    try {
      mapOutput = await runWithAbortBudget(
        (signal) => provider.extractCardCandidates(safeInput, signal),
        job.signal,
        // 该 handler 里这是第二次 Provider 调用(视觉调用之后)。输入只有
        // 少量图片证据片段,45s 足够;同时保证最坏情况 vision(75s)+map(45s)
        // 触发 110s handler 超时后,重试可命中 insight 缓存只跑本调用。
        Math.min(resolveProviderCallTimeout(JobType.MAP_CARD_GENERATION), 45_000),
      );
      mapDurationMs = Date.now() - startedAt;
      mapUsage = provider.getLastUsage();
      validated = validateCardMapOutput(providerInput, mapOutput);
    } catch (error) {
      mapDurationMs = Date.now() - startedAt;
      mapUsage = provider.getLastUsage();
      await logAICall({
        workspaceId: job.workspaceId,
        userId: auditUserId,
        jobId: job.id,
        provider: provider.id,
        modelId: provider.modelId,
        operation: "image_card_map",
        dataCategories: ["image_insight"],
        dataSizeBytes: JSON.stringify(providerInput).length,
        costTokens: mapUsage?.totalTokens ?? null,
        durationMs: mapDurationMs,
        status: "failure",
        errorMessage: safeErrorMessage(error),
      });
      throw error;
    }
  }
  throwIfJobAborted(leaseContext(job));

  await withJobTransaction(leaseContext(job), async (tx) => {
    const locked = await lockPipelineState(tx, leaseContext(job), payload, CardGenerationUnitKind.IMAGE);
    if (locked.decision !== "active" || locked.unit.status === "succeeded") return;
    const now = new Date();
    const insightSafety = (insight.safetyJson ?? {}) as Record<string, unknown>;
    const captionSoftImage = imageEvidenceUnits.length === 0 && insightSafety.captionSoft === true;
    const candidates = validated?.candidates ?? [];
    const inserted = candidates.length > 0
      ? await tx.insert(schema.cardGenerationCandidates).values(candidates.map((candidate, ordinal) => ({
          workspaceId: job.workspaceId,
          runId: locked.run.id,
          unitId: locked.unit.id,
          localOrdinal: ordinal,
          localId: candidate.localId,
          claim: candidate.claim,
          normalizedClaimHash: candidate.normalizedClaimHash,
          topic: candidate.topic,
          sectionKey: candidate.sectionKey,
          cognitiveType: candidate.cognitiveType,
          importance: candidate.importance,
          validationStatus: "accepted",
          createdAt: now,
        }))).returning()
      : [];
    const candidateByLocalId = new Map(inserted.map((candidate) => [candidate.localId, candidate]));
    const evidenceRows = candidates.flatMap((candidate) => {
      const persisted = candidateByLocalId.get(candidate.localId);
      if (!persisted) throw new Error("image candidate persistence mismatch");
      return candidate.evidenceRefIds.map((refId, ordinal) => ({
        workspaceId: job.workspaceId,
        runId: locked.run.id,
        noteVersionId: locked.run.noteVersionId,
        candidateId: persisted.id,
        sourceKind: "image_region",
        imageEvidenceUnitId: resolveImageEvidenceUnitId(refId),
        ordinal,
        createdAt: now,
      }));
    });
    if (evidenceRows.length > 0) {
      await tx.insert(schema.cardGenerationCandidateEvidence).values(evidenceRows);
    }
    const artifact = {
      imageAssetId: material.asset.id,
      imageInsightId: insight.id,
      imageEvidenceUnitIds: imageEvidenceUnits.map((unit) => unit.id),
      decorative: imageEvidenceUnits.length === 0 && !captionSoftImage,
      captionSoft: captionSoftImage,
      candidateIds: inserted.map((candidate) => candidate.id),
      noCandidateUnitIds: (validated?.noCandidateUnitIds ?? []).map((item) => ({
        unitId: resolveImageEvidenceUnitId(item.unitId),
        reason: item.reason,
      })),
      providerRequestId: mapUsage?.requestId ?? analysisUsage?.requestId ?? null,
    };
    await tx
      .update(schema.cardGenerationUnits)
      .set({
        status: "succeeded",
        artifactJson: artifact,
        artifactHash: hashJson(artifact),
        errorCode: null,
        finishedAt: now,
        updatedAt: now,
      })
      .where(and(
        eq(schema.cardGenerationUnits.id, locked.unit.id),
        eq(schema.cardGenerationUnits.workspaceId, job.workspaceId),
        eq(schema.cardGenerationUnits.status, "running"),
      ));
    const processableImages = requiredProcessableImages(locked.run);
    const completedImages = Math.min(processableImages, locked.run.completedImages + 1);
    const imageCoverageBps = locked.run.requiredImages === 0
      ? 10_000
      : Math.floor(completedImages * 10_000 / locked.run.requiredImages);
    const allImagesComplete = completedImages === processableImages;
    const sourceComplete = locked.run.completedUnits === locked.run.requiredUnits;
    const nextStatus = allImagesComplete
      ? sourceComplete ? CardGenerationRunStatus.REDUCING : CardGenerationRunStatus.MAPPING
      : CardGenerationRunStatus.AWAITING_ASSETS;
    const nextStage = allImagesComplete
      ? sourceComplete ? CardGenerationStage.SECTION_REDUCE : CardGenerationStage.TEXT_MAP
      : CardGenerationStage.IMAGE_ANALYSIS;
    const coverageReport = {
      ...locked.run.coverageReport,
      policyAdjustedImageCoverageBps: processableImages === 0
        ? 10_000
        : Math.floor(completedImages * 10_000 / processableImages),
      requiredImageSourceUnits:
        Number(locked.run.coverageReport.requiredImageSourceUnits ?? 0) + imageEvidenceUnits.length,
      completedImageSourceUnits:
        Number(locked.run.coverageReport.completedImageSourceUnits ?? 0) + imageEvidenceUnits.length,
      decorativeImages:
        Number(locked.run.coverageReport.decorativeImages ?? 0)
        + (imageEvidenceUnits.length === 0 && !captionSoftImage ? 1 : 0),
      captionSoftImages:
        Number(locked.run.coverageReport.captionSoftImages ?? 0) + (captionSoftImage ? 1 : 0),
    };
    const [updatedRun] = await tx
      .update(schema.cardGenerationRuns)
      .set({
        status: nextStatus,
        stage: nextStage,
        stateVersion: locked.run.stateVersion + 1,
        nextEventSequence: locked.run.nextEventSequence + 1,
        completedImages,
        imageCoverageBps,
        coverageReport,
        errorCode: null,
        retryable: true,
        updatedAt: now,
        finishedAt: null,
      })
      .where(and(
        eq(schema.cardGenerationRuns.id, locked.run.id),
        eq(schema.cardGenerationRuns.workspaceId, job.workspaceId),
        eq(schema.cardGenerationRuns.stateVersion, locked.run.stateVersion),
      ))
      .returning();
    if (!updatedRun) throw new Error("image progress CAS failed");
    await appendEvent(tx, locked.run, {
      stage: CardGenerationStage.IMAGE_ANALYSIS,
      state: nextStatus,
      completed: completedImages,
      total: locked.run.requiredImages,
      unit: "images",
      messageCode: "image_analysis_succeeded",
      safeDetails: {
        imageUnitOrdinal: locked.unit.ordinal,
        imageEvidenceUnits: imageEvidenceUnits.length,
        candidates: inserted.length,
        decorative: imageEvidenceUnits.length === 0 && !captionSoftImage,
        captionSoft: captionSoftImage,
      },
      createdAt: now,
    });
    if (!await advanceImageWindow(tx, updatedRun, auditUserId, job.id)) {
      await markSchedulerAttention(tx, updatedRun, now);
    }
  });

  if (analysisCalled) {
    await logAICall({
      workspaceId: job.workspaceId,
      userId: auditUserId,
      jobId: job.id,
      provider: provider.id,
      modelId: provider.visionModelId,
      operation: "image_understanding",
      dataCategories: ["image_content"],
      dataSizeBytes: material.asset.byteSize,
      costTokens: analysisUsage?.totalTokens ?? null,
      durationMs: analysisDurationMs,
      status: "success",
    });
  }
  if (providerInput && mapOutput) {
    await logAICall({
      workspaceId: job.workspaceId,
      userId: auditUserId,
      jobId: job.id,
      provider: provider.id,
      modelId: provider.modelId,
      operation: "image_card_map",
      dataCategories: ["image_insight"],
      dataSizeBytes: JSON.stringify(providerInput).length,
      costTokens: mapUsage?.totalTokens ?? null,
      durationMs: mapDurationMs,
      status: "success",
    });
  }
}

export async function runMapCardGeneration(job: CardGenerationTextJob): Promise<void> {
  const auditUserId = requireAuditUser(job);
  const payload = pipelinePayload(job);
  const begin = await beginPipelineUnit(job, CardGenerationUnitKind.TEXT_MAP, {
    status: CardGenerationRunStatus.MAPPING,
    stage: CardGenerationStage.TEXT_MAP,
    messageCode: "text_mapping_started",
    progressUnit: "source_units",
  });
  if (begin === "skip") return;
  if (begin === "already_succeeded") {
    await withJobTransaction(leaseContext(job), async (tx) => {
      const locked = await lockPipelineState(tx, leaseContext(job), payload, CardGenerationUnitKind.TEXT_MAP);
      if (locked.decision !== "active") return;
      if (!await advanceMapWindow(tx, locked.run, auditUserId, job.id)) {
        await markSchedulerAttention(tx, locked.run, new Date());
      }
    });
    return;
  }

  const material = await loadMapMaterial(job, payload);
  const governance = await resolveAIGovernanceContext(job.workspaceId, auditUserId);
  if (!governance.consentOk) throw new Error("AI consent not signed for this workspace");
  const provider = createProvider(governance.providerName, governance.providerConfig);
  const providerFingerprint = providerConfigurationFingerprint(
    governance.providerName,
    provider.modelId,
    governance.providerConfig,
  );
  assertProviderSnapshot(material.run, {
    providerName: governance.providerName,
    modelId: provider.modelId,
    providerFingerprint,
  });
  const governed = enforcePrivacyGovernanceWithPolicy(
    governance.policy,
    job.workspaceId,
    ["note_content"],
    material.input,
    governance.providerName,
  );
  if (!governed.allowed) throw new Error(governed.reason ?? "AI privacy governance blocked map input");
  const providerInput = cardMapInputSchema.parse(governed.sanitizedData);
  const aiStartedAt = Date.now();
  const output = await runWithAbortBudget(
    (signal) => provider.extractCardCandidates(providerInput, signal),
    job.signal,
    resolveProviderCallTimeout(JobType.MAP_CARD_GENERATION),
    (error) => logger.warn(
      { runId: payload.runId, unitId: payload.unitId, error: sanitizeOperationalError(error) },
      "late card map provider result ignored",
    ),
  );
  const validated = validateCardMapOutput(material.input, output);
  // 契约校验基于紧凑别名;持久化必须译回封存 span 的真实 ID。
  const resolveSpanId = (refId: string): string => {
    const spanId = material.spanIdByRefId.get(refId);
    if (!spanId) {
      throw new CardMapContractError(
        "map_unknown_evidence_ref",
        `alias ${refId} is not in the sealed span manifest`,
      );
    }
    return spanId;
  };
  throwIfJobAborted(leaseContext(job));

  await withJobTransaction(leaseContext(job), async (tx) => {
    const locked = await lockPipelineState(tx, leaseContext(job), payload, CardGenerationUnitKind.TEXT_MAP);
    if (locked.decision !== "active" || locked.unit.status === "succeeded") return;
    const spanIds = locked.unit.inputManifest.spanIds ?? [];
    const now = new Date();
    const inserted = validated.candidates.length > 0
      ? await tx.insert(schema.cardGenerationCandidates).values(validated.candidates.map((candidate, ordinal) => ({
          workspaceId: job.workspaceId,
          runId: locked.run.id,
          unitId: locked.unit.id,
          localOrdinal: ordinal,
          localId: candidate.localId,
          claim: candidate.claim,
          normalizedClaimHash: candidate.normalizedClaimHash,
          topic: candidate.topic,
          sectionKey: candidate.sectionKey,
          cognitiveType: candidate.cognitiveType,
          importance: candidate.importance,
          validationStatus: "accepted",
          createdAt: now,
        }))).returning()
      : [];
    const candidateByLocalId = new Map(inserted.map((candidate) => [candidate.localId, candidate]));
    const evidenceRows = validated.candidates.flatMap((candidate) => {
      const persisted = candidateByLocalId.get(candidate.localId);
      if (!persisted) throw new CardMapContractError("map_invalid_claim", "candidate persistence mismatch");
      return candidate.evidenceRefIds.map((refId, ordinal) => ({
        workspaceId: job.workspaceId,
        runId: locked.run.id,
        noteVersionId: locked.run.noteVersionId,
        candidateId: persisted.id,
        evidenceSpanId: resolveSpanId(refId),
        ordinal,
        createdAt: now,
      }));
    });
    if (evidenceRows.length > 0) {
      await tx.insert(schema.cardGenerationCandidateEvidence).values(evidenceRows);
    }
    const artifact = {
      sectionSummary: output.sectionSummary,
      candidateIds: inserted.map((candidate) => candidate.id),
      noCandidateUnitIds: validated.noCandidateUnitIds.map((item) => ({
        unitId: resolveSpanId(item.unitId),
        reason: item.reason,
      })),
      coveredPrimaryRefIds: validated.coveredPrimaryRefIds.map(resolveSpanId).sort(),
      providerRequestId: provider.getLastUsage()?.requestId ?? null,
    };
    await tx
      .update(schema.cardGenerationUnits)
      .set({
        status: "succeeded",
        artifactJson: artifact,
        artifactHash: hashJson(artifact),
        errorCode: null,
        finishedAt: now,
        updatedAt: now,
      })
      .where(and(
        eq(schema.cardGenerationUnits.id, locked.unit.id),
        eq(schema.cardGenerationUnits.workspaceId, job.workspaceId),
        eq(schema.cardGenerationUnits.status, "running"),
      ));
    const completed = Math.min(locked.run.requiredUnits, locked.run.completedUnits + spanIds.length);
    const coverageBps = locked.run.requiredUnits === 0
      ? 0
      : Math.floor(completed * 10_000 / locked.run.requiredUnits);
    const coverageReport = {
      ...locked.run.coverageReport,
      processedPrimaryUnits: completed,
      noCandidatePrimaryUnits:
        Number(locked.run.coverageReport.noCandidatePrimaryUnits ?? 0)
        + validated.noCandidateUnitIds.length,
    };
    const [updatedRun] = await tx
      .update(schema.cardGenerationRuns)
      .set({
        completedUnits: completed,
        sourceCoverageBps: coverageBps,
        coverageReport,
        stateVersion: locked.run.stateVersion + 1,
        nextEventSequence: locked.run.nextEventSequence + 1,
        updatedAt: now,
      })
      .where(and(
        eq(schema.cardGenerationRuns.id, locked.run.id),
        eq(schema.cardGenerationRuns.workspaceId, job.workspaceId),
        eq(schema.cardGenerationRuns.stateVersion, locked.run.stateVersion),
      ))
      .returning();
    if (!updatedRun) throw new Error("map progress CAS failed");
    await appendEvent(tx, locked.run, {
      stage: CardGenerationStage.TEXT_MAP,
      state: CardGenerationRunStatus.MAPPING,
      completed,
      total: locked.run.requiredUnits,
      unit: "source_units",
      messageCode: "text_map_unit_succeeded",
      safeDetails: {
        mapUnitOrdinal: locked.unit.ordinal,
        primaryUnits: spanIds.length,
        candidates: inserted.length,
        noCandidateUnits: validated.noCandidateUnitIds.length,
      },
      createdAt: now,
    });
    if (!await advanceMapWindow(tx, updatedRun, auditUserId, job.id)) {
      await markSchedulerAttention(tx, updatedRun, now);
    }
  });

  await logAICall({
    workspaceId: job.workspaceId,
    userId: auditUserId,
    jobId: job.id,
    provider: provider.id,
    modelId: provider.modelId,
    operation: "card_map",
    dataCategories: ["note_content"],
    dataSizeBytes: JSON.stringify(providerInput).length,
    costTokens: provider.getLastUsage()?.totalTokens ?? null,
    durationMs: Date.now() - aiStartedAt,
    status: "success",
  });
}

export async function runReduceCardGeneration(job: CardGenerationTextJob): Promise<void> {
  const auditUserId = requireAuditUser(job);
  const payload = pipelinePayload(job);
  const begin = await beginPipelineUnit(job, CardGenerationUnitKind.SECTION_REDUCE, {
    status: CardGenerationRunStatus.REDUCING,
    stage: CardGenerationStage.SECTION_REDUCE,
    messageCode: "candidate_reduce_started",
    progressUnit: "candidates",
  });
  if (begin !== "active") return;
  const candidates = await withWorkerWorkspaceTransaction(
    { workspaceId: job.workspaceId, userId: job.requestedBy },
    (tx) => tx.query.cardGenerationCandidates.findMany({
      where: and(
        eq(schema.cardGenerationCandidates.workspaceId, job.workspaceId),
        eq(schema.cardGenerationCandidates.runId, payload.runId),
        eq(schema.cardGenerationCandidates.validationStatus, "accepted"),
      ),
    }),
  );
  const reduced = reduceCandidatePool(candidates as ReducibleCandidate[]);
  await withJobTransaction(leaseContext(job), async (tx) => {
    const locked = await lockPipelineState(
      tx,
      leaseContext(job),
      payload,
      CardGenerationUnitKind.SECTION_REDUCE,
    );
    if (locked.decision !== "active" || locked.unit.status === "succeeded") return;
    const now = new Date();
    if (reduced.excluded.length > 0) {
      for (const exclusion of reduced.excluded) {
        await tx
          .update(schema.cardGenerationCandidates)
          .set({ validationStatus: "excluded", exclusionReason: exclusion.reason })
          .where(and(
            eq(schema.cardGenerationCandidates.id, exclusion.candidateId),
            eq(schema.cardGenerationCandidates.workspaceId, job.workspaceId),
            eq(schema.cardGenerationCandidates.runId, locked.run.id),
          ));
      }
    }
    if (reduced.selected.length === 0) {
      await tx
        .update(schema.cardGenerationUnits)
        .set({
          status: "terminal_failed",
          errorCode: "no_learnable_candidate",
          finishedAt: now,
          updatedAt: now,
        })
        .where(eq(schema.cardGenerationUnits.id, locked.unit.id));
      await tx
        .update(schema.cardGenerationRuns)
        .set({
          status: CardGenerationRunStatus.NEEDS_ATTENTION,
          stage: CardGenerationStage.SECTION_REDUCE,
          stateVersion: locked.run.stateVersion + 1,
          nextEventSequence: locked.run.nextEventSequence + 1,
          errorCode: "no_learnable_candidate",
          retryable: false,
          updatedAt: now,
          finishedAt: now,
        })
        .where(and(
          eq(schema.cardGenerationRuns.id, locked.run.id),
          eq(schema.cardGenerationRuns.stateVersion, locked.run.stateVersion),
        ));
      await appendEvent(tx, locked.run, {
        stage: CardGenerationStage.SECTION_REDUCE,
        state: CardGenerationRunStatus.NEEDS_ATTENTION,
        completed: 0,
        total: 0,
        unit: "candidates",
        messageCode: "no_learnable_candidate",
        createdAt: now,
      });
      return;
    }
    const artifact = {
      title: locked.run.titleSnapshot,
      summary: `全文 ${locked.run.requiredUnits} 个文本证据单元和 ${locked.run.completedImages}/${locked.run.requiredImages} 张图片已完成处理，形成 ${reduced.selected.length} 个经验证要点。`,
      selectedCandidateIds: reduced.selected.map((candidate) => candidate.id),
      excludedCandidateIds: reduced.excluded,
      sectionKeys: [...new Set(reduced.selected.map((candidate) => candidate.sectionKey))],
    };
    await tx
      .update(schema.cardGenerationUnits)
      .set({
        status: "succeeded",
        artifactJson: artifact,
        artifactHash: hashJson(artifact),
        errorCode: null,
        finishedAt: now,
        updatedAt: now,
      })
      .where(and(
        eq(schema.cardGenerationUnits.id, locked.unit.id),
        eq(schema.cardGenerationUnits.workspaceId, job.workspaceId),
      ));
    const [deckPlanUnit] = await tx
      .insert(schema.cardGenerationUnits)
      .values({
        workspaceId: job.workspaceId,
        runId: locked.run.id,
        parentUnitId: locked.unit.id,
        kind: CardGenerationUnitKind.DECK_PLAN,
        level: 0,
        ordinal: 0,
        unitKey: hashJson({
          runId: locked.run.id,
          kind: CardGenerationUnitKind.DECK_PLAN,
          selectedCandidateIds: artifact.selectedCandidateIds,
        }),
        pipelineVersion: TEXT_PIPELINE_VERSION,
        required: true,
        inputManifest: {
          selectedCandidateIds: artifact.selectedCandidateIds,
        },
        inputHash: hashJson(artifact),
        tokenEstimate: 0,
        status: "pending",
      })
      .returning();
    const scheduled = await scheduleUnits(tx, {
      run: locked.run,
      units: [deckPlanUnit],
      requestedBy: auditUserId,
      limit: 1,
    });
    const [updatedRun] = await tx
      .update(schema.cardGenerationRuns)
      .set({
        status: scheduled === 1
          ? CardGenerationRunStatus.REDUCING
          : CardGenerationRunStatus.NEEDS_ATTENTION,
        stage: CardGenerationStage.DECK_PLAN,
        stateVersion: locked.run.stateVersion + 1,
        nextEventSequence: locked.run.nextEventSequence + 1,
        errorCode: scheduled === 1 ? null : "scheduler_capacity",
        retryable: true,
        updatedAt: now,
        finishedAt: scheduled === 1 ? null : now,
      })
      .where(and(
        eq(schema.cardGenerationRuns.id, locked.run.id),
        eq(schema.cardGenerationRuns.workspaceId, job.workspaceId),
        eq(schema.cardGenerationRuns.stateVersion, locked.run.stateVersion),
      ))
      .returning({ id: schema.cardGenerationRuns.id });
    if (!updatedRun) throw new Error("reduce completion CAS failed");
    await appendEvent(tx, locked.run, {
      stage: CardGenerationStage.DECK_PLAN,
      state: scheduled === 1
        ? CardGenerationRunStatus.REDUCING
        : CardGenerationRunStatus.NEEDS_ATTENTION,
      completed: reduced.selected.length,
      total: candidates.length,
      unit: "candidates",
      messageCode: scheduled === 1 ? "deck_plan_queued" : "scheduler_capacity",
      safeDetails: {
        selectedCandidates: reduced.selected.length,
        duplicateCandidates: reduced.excluded.length,
      },
      createdAt: now,
    });
  });
}

function sectionsForCandidateIds(
  candidates: ReducibleCandidate[],
  candidateIds: string[],
): string[] {
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  return [...new Set(candidateIds.map((candidateId) => {
    const candidate = byId.get(candidateId);
    if (!candidate) throw new Error("card-set plan referenced an unknown candidate");
    return candidate.sectionKey;
  }))].sort();
}

export async function runPlanCardSet(job: CardGenerationTextJob): Promise<void> {
  const auditUserId = requireAuditUser(job);
  const payload = pipelinePayload(job);
  const begin = await beginPipelineUnit(job, CardGenerationUnitKind.DECK_PLAN, {
    status: CardGenerationRunStatus.REDUCING,
    stage: CardGenerationStage.DECK_PLAN,
    messageCode: "deck_plan_started",
    progressUnit: "cards",
  });
  if (begin !== "active") return;

  const material = await withWorkerWorkspaceTransaction(
    { workspaceId: job.workspaceId, userId: job.requestedBy },
    async (tx) => {
      const run = await tx.query.cardGenerationRuns.findFirst({
        where: and(
          eq(schema.cardGenerationRuns.id, payload.runId),
          eq(schema.cardGenerationRuns.workspaceId, job.workspaceId),
        ),
      });
      const reduceUnit = await tx.query.cardGenerationUnits.findFirst({
        where: and(
          eq(schema.cardGenerationUnits.workspaceId, job.workspaceId),
          eq(schema.cardGenerationUnits.runId, payload.runId),
          eq(schema.cardGenerationUnits.kind, CardGenerationUnitKind.SECTION_REDUCE),
          eq(schema.cardGenerationUnits.status, "succeeded"),
        ),
      });
      if (!run || !reduceUnit?.artifactJson) {
        throw new Error("deck planning is missing its reduced candidate artifact");
      }
      const selectedCandidateIds = stringArray(
        reduceUnit.artifactJson.selectedCandidateIds,
        "selectedCandidateIds",
      );
      const candidates = await tx.query.cardGenerationCandidates.findMany({
        where: and(
          eq(schema.cardGenerationCandidates.workspaceId, job.workspaceId),
          eq(schema.cardGenerationCandidates.runId, payload.runId),
          eq(schema.cardGenerationCandidates.validationStatus, "accepted"),
          inArray(schema.cardGenerationCandidates.id, selectedCandidateIds),
        ),
      });
      if (candidates.length !== selectedCandidateIds.length) {
        throw new Error("deck planning candidate allowlist is incomplete");
      }
      return {
        run,
        candidates: candidates as ReducibleCandidate[],
        excludedCandidateIds: reduceUnit.artifactJson.excludedCandidateIds,
      };
    },
  );
  const plan = planCardSet(material.candidates);
  const cardDescriptors = [
    {
      scope: "overview" as const,
      scopeKey: "overview",
      cardOrdinal: 0,
      titleHint: material.run.titleSnapshot,
      candidateIds: plan.overviewCandidateIds,
      sectionKeys: sectionsForCandidateIds(
        material.candidates,
        plan.overviewCandidateIds,
      ),
    },
    ...plan.cards.map((card, index) => ({
      scope: "section" as const,
      scopeKey: card.scopeKey,
      cardOrdinal: index + 1,
      titleHint: card.titleHint,
      candidateIds: card.candidateIds,
      sectionKeys: card.sectionKeys,
    })),
  ];
  const artifact = {
    version: "deck-plan-v1",
    candidateSetHash: hashJson(material.candidates
      .map((candidate) => ({
        id: candidate.id,
        sectionKey: candidate.sectionKey,
        topic: candidate.topic,
        importance: candidate.importance,
        localOrdinal: candidate.localOrdinal,
      }))
      .sort((left, right) => left.id.localeCompare(right.id))),
    plan,
    cards: cardDescriptors,
    excludedCandidateIds: material.excludedCandidateIds,
  };

  await withJobTransaction(leaseContext(job), async (tx) => {
    const locked = await lockPipelineState(
      tx,
      leaseContext(job),
      payload,
      CardGenerationUnitKind.DECK_PLAN,
    );
    if (locked.decision !== "active" || locked.unit.status === "succeeded") return;
    const now = new Date();
    await tx
      .update(schema.cardGenerationUnits)
      .set({
        status: "succeeded",
        artifactJson: artifact,
        artifactHash: hashJson(artifact),
        errorCode: null,
        finishedAt: now,
        updatedAt: now,
      })
      .where(and(
        eq(schema.cardGenerationUnits.id, locked.unit.id),
        eq(schema.cardGenerationUnits.workspaceId, job.workspaceId),
        eq(schema.cardGenerationUnits.status, "running"),
      ));
    const renderUnits = await tx
      .insert(schema.cardGenerationUnits)
      .values(cardDescriptors.map((card) => ({
        workspaceId: job.workspaceId,
        runId: locked.run.id,
        parentUnitId: locked.unit.id,
        kind: CardGenerationUnitKind.CARD_RENDER,
        level: 0,
        ordinal: card.cardOrdinal,
        unitKey: hashJson({
          version: "card-render-v1",
          runId: locked.run.id,
          scope: card.scope,
          scopeKey: card.scopeKey,
          candidateIds: card.candidateIds,
        }),
        pipelineVersion: TEXT_PIPELINE_VERSION,
        required: true,
        inputManifest: card,
        inputHash: hashJson(card),
        tokenEstimate: 0,
        status: "pending",
        createdAt: now,
        updatedAt: now,
      })))
      .returning();
    const scheduled = await scheduleUnits(tx, {
      run: locked.run,
      units: renderUnits,
      requestedBy: auditUserId,
      limit: Math.min(CARD_GENERATION_RENDER_WINDOW, renderUnits.length),
    });
    const hasCapacity = scheduled > 0;
    const [updatedRun] = await tx
      .update(schema.cardGenerationRuns)
      .set({
        status: hasCapacity
          ? CardGenerationRunStatus.RENDERING
          : CardGenerationRunStatus.NEEDS_ATTENTION,
        stage: CardGenerationStage.CARD_RENDER,
        stateVersion: locked.run.stateVersion + 1,
        nextEventSequence: locked.run.nextEventSequence + 1,
        errorCode: hasCapacity ? null : "scheduler_capacity",
        retryable: true,
        updatedAt: now,
        finishedAt: hasCapacity ? null : now,
      })
      .where(and(
        eq(schema.cardGenerationRuns.id, locked.run.id),
        eq(schema.cardGenerationRuns.workspaceId, job.workspaceId),
        eq(schema.cardGenerationRuns.stateVersion, locked.run.stateVersion),
      ))
      .returning();
    if (!updatedRun) throw new Error("deck plan completion CAS failed");
    await appendEvent(tx, locked.run, {
      stage: CardGenerationStage.CARD_RENDER,
      state: hasCapacity
        ? CardGenerationRunStatus.RENDERING
        : CardGenerationRunStatus.NEEDS_ATTENTION,
      completed: 0,
      total: renderUnits.length,
      unit: "cards",
      messageCode: hasCapacity ? "deck_plan_succeeded" : "scheduler_capacity",
      safeDetails: {
        cardCount: renderUnits.length,
        sectionCardCount: Math.max(0, renderUnits.length - 1),
        scheduledCards: scheduled,
      },
      createdAt: now,
    });
  });
}

async function scheduleRemainingCardRenders(
  tx: WorkerTransaction,
  run: LockedRun,
  requestedBy: string,
  currentJobId: string,
): Promise<number> {
  const [active] = await tx
    .select({ count: count() })
    .from(schema.jobs)
    .where(and(
      eq(schema.jobs.workspaceId, run.workspaceId),
      eq(schema.jobs.generationRunId, run.id),
      eq(schema.jobs.type, JobType.RENDER_CARD_GENERATION),
      inArray(schema.jobs.status, [JobStatus.PENDING, JobStatus.RUNNING]),
      ne(schema.jobs.id, currentJobId),
    ));
  const available = Math.max(
    0,
    CARD_GENERATION_RENDER_WINDOW - Number(active?.count ?? 0),
  );
  if (available === 0) return 0;
  const unscheduled = await tx.query.cardGenerationUnits.findMany({
    where: and(
      eq(schema.cardGenerationUnits.workspaceId, run.workspaceId),
      eq(schema.cardGenerationUnits.runId, run.id),
      eq(schema.cardGenerationUnits.kind, CardGenerationUnitKind.CARD_RENDER),
      eq(schema.cardGenerationUnits.status, "pending"),
      isNull(schema.cardGenerationUnits.scheduledAt),
    ),
    orderBy: [asc(schema.cardGenerationUnits.ordinal)],
    limit: available,
  });
  if (unscheduled.length === 0) return 0;
  return scheduleUnits(tx, {
    run,
    units: unscheduled,
    requestedBy,
    limit: available,
  });
}

export async function runRenderCardGeneration(
  job: CardGenerationTextJob,
): Promise<void> {
  const auditUserId = requireAuditUser(job);
  const payload = pipelinePayload(job);
  const begin = await beginPipelineUnit(job, CardGenerationUnitKind.CARD_RENDER, {
    status: CardGenerationRunStatus.RENDERING,
    stage: CardGenerationStage.CARD_RENDER,
    messageCode: "card_render_started",
    progressUnit: "cards",
  });
  if (begin !== "active") return;

  await withJobTransaction(leaseContext(job), async (tx) => {
    const locked = await lockPipelineState(
      tx,
      leaseContext(job),
      payload,
      CardGenerationUnitKind.CARD_RENDER,
    );
    if (locked.decision !== "active" || locked.unit.status === "succeeded") return;
    const manifest = locked.unit.inputManifest;
    const candidateIds = stringArray(manifest.candidateIds, "candidateIds");
    if (
      (manifest.scope !== "overview" && manifest.scope !== "section")
      || typeof manifest.scopeKey !== "string"
      || manifest.scopeKey.trim().length === 0
      || typeof manifest.cardOrdinal !== "number"
      || manifest.cardOrdinal !== locked.unit.ordinal
      || typeof manifest.titleHint !== "string"
      || manifest.titleHint.trim().length === 0
      || !Array.isArray(manifest.sectionKeys)
      || (manifest.scope === "overview"
        ? candidateIds.length < 1 || candidateIds.length > 5
        : candidateIds.length < 3 || candidateIds.length > 5)
    ) {
      throw new Error("card render manifest is invalid");
    }
    const candidates = await tx.query.cardGenerationCandidates.findMany({
      where: and(
        eq(schema.cardGenerationCandidates.workspaceId, job.workspaceId),
        eq(schema.cardGenerationCandidates.runId, locked.run.id),
        eq(schema.cardGenerationCandidates.validationStatus, "accepted"),
        inArray(schema.cardGenerationCandidates.id, candidateIds),
      ),
    });
    if (candidates.length !== candidateIds.length) {
      throw new Error("card render candidate allowlist is incomplete");
    }
    const candidateById = new Map(candidates.map((candidate) => [candidate.id, candidate]));
    const orderedCandidates = candidateIds.map((candidateId) => {
      const candidate = candidateById.get(candidateId);
      if (!candidate) throw new Error("card render candidate ordering cannot be reconstructed");
      return candidate;
    });
    const title = manifest.scope === "overview"
      ? locked.run.titleSnapshot
      : `${locked.run.titleSnapshot} · ${manifest.titleHint}`.slice(0, 200);
    const summary = manifest.scope === "overview"
      ? `总览卡汇集 ${candidateIds.length} 个跨章节核心要点。`
      : `章节卡汇集 ${candidateIds.length} 个有精确证据支持的要点。`;
    const artifact = {
      version: "card-render-v1",
      scope: manifest.scope,
      scopeKey: manifest.scopeKey,
      ordinal: manifest.cardOrdinal,
      sectionKeys: manifest.sectionKeys,
      candidateIds,
      title,
      summary,
      summarySupportCandidateIds: candidateIds,
      claimHashes: orderedCandidates.map((candidate) => candidate.normalizedClaimHash),
    };
    const now = new Date();
    await tx
      .update(schema.cardGenerationUnits)
      .set({
        status: "succeeded",
        artifactJson: artifact,
        artifactHash: hashJson(artifact),
        errorCode: null,
        finishedAt: now,
        updatedAt: now,
      })
      .where(and(
        eq(schema.cardGenerationUnits.id, locked.unit.id),
        eq(schema.cardGenerationUnits.workspaceId, job.workspaceId),
        eq(schema.cardGenerationUnits.status, "running"),
      ));
    await scheduleRemainingCardRenders(
      tx,
      locked.run,
      auditUserId,
      job.id,
    );
    const renderUnits = await tx.query.cardGenerationUnits.findMany({
      where: and(
        eq(schema.cardGenerationUnits.workspaceId, job.workspaceId),
        eq(schema.cardGenerationUnits.runId, locked.run.id),
        eq(schema.cardGenerationUnits.kind, CardGenerationUnitKind.CARD_RENDER),
        eq(schema.cardGenerationUnits.required, true),
      ),
      orderBy: [asc(schema.cardGenerationUnits.ordinal)],
    });
    const completedCount = renderUnits.filter((unit) => unit.status === "succeeded").length;
    const rendersComplete =
      renderUnits.length > 0 && completedCount === renderUnits.length;
    let publishScheduled = false;
    if (rendersComplete) {
      const deckPlanUnit = await tx.query.cardGenerationUnits.findFirst({
        where: and(
          eq(schema.cardGenerationUnits.workspaceId, job.workspaceId),
          eq(schema.cardGenerationUnits.runId, locked.run.id),
          eq(schema.cardGenerationUnits.kind, CardGenerationUnitKind.DECK_PLAN),
          eq(schema.cardGenerationUnits.status, "succeeded"),
        ),
      });
      if (!deckPlanUnit) throw new Error("card render completion lost its deck plan");
      let publishUnit = await tx.query.cardGenerationUnits.findFirst({
        where: and(
          eq(schema.cardGenerationUnits.workspaceId, job.workspaceId),
          eq(schema.cardGenerationUnits.runId, locked.run.id),
          eq(schema.cardGenerationUnits.kind, CardGenerationUnitKind.PUBLISH),
        ),
      });
      if (!publishUnit) {
        const [created] = await tx
          .insert(schema.cardGenerationUnits)
          .values({
            workspaceId: job.workspaceId,
            runId: locked.run.id,
            parentUnitId: deckPlanUnit.id,
            kind: CardGenerationUnitKind.PUBLISH,
            level: 0,
            ordinal: 0,
            unitKey: hashJson({
              runId: locked.run.id,
              kind: CardGenerationUnitKind.PUBLISH,
              renderHashes: renderUnits.map((unit) => unit.artifactHash),
            }),
            pipelineVersion: TEXT_PIPELINE_VERSION,
            required: true,
            inputManifest: {},
            inputHash: hashJson(renderUnits.map((unit) => unit.artifactHash)),
            tokenEstimate: 0,
            status: "pending",
          })
          .returning();
        publishUnit = created;
      }
      if (!publishUnit.scheduledAt) {
        publishScheduled = await scheduleUnits(tx, {
          run: locked.run,
          units: [publishUnit],
          requestedBy: auditUserId,
          limit: 1,
        }) === 1;
      } else {
        publishScheduled = true;
      }
    }
    const nextState = rendersComplete && publishScheduled
      ? {
          status: CardGenerationRunStatus.VALIDATING,
          stage: CardGenerationStage.GLOBAL_VERIFY,
          errorCode: null,
          finishedAt: null,
        }
      : rendersComplete
        ? {
            status: CardGenerationRunStatus.NEEDS_ATTENTION,
            stage: CardGenerationStage.GLOBAL_VERIFY,
            errorCode: "scheduler_capacity",
            finishedAt: now,
          }
        : {
            status: CardGenerationRunStatus.RENDERING,
            stage: CardGenerationStage.CARD_RENDER,
            errorCode: null,
            finishedAt: null,
          };
    const [updatedRun] = await tx
      .update(schema.cardGenerationRuns)
      .set({
        ...nextState,
        stateVersion: locked.run.stateVersion + 1,
        nextEventSequence: locked.run.nextEventSequence + 1,
        retryable: true,
        updatedAt: now,
      })
      .where(and(
        eq(schema.cardGenerationRuns.id, locked.run.id),
        eq(schema.cardGenerationRuns.workspaceId, job.workspaceId),
        eq(schema.cardGenerationRuns.stateVersion, locked.run.stateVersion),
      ))
      .returning();
    if (!updatedRun) throw new Error("card render completion CAS failed");
    await appendEvent(tx, locked.run, {
      stage: nextState.stage,
      state: nextState.status,
      completed: completedCount,
      total: renderUnits.length,
      unit: "cards",
      messageCode: rendersComplete
        ? publishScheduled ? "card_render_succeeded" : "scheduler_capacity"
        : "card_render_progress",
      safeDetails: {
        renderedCards: completedCount,
        cardCount: renderUnits.length,
      },
      createdAt: now,
    });
  });
}

type TextCandidateEvidence = {
  sourceKind: "text_span";
  spanId: string;
  blockId: string;
  blockOrdinal: number;
  charStart: number;
  charEnd: number;
  sourceHash: string;
  quoteText: string;
};

type ImageCandidateEvidence = {
  sourceKind: "image_region";
  imageEvidenceUnitId: string;
  imageAssetId: string;
  imageInsightId: string;
  blockId: string;
  blockOrdinal: number;
  sourceHash: string;
  quoteText: string;
  regionJson: ReturnType<typeof imageEvidenceRegionSchema.parse>;
  extractorVersion: string;
  alignmentMethod: "image_ocr" | "image_structured";
};

type ExactCandidateEvidence = TextCandidateEvidence | ImageCandidateEvidence;

type PublishCandidate = typeof schema.cardGenerationCandidates.$inferSelect & {
  evidences: ExactCandidateEvidence[];
};

type PublishCardMaterial = {
  scope: "overview" | "section";
  scopeKey: string;
  ordinal: number;
  sectionKeys: string[];
  candidateIds: string[];
  title: string;
  summary: string;
  summarySupportCandidateIds: string[];
};

type PublishMaterial = {
  title: string;
  summary: string;
  selectedCandidateIds: string[];
  excludedCandidateIds: Array<{ candidateId: string; reason: string }>;
  sectionKeys: string[];
  deckPlan: CardSetPlan;
  candidates: PublishCandidate[];
  cards: PublishCardMaterial[];
};

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0)) {
    throw new Error(`${field} must be an array of non-empty strings`);
  }
  return value;
}

async function loadPublishMaterial(
  job: CardGenerationTextJob,
  payload: PipelinePayload,
): Promise<PublishMaterial> {
  return withWorkerWorkspaceTransaction(
    { workspaceId: job.workspaceId, userId: job.requestedBy },
    async (tx) => {
      const reduceUnit = await tx.query.cardGenerationUnits.findFirst({
        where: and(
          eq(schema.cardGenerationUnits.workspaceId, job.workspaceId),
          eq(schema.cardGenerationUnits.runId, payload.runId),
          eq(schema.cardGenerationUnits.kind, CardGenerationUnitKind.SECTION_REDUCE),
          eq(schema.cardGenerationUnits.status, "succeeded"),
        ),
      });
      if (!reduceUnit?.artifactJson) throw new Error("publish is missing its successful reduce artifact");
      const deckPlanUnit = await tx.query.cardGenerationUnits.findFirst({
        where: and(
          eq(schema.cardGenerationUnits.workspaceId, job.workspaceId),
          eq(schema.cardGenerationUnits.runId, payload.runId),
          eq(schema.cardGenerationUnits.kind, CardGenerationUnitKind.DECK_PLAN),
          eq(schema.cardGenerationUnits.status, "succeeded"),
        ),
      });
      if (
        !deckPlanUnit?.artifactJson
        || !deckPlanUnit.artifactHash
      ) {
        throw new Error("publish is missing its verified deck-plan artifact");
      }
      const renderUnits = await tx.query.cardGenerationUnits.findMany({
        where: and(
          eq(schema.cardGenerationUnits.workspaceId, job.workspaceId),
          eq(schema.cardGenerationUnits.runId, payload.runId),
          eq(schema.cardGenerationUnits.kind, CardGenerationUnitKind.CARD_RENDER),
          eq(schema.cardGenerationUnits.required, true),
        ),
        orderBy: [asc(schema.cardGenerationUnits.ordinal)],
      });
      if (renderUnits.length === 0) {
        throw new Error("publish is missing card-render artifacts");
      }
      const artifact = reduceUnit.artifactJson;
      const title = requireString(artifact.title, "reduce artifact title");
      const summary = requireString(artifact.summary, "reduce artifact summary");
      const selectedCandidateIds = stringArray(
        artifact.selectedCandidateIds,
        "selectedCandidateIds",
      );
      if (selectedCandidateIds.length === 0 || new Set(selectedCandidateIds).size !== selectedCandidateIds.length) {
        throw new Error("publish candidate selection is empty or duplicated");
      }
      const sectionKeys = stringArray(artifact.sectionKeys, "sectionKeys");
      const excludedCandidateIds = Array.isArray(artifact.excludedCandidateIds)
        ? artifact.excludedCandidateIds.flatMap((item) => {
            if (!item || typeof item !== "object") return [];
            const candidateId = (item as Record<string, unknown>).candidateId;
            const reason = (item as Record<string, unknown>).reason;
            return typeof candidateId === "string" && typeof reason === "string"
              ? [{ candidateId, reason }]
              : [];
          })
        : [];
      const candidates = await tx.query.cardGenerationCandidates.findMany({
        where: and(
          eq(schema.cardGenerationCandidates.workspaceId, job.workspaceId),
          eq(schema.cardGenerationCandidates.runId, payload.runId),
          eq(schema.cardGenerationCandidates.validationStatus, "accepted"),
          inArray(schema.cardGenerationCandidates.id, selectedCandidateIds),
        ),
      });
      if (candidates.length !== selectedCandidateIds.length) {
        throw new Error("publish selection contains an unknown or excluded candidate");
      }
      const links = await tx.query.cardGenerationCandidateEvidence.findMany({
        where: and(
          eq(schema.cardGenerationCandidateEvidence.workspaceId, job.workspaceId),
          eq(schema.cardGenerationCandidateEvidence.runId, payload.runId),
          inArray(schema.cardGenerationCandidateEvidence.candidateId, selectedCandidateIds),
        ),
        orderBy: [asc(schema.cardGenerationCandidateEvidence.ordinal)],
      });
      const spanIds = [...new Set(links.flatMap((link) =>
        link.evidenceSpanId ? [link.evidenceSpanId] : []))];
      const imageEvidenceUnitIds = [...new Set(links.flatMap((link) =>
        link.imageEvidenceUnitId ? [link.imageEvidenceUnitId] : []))];
      const candidateUnitIds = [...new Set(candidates.map((candidate) => candidate.unitId))];
      const [spans, imageEvidenceUnits, candidateUnits] = await Promise.all([
        spanIds.length > 0
          ? tx.query.noteEvidenceSpans.findMany({
              where: and(
                eq(schema.noteEvidenceSpans.workspaceId, job.workspaceId),
                eq(schema.noteEvidenceSpans.noteVersionId, payload.noteVersionId),
                inArray(schema.noteEvidenceSpans.id, spanIds),
              ),
            })
          : Promise.resolve([]),
        imageEvidenceUnitIds.length > 0
          ? tx.query.noteImageEvidenceUnits.findMany({
              where: and(
                eq(schema.noteImageEvidenceUnits.workspaceId, job.workspaceId),
                inArray(schema.noteImageEvidenceUnits.id, imageEvidenceUnitIds),
              ),
            })
          : Promise.resolve([]),
        tx.query.cardGenerationUnits.findMany({
          where: and(
            eq(schema.cardGenerationUnits.workspaceId, job.workspaceId),
            eq(schema.cardGenerationUnits.runId, payload.runId),
            inArray(schema.cardGenerationUnits.id, candidateUnitIds),
          ),
        }),
      ]);
      if (spans.length !== spanIds.length || imageEvidenceUnits.length !== imageEvidenceUnitIds.length) {
        throw new Error("candidate evidence contains an unknown typed source unit");
      }
      if (candidateUnits.length !== candidateUnitIds.length) {
        throw new Error("candidate generation checkpoint cannot be reconstructed");
      }
      const imageInsightIds = [...new Set(imageEvidenceUnits.map((unit) => unit.imageInsightId))];
      const imageInsights = imageInsightIds.length > 0
        ? await tx.query.noteImageInsights.findMany({
            where: and(
              eq(schema.noteImageInsights.workspaceId, job.workspaceId),
              inArray(schema.noteImageInsights.id, imageInsightIds),
            ),
          })
        : [];
      if (imageInsights.length !== imageInsightIds.length) {
        throw new Error("candidate image insight cannot be reconstructed");
      }
      const imageBlockIds = candidateUnits.flatMap((unit) =>
        unit.kind === CardGenerationUnitKind.IMAGE && unit.inputManifest.imageBlockId
          ? [unit.inputManifest.imageBlockId]
          : []);
      const blockIds = [...new Set([
        ...spans.map((span) => span.blockId),
        ...imageBlockIds,
      ])];
      const blocks = blockIds.length > 0
        ? await tx.query.noteBlocks.findMany({
            where: and(
              eq(schema.noteBlocks.workspaceId, job.workspaceId),
              eq(schema.noteBlocks.versionId, payload.noteVersionId),
              inArray(schema.noteBlocks.id, blockIds),
            ),
          })
        : [];
      const spanById = new Map(spans.map((span) => [span.id, span]));
      const imageEvidenceById = new Map(imageEvidenceUnits.map((unit) => [unit.id, unit]));
      const imageInsightById = new Map(imageInsights.map((insight) => [insight.id, insight]));
      const candidateUnitById = new Map(candidateUnits.map((unit) => [unit.id, unit]));
      const blockById = new Map(blocks.map((block) => [block.id, block]));
      const linksByCandidate = new Map<string, typeof links>();
      for (const link of links) {
        const values = linksByCandidate.get(link.candidateId) ?? [];
        values.push(link);
        linksByCandidate.set(link.candidateId, values);
      }
      const candidateById = new Map(candidates.map((candidate) => [candidate.id, candidate]));
      const orderedCandidates = selectedCandidateIds.map((candidateId) => {
        const candidate = candidateById.get(candidateId);
        if (!candidate) throw new Error("publish candidate ordering cannot be reconstructed");
        const evidences: ExactCandidateEvidence[] = (linksByCandidate.get(candidateId) ?? []).map((link) => {
          if (link.sourceKind === "text_span") {
            if (!link.evidenceSpanId || link.imageEvidenceUnitId) {
              throw new Error("candidate text evidence has an invalid typed reference");
            }
            const span = spanById.get(link.evidenceSpanId);
            const block = span ? blockById.get(span.blockId) : undefined;
            if (!span || !block) throw new Error("candidate evidence span cannot be reconstructed");
            const quoteText = block.content.slice(span.charStart, span.charEnd);
            if (quoteText.length === 0 || sha256(quoteText) !== span.textHash) {
              throw new Error("candidate exact evidence no longer matches the sealed snapshot");
            }
            return {
              sourceKind: "text_span",
              spanId: span.id,
              blockId: block.id,
              blockOrdinal: block.ordinal,
              charStart: span.charStart,
              charEnd: span.charEnd,
              sourceHash: span.textHash,
              quoteText,
            };
          }
          if (link.sourceKind !== "image_region" || link.evidenceSpanId || !link.imageEvidenceUnitId) {
            throw new Error("candidate evidence has an unsupported typed source");
          }
          const imageEvidence = imageEvidenceById.get(link.imageEvidenceUnitId);
          const insight = imageEvidence
            ? imageInsightById.get(imageEvidence.imageInsightId)
            : undefined;
          const generationUnit = candidateUnitById.get(candidate.unitId);
          const imageBlockId = generationUnit?.inputManifest.imageBlockId;
          const block = imageBlockId ? blockById.get(imageBlockId) : undefined;
          const artifactEvidenceIds = generationUnit?.artifactJson?.imageEvidenceUnitIds;
          if (
            !imageEvidence
            || !insight
            || insight.status !== "succeeded"
            || !insight.artifactHash
            || insight.imageAssetId !== imageEvidence.imageAssetId
            || imageEvidence.required !== true
            || imageEvidence.confidenceBps < CARD_GENERATION_IMAGE_EVIDENCE_MIN_CONFIDENCE_BPS
            || !generationUnit
            || generationUnit.kind !== CardGenerationUnitKind.IMAGE
            || generationUnit.status !== "succeeded"
            || !block
            || block.type !== "image"
            || block.imageAssetId !== imageEvidence.imageAssetId
            || !Array.isArray(artifactEvidenceIds)
            || !artifactEvidenceIds.includes(imageEvidence.id)
          ) {
            throw new Error("candidate image evidence lineage cannot be reconstructed");
          }
          if (imageEvidence.text.length === 0 || sha256(imageEvidence.text) !== imageEvidence.textHash) {
            throw new Error("candidate image evidence text hash is invalid");
          }
          const alignmentMethod = imageEvidence.sourceKind === "image_ocr"
            && imageEvidence.evidenceLevel === "image_ocr_exact"
            ? "image_ocr" as const
            : imageEvidence.sourceKind === "image_fact"
              && imageEvidence.evidenceLevel === "image_structured"
              ? "image_structured" as const
              : null;
          if (!alignmentMethod) {
            throw new Error("candidate image evidence level is not publishable");
          }
          return {
            sourceKind: "image_region",
            imageEvidenceUnitId: imageEvidence.id,
            imageAssetId: imageEvidence.imageAssetId,
            imageInsightId: insight.id,
            blockId: block.id,
            blockOrdinal: block.ordinal,
            sourceHash: imageEvidence.textHash,
            quoteText: imageEvidence.text,
            regionJson: imageEvidenceRegionSchema.parse(imageEvidence.region),
            extractorVersion: insight.extractorVersion,
            alignmentMethod,
          };
        });
        if (evidences.length === 0) {
          throw new Error("active generation candidate has no exact evidence");
        }
        return { ...candidate, evidences };
      });
      const deckArtifact = deckPlanUnit.artifactJson;
      if (deckArtifact.version !== "deck-plan-v1") {
        throw new Error("publish deck-plan artifact has an unsupported version");
      }
      const deckPlan = validateCardSetPlan(
        orderedCandidates,
        deckArtifact.plan as CardSetPlan,
      );
      const candidateSetHash = hashJson(orderedCandidates
        .map((candidate) => ({
          id: candidate.id,
          sectionKey: candidate.sectionKey,
          topic: candidate.topic,
          importance: candidate.importance,
          localOrdinal: candidate.localOrdinal,
        }))
        .sort((left, right) => left.id.localeCompare(right.id)));
      if (deckArtifact.candidateSetHash !== candidateSetHash) {
        throw new Error("publish deck-plan candidate hash does not match the accepted pool");
      }
      const expectedCards = [
        {
          scope: "overview" as const,
          scopeKey: "overview",
          cardOrdinal: 0,
          titleHint: title,
          candidateIds: deckPlan.overviewCandidateIds,
          sectionKeys: sectionsForCandidateIds(
            orderedCandidates,
            deckPlan.overviewCandidateIds,
          ),
        },
        ...deckPlan.cards.map((card, index) => ({
          scope: "section" as const,
          scopeKey: card.scopeKey,
          cardOrdinal: index + 1,
          titleHint: card.titleHint,
          candidateIds: card.candidateIds,
          sectionKeys: card.sectionKeys,
        })),
      ];
      const persistedDeckCards = Array.isArray(deckArtifact.cards)
        ? deckArtifact.cards
        : [];
      if (persistedDeckCards.length !== expectedCards.length
        || renderUnits.length !== expectedCards.length) {
        throw new Error("publish card-render manifest does not match the verified deck plan");
      }
      for (const [index, expected] of expectedCards.entries()) {
        const persisted = persistedDeckCards[index];
        if (
          !persisted
          || typeof persisted !== "object"
          || Array.isArray(persisted)
          || (persisted as Record<string, unknown>).scope !== expected.scope
          || (persisted as Record<string, unknown>).scopeKey !== expected.scopeKey
          || (persisted as Record<string, unknown>).cardOrdinal !== expected.cardOrdinal
          || (persisted as Record<string, unknown>).titleHint !== expected.titleHint
          || JSON.stringify((persisted as Record<string, unknown>).candidateIds)
            !== JSON.stringify(expected.candidateIds)
          || JSON.stringify((persisted as Record<string, unknown>).sectionKeys)
            !== JSON.stringify(expected.sectionKeys)
        ) {
          throw new Error("publish deck-plan card descriptors are inconsistent");
        }
      }
      const candidateByIdWithEvidence = new Map(
        orderedCandidates.map((candidate) => [candidate.id, candidate]),
      );
      const cards: PublishCardMaterial[] = renderUnits.map((unit, index) => {
        const expected = expectedCards[index];
        const renderArtifact = unit.artifactJson;
        if (
          !expected
          || unit.status !== "succeeded"
          || unit.parentUnitId !== deckPlanUnit.id
          || unit.ordinal !== expected.cardOrdinal
          || !renderArtifact
          || !unit.artifactHash
          || renderArtifact.version !== "card-render-v1"
          || renderArtifact.scope !== expected.scope
          || renderArtifact.scopeKey !== expected.scopeKey
          || renderArtifact.ordinal !== expected.cardOrdinal
          || JSON.stringify(renderArtifact.candidateIds) !== JSON.stringify(expected.candidateIds)
          || JSON.stringify(renderArtifact.sectionKeys) !== JSON.stringify(expected.sectionKeys)
          || JSON.stringify(renderArtifact.summarySupportCandidateIds)
            !== JSON.stringify(expected.candidateIds)
          || unit.inputManifest.scope !== expected.scope
          || unit.inputManifest.scopeKey !== expected.scopeKey
          || unit.inputManifest.cardOrdinal !== expected.cardOrdinal
          || unit.inputManifest.titleHint !== expected.titleHint
          || JSON.stringify(unit.inputManifest.candidateIds)
            !== JSON.stringify(expected.candidateIds)
          || JSON.stringify(unit.inputManifest.sectionKeys)
            !== JSON.stringify(expected.sectionKeys)
        ) {
          throw new Error("publish found a card-render artifact outside the deck-plan allowlist");
        }
        const expectedClaimHashes = expected.candidateIds.map((candidateId) => {
          const candidate = candidateByIdWithEvidence.get(candidateId);
          if (!candidate) throw new Error("card render references an unknown candidate");
          return candidate.normalizedClaimHash;
        });
        if (JSON.stringify(renderArtifact.claimHashes) !== JSON.stringify(expectedClaimHashes)) {
          throw new Error("card render claim hashes no longer match accepted candidates");
        }
        return {
          scope: expected.scope,
          scopeKey: expected.scopeKey,
          ordinal: expected.cardOrdinal,
          sectionKeys: expected.sectionKeys,
          candidateIds: expected.candidateIds,
          title: requireString(renderArtifact.title, "card render title"),
          summary: requireString(renderArtifact.summary, "card render summary"),
          summarySupportCandidateIds: stringArray(
            renderArtifact.summarySupportCandidateIds,
            "summarySupportCandidateIds",
          ),
        };
      });
      return {
        title,
        summary,
        selectedCandidateIds,
        excludedCandidateIds,
        sectionKeys,
        deckPlan,
        candidates: orderedCandidates,
        cards,
      };
    },
  );
}

async function insertInBatches<T>(
  rows: T[],
  size: number,
  insert: (batch: T[]) => Promise<void>,
): Promise<void> {
  for (let start = 0; start < rows.length; start += size) {
    await insert(rows.slice(start, start + size));
  }
}

export async function runPublishCardGeneration(job: CardGenerationTextJob): Promise<void> {
  requireAuditUser(job);
  const payload = pipelinePayload(job);
  const begin = await beginPipelineUnit(job, CardGenerationUnitKind.PUBLISH, {
    status: CardGenerationRunStatus.PUBLISHING,
    stage: CardGenerationStage.PUBLISH,
    messageCode: "exact_publish_started",
    progressUnit: "card",
  });
  if (begin !== "active") return;
  const material = await loadPublishMaterial(job, payload);
  throwIfJobAborted(leaseContext(job));

  await withJobTransaction(leaseContext(job), async (tx) => {
    const locked = await lockPipelineState(
      tx,
      leaseContext(job),
      payload,
      CardGenerationUnitKind.PUBLISH,
    );
    if (locked.decision !== "active" || locked.unit.status === "succeeded") return;
    const partialResult = isPartialGenerationRun(locked.run);
    const processableRequiredImages = requiredProcessableImages(locked.run);
    const expectedImageCoverageBps = locked.run.requiredImages === 0
      ? 10_000
      : Math.floor(
          processableRequiredImages * 10_000 / locked.run.requiredImages,
        );
    if (
      (locked.run.requiredUnits <= 0 && processableRequiredImages <= 0)
      || locked.run.completedUnits !== locked.run.requiredUnits
      || locked.run.failedUnits !== 0
      || locked.run.completedImages !== processableRequiredImages
      || locked.run.sourceCoverageBps !== 10_000
      || locked.run.imageCoverageBps !== expectedImageCoverageBps
    ) {
      throw new Error("global coverage gate rejected an incomplete generation run");
    }
    const [unfinished] = await tx
      .select({ count: count() })
      .from(schema.cardGenerationUnits)
      .where(and(
        eq(schema.cardGenerationUnits.workspaceId, job.workspaceId),
        eq(schema.cardGenerationUnits.runId, locked.run.id),
        inArray(schema.cardGenerationUnits.kind, [
          CardGenerationUnitKind.TEXT_MAP,
          CardGenerationUnitKind.IMAGE,
        ]),
        ne(schema.cardGenerationUnits.status, "succeeded"),
      ));
    if (Number(unfinished?.count ?? 0) !== 0) {
      throw new Error("global coverage gate found unfinished map checkpoints");
    }

    const now = new Date();
    const excludedUnitIds = partialResult
      ? explicitImageExclusions(locked.run).map((entry) => entry.sourceUnitId)
      : [];
    const excludedImages = partialResult
      ? explicitImageExclusions(locked.run).map((entry) => ({
          sourceUnitId: entry.sourceUnitId,
          imageAssetId: entry.imageAssetId,
          imageBlockId: entry.imageBlockId,
          reason: entry.errorCode ?? "image_analysis_failed",
        }))
      : [];
    const coverageWarning = partialResult
      ? {
          code: "partial_generation" as const,
          excludedImageCount: excludedUnitIds.length,
          excludedUnitIds,
          excludedImages,
        }
      : undefined;
    const expectedEvidenceCount = material.candidates.reduce(
      (total, candidate) => total + candidate.evidences.length,
      0,
    );
    const coverageReport = {
      ...locked.run.coverageReport,
      resultCompleteness: partialResult ? "partial" : "full",
      processedPrimaryUnits: locked.run.requiredUnits,
      processedImages: locked.run.completedImages,
      excludedImageCount: excludedUnitIds.length,
      excludedUnitIds,
      excludedImages,
      policyAdjustedImageCoverageBps: 10_000,
      exactEvidenceCount: expectedEvidenceCount,
      activeCandidateCount: material.selectedCandidateIds.length,
      excludedCandidates: material.excludedCandidateIds,
      representedSections: material.deckPlan.representedSections,
      evidenceMode: "typed_exact",
      deckMode: material.deckPlan.mode,
      cardCount: material.cards.length,
    };
    const oldActiveSets = partialResult
      ? []
      : await tx
          .select()
          .from(schema.learningCardSets)
          .where(and(
            eq(schema.learningCardSets.workspaceId, job.workspaceId),
            eq(schema.learningCardSets.noteId, locked.run.noteId),
            eq(schema.learningCardSets.status, "active"),
          ))
          .for("update");
    const noteVersionRows = partialResult
      ? []
      : await tx
          .select({ id: schema.noteVersions.id })
          .from(schema.noteVersions)
          .where(and(
            eq(schema.noteVersions.workspaceId, job.workspaceId),
            eq(schema.noteVersions.noteId, locked.run.noteId),
          ));
    const noteVersionIds = noteVersionRows.map((version) => version.id);
    const oldActiveCards = noteVersionIds.length === 0
      ? []
      : await tx
          .select()
          .from(schema.learningCards)
          .where(and(
            eq(schema.learningCards.workspaceId, job.workspaceId),
            eq(schema.learningCards.status, "active"),
            inArray(schema.learningCards.noteVersionId, noteVersionIds),
          ))
          .for("update");
    const oldSetIds = oldActiveSets.map((set) => set.id);
    const oldCardIds = oldActiveCards.map((card) => card.id);
    if (oldSetIds.length > 0) {
      await tx
        .update(schema.learningCardSets)
        .set({ status: "superseded", supersededAt: now })
        .where(and(
          eq(schema.learningCardSets.workspaceId, job.workspaceId),
          inArray(schema.learningCardSets.id, oldSetIds),
          eq(schema.learningCardSets.status, "active"),
        ));
    }
    if (oldCardIds.length > 0) {
      await tx
        .update(schema.learningCards)
        .set({ status: "superseded", updatedAt: now })
        .where(and(
          eq(schema.learningCards.workspaceId, job.workspaceId),
          inArray(schema.learningCards.id, oldCardIds),
          eq(schema.learningCards.status, "active"),
        ));
      const oldKeyPoints = await tx
        .select({ id: schema.cardKeyPoints.id })
        .from(schema.cardKeyPoints)
        .where(and(
          eq(schema.cardKeyPoints.workspaceId, job.workspaceId),
          inArray(schema.cardKeyPoints.cardId, oldCardIds),
        ));
      const oldValidationEvents = await tx
        .select({ id: schema.validationEvents.id })
        .from(schema.validationEvents)
        .where(and(
          eq(schema.validationEvents.workspaceId, job.workspaceId),
          inArray(schema.validationEvents.cardId, oldCardIds),
        ));
      const oldKeyPointIds = oldKeyPoints.map((keyPoint) => keyPoint.id);
      const oldValidationEventIds = oldValidationEvents.map((event) => event.id);
      await tx
        .update(schema.reviewSchedules)
        .set({ status: "superseded", updatedAt: now })
        .where(and(
          eq(schema.reviewSchedules.workspaceId, job.workspaceId),
          eq(schema.reviewSchedules.status, "pending"),
          eq(schema.reviewSchedules.subjectType, "card"),
          inArray(schema.reviewSchedules.subjectId, oldCardIds),
        ));
      if (oldKeyPointIds.length > 0) {
        await tx
          .update(schema.reviewSchedules)
          .set({ status: "superseded", updatedAt: now })
          .where(and(
            eq(schema.reviewSchedules.workspaceId, job.workspaceId),
            eq(schema.reviewSchedules.status, "pending"),
            inArray(schema.reviewSchedules.keyPointId, oldKeyPointIds),
          ));
      }
      if (oldValidationEventIds.length > 0) {
        await tx
          .update(schema.reviewSchedules)
          .set({ status: "superseded", updatedAt: now })
          .where(and(
            eq(schema.reviewSchedules.workspaceId, job.workspaceId),
            eq(schema.reviewSchedules.status, "pending"),
            or(
              inArray(
                schema.reviewSchedules.validationEventId,
                oldValidationEventIds,
              ),
              and(
                eq(schema.reviewSchedules.subjectType, "validation"),
                inArray(schema.reviewSchedules.subjectId, oldValidationEventIds),
              ),
            ),
          ));
      }
    }

    const [cardSet] = await tx
      .insert(schema.learningCardSets)
      .values({
        workspaceId: job.workspaceId,
        noteId: locked.run.noteId,
        noteVersionId: locked.run.noteVersionId,
        generationRunId: locked.run.id,
        status: partialResult ? "partial_ready" : "active",
        title: material.title,
        summary: material.summary,
        coverageReport,
        createdAt: now,
        activatedAt: partialResult ? null : now,
        supersededAt: null,
      })
      .returning();
    const candidateById = new Map(
      material.candidates.map((candidate) => [candidate.id, candidate]),
    );
    const publishedCards: Array<{
      descriptor: PublishCardMaterial;
      card: typeof schema.learningCards.$inferSelect;
      candidates: PublishCandidate[];
      keyPoints: Array<typeof schema.cardKeyPoints.$inferSelect>;
      evidences: Array<typeof schema.evidences.$inferSelect>;
    }> = [];
    const persistedKeyPoints: Array<typeof schema.cardKeyPoints.$inferSelect> = [];
    const persistedEvidence: Array<typeof schema.evidences.$inferSelect> = [];
    for (const descriptor of material.cards) {
      const cardCandidates = descriptor.candidateIds.map((candidateId) => {
        const candidate = candidateById.get(candidateId);
        if (!candidate) throw new Error("published card lost a planned candidate");
        return candidate;
      });
      const cardOutput = {
        title: descriptor.title,
        summary: descriptor.summary,
        summarySupportCandidateIds: descriptor.summarySupportCandidateIds,
        scope: descriptor.scope,
        scopeKey: descriptor.scopeKey,
        ordinal: descriptor.ordinal,
        ...(coverageWarning ? { coverageWarning } : {}),
        key_points: cardCandidates.map((candidate, ordinal) => ({
          ordinal,
          claim: candidate.claim,
          quote_text: candidate.evidences[0]!.quoteText,
          candidateId: candidate.id,
          evidenceRefs: candidate.evidences.map((evidence) => ({
            sourceKind: evidence.sourceKind,
            id: evidence.sourceKind === "text_span"
              ? evidence.spanId
              : evidence.imageEvidenceUnitId,
          })),
          evidenceSpanIds: candidate.evidences.flatMap((evidence) =>
            evidence.sourceKind === "text_span" ? [evidence.spanId] : []),
          imageEvidenceUnitIds: candidate.evidences.flatMap((evidence) =>
            evidence.sourceKind === "image_region" ? [evidence.imageEvidenceUnitId] : []),
        })),
      };
      const [artifact] = await tx
        .insert(schema.aiArtifacts)
        .values({
          workspaceId: job.workspaceId,
          type: "learning_card",
          inputRefs: {
            noteId: locked.run.noteId,
            noteVersionId: locked.run.noteVersionId,
          },
          output: cardOutput,
          modelId: typeof locked.run.providerSnapshot.modelId === "string"
            ? locked.run.providerSnapshot.modelId
            : "card-generation-v2",
          promptVersion: "card-render-v1",
          inputHash: hashJson({
            generationFingerprint: locked.run.generationFingerprint,
            scope: descriptor.scope,
            scopeKey: descriptor.scopeKey,
            candidateIds: descriptor.candidateIds,
          }),
          status: "ready",
        })
        .returning();
      const [card] = await tx
        .insert(schema.learningCards)
        .values({
          noteVersionId: locked.run.noteVersionId,
          workspaceId: job.workspaceId,
          cardSetId: cardSet.id,
          generationRunId: locked.run.id,
          scope: descriptor.scope,
          scopeKey: descriptor.scopeKey,
          ordinal: descriptor.ordinal,
          status: partialResult ? "archived" : "active",
          schemaJson: {
            title: descriptor.title,
            summary: descriptor.summary,
            ...(coverageWarning ? { coverageWarning } : {}),
          },
          artifactId: artifact.id,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      const keyPoints = await tx
        .insert(schema.cardKeyPoints)
        .values(cardCandidates.map((candidate, ordinal) => ({
          cardId: card.id,
          workspaceId: job.workspaceId,
          ordinal,
          claim: candidate.claim,
          quoteText: candidate.evidences[0]!.quoteText,
          segmentRef: {
            blockId: candidate.evidences[0]!.blockId,
            blockOrdinal: candidate.evidences[0]!.blockOrdinal,
          },
          candidateId: candidate.id,
          createdAt: now,
        })))
        .returning();
      persistedKeyPoints.push(...keyPoints);
      const keyPointByCandidate = new Map(
        keyPoints.map((keyPoint) => [keyPoint.candidateId!, keyPoint]),
      );
      const evidenceValues: Array<typeof schema.evidences.$inferInsert> =
        cardCandidates.flatMap((candidate) => {
          const keyPoint = keyPointByCandidate.get(candidate.id);
          if (!keyPoint) {
            throw new Error("published key point lost its candidate identity");
          }
          return candidate.evidences.map((evidence) =>
            evidence.sourceKind === "text_span"
              ? {
                  workspaceId: job.workspaceId,
                  keyPointId: keyPoint.id,
                  blockId: evidence.blockId,
                  blockOrdinal: evidence.blockOrdinal,
                  quoteText: evidence.quoteText,
                  alignment: "aligned" as const,
                  alignmentScore: 100,
                  alignmentMethod: "exact_span",
                  evidenceSpanId: evidence.spanId,
                  sourceKind: "text_span",
                  charStart: evidence.charStart,
                  charEnd: evidence.charEnd,
                  sourceHash: evidence.sourceHash,
                  createdAt: now,
                }
              : {
                  workspaceId: job.workspaceId,
                  keyPointId: keyPoint.id,
                  blockId: evidence.blockId,
                  blockOrdinal: evidence.blockOrdinal,
                  quoteText: evidence.quoteText,
                  alignment: "aligned" as const,
                  alignmentScore: 100,
                  alignmentMethod: evidence.alignmentMethod,
                  sourceKind: "image_region",
                  sourceHash: evidence.sourceHash,
                  imageAssetId: evidence.imageAssetId,
                  imageInsightId: evidence.imageInsightId,
                  imageEvidenceUnitId: evidence.imageEvidenceUnitId,
                  regionJson: evidence.regionJson,
                  extractorVersion: evidence.extractorVersion,
                  createdAt: now,
                });
        });
      const cardEvidence: Array<typeof schema.evidences.$inferSelect> = [];
      await insertInBatches(evidenceValues, 300, async (batch) => {
        const rows = await tx.insert(schema.evidences).values(batch).returning();
        cardEvidence.push(...rows);
        persistedEvidence.push(...rows);
      });
      publishedCards.push({
        descriptor,
        card,
        candidates: cardCandidates,
        keyPoints,
        evidences: cardEvidence,
      });
    }
    const overview = publishedCards.find(
      ({ descriptor }) => descriptor.scope === "overview",
    );
    if (
      !overview
      || overview.descriptor.ordinal !== 0
      || persistedKeyPoints.length !== material.selectedCandidateIds.length
      || persistedEvidence.length !== expectedEvidenceCount
    ) {
      throw new Error("published card set failed its exact assignment gate");
    }
    if (oldCardIds.length > 0) {
      await tx
        .update(schema.learningCards)
        .set({ supersededByCardId: overview.card.id, updatedAt: now })
        .where(and(
          eq(schema.learningCards.workspaceId, job.workspaceId),
          inArray(schema.learningCards.id, oldCardIds),
        ));
    }

    if (oldCardIds.length > 0) {
      await tx
        .delete(schema.searchDocuments)
        .where(and(
          eq(schema.searchDocuments.workspaceId, job.workspaceId),
          or(
            and(
              eq(schema.searchDocuments.objectType, "card"),
              inArray(schema.searchDocuments.objectId, oldCardIds),
            ),
            and(
              eq(schema.searchDocuments.objectType, "evidence"),
              inArray(
                sql<string>`${schema.searchDocuments.metadata}->>'cardId'`,
                oldCardIds,
              ),
            ),
          ),
        ));
    }
    if (oldSetIds.length > 0) {
      await tx
        .delete(schema.searchDocuments)
        .where(and(
          eq(schema.searchDocuments.workspaceId, job.workspaceId),
          eq(schema.searchDocuments.objectType, "card_set"),
          inArray(schema.searchDocuments.objectId, oldSetIds),
        ));
    }
    if (!partialResult) {
      await tx
        .insert(schema.searchDocuments)
        .values({
          workspaceId: job.workspaceId,
          objectType: "card_set",
          objectId: cardSet.id,
          title: material.title,
          body: `${material.summary}\n${material.candidates.map((candidate) => candidate.claim).join("\n")}`,
          metadata: {
            noteId: locked.run.noteId,
            noteVersionId: locked.run.noteVersionId,
            generationRunId: locked.run.id,
            overviewCardId: overview.card.id,
            cardCount: publishedCards.length,
            evidenceMode: "typed_exact",
          },
          indexedAt: now,
        });
      await tx
        .insert(schema.searchDocuments)
        .values(publishedCards.map(({ descriptor, card, candidates }) => ({
          workspaceId: job.workspaceId,
          objectType: "card",
          objectId: card.id,
          title: descriptor.title,
          body: `${descriptor.summary}\n${candidates
            .map((candidate) => candidate.claim)
            .join("\n")}`,
          metadata: {
            cardSetId: cardSet.id,
            noteId: locked.run.noteId,
            noteVersionId: locked.run.noteVersionId,
            generationRunId: locked.run.id,
            scope: descriptor.scope,
            scopeKey: descriptor.scopeKey,
            ordinal: descriptor.ordinal,
            evidenceMode: "typed_exact",
          },
          indexedAt: now,
        })));
      const evidenceDocuments = publishedCards.flatMap(
        ({ descriptor, card, evidences }) =>
          evidences.map((evidence) => ({
            workspaceId: job.workspaceId,
            objectType: "evidence",
            objectId: evidence.id,
            title: "Evidence",
            body: evidence.quoteText,
            metadata: {
              cardId: card.id,
              cardSetId: cardSet.id,
              scope: descriptor.scope,
              ordinal: descriptor.ordinal,
              keyPointId: evidence.keyPointId,
              evidenceSpanId: evidence.evidenceSpanId,
              imageEvidenceUnitId: evidence.imageEvidenceUnitId,
              sourceKind: evidence.sourceKind,
            },
            indexedAt: now,
          })),
      );
      if (evidenceDocuments.length > 0) {
        await insertInBatches(evidenceDocuments, 300, async (batch) => {
          await tx.insert(schema.searchDocuments).values(batch);
        });
      }
    }

    const publishArtifact = {
      cardSetId: cardSet.id,
      overviewCardId: overview.card.id,
      cardIds: publishedCards.map(({ card }) => card.id),
      cardCount: publishedCards.length,
      keyPointCount: persistedKeyPoints.length,
      exactEvidenceCount: persistedEvidence.length,
      selectedCandidateIds: material.selectedCandidateIds,
    };
    await tx
      .update(schema.cardGenerationUnits)
      .set({
        status: "succeeded",
        artifactJson: publishArtifact,
        artifactHash: hashJson(publishArtifact),
        errorCode: null,
        finishedAt: now,
        updatedAt: now,
      })
      .where(and(
        eq(schema.cardGenerationUnits.id, locked.unit.id),
        eq(schema.cardGenerationUnits.workspaceId, job.workspaceId),
        eq(schema.cardGenerationUnits.status, "running"),
      ));
    const completionStatus = partialResult
      ? CardGenerationRunStatus.PARTIAL_READY
      : CardGenerationRunStatus.SUCCEEDED;
    const [completed] = await tx
      .update(schema.cardGenerationRuns)
      .set({
        status: completionStatus,
        stage: CardGenerationStage.COMPLETE,
        stateVersion: locked.run.stateVersion + 1,
        nextEventSequence: locked.run.nextEventSequence + 1,
        resultCardSetId: cardSet.id,
        resultCardId: overview.card.id,
        completedUnits: locked.run.requiredUnits,
        failedUnits: 0,
        sourceCoverageBps: 10_000,
        imageCoverageBps: locked.run.imageCoverageBps,
        coverageReport,
        errorCode: null,
        retryable: false,
        updatedAt: now,
        finishedAt: now,
      })
      .where(and(
        eq(schema.cardGenerationRuns.id, locked.run.id),
        eq(schema.cardGenerationRuns.workspaceId, job.workspaceId),
        eq(schema.cardGenerationRuns.stateVersion, locked.run.stateVersion),
        eq(schema.cardGenerationRuns.status, CardGenerationRunStatus.PUBLISHING),
      ))
      .returning({ id: schema.cardGenerationRuns.id });
    if (!completed) throw new Error("exact publication completion CAS failed");
    await appendEvent(tx, locked.run, {
      stage: CardGenerationStage.COMPLETE,
      state: completionStatus,
      completed: locked.run.requiredUnits,
      total: locked.run.requiredUnits,
      unit: "source_units",
      messageCode: partialResult ? "generation_partial_ready" : "generation_succeeded",
      safeDetails: {
        cardSetId: cardSet.id,
        overviewCardId: overview.card.id,
        cardCount: publishedCards.length,
        keyPointCount: persistedKeyPoints.length,
        exactEvidenceCount: persistedEvidence.length,
        excludedImageCount: excludedUnitIds.length,
      },
      createdAt: now,
    });
    throwIfJobAborted(leaseContext(job));
  });
  logger.info(
    {
      runId: payload.runId,
      unitId: payload.unitId,
      candidateCount: material.candidates.length,
      cardCount: material.cards.length,
    },
    "typed-evidence card set generation published",
  );
}

export async function projectTextPipelineJobFailure(input: {
  job: CardGenerationTextJob;
  error: unknown;
  terminal: boolean;
  retryable: boolean;
}): Promise<boolean> {
  const payload = pipelinePayload(input.job);
  return withWorkerWorkspaceTransaction(
    { workspaceId: input.job.workspaceId, userId: input.job.requestedBy },
    async (tx) => {
      await tx.execute(sql`
        SELECT pg_advisory_xact_lock(
          hashtextextended(${`job-quota:${input.job.workspaceId}`}, 0)
        )
      `);
      const [run] = await tx
        .select()
        .from(schema.cardGenerationRuns)
        .where(and(
          eq(schema.cardGenerationRuns.id, payload.runId),
          eq(schema.cardGenerationRuns.workspaceId, input.job.workspaceId),
        ))
        .for("update");
      const [unit] = await tx
        .select()
        .from(schema.cardGenerationUnits)
        .where(and(
          eq(schema.cardGenerationUnits.id, payload.unitId),
          eq(schema.cardGenerationUnits.workspaceId, input.job.workspaceId),
          eq(schema.cardGenerationUnits.runId, payload.runId),
        ))
        .for("update");
      if (!run || !unit || unit.status === "succeeded") return false;
      if (["cancelled", "superseded", "partial_ready", "succeeded"].includes(run.status)) return false;
      const now = new Date();
      const sanitizedFailure = sanitizeOperationalError(input.error);
      // Stable, user-actionable codes pass through verbatim so the UI can
      // explain the failure; everything else keeps the kind_category shape.
      const errorCode = sanitizedFailure.code && UNIT_FAILURE_CODE_ALLOWLIST.has(sanitizedFailure.code)
        ? sanitizedFailure.code
        : `${unit.kind}_${sanitizedFailure.category}`;
      await tx
        .update(schema.cardGenerationUnits)
        .set({
          status: input.terminal ? "terminal_failed" : "retryable_failed",
          errorCode,
          finishedAt: input.terminal ? now : null,
          updatedAt: now,
        })
        .where(and(
          eq(schema.cardGenerationUnits.id, unit.id),
          eq(schema.cardGenerationUnits.workspaceId, input.job.workspaceId),
        ));
      if (!input.terminal) return true;
      const failedSourceUnits = unit.kind === CardGenerationUnitKind.TEXT_MAP
        ? (unit.inputManifest.spanIds?.length ?? 0)
        : 0;
      // 方案 §7.5/G5: a terminal map/image failure must not freeze siblings.
      // While other checkpoints in the same phase can still make progress we
      // only record the failure and keep the window moving; the run settles
      // into needs_attention via markGenerationPhaseSettled once nothing in
      // the phase is pending, running, or awaiting an automatic retry.
      const requestedBy = typeof input.job.requestedBy === "string" && input.job.requestedBy
        ? input.job.requestedBy
        : null;
      const isPhaseUnit = unit.kind === CardGenerationUnitKind.TEXT_MAP
        || unit.kind === CardGenerationUnitKind.IMAGE;
      const [siblings] = isPhaseUnit
        ? await tx
            .select({ count: count() })
            .from(schema.cardGenerationUnits)
            .where(and(
              eq(schema.cardGenerationUnits.workspaceId, input.job.workspaceId),
              eq(schema.cardGenerationUnits.runId, run.id),
              inArray(schema.cardGenerationUnits.kind, [
                CardGenerationUnitKind.TEXT_MAP,
                CardGenerationUnitKind.IMAGE,
              ]),
              inArray(schema.cardGenerationUnits.status, [
                "pending",
                "running",
                "retryable_failed",
              ]),
              ne(schema.cardGenerationUnits.id, unit.id),
            ))
        : [{ count: 0 }];
      if (isPhaseUnit && requestedBy && Number(siblings?.count ?? 0) > 0) {
        const [deferred] = await tx
          .update(schema.cardGenerationRuns)
          .set({
            stateVersion: run.stateVersion + 1,
            nextEventSequence: run.nextEventSequence + 1,
            errorCode,
            retryable: true,
            failedUnits: run.failedUnits + failedSourceUnits,
            updatedAt: now,
          })
          .where(and(
            eq(schema.cardGenerationRuns.id, run.id),
            eq(schema.cardGenerationRuns.workspaceId, input.job.workspaceId),
            eq(schema.cardGenerationRuns.stateVersion, run.stateVersion),
          ))
          .returning();
        if (!deferred) throw new Error("generation unit failure CAS failed");
        await appendEvent(tx, run, {
          stage: unit.kind,
          state: run.status,
          completed: run.completedUnits,
          total: run.requiredUnits,
          unit: "source_units",
          messageCode: errorCode,
          safeDetails: {
            retryable: input.retryable,
            unitOrdinal: unit.ordinal,
            deferredSettle: true,
          },
          createdAt: now,
        });
        // Free the window slot this unit occupied so queued siblings advance.
        const advanced = unit.kind === CardGenerationUnitKind.IMAGE
          ? await advanceImageWindow(tx, deferred, requestedBy, input.job.id)
          : await advanceMapWindow(tx, deferred, requestedBy, input.job.id);
        if (!advanced) {
          await markSchedulerAttention(tx, deferred, now);
        }
        return true;
      }
      await tx
        .update(schema.cardGenerationRuns)
        .set({
          status: CardGenerationRunStatus.NEEDS_ATTENTION,
          stage: unit.kind,
          stateVersion: run.stateVersion + 1,
          nextEventSequence: run.nextEventSequence + 1,
          errorCode,
          // Manual checkpoint retry is always available from needs_attention;
          // input.retryable only classifies automatic queue retries.
          retryable: true,
          failedUnits: run.failedUnits + failedSourceUnits,
          updatedAt: now,
          finishedAt: now,
        })
        .where(and(
          eq(schema.cardGenerationRuns.id, run.id),
          eq(schema.cardGenerationRuns.workspaceId, input.job.workspaceId),
          eq(schema.cardGenerationRuns.stateVersion, run.stateVersion),
        ));
      await appendEvent(tx, run, {
        stage: unit.kind,
        state: CardGenerationRunStatus.NEEDS_ATTENTION,
        completed: run.completedUnits,
        total: run.requiredUnits,
        unit: "source_units",
        messageCode: errorCode,
        safeDetails: { retryable: input.retryable, unitOrdinal: unit.ordinal },
        createdAt: now,
      });
      return true;
    },
  );
}
