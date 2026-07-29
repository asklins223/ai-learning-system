import { and, eq, sql } from "drizzle-orm";
import { sanitizeOperationalError } from "@ailearn/shared";
import {
  withWorkerWorkspaceTransaction,
  type WorkerTransaction,
} from "../db.ts";
import * as schema from "../schema/index.ts";
import {
  lockJobLease,
  withJobTransaction,
  type JobLeaseContext,
} from "./job-lease.ts";

const TERMINAL_RUN_STATUSES = new Set([
  "succeeded",
  "partial_ready",
  "needs_attention",
  "cancelled",
  "superseded",
]);

export interface GenerationRunFenceSnapshot {
  id: string;
  status: string;
  generationEpoch: number;
}

export interface NoteGenerationFenceSnapshot {
  cardGenerationEpoch: number;
  latestGenerationRunId: string | null;
}

export type GenerationRunFenceDecision = "active" | "stale" | "terminal";

/**
 * Pure ordering policy shared by the start and publish fences.
 *
 * Terminal rows are immutable historical facts. Every other row is active only
 * while both monotonic ordering fields still point at the same run.
 */
export function decideGenerationRunFence(
  run: GenerationRunFenceSnapshot,
  note: NoteGenerationFenceSnapshot,
): GenerationRunFenceDecision {
  if (TERMINAL_RUN_STATUSES.has(run.status)) return "terminal";
  if (
    run.generationEpoch !== note.cardGenerationEpoch
    || note.latestGenerationRunId !== run.id
  ) {
    return "stale";
  }
  return "active";
}

export function generationRunIdFromPayload(
  payload: Record<string, unknown>,
): string | null {
  const value = payload.generationRunId;
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new GenerationRunContractError("generationRunId must be a non-empty string");
  }
  return value;
}

/** Only an allowlisted category is persisted; provider/database text is not. */
export function generationRunErrorCode(error: unknown): string {
  return `legacy_generate_${sanitizeOperationalError(error).category}`;
}

export class GenerationRunContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GenerationRunContractError";
  }
}

export interface ActiveGenerationRun {
  id: string;
  workspaceId: string;
  noteId: string;
  noteVersionId: string;
  generationEpoch: number;
  titleSnapshot: string;
  stateVersion: number;
  nextEventSequence: number;
}

export type GenerationRunTransitionResult =
  | { state: "active"; run: ActiveGenerationRun }
  | { state: "skip"; reason: "stale" | "terminal" };

type LockedGenerationRun = ActiveGenerationRun & {
  status: string;
  startedAt: Date | null;
};

type LockedRunAndNote = {
  run: LockedGenerationRun;
  note: NoteGenerationFenceSnapshot;
};

type RunFenceInput = {
  runId: string;
  workspaceId: string;
  noteVersionId: string;
};

async function loadAndLockRunAndNote(
  tx: WorkerTransaction,
  input: RunFenceInput,
): Promise<LockedRunAndNote> {
  const [run] = await tx
    .select({
      id: schema.cardGenerationRuns.id,
      workspaceId: schema.cardGenerationRuns.workspaceId,
      noteId: schema.cardGenerationRuns.noteId,
      noteVersionId: schema.cardGenerationRuns.noteVersionId,
      generationEpoch: schema.cardGenerationRuns.generationEpoch,
      titleSnapshot: schema.cardGenerationRuns.titleSnapshot,
      status: schema.cardGenerationRuns.status,
      stateVersion: schema.cardGenerationRuns.stateVersion,
      nextEventSequence: schema.cardGenerationRuns.nextEventSequence,
      startedAt: schema.cardGenerationRuns.startedAt,
    })
    .from(schema.cardGenerationRuns)
    .where(and(
      eq(schema.cardGenerationRuns.id, input.runId),
      eq(schema.cardGenerationRuns.workspaceId, input.workspaceId),
    ))
    .for("update");
  if (!run) {
    throw new GenerationRunContractError("generation run was not found in the job workspace");
  }
  if (run.noteVersionId !== input.noteVersionId) {
    throw new GenerationRunContractError("generation run does not match the job note version");
  }

  const [note] = await tx
    .select({
      cardGenerationEpoch: schema.notes.cardGenerationEpoch,
      latestGenerationRunId: schema.notes.latestGenerationRunId,
    })
    .from(schema.notes)
    .where(and(
      eq(schema.notes.id, run.noteId),
      eq(schema.notes.workspaceId, input.workspaceId),
    ));
  if (!note) {
    throw new GenerationRunContractError("generation run note was not found in the job workspace");
  }

  return {
    run: {
      ...run,
      generationEpoch: Number(run.generationEpoch),
      stateVersion: Number(run.stateVersion),
      nextEventSequence: Number(run.nextEventSequence),
    },
    note: {
      cardGenerationEpoch: Number(note.cardGenerationEpoch),
      latestGenerationRunId: note.latestGenerationRunId,
    },
  };
}

