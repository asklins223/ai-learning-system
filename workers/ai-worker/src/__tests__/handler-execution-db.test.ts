import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { db } from "../db.ts";
import {
  runAlignEvidence,
  runEvaluateValidation,
  type JobPayload,
} from "../handlers/index.ts";
import { runParseSource } from "../handlers/parse-source.ts";
import * as schema from "../schema/index.ts";

const WORKSPACE_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const USER_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const JOB_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const LEASE_TOKEN = "lease-token-handler-execution";

type ScenarioName = "generate" | "align" | "evaluate" | "parse";

type SourceFixture = {
  id: string;
  workspaceId: string;
  title: string;
  type: "text" | "markdown" | "code" | "url";
  origin: string | null;
  status: string;
  metadata: Record<string, unknown> | null;
};

type WriteRecord = {
  operation: "insert" | "update" | "delete";
  table: unknown;
  values?: unknown;
};

const original = {
  transaction: db.transaction,
  select: db.select,
  execute: db.execute,
  learningCardsFindFirst: db.query.learningCards.findFirst,
  noteBlocksFindMany: db.query.noteBlocks.findMany,
workspacesFindFirst: db.query.workspaces.findFirst,
cardKeyPointsFindFirst: db.query.cardKeyPoints.findFirst,
  evidencesFindFirst: db.query.evidences.findFirst,
  validationEventsFindFirst: db.query.validationEvents.findFirst,
  sourcesFindFirst: db.query.sources.findFirst,
};

let scenario: ScenarioName = "generate";
let sourceFixture: SourceFixture;
let writes: WriteRecord[] = [];
let workerMain: typeof import("../index.ts").main;
let processClaimedJob: typeof import("../index.ts").processJob;
const previousAutostart = process.env.WORKER_DISABLE_AUTOSTART;
const previousNodeEnv = process.env.NODE_ENV;

const baseJob = (payload: Record<string, unknown>): JobPayload => ({
  id: JOB_ID,
  workspaceId: WORKSPACE_ID,
  requestedBy: USER_ID,
  payload,
  leaseToken: LEASE_TOKEN,
});

function chain<T>(value: T): any {
  const promise = Promise.resolve(value);
  const result: any = {
    innerJoin: () => result,
    leftJoin: () => result,
    where: () => result,
    orderBy: () => result,
    limit: () => result,
    for: () => result,
    returning: () => result,
    onConflictDoUpdate: () => result,
    onConflictDoNothing: () => result,
    then: promise.then.bind(promise),
    catch: promise.catch.bind(promise),
    finally: promise.finally.bind(promise),
  };
  return result;
}

function transactionSelectRows(table: unknown, fields: Record<string, unknown> | undefined): unknown[] {
  if (table === schema.jobs) {
    if (fields && "count" in fields) return [{ count: 0 }];
    return [{ id: JOB_ID }];
  }
  if (table === schema.learningCards) {
    return scenario === "generate"
      ? [{
          card: {
            id: "old-card",
            noteVersionId: "old-version",
            workspaceId: WORKSPACE_ID,
            status: "active",
          },
        }]
      : [];
  }
  if (table === schema.evidences) {
    return scenario === "align"
      ? [{
          id: "old-evidence",
          workspaceId: WORKSPACE_ID,
          keyPointId: "key-point-1",
          blockId: "block-1",
          quoteText: "牛顿第一定律说明惯性",
          userOverride: "confirmed",
        }]
      : [];
  }
  if (table === schema.evidenceOverrides) {
    return scenario === "align"
      ? [{ evidenceId: "old-evidence", userId: USER_ID, override: "confirmed" }]
      : [];
  }
  if (table === schema.sources) return [sourceFixture];
  return [];
}

function insertedRows(table: unknown, values: any): unknown[] {
  if (table === schema.aiArtifacts) return [{ id: "artifact-1", ...values }];
  if (table === schema.learningCards) return [{ id: "new-card", ...values }];
  if (table === schema.cardKeyPoints) {
    const rows = (Array.isArray(values) ? values : [values]).map((value, index) => ({
      id: `generated-key-point-${index + 1}`,
      ...value,
    }));
    return rows;
  }
  if (table === schema.evidences) {
    return [{ id: `evidence-${writes.length}`, ...values }];
  }
  if (table === schema.validationEvents) return [{ id: "validation-event-1", ...values }];
  return [{ id: `row-${writes.length}`, ...values }];
}

function createTransaction(): any {
  const tx: any = {
    query: {
      jobs: { findFirst: async () => ({ id: JOB_ID }) },
      learningCards: { findFirst: async () => undefined },
      noteVersions: { findFirst: async () => undefined },
      validationEvents: { findFirst: async () => undefined },
    },
    execute: async () => [{
      workspace_id: WORKSPACE_ID,
      user_id: USER_ID,
      ok: true,
    }],
    select: (fields?: Record<string, unknown>) => ({
      from: (table: unknown) => chain(transactionSelectRows(table, fields)),
    }),
    insert: (table: unknown) => ({
      values: (values: unknown) => {
        writes.push({ operation: "insert", table, values });
        return chain(insertedRows(table, values));
      },
    }),
    update: (table: unknown) => ({
      set: (values: unknown) => {
        writes.push({ operation: "update", table, values });
        return {
          where: () => chain(
            table === schema.sources ? [sourceFixture] : [],
          ),
        };
      },
    }),
    delete: (table: unknown) => ({
      where: () => {
        writes.push({ operation: "delete", table });
        return chain([]);
      },
    }),
  };
  return tx;
}

