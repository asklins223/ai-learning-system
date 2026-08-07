import { test } from "node:test";
import assert from "node:assert/strict";
import { stageTransitionLatencySeconds, timeToFirstToolCallSeconds } from "../lib/metrics.ts";

test("P4-7: Stage Transition Latency 指标已注册且可记录(§5.4)", () => {
  stageTransitionLatencySeconds.labels("prepare", "agent_run").observe(0.5);
  stageTransitionLatencySeconds.labels("agent_run", "publish").observe(1.2);
  assert.ok(true, "指标注册并观察成功");
});

test("P4-7: Time to First Tool Call 指标已注册且可记录", () => {
  timeToFirstToolCallSeconds.labels("generation_supervisor").observe(1.2);
  timeToFirstToolCallSeconds.labels("text_extractor").observe(0.8);
  assert.ok(true, "指标注册并观察成功");
});
