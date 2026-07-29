import assert from "node:assert/strict";
import { after, test } from "node:test";
import { db } from "../db/client.ts";
import {
  cardGenerationEvents,
  cardGenerationRuns,
  cardGenerationUnits,
} from "../db/schema/card-generation.ts";
import { jobs } from "../db/schema/job.ts";
import {
  notes,
  noteVersions,
} from "../db/schema/note.ts";
import { createCardGenerationRun } from "../modules/card-generation/service.ts";

const WORKSPACE_ID = "90000000-0000-4000-8000-000000000001";
const USER_ID = "90000000-0000-4000-8000-000000000002";
const NOTE_ID = "90000000-0000-4000-8000-000000000003";
const VERSION_ID = "90000000-0000-4000-8000-000000000004";
const RUN_ID = "90000000-0000-4000-8000-000000000005";
const UNIT_ID = "90000000-0000-4000-8000-000000000006";
const JOB_ID = "90000000-0000-4000-8000-000000000007";
const IMAGE_ASSET_ID = "90000000-0000-4000-8000-000000000008";

const mutableDb = db as any;
const originalTransaction = mutableDb.transaction;

after(() => {
  mutableDb.transaction = originalTransaction;
});

type CreatedProjection = {
  run: Record<string, any>;
  units: Array<Record<string, any>>;
  jobs: Array<Record<string, any>>;
  events: Array<Record<string, any>>;
};

async function createWithFlag(
  flag: string | undefined,
  includeImage: boolean,
): Promise<CreatedProjection> {
  const previousFlag = process.env.CARD_GENERATION_V2_ENABLED;
  if (flag === undefined) delete process.env.CARD_GENERATION_V2_ENABLED;
  else process.env.CARD_GENERATION_V2_ENABLED = flag;

  const created: CreatedProjection = {
    run: {},
    units: [],
    jobs: [],
    events: [],
  };
  const now = new Date("2026-07-26T00:00:00.000Z");
  const note = {
    id: NOTE_ID,
    workspaceId: WORKSPACE_ID,
    title: includeImage ? "Multimodal default" : "Text default",
    cardGenerationEpoch: 0,
    latestGenerationRunId: null,
    deletedAt: null,
  };
  const version = {
    id: VERSION_ID,
    noteId: NOTE_ID,
    workspaceId: WORKSPACE_ID,
    versionNo: 1,
    contentHash: includeImage ? "multimodal-content" : "text-content",
    sealedAt: now,
  };
  const blocks = [
    {
      id: "90000000-0000-4000-8000-000000000010",
      versionId: VERSION_ID,
      workspaceId: WORKSPACE_ID,
      ordinal: 0,
      type: "paragraph",
      content: "Every source character reaches the v2 planner.",
      imageAssetId: null,
    },
    ...(includeImage
      ? [{
          id: "90000000-0000-4000-8000-000000000011",
          versionId: VERSION_ID,
          workspaceId: WORKSPACE_ID,
          ordinal: 1,
          type: "image",
          content: "![architecture](asset://diagram)",
          imageAssetId: IMAGE_ASSET_ID,
        }]
      : []),
  ];

  const transaction = {
    execute: async () => [{
      workspace_id: WORKSPACE_ID,
      user_id: USER_ID,
    }],
    query: {
      cardGenerationRuns: {
        findFirst: async () => undefined,
      },
      noteVersions: {
        findFirst: async () => ({ id: VERSION_ID, noteId: NOTE_ID }),
      },
      noteBlocks: {
        findMany: async () => blocks,
      },
      noteImageAssets: {
        findMany: async () => includeImage
          ? [{
              id: IMAGE_ASSET_ID,
              workspaceId: WORKSPACE_ID,
              sha256: "a".repeat(64),
              status: "ready",
              deletedAt: null,
            }]
          : [],
      },
    },
    select: () => ({
      from: (table: unknown) => {
        if (table === notes) {
          return { where: () => ({ for: async () => [note] }) };
        }
        if (table === noteVersions) {
          return { where: () => ({ for: async () => [version] }) };
        }
        if (table === jobs) {
          return { where: async () => [{ count: 0 }] };
        }
        throw new Error("unexpected select table in M6 generation test");
      },
    }),
    insert: (table: unknown) => ({
      values: (value: Record<string, any>) => {
        if (table === cardGenerationRuns) {
          created.run = value;
          return {
            returning: async () => [{
              ...value,
              id: RUN_ID,
              createdAt: now,
              updatedAt: now,
            }],
          };
        }
        if (table === cardGenerationUnits) {
          created.units.push(value);
          return {
            returning: async () => [{
              ...value,
              id: UNIT_ID,
              createdAt: now,
              updatedAt: now,
            }],
          };
        }
        if (table === jobs) {
          created.jobs.push(value);
          return {
            returning: async () => [{
              ...value,
              id: JOB_ID,
              createdAt: now,
              updatedAt: now,
            }],
          };
        }
        if (table === cardGenerationEvents) {
          created.events.push(value);
          return {};
        }
        throw new Error("unexpected insert table in M6 generation test");
      },
    }),
    update: () => ({
      set: () => ({
        where: async () => [],
      }),
    }),
  };

  mutableDb.transaction = async (
    operation: (tx: typeof transaction) => Promise<unknown>,
  ) => operation(transaction);

  try {
    await createCardGenerationRun(
      { workspaceId: WORKSPACE_ID, userId: USER_ID },
      {
        noteVersionId: VERSION_ID,
        idempotencyKey: includeImage ? "m6-default-multimodal" : `m6-${flag ?? "default"}-text`,
      },
    );
    return created;
  } finally {
    mutableDb.transaction = originalTransaction;
    if (previousFlag === undefined) delete process.env.CARD_GENERATION_V2_ENABLED;
    else process.env.CARD_GENERATION_V2_ENABLED = previousFlag;
  }
}

