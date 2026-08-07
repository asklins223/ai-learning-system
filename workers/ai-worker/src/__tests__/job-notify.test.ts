import { test } from "node:test";
import assert from "node:assert/strict";
import { pollIntervalForState, buildJobNotifyPayload, parseNotifyPayload } from "../lib/job-notify.ts";

test("P4-6: 轮询分级(活跃 100-200ms/短空闲 500ms/长空闲 1-2s)", () => {
  // 活跃:100-200ms(确定性 rng 验证边界)
  assert.equal(pollIntervalForState("active", () => 0), 100);
  assert.equal(pollIntervalForState("active", () => 0.999), 199);
  assert.ok(pollIntervalForState("active") >= 100 && pollIntervalForState("active") <= 200);

  assert.equal(pollIntervalForState("short_idle"), 500);
  assert.ok(pollIntervalForState("long_idle") >= 1000 && pollIntervalForState("long_idle") <= 2000);
  assert.equal(pollIntervalForState("long_idle", () => 0.5), 1500);
});

test("P4-6: notify payload 构造与解析(合法/非法)", () => {
  const p = buildJobNotifyPayload({
    workspaceId: "w1",
    runId: "r1",
    jobId: "j1",
    eventType: "job_ready",
    stage: "prepare",
  });
  assert.equal(typeof p.at, "string");

  const parsed = parseNotifyPayload(JSON.stringify(p));
  assert.equal(parsed?.jobId, "j1");
  assert.equal(parsed?.eventType, "job_ready");
  assert.equal(parsed?.stage, "prepare");

  assert.equal(parseNotifyPayload("not-json"), null);
  assert.equal(parseNotifyPayload(JSON.stringify({ jobId: "j1" })), null, "缺 eventType 拒绝");
  assert.equal(parseNotifyPayload(JSON.stringify({ ...p, eventType: "bogus" })), null, "非法 eventType 拒绝");
});
