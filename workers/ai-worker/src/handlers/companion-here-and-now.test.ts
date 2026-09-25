import assert from "node:assert/strict";
import { test } from "node:test";
import {
  asksForBoundaryChange,
  asksForLearningStats,
  extractNoteTitleReference,
  noteOpeningExcerpt,
  renderHereAndNow,
  summarizeLearningStats,
  weekdayLabel,
  type HereAndNowSnapshot,
} from "./companion-here-and-now.ts";

function snapshot(overrides: Partial<HereAndNowSnapshot> = {}): HereAndNowSnapshot {
  return {
    localTime: "2026-09-20 18:12",
    weekday: "周六",
    partOfDay: "晚上",
    minutesSinceLastSeen: null,
    pet: null,
    activeRun: null,
    dueReviews: 0,
    today: { studySeconds: 0, runs: 0 },
    recentNotes: [],
    noteCount: 0,
    pendingProposals: 0,
    nextReminder: null,
    noteReference: null,
    imagesReadable: false,
    currentPage: null,
    livePageView: null,
    learningStats: null,
    factSpans: null,
    boundaryFacts: null,
    ...overrides,
  };
}

test("答应的提醒会出现在她知道的当下（不记得自己许过约，比没答应更伤）", () => {
  const block = renderHereAndNow(snapshot({
    nextReminder: { text: "把消防笔记的疏散路线过一遍", fireAtLocal: "09-21 09:00" },
  }));
  assert.ok(block?.includes("09-21 09:00"));
  assert.ok(block?.includes("消防笔记"));
});

test("用户点名的笔记：找到就给 id，没找到也不给她「它不存在」这个结论", () => {
  const found = renderHereAndNow(snapshot({
    noteReference: { title: "欧姆定律生成验收", found: true, noteId: "b4ab4749-d888-4b93-9019-e33b74679206", ageLabel: "4 天前", imageCount: 0, opening: null, openRuns: [], nearest: null },
  }));
  assert.ok(found?.includes("b4ab4749-d888-4b93-9019-e33b74679206"));
  assert.ok(found?.includes("companion_read_note"));

  const missing = renderHereAndNow(snapshot({
    noteReference: { title: "欧姆定律生成验收", found: false, noteId: null, ageLabel: null, imageCount: 0, opening: null, openRuns: [], nearest: null },
  }));
  assert.ok(missing?.includes("按标题没找到"));
  // 关键：这一行必须把她推向"再查一次/照实说"，而不是让她有依据地下假结论
  assert.ok(missing?.includes("companion_search_notes"));
  assert.ok(!missing?.includes("不存在"));
});

/**
 * "库里没有匹配"由服务端替她说完，还附赠一个更接近的真东西（39b §9.3 第二行）。
 *
 * 这一行是**未命中**时才有的：没有它，她手上只有一个"没找到"，于是"库里没有这篇"
 * 这句话在她的世界里就是成立的（那正是实机里可证伪的那句假阴性）。
 */
test("《标题》没对上时给出最接近的一篇，命中时反而不能提", () => {
  const withNearest = renderHereAndNow(snapshot({
    noteReference: {
      title: "欧姆定律生成验收", found: false, noteId: null, ageLabel: null, imageCount: 0, opening: null,
      openRuns: [], nearest: { title: "欧姆定律生成验收稿", score: 0.62 },
    },
  }));
  assert.ok(withNearest?.includes("最接近的是《欧姆定律生成验收稿》"));
  assert.ok(withNearest?.includes("0.62"), "相似度要一起给，她才能判断该不该信这一条");
  assert.ok(withNearest?.includes("不要替笔记库下"));

  const found = renderHereAndNow(snapshot({
    noteReference: {
      title: "欧姆定律生成验收", found: true, noteId: "b4ab4749-d888-4b93-9019-e33b74679206",
      ageLabel: "4 天前", imageCount: 0, opening: null, openRuns: [], nearest: null,
    },
  }));
  assert.ok(!found?.includes("最接近的是"), "命中时还提最接近的，等于把真对象说成近似的");
});

/**
 * `start`/`resume` 的服务端回填（39b §9.8 的 C1）：用户说"继续学《X》"，她手上要
 * **先**有"这篇有几轮、什么状态、runId 是哪个"——否则那两个工具只能服务端替她挑最近一条，
 * 挑错了用户看不出为什么动的不是这一篇。
 */
