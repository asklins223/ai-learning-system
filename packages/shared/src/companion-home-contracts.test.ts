import assert from "node:assert/strict";
import test from "node:test";
import {
  companionHomeProjectionV1Schema,
  companionRoomProfilePatchV1Schema,
  companionRoomProfileV1Schema,
} from "./companion-home-contracts.ts";

const roomProfile = {
  version: 1 as const,
  revision: 3,
  unlockedDecorIds: ["keepsake.first-note" as const],
  equippedDecorBySlot: {
    desk: "keepsake.first-note" as const,
    shelf: null,
    window: null,
    rest: null,
  },
  // 装备只决定完成/交接后的短暂反馈；稳定画面不会持续渲染粒子。
  unlockedEffectIds: ["effect.page-ribbon" as const],
  equippedEffectId: "effect.page-ribbon" as const,
  updatedAt: "2026-09-09T10:00:00.000Z",
};

test("CompanionRoomProfileV1 accepts the bounded equipment model", () => {
  assert.deepEqual(companionRoomProfileV1Schema.parse(roomProfile), roomProfile);
  assert.throws(() => companionRoomProfileV1Schema.parse({
    ...roomProfile,
    unlockedDecorIds: ["keepsake.first-note", "keepsake.first-note"],
  }));
  assert.throws(() => companionRoomProfileV1Schema.parse({
    ...roomProfile,
    debugItem: true,
  }));
  assert.throws(() => companionRoomProfileV1Schema.parse({
    ...roomProfile,
    unlockedDecorIds: [],
  }));
  assert.throws(() => companionRoomProfileV1Schema.parse({
    ...roomProfile,
    equippedDecorBySlot: {
      ...roomProfile.equippedDecorBySlot,
      desk: null,
      window: "keepsake.first-note",
    },
  }));
  assert.throws(() => companionRoomProfileV1Schema.parse({
    ...roomProfile,
    equippedDecorBySlot: {
      ...roomProfile.equippedDecorBySlot,
      shelf: "keepsake.first-note",
    },
  }));
  assert.throws(() => companionRoomProfileV1Schema.parse({
    ...roomProfile,
    unlockedEffectIds: [],
  }));
});

test("CompanionRoomProfilePatchV1 only carries CAS and equipment choices", () => {
  assert.deepEqual(companionRoomProfilePatchV1Schema.parse({
    version: 1,
    revision: 3,
    equippedDecorBySlot: { desk: null },
  }), {
    version: 1,
    revision: 3,
    equippedDecorBySlot: { desk: null },
  });
  assert.throws(() => companionRoomProfilePatchV1Schema.parse({ version: 1, revision: 3 }));
  assert.throws(() => companionRoomProfilePatchV1Schema.parse({
    version: 1,
    revision: 3,
    equippedDecorBySlot: {},
  }));
  assert.throws(() => companionRoomProfilePatchV1Schema.parse({
    version: 1,
    revision: 3,
    unlockedDecorIds: ["keepsake.first-review"],
  }));
});

test("CompanionHomeProjectionV1 exposes memory counts but no memory body", () => {
  const projection = {
    version: 1 as const,
    snapshotAt: "2026-09-09T10:00:00.000Z",
    profileSummary: {
      name: "学习伴星",
      activeness: "moderate" as const,
      boundaries: {
        allowPlayful: true,
        allowNudgeLearning: true,
        allowVoiceTags: false,
        catchphrase: null,
      },
      familiarity: 0.25,
      interactionCount: 12,
      source: "saved_profile" as const,
    },
    memorySummary: { confirmedCount: 4, candidateCount: 2, updatedAt: null },
    proactiveCue: null,
    roomProfile,
  };
  assert.deepEqual(companionHomeProjectionV1Schema.parse(projection), projection);
  assert.throws(() => companionHomeProjectionV1Schema.parse({
    ...projection,
    memorySummary: { ...projection.memorySummary, rawMemories: ["private"] },
  }));
  assert.throws(() => companionHomeProjectionV1Schema.parse({
    ...projection,
    proactiveCue: {
      text: "过期提醒",
      expiresAt: "2026-09-09T09:59:59.000Z",
      revision: 1,
    },
  }));
  assert.doesNotThrow(() => companionHomeProjectionV1Schema.parse({
    ...projection,
    proactiveCue: {
      text: "仍然有效的提醒",
      expiresAt: "2026-09-09T10:00:01.000Z",
      revision: 1,
    },
  }));
});
