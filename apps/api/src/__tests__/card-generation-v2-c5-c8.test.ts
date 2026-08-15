/**
 * 方案 20 C5/C6/C7/C8: Target Snapshot Adapter + Legacy Read Adapter +
 * Shadow/Cutover + Shutdown/RC 测试。
 *
 * 本测试验证纯逻辑函数的正确性，不依赖数据库。
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  isObjectiveEligibleForRecommendation,
  assertNotCandidate,
  type PublicCardViewV2,
} from "../modules/card-generation-v2/legacy-read-adapter.ts";
import {
  SHADOW_NAMESPACE_PREFIX,
  ShadowActivationError,
} from "../modules/card-generation-v2/shadow-cutover-service.ts";
import {
  planSchemaShrink,
  checkRCReadiness,
  type LegacyWriterShutdownReport,
} from "../modules/card-generation-v2/shutdown-rc-service.ts";

// ─── C6: Legacy Read Adapter 纯逻辑测试 ──────────────────────────────────

describe("C6: Legacy Read Adapter", () => {
  test("isObjectiveEligibleForRecommendation: active is eligible", () => {
    assert.ok(isObjectiveEligibleForRecommendation("active"));
  });

  test("isObjectiveEligibleForRecommendation: archived is not eligible", () => {
    assert.ok(!isObjectiveEligibleForRecommendation("archived"));
  });

  test("isObjectiveEligibleForRecommendation: superseded is not eligible", () => {
    assert.ok(!isObjectiveEligibleForRecommendation("superseded"));
  });

  test("assertNotCandidate: accepts valid cardId and objectiveId", () => {
    assert.doesNotThrow(() => assertNotCandidate("card-123", "obj-456"));
  });

  test("assertNotCandidate: rejects empty IDs", () => {
    assert.throws(() => assertNotCandidate("", "obj-456"), /must be non-empty/);
    assert.throws(() => assertNotCandidate("card-123", ""), /must be non-empty/);
  });

  test("PublicCardViewV2 type structure is correct", () => {
    const view: PublicCardViewV2 = {
      cardId: "c1",
      objectiveId: "o1",
      cardRevision: 1,
      publicationRevision: 1,
      lifecycle: "active",
      front: { cue: "test", prompt: "answer?" },
      publicSummary: "summary",
      knowledgeForm: "fact",
      strategy: "recall",
      sourceLabel: null,
      objectiveRevision: 1,
      objectiveStatement: "statement",
      preferredIntents: ["stabilize"],
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    };
    assert.equal(view.lifecycle, "active");
    assert.equal(view.front.cue, "test");
    assert.equal(view.preferredIntents.length, 1);
  });
});

// ─── C7: Shadow/Cutover 纯逻辑测试 ───────────────────────────────────────

describe("C7: Shadow Namespace", () => {
  test("SHADOW_NAMESPACE_PREFIX is 'shadow-'", () => {
    assert.equal(SHADOW_NAMESPACE_PREFIX, "shadow-");
  });

  test("ShadowActivationError has correct code", () => {
    const error = new ShadowActivationError("shadow_run_cannot_activate", "test message");
    assert.equal(error.code, "shadow_run_cannot_activate");
    assert.equal(error.name, "ShadowActivationError");
    assert.ok(error.message.includes("test message"));
  });
});

// ─── C8: Shutdown/RC 纯逻辑测试 ──────────────────────────────────────────

describe("C8: Schema Shrink Planner", () => {
  test("planSchemaShrink returns steps with correct order", () => {
    const report: LegacyWriterShutdownReport = {
      canShutdown: false,
      totalHitsLast7Days: 5,
      totalHitsLast24Hours: 1,
      byWriterKind: [],
      blockingReasons: ["still has hits"],
      recommendation: "wait",
    };
    const plan = planSchemaShrink(report);
    assert.ok(plan.steps.length >= 6);
    assert.equal(plan.steps[0].step, 1);
    assert.equal(plan.steps[0].action, "archive");
    assert.equal(plan.canExecute, false); // Always false until approved
    assert.ok(plan.blockingIssues.length > 0);
  });

  test("planSchemaShrink marks step 1 as ready when shutdown is ready", () => {
    const report: LegacyWriterShutdownReport = {
      canShutdown: true,
      totalHitsLast7Days: 0,
      totalHitsLast24Hours: 0,
      byWriterKind: [],
      blockingReasons: [],
      recommendation: "proceed",
    };
    const plan = planSchemaShrink(report);
    assert.equal(plan.steps[0].status, "ready");
  });
});

describe("C8: RC Readiness Checker", () => {
  test("checkRCReadiness returns items across all categories", () => {
    const report: LegacyWriterShutdownReport = {
      canShutdown: false,
      totalHitsLast7Days: 5,
      totalHitsLast24Hours: 1,
      byWriterKind: [],
      blockingReasons: ["still has hits"],
      recommendation: "wait",
    };
    const rc = checkRCReadiness(report);
    assert.ok(rc.totalItems >= 20);
    const categories = new Set(rc.items.map((i) => i.category));
    assert.ok(categories.has("product"));
    assert.ok(categories.has("content_quality"));
    assert.ok(categories.has("data"));
    assert.ok(categories.has("integration"));
    assert.ok(categories.has("consumer"));
    assert.ok(categories.has("evaluation"));
    assert.ok(categories.has("operations"));
  });

  test("checkRCReadiness blocks release when legacy writer not ready", () => {
    const report: LegacyWriterShutdownReport = {
      canShutdown: false,
      totalHitsLast7Days: 5,
      totalHitsLast24Hours: 1,
      byWriterKind: [],
      blockingReasons: ["still has hits"],
      recommendation: "wait",
    };
    const rc = checkRCReadiness(report);
    assert.ok(rc.blockedItems > 0);
    assert.ok(!rc.canRelease);
  });

  test("checkRCReadiness still has pending items even when writer is ready", () => {
    const report: LegacyWriterShutdownReport = {
      canShutdown: true,
      totalHitsLast7Days: 0,
      totalHitsLast24Hours: 0,
      byWriterKind: [],
      blockingReasons: [],
      recommendation: "proceed",
    };
    const rc = checkRCReadiness(report);
    // Should still have pending items (RC corpus, blind eval, etc.)
    assert.ok(rc.totalItems > rc.completeItems);
  });
});