test("点名的笔记上有没结束的轮次：给出轮数与 runId，并指向 resume", () => {
  const block = renderHereAndNow(snapshot({
    noteReference: {
      title: "数据库索引优化策略", found: true, noteId: "b4ab4749-d888-4b93-9019-e33b74679206",
      ageLabel: "2 小时前", imageCount: 0, opening: null, nearest: null,
      openRuns: [
        { id: "11111111-1111-4111-8111-111111111111", phase: "paused" },
        { id: "22222222-2222-4222-8222-222222222222", phase: "active" },
      ],
    },
  }));
  assert.ok(block?.includes("有 1 轮学习正在进行中"));
  assert.ok(block?.includes("有 1 轮学习在暂停中"));
  assert.ok(block?.includes("22222222-2222-4222-8222-222222222222"), "进行中的那一轮没给 runId");
  assert.ok(block?.includes("companion_resume_learning"), "没把她推向「接着这一轮」，她会另起一轮");

  // 反向对照：没有没结束的轮次时一个字都不提（多写的"0 轮"就是噪音，也可能被她念出来）。
  const none = renderHereAndNow(snapshot({
    noteReference: {
      title: "数据库索引优化策略", found: true, noteId: "b4ab4749-d888-4b93-9019-e33b74679206",
      ageLabel: "2 小时前", imageCount: 0, opening: null, openRuns: [], nearest: null,
    },
  }));
  assert.ok(!none?.includes("在暂停中"));
});

/**
 * 图的事实要在她说之前就在场（实机 2026-09-21 场景 Z）。
 *
 * 她零工具的那句"我把这篇笔记的正文读完了，里面没有截图"并不是随口撒谎——她读的是
 * `note_blocks`，而图在另一张表里，所以**照实读正文也会推出"没有图"**。这种假阴性
 * 靠事后闸拦只能救回一次（并且要先付一步假话），把图数当数据注入才是根治。
 */
test("有图就先把图数交给她：看不了时禁止承诺，能看时指向 companion_read_image", () => {
  const denied = renderHereAndNow(snapshot({
    imagesReadable: false,
    noteReference: { title: "IndexTTS 2.5", found: true, noteId: "a7aa823c-f2cf-4b3d-bda1-37a6eca14bce", ageLabel: "3 天前", imageCount: 6, opening: null, openRuns: [], nearest: null },
  }));
  assert.ok(denied?.includes("6 张图"));
  assert.ok(denied?.includes("图片外发没开启"));
  assert.ok(denied?.includes("允许发送图片内容"), "拒绝也要给得出路，否则用户只会听到一句「看不了」");
  assert.ok(denied?.includes("正文没有图片标记不代表没有图"), "要挡住她由正文推「没有图」的那步推理");
  assert.ok(denied?.includes("不要说「我看看这张图」"));

  const readable = renderHereAndNow(snapshot({
    imagesReadable: true,
    noteReference: { title: "IndexTTS 2.5", found: true, noteId: "a7aa823c-f2cf-4b3d-bda1-37a6eca14bce", ageLabel: "3 天前", imageCount: 2, opening: null, openRuns: [], nearest: null },
  }));
  assert.ok(readable?.includes("companion_read_image"));
  assert.ok(!readable?.includes("图片外发没开启"), "政策开着时不能告诉她看不了");

  // 没图时一个字都不提：多出来的那句"另有一张图"本身就是假事实。
  const none = renderHereAndNow(snapshot({
    noteReference: { title: "欧姆定律", found: true, noteId: "b4ab4749-d888-4b93-9019-e33b74679206", ageLabel: "4 天前", imageCount: 0, opening: null, openRuns: [], nearest: null },
  }));
  assert.ok(!none?.includes("张图"));
});

test("《标题》形态只从用户这句话里取，且限长", () => {
  assert.equal(extractNoteTitleReference("《欧姆定律生成验收》那篇写了什么？"), "欧姆定律生成验收");
  assert.equal(extractNoteTitleReference("先看《A》再看《B》"), "A");
  assert.equal(extractNoteTitleReference("今天好累啊"), null);
  assert.equal(extractNoteTitleReference("《".repeat(40)), null);
});