function installDatabaseHarness(): void {
  db.transaction = (async (operation: (tx: any) => Promise<unknown>) => (
    operation(createTransaction())
  )) as typeof db.transaction;

  db.select = ((fields?: Record<string, unknown>) => ({
    from: () => chain(scenario === "generate"
      ? [{
          version: {
            id: "note-version-1",
            noteId: "note-1",
            workspaceId: WORKSPACE_ID,
          },
          note: {
            id: "note-1",
            workspaceId: WORKSPACE_ID,
            title: "牛顿力学",
          },
        }]
      : transactionSelectRows(undefined, fields)),
  })) as unknown as typeof db.select;

  db.execute = (async (query: SQL) => {
    const queryText = new PgDialect().sqlToQuery(query).sql;
    if (queryText.includes("ailearn_reap_stale_jobs")) return [];
    if (queryText.includes("ailearn_claim_jobs")) return [];
    if (queryText.includes("ailearn_finish_job")) return [{ ok: true }];
    if (queryText.includes("ailearn_fail_job")) return [{ status: "pending" }];
    return [{
      id: "evidence-1",
      block_id: "block-1",
      alignment: "aligned",
      alignment_score: 100,
      user_override: null,
      block_content: "重力使物体相互吸引",
    }];
}) as unknown as typeof db.execute;

db.query.workspaces.findFirst = (async () => ({
id: WORKSPACE_ID,
aiDataPolicy: {
sendToExternal: false,
piiDetection: true,
auditLogging: false,
},
    aiConsentVersion: null,
    aiConsentAt: null,
  })) as typeof db.query.workspaces.findFirst;

  db.query.learningCards.findFirst = (async () => {
    if (scenario === "align") {
      return {
        id: "card-1",
        noteVersionId: "note-version-1",
        workspaceId: WORKSPACE_ID,
      };
    }
    if (scenario === "evaluate") {
      return { id: "card-1", workspaceId: WORKSPACE_ID };
    }
    return undefined;
  }) as typeof db.query.learningCards.findFirst;

  db.query.noteBlocks.findMany = (async () => {
    if (scenario === "align") {
      return [
        { id: "block-1", ordinal: 0, type: "paragraph", content: "牛顿第一定律说明惯性" },
        { id: "block-2", ordinal: 1, type: "quote", content: "牛顿第一定律说明惯性" },
        { id: "image-block", ordinal: 2, type: "image", content: "![diagram](https://example.test/diagram.png)" },
      ];
    }
    return [
      { id: "heading", ordinal: 0, type: "heading", content: `# ${"力学标题".repeat(500)}` },
      { id: "paragraph", ordinal: 1, type: "paragraph", content: "惯性描述物体保持原有运动状态的性质。".repeat(300) },
      { id: "list", ordinal: 2, type: "list", content: "质量越大，改变运动状态越困难。".repeat(120) },
      { id: "image-alt", ordinal: 3, type: "image", content: "![惯性示意图](https://example.test/inertia.png)" },
      { id: "image-empty", ordinal: 4, type: "image", content: "![](https://example.test/empty.png)" },
    ];
  }) as typeof db.query.noteBlocks.findMany;

  db.query.cardKeyPoints.findFirst = (async () => ({
    id: "key-point-1",
    cardId: "card-1",
    workspaceId: WORKSPACE_ID,
    claim: "牛顿第一定律说明物体具有惯性",
    quoteText: scenario === "align" ? "牛顿第一定律说明惯性" : "重力使物体相互吸引",
  })) as typeof db.query.cardKeyPoints.findFirst;
  db.query.evidences.findFirst = (async () => (
    scenario === "align" ? { id: "old-evidence" } : undefined
  )) as typeof db.query.evidences.findFirst;
  db.query.validationEvents.findFirst = (async () => undefined) as typeof db.query.validationEvents.findFirst;
  db.query.sources.findFirst = (async () => sourceFixture) as typeof db.query.sources.findFirst;
}

before(async () => {
  process.env.NODE_ENV = "test";
  process.env.WORKER_DISABLE_AUTOSTART = "1";
  const worker = await import("../index.ts");
  workerMain = worker.main;
  processClaimedJob = worker.processJob;
});

beforeEach(() => {
  writes = [];
  sourceFixture = {
    id: "source-1",
    workspaceId: WORKSPACE_ID,
    title: "测试来源",
    type: "markdown",
    origin: "manual",
    status: "pending",
    metadata: {
      rawContent: "# 第一节\n\n惯性描述物体保持运动状态。\n\n- 质量越大越难改变状态",
    },
  };
  installDatabaseHarness();
});

