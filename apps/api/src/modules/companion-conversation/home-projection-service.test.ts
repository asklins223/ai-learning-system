import assert from "node:assert/strict";
import test from "node:test";
import type { CompanionRoomProfileV1 } from "@ailearn/shared/companion-home-contracts";
import type { ApiTransaction } from "../../db/client.ts";
import {
  deriveMilestoneUnlocks,
  getCompanionHomeProjection,
  getCompanionRoomProfile,
  patchCompanionRoomProfile,
  validateRoomEquipmentPatch,
} from "./home-projection-service.ts";

const current: CompanionRoomProfileV1 = {
  version: 1,
  revision: 3,
  unlockedDecorIds: ["keepsake.first-note", "keepsake.first-review"],
  equippedDecorBySlot: { desk: null, shelf: null, window: null, rest: null },
  unlockedEffectIds: ["effect.page-ribbon", "effect.ink-ripple"],
  equippedEffectId: null,
  proactiveMuted: false,
  updatedAt: "2026-09-10T00:00:00.000Z",
};

test("server milestones unlock only confirmed room resources", () => {
  assert.deepEqual(deriveMilestoneUnlocks({
    hasSavedNote: true,
    hasActiveGoal: false,
    hasCompletedReview: true,
    hasConfirmedMemory: false,
  }), {
    decorIds: ["keepsake.first-note", "keepsake.first-review"],
    effectIds: ["effect.page-ribbon", "effect.ink-ripple"],
  });
});

test("all canonical milestones map to the complete bounded unlock set", () => {
  assert.deepEqual(deriveMilestoneUnlocks({
    hasSavedNote: true,
    hasActiveGoal: true,
    hasCompletedReview: true,
    hasConfirmedMemory: true,
  }), {
    decorIds: [
      "keepsake.first-note",
      "keepsake.first-goal",
      "keepsake.first-review",
      "keepsake.first-memory",
    ],
    effectIds: ["effect.page-ribbon", "effect.ink-ripple"],
  });
});

test("room equipment accepts unlocked resources in legal slots", () => {
  assert.deepEqual(validateRoomEquipmentPatch(current, {
    version: 1,
    revision: 3,
    equippedDecorBySlot: { shelf: "keepsake.first-note", rest: "keepsake.first-review" },
    equippedEffectId: "effect.ink-ripple",
  }), {
    ok: true,
    equippedDecorBySlot: {
      desk: null,
      shelf: "keepsake.first-note",
      window: null,
      rest: "keepsake.first-review",
    },
    equippedEffectId: "effect.ink-ripple",
  });
});

test("room equipment rejects locked, misplaced, and duplicate resources", () => {
  assert.equal(validateRoomEquipmentPatch(current, {
    version: 1,
    revision: 3,
    equippedDecorBySlot: { window: "keepsake.first-note" },
  }).ok, false);
  assert.deepEqual(validateRoomEquipmentPatch(current, {
    version: 1,
    revision: 3,
    equippedDecorBySlot: { desk: "keepsake.first-note", shelf: "keepsake.first-note" },
  }), {
    ok: false,
    reason: "decor_duplicate",
    resourceId: "keepsake.first-note",
    slot: "shelf",
  });
  assert.deepEqual(validateRoomEquipmentPatch(current, {
    version: 1,
    revision: 3,
    equippedDecorBySlot: { rest: "keepsake.first-memory" },
  }), {
    ok: false,
    reason: "decor_locked",
    resourceId: "keepsake.first-memory",
    slot: "rest",
  });
  assert.deepEqual(validateRoomEquipmentPatch({
    ...current,
    unlockedEffectIds: [],
  }, {
    version: 1,
    revision: 3,
    equippedEffectId: "effect.page-ribbon",
  }), {
    ok: false,
    reason: "effect_locked",
    resourceId: "effect.page-ribbon",
  });
});

type FakeRoomProfileRow = {
  id: string;
  workspaceId: string;
  userId: string;
  revision: number;
  unlockedDecorIds: CompanionRoomProfileV1["unlockedDecorIds"];
  equippedDecorBySlot: CompanionRoomProfileV1["equippedDecorBySlot"];
  unlockedEffectIds: CompanionRoomProfileV1["unlockedEffectIds"];
  equippedEffectId: CompanionRoomProfileV1["equippedEffectId"];
  /** 0266：空间级打扰开关。mock 行也要带它，否则 toRoomProfile 的 strictObject 解析失败。 */
  proactiveMuted: boolean;
  createdAt: Date;
  updatedAt: Date;
};

type FakeExecutorOptions = {
  readonly milestones?: Partial<Record<"notes" | "learning_objectives_v2" | "learning_runs" | "assistant_memory_items", boolean>>;
  readonly initialProfile?: FakeRoomProfileRow | null;
  readonly profileReads?: FakeRoomProfileRow[];
  readonly petProfile?: Record<string, unknown> | null;
  readonly memorySummary?: { confirmedCount: number; candidateCount: number; updatedAt: Date | null };
  readonly proactiveDeliveries?: Array<Record<string, unknown>>;
  readonly failProfileUpdate?: boolean;
};

