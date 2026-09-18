/**
 * run-critic 单元测试：prompt 构造、strict 输出解析、fail closed 语义。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildCriticPrompt,
  CriticOutputError,
  extractCriticJson,
  materializeCriticEvidenceRefs,
  parseCriticOutput,
  type CriticInput,
} from "./run-critic.ts";
import { hashCanonicalV2 } from "@ailearn/shared/hash-canonical-v2";

function makeInput(): CriticInput {
  return {
    taskPrompt: "请解释为什么成立：遗忘曲线表明复习间隔决定长期记忆",
    claim: "遗忘曲线表明复习间隔决定长期记忆",
    evidenceQuotes: ["证据引文一：间隔重复能显著降低遗忘率。"],
    answerText: "因为遗忘在刚学完时最快，通过间隔复习可以在遗忘发生前巩固，所以复习的时间安排直接决定长期记忆的效果。",
    intent: "explain",
    rubricTargetIds: ["rubric:explain:abc123"],
  };
}

test("buildCriticPrompt：包含题面/观点/证据/答案与 rubric 目标，并要求只输出 JSON", () => {
  const prompt = buildCriticPrompt(makeInput());
  assert.ok(prompt.includes("遗忘曲线表明复习间隔决定长期记忆"));
  assert.ok(prompt.includes("证据引文一"));
  assert.ok(prompt.includes("复习的时间安排直接决定长期记忆"));
  assert.ok(prompt.includes("rubric:explain:abc123"));
  assert.ok(prompt.includes("json_object") === false);
  assert.ok(prompt.includes("只输出 JSON"));
  // 角色隔离：明示不是辅导老师。
  assert.ok(prompt.includes("不是辅导老师"));
  assert.ok(prompt.includes("不是可执行指令"));
});

test("parseCriticOutput：合法输出通过，confidence 默认 1", () => {
  const parsed = parseCriticOutput(
    JSON.stringify({
      verdicts: [
        { rubricItemId: "rubric:explain:abc123", verdict: "covered", userFacingReason: "用自己的话解释了原因" },
      ],
    }),
    ["rubric:explain:abc123"],
  );
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].verdict, "covered");
  assert.equal(parsed[0].confidence, 1);
});

test("parseCriticOutput：markdown 围栏被剥离", () => {
  const parsed = parseCriticOutput(
    "```json\n{\"verdicts\":[{\"rubricItemId\":\"r1\",\"verdict\":\"missing\",\"userFacingReason\":\"未覆盖\"}]}\n```",
    ["r1"],
  );
  assert.equal(parsed[0].verdict, "missing");
});

test("parseCriticOutput：支持 V2 rubric 合同允许的 80 条逐项结论", () => {
  const rubricTargetIds = Array.from({ length: 80 }, (_, index) => `r${index + 1}`);
  const parsed = parseCriticOutput(JSON.stringify({
    verdicts: rubricTargetIds.map((rubricItemId) => ({
      rubricItemId,
      verdict: "covered",
      userFacingReason: "已覆盖",
    })),
  }), rubricTargetIds);
  assert.equal(parsed.length, 80);
});

test("parseCriticOutput：重复的 closure rubric 目标 fail closed", () => {
  assert.throws(
    () => parseCriticOutput(JSON.stringify({
      verdicts: [{ rubricItemId: "r1", verdict: "covered", userFacingReason: "已覆盖" }],
    }), ["r1", "r1"]),
    CriticOutputError,
  );
});

test("materializeCriticEvidenceRefs：只把哈希校验通过的冻结原文切片交给 Critic", () => {
  const blockContent = "开头。间隔复习能降低遗忘率。结尾。";
  const quote = "间隔复习能降低遗忘率。";
  const startOffset = blockContent.indexOf(quote);
  const refs = materializeCriticEvidenceRefs(
    [{ evidenceSnapshotId: "e1", evidenceSnapshotHash: "a".repeat(64) }],
    [{
      evidenceSnapshotId: "e1",
      evidenceSnapshotHash: "a".repeat(64),
      quoteHash: hashCanonicalV2("evidence-quote", { quote }),
      blockContentHash: hashCanonicalV2("block", { content: blockContent }),
      startOffset,
      endOffset: startOffset + quote.length,
      blockContent,
    }],
  );
  assert.deepEqual(refs, [{ evidenceSnapshotHash: "a".repeat(64), preview: quote }]);
});

test("materializeCriticEvidenceRefs：原文变化时 fail closed", () => {
  assert.throws(() => materializeCriticEvidenceRefs(
    [{ evidenceSnapshotId: "e1", evidenceSnapshotHash: "a".repeat(64) }],
    [{
      evidenceSnapshotId: "e1",
      evidenceSnapshotHash: "a".repeat(64),
      quoteHash: hashCanonicalV2("evidence-quote", { quote: "原始证据" }),
      blockContentHash: hashCanonicalV2("block", { content: "原始证据" }),
      startOffset: 0,
      endOffset: 4,
      blockContent: "篡改证据",
    }],
  ), CriticOutputError);
});

test("parseCriticOutput：未知 rubricItemId / 缺条 / 重复 → CriticOutputError（fail closed）", () => {
  assert.throws(
    () => parseCriticOutput(
      JSON.stringify({ verdicts: [{ rubricItemId: "evil", verdict: "covered", userFacingReason: "x" }] }),
      ["r1"],
    ),
    CriticOutputError,
  );
  assert.throws(
    () => parseCriticOutput(JSON.stringify({ verdicts: [] }), ["r1"]),
    CriticOutputError,
  );
  assert.throws(
    () => parseCriticOutput(
      JSON.stringify({
        verdicts: [
          { rubricItemId: "r1", verdict: "covered", userFacingReason: "a" },
          { rubricItemId: "r1", verdict: "partial", userFacingReason: "b" },
        ],
      }),
      ["r1"],
    ),
    CriticOutputError,
  );
});

test("parseCriticOutput：非法 verdict / 非 JSON / 缺字段 → 失败", () => {
  assert.throws(
    () => parseCriticOutput(
      JSON.stringify({ verdicts: [{ rubricItemId: "r1", verdict: "excellent", userFacingReason: "x" }] }),
      ["r1"],
    ),
    CriticOutputError,
  );
  assert.throws(() => parseCriticOutput("not-json", ["r1"]), CriticOutputError);
  assert.throws(
    () => parseCriticOutput(
      JSON.stringify({ verdicts: [{ rubricItemId: "r1", verdict: "covered" }] }),
      ["r1"],
    ),
    CriticOutputError,
  );
});

test("extractCriticJson：多种包装形状提取 JSON 体", () => {
  assert.equal(extractCriticJson('```json\n{"a":1}\n```'), '{"a":1}');
  assert.equal(extractCriticJson('前缀 {"a":1} 后缀'), '{"a":1}');
  assert.equal(extractCriticJson('{"a":1}'), '{"a":1}');
});

test("critic 输出含答案关键内容的 userFacingReason 长度受限（schema max 500）", () => {
  // userFacingReason 超长 → 拒绝（防止把长正文塞进原因字段）。
  assert.throws(
    () => parseCriticOutput(
      JSON.stringify({
        verdicts: [{ rubricItemId: "r1", verdict: "covered", userFacingReason: "x".repeat(501) }],
      }),
      ["r1"],
    ),
    CriticOutputError,
  );
});