after(() => {
  db.transaction = original.transaction;
  db.select = original.select;
  db.execute = original.execute;
  db.query.learningCards.findFirst = original.learningCardsFindFirst;
  db.query.noteBlocks.findMany = original.noteBlocksFindMany;
db.query.workspaces.findFirst = original.workspacesFindFirst;
db.query.cardKeyPoints.findFirst = original.cardKeyPointsFindFirst;
  db.query.evidences.findFirst = original.evidencesFindFirst;
  db.query.validationEvents.findFirst = original.validationEventsFindFirst;
  db.query.sources.findFirst = original.sourcesFindFirst;
  if (previousAutostart === undefined) delete process.env.WORKER_DISABLE_AUTOSTART;
  else process.env.WORKER_DISABLE_AUTOSTART = previousAutostart;
  if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = previousNodeEnv;
});

describe("worker handlers execute their real database workflows", () => {
  it("force-realigns evidence while restoring legacy and per-user overrides", async () => {
    scenario = "align";
    await runAlignEvidence(baseJob({ keyPointId: "key-point-1", force: true }));

    const evidenceInserts = writes.filter(
      (write) => write.operation === "insert" && write.table === schema.evidences,
    );
    assert.equal(evidenceInserts.length, 2);
    assert.ok(writes.some((write) => write.operation === "insert" && write.table === schema.evidenceOverrides));
    assert.ok(writes.some((write) => write.operation === "delete" && write.table === schema.evidences));
  });

  it("evaluates an answer and persists the complete review workflow", async () => {
    scenario = "evaluate";
    await runEvaluateValidation(baseJob({
      cardId: "card-1",
      keyPointId: "key-point-1",
      questionId: "question-1",
      questionType: "free_text",
      question: "重力有什么作用？",
      userAnswer: "重力使物体相互吸引",
    }));

    assert.ok(writes.some((write) => write.operation === "insert" && write.table === schema.aiArtifacts));
    assert.ok(writes.some((write) => write.operation === "insert" && write.table === schema.validationEvents));
    assert.ok(writes.some((write) => write.operation === "insert" && write.table === schema.understandingEvents));
    assert.ok(writes.some((write) => write.operation === "insert" && write.table === schema.reviewSchedules));
  });

  it("parses content and atomically writes segments, ready state, and search projection", async () => {
    scenario = "parse";
    await runParseSource(baseJob({ sourceId: "source-1" }));

    assert.ok(writes.some((write) => write.operation === "insert" && write.table === schema.sourceSegments));
    assert.ok(writes.some((write) => write.operation === "insert" && write.table === schema.searchDocuments));
    assert.ok(writes.some((write) => (
      write.operation === "update"
      && write.table === schema.sources
      && (write.values as { status?: string }).status === "ready"
    )));
  });

  it("marks a private-URL fetch failure and writes a diagnostic search projection", async () => {
    scenario = "parse";
    sourceFixture = {
      ...sourceFixture,
      type: "url",
      origin: "http://127.0.0.1/private",
      metadata: { url: "http://127.0.0.1/private" },
    };

    await assert.rejects(
      runParseSource(baseJob({ sourceId: "source-1", fetchUrlContent: true })),
      /URL fetch failed: blocked: private\/internal host/,
    );
    assert.ok(writes.some((write) => (
      write.operation === "update"
      && write.table === schema.sources
      && (write.values as { status?: string }).status === "failed"
    )));
    assert.ok(writes.some((write) => write.operation === "insert" && write.table === schema.searchDocuments));
  });

  it("commits an empty source as ready with a needs-fetch projection", async () => {
    scenario = "parse";
    sourceFixture = {
      ...sourceFixture,
      origin: "https://example.test/article",
      metadata: {},
    };

    await runParseSource(baseJob({ sourceId: "source-1" }));
    const projection = writes.find(
      (write) => write.operation === "insert" && write.table === schema.searchDocuments,
    );
    assert.ok(projection);
    assert.equal(
      (projection.values as { metadata: { needsContentFetch?: boolean } }).metadata.needsContentFetch,
      true,
    );
  });

  it("runs claimed jobs through success, retryable failure, and unknown-type transitions", async () => {
    scenario = "parse";
    const claimedJob = {
      ...baseJob({ sourceId: "source-1" }),
      type: "parse_source",
      attempts: 0,
    };

    await processClaimedJob(claimedJob);
    await processClaimedJob({
      ...claimedJob,
      id: "dddddddd-dddd-dddd-dddd-dddddddddddd",
      payload: {},
    });
    await processClaimedJob({
      ...claimedJob,
      id: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee",
      type: "future_job_type",
    });

    assert.ok(writes.some((write) => write.operation === "insert" && write.table === schema.sourceSegments));
  });

  it("starts metrics and closes cleanly after a shutdown signal", async () => {
    const previousPort = process.env.WORKER_METRICS_PORT;
    process.env.WORKER_METRICS_PORT = "0";
    try {
      process.emit("SIGTERM");
      await workerMain();
    } finally {
      if (previousPort === undefined) delete process.env.WORKER_METRICS_PORT;
      else process.env.WORKER_METRICS_PORT = previousPort;
    }
  });
});