test("DOW → 中文星期：0=周日 … 6=周六（下标写错会天天报错星期）", () => {
  assert.equal(weekdayLabel(0), "周日");
  assert.equal(weekdayLabel(1), "周一");
  assert.equal(weekdayLabel(5), "周五");
  assert.equal(weekdayLabel(6), "周六");
});

test("空状态只有一行时钟时整块不注入", () => {
  assert.equal(renderHereAndNow(snapshot()), null);
});

test("有值行才渲染，空行不进 prompt", () => {
  const block = renderHereAndNow(snapshot({
    dueReviews: 41,
    today: { studySeconds: 1560, runs: 2 },
    activeRun: { topic: "贝叶斯更新", phase: "active", usedSeconds: 240, budgetSeconds: 600, taskPrompt: "解释先验概率" },
  }))!;
  assert.match(block, /^<here_and_now>\n/);
  assert.match(block, /\n<\/here_and_now>$/);
  assert.match(block, /现在：2026-09-20 18:12 周六（晚上）/);
  assert.match(block, /正在学习「贝叶斯更新」，正在做：解释先验概率/);
  assert.match(block, /到期待复习 41 项/);
  // 没有笔记、没有待确认动作、没有宠物档案 → 这三行必须整个不出现，而不是写成"无"。
  assert.doesNotMatch(block, /最近笔记/);
  assert.doesNotMatch(block, /还有 .* 个动作/);
  assert.doesNotMatch(block, /你是「/);
  assert.doesNotMatch(block, /无/);
});

/**
 * 实机 2026-09-21 22:00：用户只发了「嘿嘿」两个字，她回的是
 * 「嘿嘿什么呀，是不是偷偷在笑我。要不要把刚才那步回忆先说两句给我听？今天已经学了 42 分钟，
 * 本周累计 99 分钟。」——42 分钟就是这一块里 `今日已学 42 分钟` 被原样念出来的，
 * 99 分钟是她顺手调 `companion_get_learning_stats` 换来的（steps=2 tools=1，没人问）。
 *
 * 环境块的职责是"她知道此刻是什么状况"，不是"她有台词可念"。时长/次数这一类
 * **只能进判断、不能进嘴**的数字从这里撤掉；用户真问"我今天学了多久"时她走工具，
 * 那条路刚实测是通的（同一口径、succeeded）。
 *
 * 到期数留着有原因：`claimsNothingDueAgainstFacts` 就靠这一行识破"到期列表是空的"
 * 那句假阴性（§9.41），撤掉它等于把闸拆了——所以这条测试两头都钉。
 */
test("环境块不给可念的时长与计数：知道 ≠ 念出来", () => {
  const block = renderHereAndNow(snapshot({
    dueReviews: 41,
    today: { studySeconds: 1_560, runs: 2 },
    noteCount: 828,
    recentNotes: [{ title: "贝叶斯笔记", ageLabel: "刚刚" }],
    pet: { name: "Mao", activeness: "moderate", interactionCount: 137 },
    activeRun: { topic: "贝叶斯更新", phase: "active", usedSeconds: 240, budgetSeconds: 600, taskPrompt: null },
  }))!;
  assert.doesNotMatch(block, /今日已学|个学习运行/);
  assert.doesNotMatch(block, /累计互动|137/);
  assert.doesNotMatch(block, /笔记库共|828/);
  assert.doesNotMatch(block, /已学 \d+ 分钟|计划 \d+ 分钟/);
  // 该在的还得在：否则"整块删空"也能骗过上面四条否定式断言。
  assert.match(block, /到期待复习 41 项/);
  assert.match(block, /正在学习「贝叶斯更新」/);
  assert.match(block, /你是「Mao」/);
  assert.match(block, /《贝叶斯笔记》\(刚刚\)/);
});

test("久未见面才提示间隔，刚聊过不打扰", () => {
  assert.doesNotMatch(renderHereAndNow(snapshot({ minutesSinceLastSeen: 5 })) ?? "", /距上次/);
  assert.match(renderHereAndNow(snapshot({ minutesSinceLastSeen: 20 })) ?? "", /距上次和用户说话：20 分钟前/);
  assert.match(renderHereAndNow(snapshot({ minutesSinceLastSeen: 60 * 26 })) ?? "", /距上次和用户说话：昨天/);
});

