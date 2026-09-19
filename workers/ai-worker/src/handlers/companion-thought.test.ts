import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildDeterministicThoughts,
  buildExpressionPrompt,
  containsInternalToken,
  cosineSimilarity,
  isDuplicateThought,
  isWithinQuietHoursLocal,
  parseThoughtCandidates,
  parseVectorText,
  selectThoughtExpression,
  shouldStaySilentForFeedback,
  validateThoughtExpression,
  type ThoughtMaterial,
} from "./companion-thought.ts";

function baseMaterial(overrides: Partial<ThoughtMaterial> = {}): ThoughtMaterial {
  return {
    today: "2026-09-18",
    readyReviews: 0,
    streakDays: 0,
    daysSinceLastLearning: null,
    familiarity: 0,
    petName: "Mao",
    allowNudgeLearning: true,
    allowPlayful: true,
    catchphrase: null,
    recentlySaid: [],
    deliveredToday: 0,
    recentThoughtEmbeddings: [],
    recentDeliveryStates: [],
    activeDedupeKeys: new Set(),
    ...overrides,
  };
}

test("确定性念头：复习到期/连续学习/惰性 三条规则", () => {
  const due = buildDeterministicThoughts(baseMaterial({ readyReviews: 5 }));
  assert.equal(due.length, 1);
  assert.equal(due[0].source, "review_due");
  assert.equal(due[0].dedupeKey, "review_due:2026-09-18");
  assert.ok(due[0].text.includes("5"));

  const streak = buildDeterministicThoughts(baseMaterial({ streakDays: 4 }));
  assert.equal(streak[0].source, "streak");
  assert.ok(streak[0].text.includes("4"));

  const lapse = buildDeterministicThoughts(baseMaterial({ daysSinceLastLearning: 5, familiarity: 0.3 }));
  assert.equal(lapse[0].source, "inactivity");
});

test("确定性念头：门槛与去重键生效", () => {
  // allowNudgeLearning=false → 不催复习也不提惰性
  assert.equal(buildDeterministicThoughts(baseMaterial({ readyReviews: 5, allowNudgeLearning: false })).length, 0);
  // 熟悉度不足 → 惰性提醒不生成（冷启动就该安静）
  assert.equal(buildDeterministicThoughts(baseMaterial({ daysSinceLastLearning: 5, familiarity: 0.1 })).length, 0);
  // streak < 3 不生成
  assert.equal(buildDeterministicThoughts(baseMaterial({ streakDays: 2 })).length, 0);
  // 同 dedupeKey 已有活跃念头 → 不重复生成
  assert.equal(
    buildDeterministicThoughts(baseMaterial({ readyReviews: 5, activeDedupeKeys: new Set(["review_due:2026-09-18"]) })).length,
    0,
  );
});

test("LLM 候选解析：JSON 消毒、长度与内部 token 拒绝、最多 3 条", () => {
  const raw = JSON.stringify({
    thoughts: [
      { text: "下午适合把那道题收个尾。", urgency: 40, topic: "nudge" },
      { text: "正常第二条。", urgency: 999 },
      { text: "别提 companion-persona-v4 这种词" },
      { text: "第四条被条数上限裁掉。", urgency: 10 },
    ],
  });
  const out = parseThoughtCandidates(raw, "2026-09-18");
  assert.equal(out.length, 2); // 空/超长/泄 token 的都被拒；第 4 条超出 3 条上限
  assert.equal(out[0].source, "llm");
  assert.equal(out[1].urgency, 100); // clamp
  assert.equal(parseThoughtCandidates("不是 JSON", "2026-09-18").length, 0);
});

test("LLM 候选解析：念头正文是 JSON 信封时剥出正文，剥不掉就丢掉", () => {
  // 念头文本会直接念给用户听，绝不能把 JSON 摆出去（见 companion-dialogue-content）。
  const raw = JSON.stringify({
    thoughts: [
      { text: '{"text":"剥出这一句。"}', topic: "nudge" },
      { text: '[{"text":"数组信封也剥掉。","type":"text"}]', topic: "nudge" },
      { text: '{"unknown_shape": [1, 2, 3]}', topic: "nudge" },
    ],
  });
  const out = parseThoughtCandidates(raw, "2026-09-18");
  assert.deepEqual(out.map((candidate) => candidate.text), ["剥出这一句。", "数组信封也剥掉。"]);
});

test("内部 token 检测：UUID / persona id / cue 都算泄露", () => {
  assert.equal(containsInternalToken("有一张卡 423e4567-e89b-12d3-a456-426614174000 该复习了"), true);
  assert.equal(containsInternalToken("正常的中文句子"), false);
});

