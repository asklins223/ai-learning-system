import { test } from "node:test";
import assert from "node:assert/strict";
import type { GenerationPlan } from "@ailearn/shared";
import {
  buildScheduleState,
  decideSchedule,
  scheduleWaves,
  type BundleScheduleState,
} from "../agent/specialist-dag.ts";

function plan(bundles: Array<{ id: string; deps?: string[] }>): GenerationPlan {
  return {
    schemaVersion: "1",
    documentIntent: "test",
    learningFocus: ["x"],
    bundleTasks: bundles.map((b) => ({
      bundleId: b.id,
      specialist: "text_extractor",
      extractionFocus: b.id,
      relatedBundleIds: b.deps ?? [],
      expectedDecisionKinds: ["candidate", "no_candidate"],
    })),
    compositionStrategy: { density: "standard", cardBudget: 3 },
  };
}

test("independent bundles all runnable in first wave", () => {
  const p = plan([{ id: "b1" }, { id: "b2" }, { id: "b3" }]);
  const states = buildScheduleState(p, new Set());
  const d = decideSchedule(states);
  assert.deepEqual(d.runnable.sort(), ["b1", "b2", "b3"]);
  assert.equal(d.canCompose, false);
  assert.deepEqual(d.pending, []);
});

test("dependency ordering: dependent waits for dependency", () => {
  const p = plan([{ id: "b1" }, { id: "b2", deps: ["b1"] }]);
  const states = buildScheduleState(p, new Set());
  const d = decideSchedule(states);
  assert.deepEqual(d.runnable, ["b1"]);
  assert.deepEqual(d.pending, ["b2"]);
  assert.equal(d.canCompose, false);
});

test("after dependency completes, dependent becomes runnable", () => {
  const p = plan([{ id: "b1" }, { id: "b2", deps: ["b1"] }]);
  const states = buildScheduleState(p, new Set(["b1"]));
  const d = decideSchedule(states);
  assert.deepEqual(d.runnable, ["b2"]);
  assert.equal(d.canCompose, false);
});

test("canCompose only when all required completed (auto Compose trigger)", () => {
  const p = plan([{ id: "b1" }, { id: "b2", deps: ["b1"] }]);
  assert.equal(decideSchedule(buildScheduleState(p, new Set(["b1"]))).canCompose, false);
  const done = decideSchedule(buildScheduleState(p, new Set(["b1", "b2"])));
  assert.equal(done.canCompose, true);
  assert.deepEqual(done.runnable, []);
  assert.deepEqual(done.pending, []);
});

test("scheduleWaves groups independent bundles and orders deps", () => {
  const p = plan([
    { id: "b1" },
    { id: "b2", deps: ["b1"] },
    { id: "b3", deps: ["b1"] },
    { id: "b4" },
  ]);
  const waves = scheduleWaves(buildScheduleState(p, new Set()));
  // 波 1:{b1,b4} 并行;波 2:{b2,b3} 并行
  assert.deepEqual(waves[0].sort(), ["b1", "b4"]);
  assert.deepEqual(waves[1].sort(), ["b2", "b3"]);
});

test("cycle fallback: defensive, does not infinite loop", () => {
  const states: BundleScheduleState[] = [
    { bundleId: "a", specialist: "text_extractor", relatedBundleIds: ["b"], completed: false, required: true },
    { bundleId: "b", specialist: "text_extractor", relatedBundleIds: ["a"], completed: false, required: true },
  ];
  const waves = scheduleWaves(states);
  // 防环:每波至少推进一个,最终全部出队
  assert.equal(waves.length, 2);
  assert.deepEqual(new Set(waves.flat()).size, 2);
});