test("笔记标题与目标超长被截断，不撑爆每轮 token", () => {
  const block = renderHereAndNow(snapshot({
    activeRun: { topic: "一".repeat(80), phase: "active", usedSeconds: 0, budgetSeconds: null, taskPrompt: null },
    recentNotes: [{ title: "《嵌套》书名号里还有很长的标题一直到需要截断的程度", ageLabel: "刚刚" }],
    noteCount: 828,
  }))!;
  // 标题里带书名号也不能把整行撑爆：按 20 字截断加省略号（不做嵌套解析，那是渲染层的事）。
  const noteLine = block.split("\n").find((line) => line.startsWith("最近笔记"))!;
  assert.match(noteLine, /《.*?…》\(刚刚\)$/);
  assert.ok(noteLine.length < 60, `笔记行应被截住，实际 ${noteLine.length}`);
  assert.ok(block.length < 400, `整块应控制在几百字符内，实际 ${block.length}`);
});

/**
 * 用户这句话在要学习数据吗（实机 2026-09-22 场景 B/N）。
 *
 * 判据必须**保守**：漏了的代价只是她自己再去调一次工具（今天就是这样），
 * 误判的代价是把"没问也报数"重新请回来——那正是 §9.60 刚赶出去的东西。
 */
test("asksForLearningStats：只认明确在要学习数据的说法", () => {
  for (const text of [
    "我今天一共学了多久了？",
    "我这周总共学了多久？现在有多少张活跃卡片、多少篇笔记？",
    "今天学了多长时间啦",
    "我现在有多少个东西到期该复习了？",
    "最近的学习进度怎么样？",
  ]) {
    assert.equal(asksForLearningStats(text), true, `该认出来：${text}`);
  }
  for (const text of [
    "嘿嘿", "哈哈", "你笑什么嘛",
    "这道题怎么做？",
    "帮我记住：我习惯在图书馆三楼复习。",
    "《欧姆定律生成验收》那篇笔记里写了什么？",
    "把这张卡打开看看",
    undefined, "",
  ]) {
    assert.equal(asksForLearningStats(text), false, `不该误判：${text}`);
  }
});

test("问到学习数据时：环境块只给指路，数值由 <fact_spans> 渲染（一处一个来源）", () => {
  const stats = {
    todayMinutes: 33, weekMinutes: 154, dueReviews: 25,
    dueNext24Hours: 8, activeCards: 16, noteCount: 11,
  };
  const asked = renderHereAndNow(snapshot({ learningStats: stats }))!;
  // 39d W2-5：数值**撤出环境块**，只留指路与防复读那半句（历史里的旧数仍要被降级）。
  assert.match(asked, /可报的读数在 <fact_spans> 里/);
  assert.match(asked, /要报就写 \{\{f:key\}\}/);
  assert.match(asked, /历史对话里.*可能已经变/);
  assert.doesNotMatch(asked, /33 分钟/, "数值不许在环境块里再渲染一遍（那样就有两处来源了）");
  assert.doesNotMatch(renderHereAndNow(snapshot()) ?? "", /可报的读数在 <fact_spans> 里/);
  // 工具与环境块共用同一份摘要，口径不能两份。
  assert.equal(summarizeLearningStats(stats), "今日 33 分钟，本周 154 分钟，到期复习 25 项");
});

/**
 * 用户这一轮要改她的行为边界吗（实机 2026-09-22 场景 T）。
 *
 * 判据同样保守，理由与学习数据那条一样：误判只是多一行她用得上的事实，
 * 漏判则让她在不知道"现在到底是什么状态"的情况下张口承诺——
 * 实测她说过"嗯，这条早就设好了喵"，而库里 `allowNudgeLearning` 还是 true。
 */
test("asksForBoundaryChange：只认明确要改边界/口吻的说法", () => {
  for (const text of [
    "以后别主动催我复习，我不问你别说。",
    "别催我学习了",
    "给你自己加个口头禅：就这么定了",
    "把玩趣关掉",
    "以后不要主动提醒我复习",
  ]) {
    assert.equal(asksForBoundaryChange(text), true, `该认出来：${text}`);
  }
  for (const text of [
    "我今天一共学了多久了？",
    "帮我记住：我习惯在图书馆三楼复习。",
    "嘿嘿", "哈哈",
    "这道题怎么做？",
    undefined, "",
  ]) {
    assert.equal(asksForBoundaryChange(text), false, `不该误判：${text}`);
  }
});