async function appendGenerationRunEvent(
  tx: WorkerTransaction,
  input: {
    runId: string;
    workspaceId: string;
    sequence: number;
    stage: string;
    state: string;
    completed: number;
    total: number;
    unit: string;
    messageCode: string;
    safeDetails?: Record<string, unknown>;
    createdAt: Date;
  },
): Promise<void> {
  await tx.insert(schema.cardGenerationEvents).values({
    runId: input.runId,
    workspaceId: input.workspaceId,
    sequence: input.sequence,
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

async function markRunSuperseded(
  tx: WorkerTransaction,
  locked: LockedRunAndNote,
  now: Date,
): Promise<void> {
  const [updated] = await tx
    .update(schema.cardGenerationRuns)
    .set({
      status: "superseded",
      stage: "complete",
      stateVersion: sql`${schema.cardGenerationRuns.stateVersion} + 1`,
      nextEventSequence: sql`${schema.cardGenerationRuns.nextEventSequence} + 1`,
      errorCode: "stale_generation_epoch",
      retryable: false,
      updatedAt: now,
      finishedAt: now,
    })
    .where(and(
      eq(schema.cardGenerationRuns.id, locked.run.id),
      eq(schema.cardGenerationRuns.workspaceId, locked.run.workspaceId),
      eq(schema.cardGenerationRuns.stateVersion, locked.run.stateVersion),
    ))
    .returning({ id: schema.cardGenerationRuns.id });
  if (!updated) {
    throw new GenerationRunContractError("generation run supersede CAS failed");
  }

  await appendGenerationRunEvent(tx, {
    runId: locked.run.id,
    workspaceId: locked.run.workspaceId,
    sequence: locked.run.nextEventSequence,
    stage: "complete",
    state: "superseded",
    completed: 0,
    total: 1,
    unit: "run",
    messageCode: "stale_generation_epoch",
    safeDetails: {
      generationEpoch: locked.run.generationEpoch,
      currentGenerationEpoch: locked.note.cardGenerationEpoch,
    },
    createdAt: now,
  });
}

async function evaluateLockedFence(
  tx: WorkerTransaction,
  locked: LockedRunAndNote,
  now: Date,
): Promise<GenerationRunFenceDecision> {
  const decision = decideGenerationRunFence(locked.run, locked.note);
  if (decision === "stale") {
    await markRunSuperseded(tx, locked, now);
  }
  return decision;
}

export async function startCardGenerationRun(
  lease: JobLeaseContext,
  input: { runId: string; noteVersionId: string },
): Promise<GenerationRunTransitionResult> {
  return withJobTransaction(lease, async (tx) => {
    await lockJobLease(tx, lease);
    // API run creation and every publish fence use the same workspace lock.
    // This serializes the note epoch read without granting the Worker UPDATE
    // privilege on notes merely to issue SELECT ... FOR UPDATE.
    await tx.execute(sql`
      SELECT pg_advisory_xact_lock(
        hashtextextended(${`job-quota:${lease.workspaceId}`}, 0)
      )
    `);
    const locked = await loadAndLockRunAndNote(tx, {
      runId: input.runId,
      workspaceId: lease.workspaceId,
      noteVersionId: input.noteVersionId,
    });
    const now = new Date();
    const decision = await evaluateLockedFence(tx, locked, now);
    if (decision !== "active") {
      return { state: "skip", reason: decision };
    }

    const [updated] = await tx
      .update(schema.cardGenerationRuns)
      .set({
        status: "planning",
        stage: "legacy_generate",
        stateVersion: sql`${schema.cardGenerationRuns.stateVersion} + 1`,
        nextEventSequence: sql`${schema.cardGenerationRuns.nextEventSequence} + 1`,
        errorCode: null,
        retryable: true,
        startedAt: locked.run.startedAt ?? now,
        updatedAt: now,
        finishedAt: null,
      })
      .where(and(
        eq(schema.cardGenerationRuns.id, locked.run.id),
        eq(schema.cardGenerationRuns.workspaceId, locked.run.workspaceId),
        eq(schema.cardGenerationRuns.stateVersion, locked.run.stateVersion),
      ))
      .returning({
        stateVersion: schema.cardGenerationRuns.stateVersion,
        nextEventSequence: schema.cardGenerationRuns.nextEventSequence,
      });
    if (!updated) {
      throw new GenerationRunContractError("generation run start CAS failed");
    }

    await appendGenerationRunEvent(tx, {
      runId: locked.run.id,
      workspaceId: locked.run.workspaceId,
      sequence: locked.run.nextEventSequence,
      stage: "legacy_generate",
      state: "planning",
      completed: 0,
      total: 1,
      unit: "legacy_job",
      messageCode: "legacy_generate_started",
      createdAt: now,
    });

    return {
      state: "active",
      run: {
        id: locked.run.id,
        workspaceId: locked.run.workspaceId,
        noteId: locked.run.noteId,
        noteVersionId: locked.run.noteVersionId,
        generationEpoch: locked.run.generationEpoch,
        titleSnapshot: locked.run.titleSnapshot,
        stateVersion: Number(updated.stateVersion),
        nextEventSequence: Number(updated.nextEventSequence),
      },
    };
  });
}

/**
 * Re-check ordering immediately before the first legacy publication mutation.
 * The returned stateVersion is the CAS input for the atomic success transition.
 */
export async function beginCardGenerationPublish(
  tx: WorkerTransaction,
  input: RunFenceInput,
): Promise<GenerationRunTransitionResult> {
  const locked = await loadAndLockRunAndNote(tx, input);
  const now = new Date();
  const decision = await evaluateLockedFence(tx, locked, now);
  if (decision !== "active") {
    return { state: "skip", reason: decision };
  }

  const [updated] = await tx
    .update(schema.cardGenerationRuns)
    .set({
      status: "publishing",
      stage: "publish",
      stateVersion: sql`${schema.cardGenerationRuns.stateVersion} + 1`,
      nextEventSequence: sql`${schema.cardGenerationRuns.nextEventSequence} + 1`,
      updatedAt: now,
    })
    .where(and(
      eq(schema.cardGenerationRuns.id, locked.run.id),
      eq(schema.cardGenerationRuns.workspaceId, locked.run.workspaceId),
      eq(schema.cardGenerationRuns.stateVersion, locked.run.stateVersion),
    ))
    .returning({
      stateVersion: schema.cardGenerationRuns.stateVersion,
      nextEventSequence: schema.cardGenerationRuns.nextEventSequence,
    });
  if (!updated) {
    throw new GenerationRunContractError("generation run publish CAS failed");
  }

  await appendGenerationRunEvent(tx, {
    runId: locked.run.id,
    workspaceId: locked.run.workspaceId,
    sequence: locked.run.nextEventSequence,
    stage: "publish",
    state: "publishing",
    completed: 0,
    total: 1,
    unit: "card",
    messageCode: "legacy_publish_started",
    createdAt: now,
  });

  return {
    state: "active",
    run: {
      id: locked.run.id,
      workspaceId: locked.run.workspaceId,
      noteId: locked.run.noteId,
      noteVersionId: locked.run.noteVersionId,
      generationEpoch: locked.run.generationEpoch,
      titleSnapshot: locked.run.titleSnapshot,
      stateVersion: Number(updated.stateVersion),
      nextEventSequence: Number(updated.nextEventSequence),
    },
  };
}

export async function completeCardGenerationRun(
  tx: WorkerTransaction,
  input: { run: ActiveGenerationRun; cardId: string },
): Promise<void> {
  const now = new Date();
  const [updated] = await tx
    .update(schema.cardGenerationRuns)
    .set({
      status: "succeeded",
      stage: "complete",
      stateVersion: sql`${schema.cardGenerationRuns.stateVersion} + 1`,
      nextEventSequence: sql`${schema.cardGenerationRuns.nextEventSequence} + 1`,
      resultCardId: input.cardId,
      errorCode: null,
      retryable: false,
      updatedAt: now,
      finishedAt: now,
    })
    .where(and(
      eq(schema.cardGenerationRuns.id, input.run.id),
      eq(schema.cardGenerationRuns.workspaceId, input.run.workspaceId),
      eq(schema.cardGenerationRuns.stateVersion, input.run.stateVersion),
      eq(schema.cardGenerationRuns.status, "publishing"),
    ))
    .returning({ id: schema.cardGenerationRuns.id });
  if (!updated) {
    throw new GenerationRunContractError("generation run completion CAS failed");
  }

  await appendGenerationRunEvent(tx, {
    runId: input.run.id,
    workspaceId: input.run.workspaceId,
    sequence: input.run.nextEventSequence,
    stage: "complete",
    state: "succeeded",
    completed: 1,
    total: 1,
    unit: "card",
    messageCode: "legacy_generation_succeeded",
    safeDetails: { cardId: input.cardId },
    createdAt: now,
  });
}

/** Close a retry/idempotency path that finds the already-published card. */
export async function completeExistingCardGenerationRun(
  lease: JobLeaseContext,
  input: { runId: string; noteVersionId: string; cardId: string },
): Promise<GenerationRunTransitionResult> {
  return withJobTransaction(lease, async (tx) => {
    await lockJobLease(tx, lease);
    await tx.execute(sql`
      SELECT pg_advisory_xact_lock(
        hashtextextended(${`job-quota:${lease.workspaceId}`}, 0)
      )
    `);
    const publishing = await beginCardGenerationPublish(tx, {
      runId: input.runId,
      workspaceId: lease.workspaceId,
      noteVersionId: input.noteVersionId,
    });
    if (publishing.state === "skip") return publishing;
    await completeCardGenerationRun(tx, {
      run: publishing.run,
      cardId: input.cardId,
    });
    return publishing;
  });
}

/**
 * Project a terminal legacy job failure into the business run after the job's
 * own lease-fenced dead transition succeeded.
 */
export async function markCardGenerationRunNeedsAttention(input: {
  workspaceId: string;
  requestedBy: string | null;
  payload: Record<string, unknown>;
  error: unknown;
  retryable: boolean;
}): Promise<boolean> {
  const runId = generationRunIdFromPayload(input.payload);
  if (!runId) return false;
  const errorCode = generationRunErrorCode(input.error);

  return withWorkerWorkspaceTransaction(
    { workspaceId: input.workspaceId, userId: input.requestedBy },
    async (tx) => {
      const [run] = await tx
        .select({
          id: schema.cardGenerationRuns.id,
          workspaceId: schema.cardGenerationRuns.workspaceId,
          status: schema.cardGenerationRuns.status,
          stateVersion: schema.cardGenerationRuns.stateVersion,
          nextEventSequence: schema.cardGenerationRuns.nextEventSequence,
        })
        .from(schema.cardGenerationRuns)
        .where(and(
          eq(schema.cardGenerationRuns.id, runId),
          eq(schema.cardGenerationRuns.workspaceId, input.workspaceId),
        ))
        .for("update");
      if (!run || TERMINAL_RUN_STATUSES.has(run.status)) return false;

      const now = new Date();
      const [updated] = await tx
        .update(schema.cardGenerationRuns)
        .set({
          status: "needs_attention",
          stage: "legacy_generate",
          stateVersion: sql`${schema.cardGenerationRuns.stateVersion} + 1`,
          nextEventSequence: sql`${schema.cardGenerationRuns.nextEventSequence} + 1`,
          errorCode,
          retryable: input.retryable,
          updatedAt: now,
          finishedAt: now,
        })
        .where(and(
          eq(schema.cardGenerationRuns.id, run.id),
          eq(schema.cardGenerationRuns.workspaceId, run.workspaceId),
          eq(schema.cardGenerationRuns.stateVersion, run.stateVersion),
        ))
        .returning({ id: schema.cardGenerationRuns.id });
      if (!updated) return false;

      await appendGenerationRunEvent(tx, {
        runId: run.id,
        workspaceId: run.workspaceId,
        sequence: Number(run.nextEventSequence),
        stage: "legacy_generate",
        state: "needs_attention",
        completed: 0,
        total: 1,
        unit: "legacy_job",
        messageCode: errorCode,
        safeDetails: { retryable: input.retryable },
        createdAt: now,
      });
      return true;
    },
  );
}
