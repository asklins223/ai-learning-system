import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryArtifactCache } from "../agent/unit-artifact-cache.ts";
import { diffNoteVersions, type NoteBlockLike } from "../agent/note-diff.ts";
import { planChangedClaimReview, assertNoUnreviewedClaims, type ChangedClaimReviewInput } from "../agent/changed-claim-review.ts";
import { claimHash, computeCriticCacheKey } from "../agent/incremental-caches.ts";

function block(id: string, content: string): NoteBlockLike {
  return { id, ordinal: 0, type: "paragraph", content };
}

function reviewInput(diff: ReturnType<typeof diffNoteVersions>, claimsBySpan: Map<string, string[]>): ChangedClaimReviewInput {
  const criticCache = createMemoryArtifactCache();
  return {
    diff,
    claimsBySpan,
    criticCache,
    criticCacheKeyFor: (claim, mode) =>
      computeCriticCacheKey({ workspaceId: "w1", runId: "r1", claimHash: claimHash(claim), criticMode: mode, promptVersion: "p1" }),
    criticMode: "light",
  };
}

test("P5-5: 变化 span 的 claim 重新审查,未变化引用旧 verdict", () => {
  const prev = [block("s1", "旧"), block("s2", "旧")];
  const next = [block("s1", "新"), block("s2", "旧")];
  const diff = diffNoteVersions(prev, next);
  const claimsBySpan = new Map<string, string[]>([
    ["s1", ["变化后的 claim"]],
    ["s2", ["未变化的 claim"]],
  ]);
  const input = reviewInput(diff, claimsBySpan);

  // 预热:把"未变化的 claim"的旧 verdict 写入缓存(模拟上一版本已审查)
  const cachedKey = input.criticCacheKeyFor("未变化的 claim", "light");
  input.criticCache.put({ cacheKey: cachedKey, artifact: { verdict: "supported" }, cachedAt: Date.now(), modelVersion: "m1", promptVersion: "p1", unitKind: "critic_verdict" });

  const r = planChangedClaimReview(input);
  assert.deepEqual(r.toReview.map((c) => c.claim), ["变化后的 claim"], "只有变化 claim 进入审查");
  assert.equal(r.reusedCount, 1, "未变化 claim 引用旧 verdict");
  assert.equal(r.reuseVerdicts[0].claim, "未变化的 claim");
  assert.equal(assertNoUnreviewedClaims(["变化后的 claim", "未变化的 claim"], r), true);
});

test("P5-5: 未变化但无旧 verdict(冷启动)仍需审查一次", () => {
  const prev = [block("s1", "旧"), block("s2", "旧")];
  const next = [block("s1", "新"), block("s2", "旧")];
  const diff = diffNoteVersions(prev, next);
  const claimsBySpan = new Map<string, string[]>([["s2", ["冷启动 claim"]]]);
  const input = reviewInput(diff, claimsBySpan);
  const r = planChangedClaimReview(input);
  // s2 未变化但缓存为空 → 需要审查(但按设计:未变化且无缓存才审查一次)
  assert.deepEqual(r.toReview.map((c) => c.claim), ["冷启动 claim"]);
  assert.equal(r.reusedCount, 0);
});

test("P5-5: 无遗漏断言——全部 claim 有结论", () => {
  const diff = diffNoteVersions([block("s1", "a")], [block("s1", "a")]);
  const claimsBySpan = new Map<string, string[]>([["s1", ["claim-1"]]]);
  const input = reviewInput(diff, claimsBySpan);
  const r = planChangedClaimReview(input);
  // 无缓存 → 全部需要审查,无遗漏
  assert.equal(assertNoUnreviewedClaims(["claim-1"], r), true);
  assert.equal(r.reusedCount, 0);
});