test("要改边界时，当前状态先摆出来；说「记住了」不等于改了", () => {
  const asked = renderHereAndNow(snapshot({
    boundaryFacts: { allowNudgeLearning: true, allowPlayful: true, allowVoiceTags: false },
  }))!;
  assert.match(asked, /催复习=开着/);
  assert.match(asked, /语音情绪标签=关着/);
  // 这一句是这次要买的后果：她以前把"应下来"当成"已经改好了"。
  assert.match(asked, /光答"记下了"什么都没变/);
  assert.doesNotMatch(renderHereAndNow(snapshot()) ?? "", /催复习=/);
});

// §12.5 ①：她把"原文"编成课本话，是因为手上只有一句"要看正文就调工具"，
// 而没有任何一段真文本。注进首块开头之后，她不必补，也不该拿这段往下补。
test("noteOpeningExcerpt：只取第一句、压换行、封顶 120 字", () => {
  assert.equal(
    noteOpeningExcerpt("欧姆定律说明，\n在电阻不变时，电流与电压成正比，公式为 I=U/R。\n例如电压增加一倍。"),
    "欧姆定律说明， 在电阻不变时，电流与电压成正比，公式为 I=U/R。",
  );
  assert.equal(noteOpeningExcerpt("没有句号的整段".repeat(30))!.length, 121,
    "超长要截断并留省略号");
  assert.equal(noteOpeningExcerpt(null), null);
  assert.equal(noteOpeningExcerpt("   \n  "), null);
});

test("点名的笔记找到时，快照里带出真开头并注明不许往下补", () => {
  const block = renderHereAndNow(snapshot({
    noteReference: {
      title: "欧姆定律生成验收", found: true, noteId: "b4ab4749-d888-4b93-9019-e33b74679206",
      ageLabel: "4 天前", imageCount: 0, opening: "欧姆定律说明，在电阻不变时，电流与电压成正比。",
      openRuns: [], nearest: null,
    },
  }));
  assert.ok(block?.includes("这篇的开头是：「欧姆定律说明，在电阻不变时，电流与电压成正比。」"));
  assert.ok(block?.includes("不要照这段往下补"), "要同时点名边界：只有开头，更长的还得去读");
});

/**
 * 当前屏的**状态行**折进环境块（39d W2-2，worker 侧感知通道）。
 *
 * 她过去只读得到"用户正在看笔记《X》"，读不到那一屏上正在发生什么——而后者才是用户
 * 问"这一页怎么了"时要答的东西。`statusLine` 来自该页自己发布的 `readable_view`
 * （P4-a 五页登记，逐字），所以这一条的可见行为必须钉住。
 */
test("当前屏有状态行时，折进「用户正在看」后面那一行", () => {
  const block = renderHereAndNow(snapshot({
    currentPage: { kind: "笔记", title: "数据库索引优化策略", statusLine: "● 有改动还没保存" },
  }));
  assert.ok(block?.includes("用户正在看笔记《数据库索引优化策略》"));
  assert.ok(block?.includes("这一屏：● 有改动还没保存"), "状态行要逐字带过去");
});

test("没有状态行时不多渲染那一行（少一行好过多一行假的）", () => {
  const block = renderHereAndNow(snapshot({
    currentPage: { kind: "笔记", title: "数据库索引优化策略", statusLine: null },
  }));
  assert.ok(block?.includes("用户正在看笔记《数据库索引优化策略》"));
  assert.ok(!block?.includes("这一屏："), "statusLine 为 null 时不该出现这一行");
});

test("状态行过长时截断，不把整段塞进环境块", () => {
  const long = "● ".concat("很长的状态说明".repeat(20));
  const block = renderHereAndNow(snapshot({
    currentPage: { kind: "笔记", title: "X", statusLine: long },
  }));
  assert.ok(block);
  assert.ok(!block.includes(long), "原样的超长状态行不该整段进块");
  assert.ok(block.includes("这一屏："));
});
