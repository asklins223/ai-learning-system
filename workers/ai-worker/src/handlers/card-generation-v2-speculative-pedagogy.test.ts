/**
 * 投机 pedagogy 的**复用守卫**回归（2026-09-17 极限延迟改造）。
 *
 * 背景：pedagogy 是集合级调用，与 grounding 唯一的关联是 prompt 里的不透明标识
 * `candidateEvidenceBindingPlanHashes`。因此主管线在最后一个候选 author 完成时
 * 就用占位 hash 发起 pedagogy，与 grounding 波并发（关键路径 4 阶段 → 3 阶段）。
 *
 * 复用必须**严格**：pedagogy 的 perCandidate 判定与 `candidateRevisionHashes` /
 * `candidateEvidenceBindingPlanHashes` **按下标对应**，集合相同但顺序不同会把
 * verdict 挂到错误候选上；长度不同或成员不同则必须重跑。
 * 本测试钉住"只有逐位相同才复用"，以及复用前必须把真实 hash 写回并重算 reportHash。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  isSameCandidateSequence,
  withBindingPlanHashes,
} from "./card-generation-v2-handler.ts";
import type { PedagogyCriticReportV2 } from "@ailearn/shared/card-quality-v2-contracts";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function report(hashes: string[]): PedagogyCriticReportV2 {
  return {
    version: 2,
    runId: "11111111-1111-4111-8111-111111111111",
    candidateRevisionHashes: [HASH_A, HASH_B],
    candidateEvidenceBindingPlanHashes: hashes,
    planRevisionId: "22222222-2222-4222-8222-222222222222",
    planVersion: 1,
    planHash: HASH_A,
    inputHash: HASH_B,
    verdict: "pass",
    perCandidate: [
      { candidateId: "33333333-3333-4333-8333-333333333331", verdict: "keep", hardIssues: [] },
      { candidateId: "33333333-3333-4333-8333-333333333332", verdict: "keep", hardIssues: [] },
    ],
    setIssues: [],
    recommendedFinalCount: 2,
    criticVersion: "card-pedagogy-critic/v1",
    reportHash: "c".repeat(64),
  } as PedagogyCriticReportV2;
}

test("复用守卫：逐位相同（含顺序）才复用", () => {
  assert.equal(isSameCandidateSequence(["a", "b"], ["a", "b"]), true);
});

test("复用守卫：顺序不同必须重跑（verdict 按下标对应，错序会挂错候选）", () => {
  assert.equal(isSameCandidateSequence(["a", "b"], ["b", "a"]), false);
});

test("复用守卫：长度不同（grounding 淘汰/去重落选）必须重跑", () => {
  assert.equal(isSameCandidateSequence(["a", "b"], ["a"]), false);
  assert.equal(isSameCandidateSequence(["a"], ["a", "b"]), false);
});

test("复用守卫：成员不同必须重跑", () => {
  assert.equal(isSameCandidateSequence(["a", "b"], ["a", "c"]), false);
});

test("复用守卫：空集不构成复用（pedagogy 对空集不调用）", () => {
  assert.equal(isSameCandidateSequence([], []), true);
});

test("复用前必须把真实 binding plan hash 写回，并重算 reportHash", () => {
  const placeholder = report([HASH_A, HASH_A]); // 投机时占位（= candidateRevisionHash）
  const real = [HASH_A, HASH_B];
  const filled = withBindingPlanHashes(placeholder, real);

  assert.deepEqual(filled.candidateEvidenceBindingPlanHashes, real, "必须替换为真实 hash");
  assert.notEqual(filled.reportHash, placeholder.reportHash, "替换后必须重算 reportHash");
  assert.equal(filled.reportHash.length, 64);
  // 除 hash 字段外，其余判定内容必须原样保留（复用不得改写裁决）。
  assert.deepEqual(filled.perCandidate, placeholder.perCandidate);
  assert.equal(filled.verdict, placeholder.verdict);
});

test("复用是幂等的：同一报告 + 同一真实 hash 得到同一 reportHash", () => {
  const placeholder = report([HASH_A, HASH_A]);
  const first = withBindingPlanHashes(placeholder, [HASH_A, HASH_B]);
  const second = withBindingPlanHashes(placeholder, [HASH_A, HASH_B]);
  assert.equal(first.reportHash, second.reportHash);
});