test("unset CARD_GENERATION_V2_ENABLED creates the text-v2 planner path", async () => {
  const created = await createWithFlag(undefined, false);

  assert.equal(created.run.providerSnapshot.executionMode, "text_v2");
  assert.equal(created.run.pipelineVersion, "card-generation-v2-m5");
  assert.equal(created.run.promptBundleVersion, "map-candidate-v1+deck-plan-v1");
  assert.deepEqual(created.units.map((unit) => unit.kind), ["planner"]);
  assert.deepEqual(created.jobs.map((job) => job.type), ["plan_card_generation"]);
  assert.equal(
    created.jobs.some((job) => job.type === "generate_card" || job.type === "align_evidence"),
    false,
  );
});

test("unset CARD_GENERATION_V2_ENABLED creates the multimodal-v2 planner path", async () => {
  const created = await createWithFlag(undefined, true);

  assert.equal(created.run.providerSnapshot.executionMode, "multimodal_v2");
  assert.equal(created.run.pipelineVersion, "card-generation-v2-m5");
  assert.equal(
    created.run.promptBundleVersion,
    "map-candidate-v1+image-understanding-v1+deck-plan-v1",
  );
  assert.deepEqual(created.units.map((unit) => unit.kind), ["planner"]);
  assert.deepEqual(created.jobs.map((job) => job.type), ["plan_card_generation"]);
  assert.equal(
    created.jobs.some((job) => job.type === "generate_card" || job.type === "align_evidence"),
    false,
  );
});

test("explicit false keeps legacy_bridge as the rollback path", async () => {
  const created = await createWithFlag("false", false);

  assert.equal(created.run.providerSnapshot.executionMode, "legacy_bridge");
  assert.equal(created.run.pipelineVersion, "card-generation-v2-m1");
  assert.equal(created.run.promptBundleVersion, "legacy-card-v1");
  assert.deepEqual(created.units, []);
  assert.deepEqual(created.jobs.map((job) => job.type), ["generate_card"]);
  assert.equal(created.jobs.some((job) => job.type === "align_evidence"), false);
});
