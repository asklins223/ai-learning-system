import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildExtractMessages,
  isVolatileStatisticMemory,
  memoryExtractOutputSchema,
  parseMemoryExtractJson,
} from "./companion-memory-extractor.ts";

test("isVolatileStatisticMemory：拦『现在这一份』统计，不拦用户说过的带数字偏好", () => {
  // 实机被写进 learning_context 的那条（里面的 23 分钟本来就是编的）。
  assert.equal(isVolatileStatisticMemory("截至当前，用户本周累计学习时长为23分钟，拥有10张活跃卡片和9篇笔记。"), true);
  assert.equal(isVolatileStatisticMemory("用户今天学了 45 分钟。"), true);
  // 稳定偏好：带数字但不是"当下这份统计"。
  assert.equal(isVolatileStatisticMemory("每天只能挤出四十分钟学习，希望练习节奏短一点"), false);
  assert.equal(isVolatileStatisticMemory("用户偏好短节奏学习，每次练习约10分钟，每天总计约40分钟，中间需休息。"), false);
  assert.equal(isVolatileStatisticMemory("下个月要考日语N3"), false);
  // 名字里带量词的卡/笔记标题不是统计。误判的后果是**这条记忆根本没写进去**——
  // 比误放难发现得多（气泡那条同判据已经踩过一次，见 companion-thought 的 readsOutStatistics）。
  assert.equal(isVolatileStatisticMemory("今天学了「背 3 条法律」那张卡，还没掌握。"), false);
  assert.equal(isVolatileStatisticMemory("本周把《每天 5 张图》那篇读完了。"), false);
  // 掩码只洗名字：名字之外的读数照样要拦。
  assert.equal(isVolatileStatisticMemory("今天学了「背 3 条法律」那张卡，另外累计 45 分钟。"), true);
});

test("memory extract messages: 包含 system 提示与拼接对话", () => {
  const messages = buildExtractMessages({
    userText: "我喜欢语音讲解",
    assistantText: "好呀，以后多用语音。",
    recent: [{ role: "user", text: "今天学光合作用" }],
  });
  assert.equal(messages.length, 2);
  assert.match(messages[0].content, /记忆整理器/);
  assert.match(messages[1].content, /我喜欢语音讲解/);
});

test("memory extract schema: 合法候选通过，低置信仍可解析", () => {
  const parsed = memoryExtractOutputSchema.safeParse({
    version: 1,
    candidates: [
      { kind: "preference", content: "喜欢语音讲解", importance: 0.7, confidence: 0.8, scope: "workspace", linkedEntityIds: [] },
    ],
  });
  assert.equal(parsed.success, true);
  if (parsed.success) assert.equal(parsed.data.candidates[0].kind, "preference");
});

test("parseMemoryExtractJson: 纯 JSON 原样解析", () => {
  const out = parseMemoryExtractJson('{"version":1,"candidates":[]}');
  assert.deepEqual(out, { version: 1, candidates: [] });
});

test("parseMemoryExtractJson: ```json fence 包裹可剥离解析", () => {
  const out = parseMemoryExtractJson('```json\n{"version":1,"candidates":[{"kind":"preference","content":"喜欢安静","importance":0.6,"confidence":0.9,"scope":"workspace","linkedEntityIds":[]}]}\n```');
  assert.equal((out as { candidates: unknown[] }).candidates.length, 1);
});

test("parseMemoryExtractJson: 前后赘述提取首个 JSON 片段", () => {
  const out = parseMemoryExtractJson('好的，这是提取结果：{"version":1,"candidates":[]} 希望对你有帮助');
  assert.deepEqual(out, { version: 1, candidates: [] });
});

test("parseMemoryExtractJson: 全形态失败抛 SyntaxError", () => {
  assert.throws(() => parseMemoryExtractJson("完全不是 JSON"), SyntaxError);
});

// ─── schema 宽容度（§9.11：88 次解析失败的主因是契约没告诉模型、又卡得死）──
// 模型自然输出的是"最小可用形状"，schema 必须接住它。

test("schema：省略 version 字段可解析（以前 z.literal(1) 必填 → 整单失败）", () => {
  const out = memoryExtractOutputSchema.safeParse({
    candidates: [{ kind: "goal", content: "下个月考日语N3", confidence: 0.9 }],
  });
  assert.equal(out.success, true, JSON.stringify(out.success ? {} : out.error.issues));
  if (out.success) {
    assert.equal(out.data.version, 1, "version 应回填默认 1");
    assert.equal(out.data.candidates[0].importance, 0.5, "importance 有默认");
    assert.equal(out.data.candidates[0].scope, "workspace", "scope 有默认");
    assert.deepEqual(out.data.candidates[0].linkedEntityIds, []);
  }
});

test("schema：超过 3 条时截断保留前 3 条，而不是判整单失败", () => {
  const many = Array.from({ length: 5 }, (_, i) => ({
    kind: "preference", content: `偏好 ${i}`, confidence: 0.8,
  }));
  const out = memoryExtractOutputSchema.safeParse({ candidates: many });
  assert.equal(out.success, true);
  if (out.success) assert.equal(out.data.candidates.length, 3);
});