function tableName(table: unknown): string | undefined {
  return (table as Record<symbol, unknown>)?.[Symbol.for("drizzle:Name")] as string | undefined;
}

function queryChain(rows: unknown[]) {
  const promise = Promise.resolve(rows);
  const chain = {
    then: promise.then.bind(promise),
    catch: promise.catch.bind(promise),
    finally: promise.finally.bind(promise),
    limit: async (count: number) => rows.slice(0, count),
    orderBy: () => chain,
  };
  return chain;
}

function fakeExecutor(options: FakeExecutorOptions = {}) {
  const now = new Date("2026-09-10T08:00:00.000Z");
  let profile = options.initialProfile ?? null;
  const profileReads = [...(options.profileReads ?? [])];
  const inserted: Array<Record<string, unknown>> = [];
  const updated: Array<Record<string, unknown>> = [];

  const executor = {
    select: (columns?: Record<string, unknown>) => ({
      from: (table: unknown) => ({
        where: () => {
          const name = tableName(table);
          if (name === "companion_room_profiles") {
            const next = profileReads.length > 0 ? profileReads.shift()! : profile;
            return queryChain(next ? [next] : []);
          }
          if (name === "pet_profiles") return queryChain(options.petProfile ? [options.petProfile] : []);
          if (name === "assistant_deliveries") return queryChain(options.proactiveDeliveries ?? []);
          if (name === "assistant_memory_items" && columns && "confirmedCount" in columns) {
            return queryChain([options.memorySummary ?? {
              confirmedCount: 0,
              candidateCount: 0,
              updatedAt: null,
            }]);
          }
          const present = Boolean(options.milestones?.[name as keyof NonNullable<FakeExecutorOptions["milestones"]>]);
          return queryChain(present ? [{ id: `${name}-milestone` }] : []);
        },
      }),
    }),
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>) => {
        inserted.push(values);
        const chain = {
          onConflictDoNothing: () => chain,
          returning: async () => {
            if (tableName(table) !== "companion_room_profiles") return [];
            profile = {
              id: "room-profile-row",
              workspaceId: String(values.workspaceId),
              userId: String(values.userId),
              revision: 1,
              unlockedDecorIds: values.unlockedDecorIds as FakeRoomProfileRow["unlockedDecorIds"],
              equippedDecorBySlot: values.equippedDecorBySlot as FakeRoomProfileRow["equippedDecorBySlot"],
              unlockedEffectIds: values.unlockedEffectIds as FakeRoomProfileRow["unlockedEffectIds"],
              equippedEffectId: values.equippedEffectId as FakeRoomProfileRow["equippedEffectId"],
              proactiveMuted: (values.proactiveMuted as boolean | undefined) ?? false,
              createdAt: values.createdAt as Date,
              updatedAt: values.updatedAt as Date,
            };
            return [profile];
          },
        };
        return chain;
      },
    }),
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => {
        updated.push(values);
        return {
          where: () => ({
            returning: async () => {
              if (options.failProfileUpdate || tableName(table) !== "companion_room_profiles" || !profile) return [];
              profile = { ...profile, ...values } as FakeRoomProfileRow;
              return [profile];
            },
          }),
        };
      },
    }),
  } as unknown as ApiTransaction;

  return { executor, inserted, updated, getProfile: () => profile, now };
}

const scope = {
  workspaceId: "11111111-1111-4111-8111-111111111111",
  userId: "22222222-2222-4222-8222-222222222222",
};

function profileRow(overrides: Partial<FakeRoomProfileRow> = {}): FakeRoomProfileRow {
  const timestamp = new Date("2026-09-10T07:00:00.000Z");
  return {
    id: "room-profile-row",
    ...scope,
    revision: 3,
    unlockedDecorIds: ["keepsake.first-note"],
    equippedDecorBySlot: { desk: null, shelf: null, window: null, rest: null },
    unlockedEffectIds: ["effect.page-ribbon"],
    equippedEffectId: null,
    proactiveMuted: false,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  };
}

test("first room-profile read creates the bounded default from canonical milestones", async () => {
  const fake = fakeExecutor({
    milestones: { notes: true, learning_runs: true },
  });
  const profile = await getCompanionRoomProfile(fake.executor, scope, fake.now);

  assert.equal(profile.revision, 1);
  assert.deepEqual(profile.unlockedDecorIds, ["keepsake.first-note", "keepsake.first-review"]);
  assert.deepEqual(profile.unlockedEffectIds, ["effect.page-ribbon", "effect.ink-ripple"]);
  assert.deepEqual(profile.equippedDecorBySlot, {
    desk: null,
    shelf: null,
    window: null,
    rest: null,
  });
  assert.equal(fake.inserted.length, 1);
});

test("milestone reconciliation is monotonic and advances revision only for new unlocks", async () => {
  const existing = profileRow({
    unlockedDecorIds: ["keepsake.first-note", "keepsake.first-memory"],
  });
  const fake = fakeExecutor({
    initialProfile: existing,
    milestones: { notes: true, learning_runs: true },
  });
  const profile = await getCompanionRoomProfile(fake.executor, scope, fake.now);

  assert.equal(profile.revision, 4);
  assert.deepEqual(profile.unlockedDecorIds, [
    "keepsake.first-note",
    "keepsake.first-review",
    "keepsake.first-memory",
  ]);
  assert.deepEqual(profile.unlockedEffectIds, ["effect.page-ribbon", "effect.ink-ripple"]);
  assert.equal(fake.updated.length, 1);
});

