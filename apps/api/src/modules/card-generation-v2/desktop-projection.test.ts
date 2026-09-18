import assert from "node:assert/strict";
import test from "node:test";
import { projectCardGenerationRecoveryV1 } from "./desktop-projection.ts";

const RUN_ID = "11111111-1111-4111-8111-111111111111";
const NOTE_ID = "22222222-2222-4222-8222-222222222222";
const VERSION_ID = "33333333-3333-4333-8333-333333333333";

function input(status: "needs_attention" | "failed" | "stale", overrides: Record<string, unknown> = {}) {
  return {
    runId: RUN_ID,
    noteId: NOTE_ID,
    noteVersionId: VERSION_ID,
    status,
    sourceOutdated: false,
    error: null,
    ...overrides,
  } as Parameters<typeof projectCardGenerationRecoveryV1>[0];
}

test("Card Generation recovery projection maps all recovery states to strict safe actions", () => {
  const attention = projectCardGenerationRecoveryV1(input("needs_attention"));
  const failed = projectCardGenerationRecoveryV1(input("failed", { error: { code: "provider_timeout", message: "hidden" } }));
  const stale = projectCardGenerationRecoveryV1(input("stale", { sourceOutdated: true }));

  assert.equal(attention?.publicReasonCode, "attention_required");
  assert.equal(failed?.publicReasonCode, "provider_unavailable");
  assert.equal(stale?.publicReasonCode, "source_outdated");
  for (const recovery of [attention, failed, stale]) {
    assert.equal(recovery?.retryability, "resync_required");
    assert.deepEqual(recovery?.allowedActions.map((action) => action.kind), ["refresh_status", "return_note"]);
    const actionKinds = recovery?.allowedActions.map((action) => action.kind) ?? [];
    assert.equal((actionKinds as readonly string[]).includes("cancel_run"), false);
    const returnAction = recovery?.allowedActions.find((action) => action.kind === "return_note");
    assert.deepEqual(returnAction && "sourceRef" in returnAction ? returnAction.sourceRef : null, { noteId: NOTE_ID, noteVersionId: VERSION_ID });
  }
});

test("non-recovery run states do not receive a recovery projection", () => {
  const projection = projectCardGenerationRecoveryV1({
    ...input("needs_attention"),
    status: "planning",
  });
  assert.equal(projection, null);
});

/**
 * 就地重试的签发条件（2026-09-18 补齐产品缺口）。
 *
 * 背景：唯一候选被 critic 否决时 run 会终态化为 needs_attention 且没有候选可审核，
 * 此前恢复契约只给"回笔记重开一次全新生成"，用户必须重付 planner + 全部 critic 的
 * token。现在服务端在**确有可重试理由**时签发 retry_generation。
 *
 * 这组用例锁住的是"何时**不**签发"——宁可少给一个按钮，也不能给一个注定失败或
 * 把服务端问题伪装成用户可操作项的按钮。
 */
test("质量门禁失败 + 来源新鲜 → 签发就地重试", () => {
  const recovery = projectCardGenerationRecoveryV1(input("needs_attention", {
    error: { code: "quality_gate_failed", message: "all candidates failed quality gates" },
  }));
  assert.equal(recovery?.retryability, "retry_in_place");
  assert.deepEqual(
    recovery?.allowedActions.map((action) => action.kind),
    ["refresh_status", "return_note", "retry_generation"],
  );
  const retry = recovery?.allowedActions.find((action) => action.kind === "retry_generation");
  assert.equal(retry && "runId" in retry ? retry.runId : null, RUN_ID);
});

test("provider/配置类失败不签发重试（重跑只会原样再失败一次）", () => {
  for (const code of ["generation_failed", "provider_timeout", "credential_missing"]) {
    const recovery = projectCardGenerationRecoveryV1(input("needs_attention", {
      error: { code, message: "hidden" },
    }));
    assert.equal(recovery?.retryability, "resync_required", `code=${code} must not be retryable in place`);
    assert.equal(
      recovery?.allowedActions.some((action) => action.kind === "retry_generation"),
      false,
      `code=${code} must not offer retry_generation`,
    );
  }
});

test("来源已过期时不签发重试（对着过期来源重跑只会再失败）", () => {
  const recovery = projectCardGenerationRecoveryV1(input("needs_attention", {
    sourceOutdated: true,
    error: { code: "quality_gate_failed", message: "hidden" },
  }));
  assert.notEqual(recovery?.retryability, "retry_in_place");
  assert.equal(recovery?.allowedActions.some((action) => action.kind === "retry_generation"), false);
});

test("failed / stale 状态不签发就地重试（只有 needs_attention 可重试）", () => {
  for (const status of ["failed", "stale"] as const) {
    const recovery = projectCardGenerationRecoveryV1(input(status, {
      error: { code: "quality_gate_failed", message: "hidden" },
    }));
    assert.equal(recovery?.allowedActions.some((action) => action.kind === "retry_generation"), false, `status=${status}`);
  }
});
