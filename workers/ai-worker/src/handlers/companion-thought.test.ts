import { test } from "node:test";
import assert from "node:assert/strict";
import { containsCompanionInternalToken } from "./companion-dialogue-content.ts";
import {
  buildDeterministicThoughts,
  buildExpressionPrompt,
  cosineSimilarity,
  isDuplicateThought,
  introducesUnverifiedNumbers,
  readsOutStatistics,
  parseThoughtCandidates,
  parseVectorText,
  selectThoughtExpression,
  splitActiveThoughts,
  validateThoughtExpression,
  type ThoughtMaterial,
} from "./companion-thought.ts";

function baseMaterial(overrides: Partial<ThoughtMaterial> = {}): ThoughtMaterial {
  return {
    today: "2026-09-18",
    readyReviews: 0,
    dueSoonReviews: 0,
    dueReviewTitles: [],
    soonDueTitles: [],
    streakDays: 0,
    daysSinceLastLearning: null,
    familiarity: 0,
    petName: "Mao",
    allowNudgeLearning: true,
    allowPlayful: true,
    catchphrase: null,
    recentlySaid: [],
    msSinceLastRoutineCue: null,
    recentThoughtEmbeddings: [],
    recentDeliveryStates: [],
    blockedDedupeKeys: new Set(),
    storedCandidates: new Map(),
    facts: null,
    ...overrides,
  };
}

test("确定性念头：复习到期/连续学习/惰性 三条规则", () => {
  const due = buildDeterministicThoughts(baseMaterial({
    readyReviews: 5, dueReviewTitles: ["牛顿第二定律的比例关系"],
  }));
  assert.equal(due.length, 1);
  assert.equal(due[0].source, "review_due");
  assert.equal(due[0].dedupeKey, "review_due:2026-09-18");
  // 说的是**哪一张**，不是有几条：计数是系统统计，不是她开口的方式（用户 2026-09-21）。
  assert.ok(due[0].text.includes("牛顿第二定律的比例关系"), due[0].text);
  assert.equal(/\d/.test(due[0].text), false, `气泡里不该出现数字：${due[0].text}`);

  // 有到期但说不出是哪一张 → 宁可不提，也不退回成"有 5 条到期了"
  assert.equal(buildDeterministicThoughts(baseMaterial({ readyReviews: 5 })).length, 0);

  const streak = buildDeterministicThoughts(baseMaterial({ streakDays: 4 }));
  assert.equal(streak[0].source, "streak");
  assert.equal(/\d/.test(streak[0].text), false, `连续学习也不该报天数：${streak[0].text}`);

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
  // 同 dedupeKey 已经说出口 → 不重复生成
  assert.equal(
    buildDeterministicThoughts(baseMaterial({ readyReviews: 5, blockedDedupeKeys: new Set(["review_due:2026-09-18"]) })).length,
    0,
  );
});

test("确定性念头：12 小时内将要到期的复习单独成一条（用户『稍后』掉的批次也要提）", () => {
  const soon = buildDeterministicThoughts(baseMaterial({
    dueSoonReviews: 25, soonDueTitles: ["消防疏散四步"],
  }));
  assert.equal(soon.length, 1);
  assert.equal(soon[0].topic, "review_due_soon");
  assert.equal(soon[0].dedupeKey, "review_due_soon:2026-09-18");
  assert.ok(soon[0].text.includes("消防疏散四步"), soon[0].text);
  assert.equal(/\d/.test(soon[0].text), false, `12 小时那档也不报条数：${soon[0].text}`);
  // 到期与将要到期同时存在 → 两条都在，按 urgency 排序由编排层负责
  assert.equal(buildDeterministicThoughts(baseMaterial({
    readyReviews: 3, dueSoonReviews: 8,
    dueReviewTitles: ["欧姆定律生成验收"], soonDueTitles: ["消防疏散四步"],
  })).length, 2);
  // 不允许催学习 → 两条都不生成
  assert.equal(
    buildDeterministicThoughts(baseMaterial({
      readyReviews: 3, dueSoonReviews: 8, allowNudgeLearning: false,
      dueReviewTitles: ["欧姆定律生成验收"], soonDueTitles: ["消防疏散四步"],
    })).length, 0,
  );
});

