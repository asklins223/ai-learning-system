import { describe, expect, it } from "vitest";
import { learningRunPublicSnapshotV2Schema } from "@ailearn/shared/learning-run-v2-contracts";
import { FormalAssessmentGuard, companionDeliveryKindValues } from "./formal-assessment-guard";

const snapshot = (overrides: Record<string, unknown> = {}) => learningRunPublicSnapshotV2Schema.parse({
  version: 2,
  runId: "00000000-0000-4000-8000-000000000001",
  snapshotId: "00000000-0000-4000-8000-000000000002",
  originV2: { kind: "card", cardId: "00000000-0000-4000-8000-000000000003", objectiveId: "00000000-0000-4000-8000-000000000004" },
  target: {
    objectiveId: "00000000-0000-4000-8000-000000000004",
    objectiveRevision: 1,
    cardId: "00000000-0000-4000-8000-000000000003",
    publicationRevision: 1,
    cardRevision: 1,
    publicPayloadHash: "a".repeat(64),
    publicSummary: "Public",
    semanticTargetFingerprint: "b".repeat(64),
    targetRevisionHash: "c".repeat(64),
  },
  returnTargetV2: { kind: "card", cardId: "00000000-0000-4000-8000-000000000003", objectiveId: "00000000-0000-4000-8000-000000000004" },
  phase: "active",
  runRevision: 1,
  runtimeEpoch: 1,
  activeSecondsUsed: 0,
  timeBudgetSeconds: 180,
  activeTask: null,
  allowedActions: [{ version: 2, kind: "end", abandonLockedEvidence: false, confirmationRequired: true }],
  publishedTargetEligibility: "eligible",
  ...overrides,
});

describe("FormalAssessmentGuard", () => {
  it("fails closed for unknown/disconnected/epoch mismatch and blocks broker delivery", () => {
    const guard = new FormalAssessmentGuard();
    expect(guard.allowsCompanionDelivery()).toBe(false);
    for (const kind of companionDeliveryKindValues) {
      expect(guard.authorizeCompanionDelivery(kind)).toEqual({ allowed: false, kind, reason: "guard_fail_closed" });
    }
    expect(guard.syncFromSnapshot({ bad: true })).toMatchObject({ state: "fail_closed_silent", reason: "unknown" });
    expect(guard.syncFromSnapshot(snapshot(), false)).toMatchObject({ state: "fail_closed_silent", reason: "disconnected" });
  });

  it("activates before formal task delivery and stays silent through terminal cleanup", () => {
    const guard = new FormalAssessmentGuard();
    expect(guard.syncFromSnapshot(snapshot({
      activeTask: {
        version: 1,
        taskId: "00000000-0000-4000-8000-000000000005",
        runId: "00000000-0000-4000-8000-000000000001",
        sequence: 1,
        intent: "explain",
        prompt: "Public prompt",
        targetSummary: "Public target",
        activeVariant: {
          variantId: "variant-1",
          purpose: "formal",
          interaction: { kind: "text_response", maxChars: 100 },
          templateTrustCeiling: "mastery_eligible",
          estimatedActiveSeconds: 30,
          publicPayloadHash: "a".repeat(64),
          inputSchemaHash: "b".repeat(64),
          disclosureProfileHash: "c".repeat(64),
          revision: 1,
        },
        availableAlternatives: [],
        assistancePolicy: { hintLevels: 1, exposureLowersTrust: true },
        status: "active",
        revision: 1,
      },
    }))).toMatchObject({ state: "active", reason: "assessment_active" });
    expect(guard.allowsCompanionDelivery()).toBe(false);
    for (const kind of companionDeliveryKindValues) {
      expect(guard.authorizeCompanionDelivery(kind)).toEqual({ allowed: false, kind, reason: "formal_assessment_silence" });
    }
    expect(guard.syncFromSnapshot(snapshot({ phase: "ended" }))).toMatchObject({ state: "releasing" });
    expect(guard.completeRelease({ runId: "00000000-0000-4000-8000-000000000001", runtimeEpoch: 1 }, true)).toMatchObject({ state: "inactive", reason: "cleared" });
    expect(guard.allowsCompanionDelivery()).toBe(true);
    for (const kind of companionDeliveryKindValues) {
      expect(guard.authorizeCompanionDelivery(kind)).toEqual({ allowed: true, kind });
    }
  });

  it("rejects sensitivity, key and terminal-proof drift without opening the broker", () => {
    const guard = new FormalAssessmentGuard();
    const key = { runId: "00000000-0000-4000-8000-000000000010", runtimeEpoch: 3 };
    const otherKey = { runId: "00000000-0000-4000-8000-000000000011", runtimeEpoch: 3 };

    expect(guard.arm(key, false)).toMatchObject({ state: "fail_closed_silent", reason: "sensitivity_missing" });
    expect(guard.arm(key, true)).toMatchObject({ state: "armed", reason: "awaiting_activation" });
    expect(guard.activate(otherKey)).toMatchObject({ state: "fail_closed_silent", reason: "stale" });
    expect(guard.allowsCompanionDelivery()).toBe(false);

    expect(guard.arm(key, true)).toMatchObject({ state: "armed" });
    expect(guard.activate(key)).toMatchObject({ state: "active", reason: "assessment_active" });
    expect(guard.beginRelease(key, false)).toMatchObject({ state: "fail_closed_silent", reason: "stale" });
    expect(guard.allowsCompanionDelivery()).toBe(false);

    expect(guard.syncFromSnapshot(snapshot({ runId: key.runId, runtimeEpoch: 2 }))).toMatchObject({
      state: "fail_closed_silent",
      reason: "epoch_mismatch",
    });
    expect(guard.syncFromSnapshot(snapshot({ runId: otherKey.runId }))).toMatchObject({
      state: "fail_closed_silent",
      reason: "stale",
    });
  });
});