test("room-profile patch rejects a stale revision before attempting equipment update", async () => {
  const fake = fakeExecutor({ initialProfile: profileRow() });
  const result = await patchCompanionRoomProfile(fake.executor, scope, {
    version: 1,
    revision: 2,
    equippedDecorBySlot: { desk: "keepsake.first-note" },
  }, fake.now);

  assert.deepEqual(result, { ok: false, reason: "revision_conflict", currentRevision: 3 });
  assert.equal(fake.updated.length, 0);
});

test("room-profile patch reports a CAS race and never returns the attempted equipment", async () => {
  const latest = profileRow({ revision: 4 });
  const fake = fakeExecutor({
    initialProfile: profileRow(),
    profileReads: [profileRow(), latest],
    failProfileUpdate: true,
  });
  const result = await patchCompanionRoomProfile(fake.executor, scope, {
    version: 1,
    revision: 3,
    equippedDecorBySlot: { desk: "keepsake.first-note" },
  }, fake.now);

  assert.deepEqual(result, { ok: false, reason: "revision_conflict", currentRevision: 4 });
});

test("home projection uses the safe system profile and exposes only aggregate memory", async () => {
  const fake = fakeExecutor({
    initialProfile: profileRow(),
    memorySummary: {
      confirmedCount: 4,
      candidateCount: 2,
      updatedAt: new Date("2026-09-10T07:30:00.000Z"),
    },
    proactiveDeliveries: [{
      payloadRef: { text: "  今天可以复习一小组卡片。  ", privateMemory: "never return" },
      expiresAt: new Date("2026-09-10T09:00:00.000Z"),
      inboxSequence: 8,
    }],
  });
  const projection = await getCompanionHomeProjection(fake.executor, scope, fake.now);

  assert.equal(projection.profileSummary.source, "system_default");
  assert.equal(projection.profileSummary.activeness, "moderate");
  assert.deepEqual(projection.memorySummary, {
    confirmedCount: 4,
    candidateCount: 2,
    updatedAt: "2026-09-10T07:30:00.000Z",
  });
  assert.deepEqual(projection.proactiveCue, {
    text: "今天可以复习一小组卡片。",
    expiresAt: "2026-09-10T09:00:00.000Z",
    revision: 8,
    origin: "system",
  });
  assert.equal("privateMemory" in projection, false);
  assert.equal("rawMemories" in projection.memorySummary, false);
  assert.doesNotMatch(JSON.stringify(projection), /never return|privateMemory|rawMemories/);
});

test("proactive cue origin：念头可点开、到点提醒是承诺、其余算系统事件", async () => {
  const uuid = "11111111-1111-1111-1111-111111111111";
  const cases: [string, Record<string, unknown>, Record<string, unknown>][] = [
    ["thought", { kind: "system_event", systemEventId: `thought:${uuid}`, text: "想起你昨天那道题。" },
      { text: "想起你昨天那道题。", origin: "thought", thoughtId: uuid }],
    ["reminder", { kind: "system_event", systemEventId: `reminder:${uuid}`, text: "该去复习了。" },
      { text: "该去复习了。", origin: "reminder" }],
    ["run.completed", { kind: "system_event", systemEventId: `run.completed:${uuid}`, text: "刚学完了。" },
      { text: "刚学完了。", origin: "system" }],
  ];
  for (const [label, payloadRef, expected] of cases) {
    const fake = fakeExecutor({
      initialProfile: profileRow(),
      proactiveDeliveries: [{ payloadRef, expiresAt: new Date("2026-09-10T09:00:00.000Z"), inboxSequence: 3 }],
    });
    const projection = await getCompanionHomeProjection(fake.executor, scope, fake.now);
    assert.deepEqual({ ...(projection.proactiveCue ?? {}) }, {
      expiresAt: "2026-09-10T09:00:00.000Z",
      revision: 3,
      ...expected,
    }, label);
  }
});

test("saved companion profile is projected through an explicit safe field allowlist", async () => {
  const fake = fakeExecutor({
    initialProfile: profileRow(),
    petProfile: {
      name: "星澜",
      activeness: "quiet",
      boundaries: {
        allowPlayful: false,
        allowNudgeLearning: true,
        allowVoiceTags: false,
        catchphrase: null,
      },
      familiarity: 0.6,
      interactionCount: 7,
      rawMemoryBody: "must never cross the home projection boundary",
      privateInstructions: "must never cross the home projection boundary",
    },
  });

  const projection = await getCompanionHomeProjection(fake.executor, scope, fake.now);
  assert.equal(projection.profileSummary.source, "saved_profile");
  assert.equal(projection.profileSummary.name, "星澜");
  assert.doesNotMatch(JSON.stringify(projection), /rawMemoryBody|privateInstructions|must never cross/);
});