test("语义去重：bigram 降级 + embedding 阈值", () => {
  assert.equal(isDuplicateThought("有 5 条复习到期了，要过一遍吗？", {
    recentTexts: ["有 5 条复习到期了，要过一遍吗？"],
    recentEmbeddings: [],
    candidateEmbedding: null,
  }), true);
  assert.equal(isDuplicateThought("今天状态不错，来收个尾？", {
    recentTexts: ["连续 4 天都有学习，值得记一笔。"],
    recentEmbeddings: [],
    candidateEmbedding: null,
  }), false);

  const a = Array.from({ length: 8 }, (_, i) => (i % 2 === 0 ? 1 : 0));
  const b = Array.from({ length: 8 }, (_, i) => (i % 2 === 0 ? 1 : 0));
  const c = Array.from({ length: 8 }, (_, i) => (i % 2 === 0 ? 0 : 1));
  assert.ok(cosineSimilarity(a, b) > 0.99);
  assert.equal(cosineSimilarity(a, c), 0);
  assert.equal(isDuplicateThought("新念头文本", {
    recentTexts: [],
    recentEmbeddings: [b],
    candidateEmbedding: a,
  }), true);
});

test("反馈降权：最近 3 条里 dismiss ≥2 → 沉默", () => {
  assert.equal(shouldStaySilentForFeedback(["dismissed", "dismissed", "acted"]), true);
  assert.equal(shouldStaySilentForFeedback(["dismissed", "acted", "acted"]), false);
  assert.equal(shouldStaySilentForFeedback([]), false);
});

test("静默时段：跨午夜环绕 + 解析失败 fail closed", () => {
  const now = new Date("2026-09-18T18:30:00Z"); // UTC 18:30
  assert.equal(
    isWithinQuietHoursLocal({ startLocal: "23:00", endLocal: "07:00", timezone: "UTC" }, now),
    false,
  );
  assert.equal(
    isWithinQuietHoursLocal({ startLocal: "17:00", endLocal: "20:00", timezone: "UTC" }, now),
    true,
  );
  // 时区非法 → fail closed（宁可不打扰）
  assert.equal(
    isWithinQuietHoursLocal({ startLocal: "22:00", endLocal: "07:00", timezone: "Not/AZone" }, now),
    true,
  );
});

test("表达校验（切片③ grounding）：长度 / 泄露 / 实体命中", () => {
  const grounding = [{ name: "光的折射", entityRef: "card:223e4567-e89b-12d3-a456-426614174000" }];
  assert.equal(validateThoughtExpression("该回看「光的折射」了。", grounding), true);
  // grounding 非空但没提到实体 → 拒（不许说不存在的事）
  assert.equal(validateThoughtExpression("随便聊聊天气吧。", grounding), false);
  // 内部 ID → 拒
  assert.equal(validateThoughtExpression("光的折射 423e4567-e89b-12d3-a456-426614174000", grounding), false);
  // 超长 → 拒
  assert.equal(validateThoughtExpression("长".repeat(81), []), false);
  // 无 grounding 时普通句子通过
  assert.equal(validateThoughtExpression("随便聊聊天气吧。", []), true);
});

test("多候选挑一：第一个通过校验的胜出，全败返回 null", () => {
  const grounding = [{ name: "光的折射", entityRef: "card:x" }];
  assert.equal(selectThoughtExpression(["跑题的", "聊聊「光的折射」。"], grounding), "聊聊「光的折射」。",
  );
  assert.equal(selectThoughtExpression(["跑题的", "也跑题"], grounding), null);
});

test("表达 prompt：关系状态与最近说过的话都进 prompt", () => {
  const prompt = buildExpressionPrompt({
    petName: "Mao",
    familiarity: 0.42,
    allowPlayful: true,
    allowNudgeLearning: false,
    catchphrase: "一点点来",
    thoughtText: "有 5 条复习到期了。",
    groundingNames: [],
    recentlySaid: ["昨天说的那句话"],
  });
  assert.ok(prompt.includes("0.42"));
  assert.ok(prompt.includes("一点点来"));
  assert.ok(prompt.includes("催学习=不要"));
  assert.ok(prompt.includes("昨天说的那句话"));
});

test("向量文本解析", () => {
  assert.deepEqual(parseVectorText("[1,2,3]"), [1, 2, 3]);
  assert.equal(parseVectorText("not a vector"), null);
  assert.equal(parseVectorText("[1,x,3]"), null);
});
