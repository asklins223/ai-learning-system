/**
 * run-critic 单元测试：prompt 构造、strict 输出解析、fail closed 语义。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildCriticPrompt,
  createOpenAICompatibleCritic,
  CriticOutputError,
  CriticUnavailableError,
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

// ── W3-5：Critic 跑在公共任务运行基础上之后，重试与分类得有人验 ────────────
// 这段循环以前没有一条用例走到过（`createOpenAICompatibleCritic` 在测试里从没被构造），
// 所以"重试几次、哪些失败算瞬时、strict 解析失败算哪一类"全是口头承诺。

const CRITIC_TEST_ENV = {
  url: "https://critic.test.example/v1/chat/completions",
  key: "k",
  model: "m",
  currentActiveTransaction: () => undefined,
};

const VERDICT_BODY = (itemId: string) => ({
  choices: [{ message: { content: JSON.stringify({ verdicts: [{ rubricItemId: itemId, verdict: "covered", userFacingReason: "实质覆盖了目标" }] }) } }],
});

function criticInputFor(itemId: string) {
  return {
    taskPrompt: "什么是索引的选择性？", claim: "选择性衡量列上不同值的比例",
    evidenceQuotes: ["选择性 = 不同值数 / 总行数"], answerText: "看唯一值占多少",
    intent: "recall", rubricTargetIds: [itemId],
  };
}

const scopeFor = (itemId: string) => ({
  workspaceId: "11111111-1111-1111-1111-111111111111",
  userId: "22222222-2222-2222-2222-222222222222",
  assessmentId: `as-${itemId}`, inputSnapshotHash: "hash-x",
});

test("Critic 重试：瞬时失败一次后成功 ⇒ 恰好两次尝试，结果照原样返回", async () => {
  const calls: number[] = [];
  const critic = createOpenAICompatibleCritic({
    ...CRITIC_TEST_ENV,
    requester: async () => {
      calls.push(calls.length + 1);
      if (calls.length === 1) return { status: 503, statusText: "busy", body: {} };
      return { status: 200, statusText: "ok", body: VERDICT_BODY("r1") };
    },
  });
  const verdicts = await critic.assess(criticInputFor("r1"), scopeFor("r1"));
  assert.equal(calls.length, 2, "瞬时故障该重试一次");
  assert.deepEqual(verdicts.map((v) => v.rubricItemId), ["r1"]);
});

test("Critic 重试额度是 1：一直 5xx 也只调两次，然后 fail closed", async () => {
  let calls = 0;
  const critic = createOpenAICompatibleCritic({
    ...CRITIC_TEST_ENV,
    requester: async () => { calls += 1; return { status: 500, statusText: "boom", body: {} }; },
  });
  await assert.rejects(() => critic.assess(criticInputFor("r2"), scopeFor("r2")), CriticUnavailableError);
  assert.equal(calls, 2, "不许无限重试——那会把 outbox 卡死");
});

test("Critic 非瞬时 4xx 不重试：请求本身不对，再等一次只是慢一点", async () => {
  let calls = 0;
  const critic = createOpenAICompatibleCritic({
    ...CRITIC_TEST_ENV,
    requester: async () => { calls += 1; return { status: 401, statusText: "denied", body: {} }; },
  });
  await assert.rejects(() => critic.assess(criticInputFor("r3"), scopeFor("r3")), CriticUnavailableError);
  assert.equal(calls, 1);
});

test("Critic 输出不合 strict 算形状问题：报 CriticOutputError，不伪装成 provider 不在", async () => {
  let calls = 0;
  const critic = createOpenAICompatibleCritic({
    ...CRITIC_TEST_ENV,
    requester: async () => {
      calls += 1;
      return { status: 200, statusText: "ok", body: { choices: [{ message: { content: '{"verdicts":[]}' } }] } };
    },
  });
  // "provider 抖动"和"答得不合合同"是两种用户可见说法，混起来就会把合同问题
  // 说成"评估暂时不可用，请稍后再试"。
  await assert.rejects(() => critic.assess(criticInputFor("r4"), scopeFor("r4")), CriticOutputError);
  assert.equal(calls, 2, "形状问题也有一次修复机会（与内核的同一条规则）");
});

test("Critic 在活动事务里被调用 ⇒ 执行边界当场拒绝，一次请求都不发", async () => {
  let calls = 0;
  const critic = createOpenAICompatibleCritic({
    ...CRITIC_TEST_ENV,
    currentActiveTransaction: () => ({ context: {}, transaction: {}, open: true }),
    requester: async () => { calls += 1; return { status: 200, statusText: "ok", body: VERDICT_BODY("r5") }; },
  });
  await assert.rejects(() => critic.assess(criticInputFor("r5"), scopeFor("r5")), /外部调用被拒/);
  assert.equal(calls, 0, "边界拒了却还是把请求发出去了");
});

test("Critic 未配置 ⇒ 仍是 unavailable（迁外壳没改掉这条 fail-closed 入口）", async () => {
  const critic = createOpenAICompatibleCritic({
    url: "", key: "", model: "", currentActiveTransaction: () => undefined,
  });
  await assert.rejects(() => critic.assess(criticInputFor("r6"), scopeFor("r6")), CriticUnavailableError);
});