test("schema：confidence 仍必填——它是置信度闸的输入，给默认值等于替模型表态", () => {
  const out = memoryExtractOutputSchema.safeParse({
    candidates: [{ kind: "goal", content: "没有置信度的条目" }],
  });
  assert.equal(out.success, false);
});

test("schema：kind 非法枚举仍被拒（宽容只针对缺省，不针对错值）", () => {
  const out = memoryExtractOutputSchema.safeParse({
    candidates: [{ kind: "secret", content: "不该被接受", confidence: 0.9 }],
  });
  assert.equal(out.success, false);
});

test("prompt 必须把 JSON 形状与枚举写给模型（契约不能只在代码里）", () => {
  const messages = buildExtractMessages({ userText: "u", assistantText: "a", recent: [] });
  const system = messages[0].content;
  assert.ok(system.includes('"candidates"'), "prompt 未给出 JSON 形状");
  for (const kind of ["goal", "preference", "learning_context", "interaction_note", "episodic"]) {
    assert.ok(system.includes(kind), `prompt 未列出枚举 ${kind}`);
  }
  assert.ok(system.includes("confidence"), "prompt 未说明 confidence");
});

// ─── 候选记忆冷静期（方案 29 §11 C2）：SQL 与 TS 必须是同一个判据 ──────────────
// 0256 那条迁移里的解禁规则跑在 plpgsql（SECURITY DEFINER，跨用户扫），
// 判据的正主是这个文件的 isVolatileStatisticMemory。两处各写一份正则，
// 早晚会漂——这条测试把两边按同一批样本对齐，漂了就红。
import { readFileSync, readdirSync } from "node:fs";

function migrationStatTests(): { window: RegExp; quantity: RegExp } {
  const url = new URL(
    "../../../../apps/api/src/db/migrations/0256_companion_candidate_memory_cooling_off.sql",
    import.meta.url,
  );
  const sqlText = readFileSync(url, "utf8");
  const patterns = [...sqlText.matchAll(/content ~ '([^']+)'/g)].map((m) => m[1]);
  assert.equal(patterns.length, 2, "迁移里应当有两条 content ~ '…' （时间窗 + 量词）");
  return { window: new RegExp(patterns[0]), quantity: new RegExp(patterns[1]) };
}

test("0256 的解禁例外与抽取器的统计判据逐样本一致", () => {
  const { window, quantity } = migrationStatTests();
  const sqlBlocks = (content: string) => window.test(content) && quantity.test(content);
  for (const content of [
    "截至当前，用户本周累计学习时长为23分钟，拥有10张活跃卡片和9篇笔记。",
    "用户今天学了 45 分钟。",
    "这一阵他打开了 12 张卡。",
    "这周要掌握光合作用的 3 个阶段。",
    // 下面三条都不该被例外挡住：没有"当前时间窗"，或数字只在名字里。
    "用户说每天只能挤出 40 分钟。",
    "卡片「背 3 条法律」还没复习。",
    "喜欢用语音念题。",
  ]) {
    assert.equal(
      sqlBlocks(content), isVolatileStatisticMemory(content),
      `判据漂移：${content}`,
    );
  }
});

// 已知且**故意保留**的差异：TS 侧先把「…」/《…》里的内容遮掉再判，SQL 侧没有那一步，
// 所以"数字只出现在名字里、又恰好带时间窗"的行在 SQL 侧更严——代价只是这条候选
// 多等一天（手动确认那条路不受影响），反向的误放在这里是要命的那一侧。
test("0256 的例外比抽取器更严，方向必须是这样", () => {
  const { window, quantity } = migrationStatTests();
  const content = "本周的计划写在《背 3 条法律》里。";
  assert.equal(isVolatileStatisticMemory(content), false, "TS 遮掉名字后不该判成统计");
  assert.equal(window.test(content) && quantity.test(content), true, "SQL 侧应当更严");
});

// ─── 产 JSON 的伴星调用一律关思考（§9.71 那根因的自动兜底）────────────────────
// 摘要器当年"建表以来 0 行"的三个根因里，最难自己浮出来的就是这个：思考 token 吃满
// maxTokens 之后 content 为空，JSON 解析失败，job 一路重试到 dead。修了摘要器、
// 日记、念头，抽取器漏了整整一天（实机 2026-09-22：dead 里 OUTPUT_INVALID 与
// provider_http_400 各一条）。这条不测行为，测的是"下一个新增的取回调用别再漏"。
test("每个用 json_object 取回的伴星 handler 都必须 withThinkingDisabled", () => {
  const dir = new URL(".", import.meta.url);
  const offenders = readdirSync(dir)
    .filter((name) => name.startsWith("companion-") && name.endsWith(".ts") && !name.includes(".test."))
    .filter((name) => {
      const text = readFileSync(new URL(name, dir), "utf8");
      return text.includes('responseFormat: "json_object"') && !text.includes("withThinkingDisabled(");
    });
  assert.deepEqual(offenders, [], `这些 handler 产 JSON 却没关思考：${offenders.join(", ")}`);
});
