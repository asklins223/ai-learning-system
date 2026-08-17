/**
 * Plan 23 W0-02：正式消费者 audit gate 测试。
 * - 必需正式消费者全部登记；
 * - formal 条目必须有 owner/status/statusAt；
 * - 基线期 gate 必须失败（dual/pending 不是 release gate 的问题被固化为可执行条件）；
 * - 全部 done 时 gate 通过。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LEGACY_CONSUMER_REGISTRY,
  FORMAL_CONSUMER_REQUIRED_MODULES,
  formalConsumerGateReport,
  assertFormalConsumerGate,
  assertNoNewClaimDependencies,
} from "./legacy-consumer-audit.ts";

test("W0-02: registry covers every required formal consumer module", () => {
  const registered = new Set(LEGACY_CONSUMER_REGISTRY.map((e) => e.module));
  const missing = FORMAL_CONSUMER_REQUIRED_MODULES.filter((m) => !registered.has(m));
  assert.deepEqual(missing, []);
});

test("W0-02: formal consumers each have owner and dated status", () => {
  for (const e of LEGACY_CONSUMER_REGISTRY.filter((x) => x.formal === true)) {
    assert.ok(e.owner, "formal consumer missing owner: " + e.module);
    assert.ok(e.status, "formal consumer missing status: " + e.module);
    assert.ok(e.statusAt, "formal consumer missing statusAt: " + e.module);
  }
});

test("W0-02 baseline: gate FAILS while formal consumers are pending/dual (documents §2.7)", () => {
  const report = formalConsumerGateReport();
  assert.equal(report.missingModules.length, 0, "no missing modules allowed at baseline");
  assert.ok(
    report.pendingFormalConsumers.length > 0,
    "baseline must have pending formal consumers (W5 flips gate to pass)",
  );
  assert.equal(report.pass, false);
  assert.throws(() => assertFormalConsumerGate(), /Formal consumer gate failed/);
});

test("W0-02: gate passes when every formal consumer is done", () => {
  const done = LEGACY_CONSUMER_REGISTRY.map((e) =>
    e.formal === true
      ? { ...e, status: "done" as const, statusAt: "2026-08-16" }
      : e,
  );
  const report = formalConsumerGateReport(done);
  assert.equal(report.pass, true);
  assert.deepEqual(report.pendingFormalConsumers, []);
  assert.deepEqual(assertFormalConsumerGate(done), { pass: true });
});

test("W0-02: gate flags missing required modules", () => {
  const trimmed = LEGACY_CONSUMER_REGISTRY.filter(
    (e) => e.module !== "apps/web/app/(workspace)/(default)/page.tsx",
  );
  const report = formalConsumerGateReport(trimmed);
  assert.equal(report.pass, false);
  assert.deepEqual(report.missingModules, ["apps/web/app/(workspace)/(default)/page.tsx"]);
});

test("C0: assertNoNewClaimDependencies flags modules outside registry", () => {
  const found = [
    "apps/web/app/(workspace)/(default)/page.tsx",
    "some/unknown/module.ts",
  ];
  const { newViolations } = assertNoNewClaimDependencies(found);
  assert.deepEqual(newViolations, ["some/unknown/module.ts"]);
});
