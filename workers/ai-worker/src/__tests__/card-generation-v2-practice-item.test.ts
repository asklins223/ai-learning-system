/**
 * v23 练习件的两道确定性闸（sanitizePracticeItem）。
 *
 * 全部不花模型：这里验的是"模型交来的东西能不能留"，不是"模型会不会交"。
 * 后者要靠 §5 那一次真跑验收。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sanitizePracticeItem, authorObjectiveDraftSchema } from "../card-generation-v2/providers.ts";
import { buildAuthorSystemPrompt } from "../card-generation-v2/prompts.ts";
import { practiceFormsForKnowledgeForm } from "@ailearn/shared/card-generation-v2-contracts";
import type { PracticeItemV2 } from "@ailearn/shared/card-generation-v2-contracts";

/** author 输出的最小合法 objective（v24 验收只用它的 practiceItem 键）。 */
const objectiveFixture = {
  objectiveStatement: "复述灭火器的四个使用步骤",
  publicSummary: "提、拔、握、压四步的顺序与含义",
  conceptLabel: "灭火器使用四步",
  knowledgeForm: "procedure",
  preferredTaskIntents: ["recall"],
  canonicalAnswer: {
    kind: "ordered_steps",
    steps: [
      { unitId: "s1", text: "提起灭火器" },
      { unitId: "s2", text: "拔掉保险销" },
    ],
  },
  learningSupport: { explanation: "四步顺序不可颠倒" },
  rubric: {
    version: 2,
    units: [{
      rubricUnitId: "r1", facet: "recall", criterion: "顺序正确", required: true,
      answerUnitIds: ["s1"],
    }],
    passingPolicy: { requireAllRequiredUnits: true, allowContradiction: false },
  },
  relations: [],
  difficulty: "introductory",
  evidenceRefIds: [],
  practiceItem: null,
};

const EVID = "11111111-1111-4111-8111-111111111111";

function choice(overrides: Partial<Extract<PracticeItemV2, { kind: "single_choice" }>> = {}) {
  return {
    kind: "single_choice" as const,
    options: [
      { unitId: "opt-1", text: "主动回忆更能延长保持", evidenceRefIds: [EVID] },
      { unitId: "opt-2", text: "重复阅读更能延长保持", evidenceRefIds: [EVID] },
    ],
    correctUnitId: "opt-1",
    ...overrides,
  };
}

/**
 * v24：practiceItem 从可省略改成**必填可空**。
 * 这条测试就是那处改动的验收：省略键必须被拒，显式 null 必须通过。
 */
describe("authorObjectiveDraftSchema v24", () => {
  it("交出合法的 objective 后，删掉 practiceItem 键就不通过", () => {
    const withNull = { ...objectiveFixture, practiceItem: null };
    assert.equal(authorObjectiveDraftSchema.safeParse(withNull).success, true, "显式 null 应当通过");

    const withoutKey: Record<string, unknown> = { ...objectiveFixture };
    delete withoutKey.practiceItem;
    const parsed = authorObjectiveDraftSchema.safeParse(withoutKey);
    assert.equal(parsed.success, false, "省略 practiceItem 键必须被拒（v24 的核心）");
    if (!parsed.success) {
      assert.ok(
        parsed.error.issues.some((issue) => issue.path.join(".") === "practiceItem"),
        "拒绝原因必须指到 practiceItem 本身",
      );
    }
  });
});

/**
 * v25：客观题形状按知识形态限定。
 * 这条表的真正作用是让"fact 卡为什么没有选择题"变成一个可断言的问题，
 * 而不是每次跑完靠肉眼猜模型有没有偷懒。
 */