test("未过期念头分流：说过的封键、没说出口的按 key 留作待送", () => {
  const split = splitActiveThoughts([
    { dedupe_key: "review_due:2026-09-18", status: "delivered", id: "a" },
    { dedupe_key: "llm:2026-09-18:beef", status: "candidate", id: "b" },
    { dedupe_key: "streak:2026-09-18", status: "spent", id: "c" },
  ]);
  assert.deepEqual([...split.blockedDedupeKeys].sort(), ["review_due:2026-09-18", "streak:2026-09-18"]);
  assert.equal(split.storedCandidates.get("llm:2026-09-18:beef"), "b");
  // 同一 key 既有 candidate 又有 delivered → 以"说过"为准，不再送
  assert.equal(splitActiveThoughts([
    { dedupe_key: "k", status: "candidate", id: "1" },
    { dedupe_key: "k", status: "delivered", id: "2" },
  ]).storedCandidates.has("k"), false);
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

test("LLM 念头按内容而不是按序号去重", () => {
  // 序号去重会让同一天靠后的调度必然产不出候选：模型说的全新那句话只要排在第 0 位，
  // 就和上一轮的第 0 位撞 key 被丢掉。
  const one = parseThoughtCandidates(
    JSON.stringify({ thoughts: [{ text: "同一句话。", topic: "t" }, { text: "另一句话。", topic: "t" }] }),
    "2026-09-18",
  );
  const again = parseThoughtCandidates(
    JSON.stringify({ thoughts: [{ text: "同一句话。", topic: "t" }, { text: "换了个说法。", topic: "t" }] }),
    "2026-09-18",
  );
  assert.equal(one[0].dedupeKey, again[0].dedupeKey);
  assert.notEqual(one[1].dedupeKey, again[1].dedupeKey);
  assert.match(one[0].dedupeKey, /^llm:2026-09-18:[0-9a-f]{10}$/);
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
  assert.equal(containsCompanionInternalToken("有一张卡 423e4567-e89b-12d3-a456-426614174000 该复习了"), true);
  assert.equal(containsCompanionInternalToken("正常的中文句子"), false);
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

/**
 * 改写不许把数字改掉（实机 2026-09-21 查库发现的洞）。
 *
 * 数字型候选的 `grounding` 恒为 `[]`（库里那条"接下来 12 小时里有 25 条复习要到期"
 * 就是 `[]`），所以"必须命中实体名"那条对这型候选**整条形同虚设**：
 * 长度与 token 泄露之外什么都不管，模型可以把 25 改成任何数——而这句话的全部内容
 * 就是那个数。用户没问，气泡自己飘出来说话，被证伪一次比对话里说错更贵。
 */
test("气泡里的数字：统计形状一律拒，改写更不许改数字", () => {
  // 实机 2026-09-21：LLM 候选写出"今晚这42分钟学得很扎实"，那个 42 是环境块里的**真值**，
  // 所以"不许改数字"那道闸放它过了——但它是系统读数，不是她开口的方式。
  // 于是这一层先按**形状**拒，再按"改没改"拒：两句都得红。
  const source = "接下来 12 小时里有 25 条复习要到期，要不要提前扫一眼？";
  assert.equal(validateThoughtExpression(source, [], source), false, "照念原句也是读数，一样不送");
  assert.equal(validateThoughtExpression("明天有 3 条复习到期啦，先看一眼？", [], source), false);
  // 不提数字才是这条链路想要的表达；数字留在名字里是安全的。
  assert.equal(validateThoughtExpression("复习快到期啦，要不要先扫一眼？", [], source), true);
  // 改写这一路的 allowedSource 就是候选原句本身（数字出现在名字里也算有出处），
  // 所以这里传带名字的那句，而不是传上面那句计数模板。
  const titled = "《IndexTTS 2.5》那篇的原文要不要再给你看一眼？";
  assert.equal(validateThoughtExpression("《IndexTTS 2.5》那篇还想接着看吗？", [], titled), true,
    "数字是名字的一部分，不是统计");
  assert.equal(readsOutStatistics("今晚这42分钟学得很扎实"), true);
  assert.equal(readsOutStatistics("《IndexTTS 2.5》那篇还想接着看吗"), false);
  // 回落到模板原句由调用方负责（selectThoughtExpression 返回 null 时 expression 不变），
  // 代价只是少一点花样，不是没有气泡——这一点和对话链路相反，那边拒绝=用户没回答。
  assert.equal(selectThoughtExpression(["明天有 3 条到期啦"], [], "复习快到期啦"), null);
  assert.equal(introducesUnverifiedNumbers("学了 47 分钟", "学了 47 分钟"), false);
  assert.equal(introducesUnverifiedNumbers("学了 47 分钟", "今天学了一些"), true);
});

test("LLM 现编的念头里，服务端没给过的数字在解析这一步就被丢", () => {
  const facts = "今日已学 12 分钟；到期复习 3 条";
  const raw = JSON.stringify({
    thoughts: [
      { text: "今天学了 47 分钟，收个尾正好。", topic: "study_today" },
      { text: "今天学了 12 分钟，收个尾正好。", topic: "study_today" },
      { text: "还有 3 条到期，看完就轻松了。", topic: "review_due" },
    ],
  });
  const out = parseThoughtCandidates(raw, "2026-09-18", facts);
  // 47 从没被服务端说过 → 整条丢；12 与 3 都在事实里 → 留。
  assert.deepEqual(out.map((candidate) => candidate.text), [
    "今天学了 12 分钟，收个尾正好。",
    "还有 3 条到期，看完就轻松了。",
  ]);
  // 日期本身允许（09 与 9 归一化后同一个数），否则"9 月的最后一天"这种话会被误杀。
  assert.equal(parseThoughtCandidates(
    JSON.stringify({ thoughts: [{ text: "9 月最后一天啦。", topic: "date" }] }),
    "2026-09-30", facts,
  ).length, 1);
  // 不传 facts 也**不是关掉这道闸**：比较源里永远带着 `today`，所以没被服务端说过的
  // 数字仍然全丢。留一个可省的允许集只用于"改写已有候选"那一步（那里比的是原句）。
  assert.equal(parseThoughtCandidates(raw, "2026-09-18").length, 0);
  assert.equal(parseThoughtCandidates(raw, "2026-09-18", "学了 47 分钟").length, 1);
});

test("多候选挑一：第一个通过校验的胜出，全败返回 null", () => {  const grounding = [{ name: "光的折射", entityRef: "card:x" }];
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
    facts: "现在：2026-09-18 08:40 周五（早上）",
    thoughtText: "有 5 条复习到期了。",
    groundingNames: [],
    recentlySaid: ["昨天说的那句话"],
  });
  assert.ok(prompt.includes("0.42"));
  assert.ok(prompt.includes("一点点来"));
  assert.ok(prompt.includes("催学习=不要"));
  assert.ok(prompt.includes("昨天说的那句话"));
  // 主动开口的措辞要贴当下：时刻进的是**表达**层，不只是候选层，否则同一条念头
  // 早上和深夜会被写成同一句。
  assert.ok(prompt.includes("2026-09-18 08:40"));
  assert.ok(!buildExpressionPrompt({
    petName: "Mao",
    familiarity: 0.42,
    allowPlayful: true,
    allowNudgeLearning: false,
    catchphrase: null,
    facts: null,
    thoughtText: "有 5 条复习到期了。",
    groundingNames: [],
    recentlySaid: [],
  }).includes("你知道的当下"));
});

test("向量文本解析", () => {
  assert.deepEqual(parseVectorText("[1,2,3]"), [1, 2, 3]);
  assert.equal(parseVectorText("not a vector"), null);
  assert.equal(parseVectorText("[1,x,3]"), null);
});