describe("practiceFormsForKnowledgeForm", () => {
  it("无次序的知识首选选择/判断，有次序的首选排序", () => {
    assert.deepEqual([...practiceFormsForKnowledgeForm("fact")], ["single_choice", "true_false"]);
    assert.deepEqual([...practiceFormsForKnowledgeForm("definition")][0], "single_choice");
    assert.deepEqual([...practiceFormsForKnowledgeForm("boundary")][0], "true_false");
    assert.deepEqual([...practiceFormsForKnowledgeForm("sequence")], ["ordering"]);
    assert.deepEqual([...practiceFormsForKnowledgeForm("procedure")], ["ordering", "matching"]);
    assert.deepEqual([...practiceFormsForKnowledgeForm("comparison")][0], "matching");
  });

  it("author 系统提示把这张卡允许的形状写进去，序列题不会被提示成选择题", () => {
    const factPrompt = buildAuthorSystemPrompt("recall", "fact");
    assert.match(factPrompt, /practiceItem 只允许这些形状/);
    assert.ok(factPrompt.includes("single_choice"), "fact 卡应被告知首选选择题");
    const seqPrompt = buildAuthorSystemPrompt("sequence", "sequence");
    assert.ok(seqPrompt.includes("ordering → ") || seqPrompt.includes("ordering"), "序列表仍应拿到 ordering");
    assert.ok(!seqPrompt.includes("single_choice → "), "次序类知识不该被提示成选择题优先");
  });

  /**
   * D6：整批配额里被点名的那张卡，提示必须点名到**具体形状**——否则模型只知道
   * "尽量交"，又回到 v23 那种一整批全不交、或者一律挑最省事的 ordering。
   */
  it("配额点名的卡在提示里被点名到具体形状，没点名的直说不强制", () => {
    const required = buildAuthorSystemPrompt("recall", "fact", "true_false");
    assert.match(required, /这一批要求本卡必须交出一道 true_false 练习件/);
    assert.match(required, /配额不是伪造干扰项的理由/);

    const optional = buildAuthorSystemPrompt("recall", "fact", null);
    assert.match(optional, /本卡不在配额点名之列/);
    assert.ok(!optional.includes("必须交出一道"));
  });
});

describe("sanitizePracticeItem", () => {
  it("没交练习件就是没有，不报错也不伪造", () => {
    assert.equal(sanitizePracticeItem(undefined, {}), undefined);
  });

  it("干扰项都有证据出处的选择题原样留下", () => {
    const item = choice();
    assert.equal(sanitizePracticeItem(item, {}), item);
  });

  it("正确项指向一个没给出过的选项 → 整件丢掉（这种题永远判不对）", () => {
    assert.equal(sanitizePracticeItem(choice({ correctUnitId: "opt-9" }), {}), undefined);
  });

  it("干扰项既无证据、本卡也没有 misconception → 丢掉", () => {
    const item = choice({
      options: [
        { unitId: "opt-1", text: "甲", evidenceRefIds: [EVID] },
        { unitId: "opt-2", text: "乙", evidenceRefIds: [] },
      ],
    });
    assert.equal(sanitizePracticeItem(item, {}), undefined);
  });

  it("干扰项没写证据，但本卡有 misconception（有证据的常见误解）→ 留下", () => {
    const item = choice({
      options: [
        { unitId: "opt-1", text: "甲", evidenceRefIds: [EVID] },
        { unitId: "opt-2", text: "乙" },
      ],
    });
    assert.equal(sanitizePracticeItem(item, { misconception: "常见误解是把重读当成回忆" }), item);
  });

  it("排序题的正确顺序不是单元集合的全排列 → 丢掉", () => {
    const item = {
      kind: "ordering" as const,
      units: [
        { unitId: "u1", text: "第一步", evidenceRefIds: [EVID] },
        { unitId: "u2", text: "第二步", evidenceRefIds: [EVID] },
      ],
      correctUnitOrder: ["u1", "u3"],
    };
    assert.equal(sanitizePracticeItem(item, {}), undefined);
  });

  it("判断题的命题没有证据 → 丢掉（一条无出处的断言不该拿去判对错）", () => {
    const noEvidence = { kind: "true_false" as const, proposition: "间隔越长一定越好", expected: false };
    assert.equal(sanitizePracticeItem(noEvidence, {}), undefined);
    const withEvidence = { ...noEvidence, evidenceRefIds: [EVID] };
    assert.deepEqual(sanitizePracticeItem(withEvidence, {}), withEvidence);
  });
});
