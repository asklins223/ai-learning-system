/**
 * Companion Agent 运行时单测（方案《将 AI 伴星升级为可扩展 Agent》§1/§2/§3/§4）。
 *
 * 覆盖运行时里不依赖 DB 的决策面——这些正是方案验收清单里"必须失败关闭"的部分：
 * - 工具面：每轮全给、只按权限档过滤（技能层已删，不再有"这轮选中了什么"）；
 * - 工具与权限：只读权限禁止一切写工具，guided/full 仍保留高危确认；
 * - provider 工具调用标识：越界 id/name 必须被阻止（不得进入审计表或 SSE）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  canUseCompanionAgentTool,
  getCompanionAgentTool,
  resolveAllCompanionAgentTools,
  validateCompanionAgentToolArguments,
} from "@ailearn/shared";
import {
  FINAL_ANSWER_HOLD_CHARS,
  boundedToolCallIdentity,
  actionSteerBudget,
  joinVisibleSegmentsDeduped,
  partitionPersonaPatch,
  planStepSteer,
  stepHoldChars,
  steerableToolNames,
  runStreamingAgentStep,
  safeArgumentsHash,
  taskQueueToolResult,
} from "./companion-agent-runtime.ts";
import { CompanionStreamStoppedError } from "./companion-dialogue-stream.ts";
import type { AIProvider } from "../lib/ai-provider.ts";

test("工具解析：只读权限下不存在任何写工具", () => {
  const readOnlyTools = resolveAllCompanionAgentTools("read_only");
  assert.ok(readOnlyTools.length > 0, "只读权限仍应保留读取工具");
  for (const definition of readOnlyTools) {
    assert.equal(definition.riskClass, "read", `${definition.name} 不应出现在只读权限中`);
    assert.equal(canUseCompanionAgentTool("read_only", definition).allowed, true);
  }
  // 计划类写工具在只读权限下必须被拒绝
  for (const name of ["companion_start_learning", "companion_pause_learning", "companion_defer_review"]) {
    const definition = getCompanionAgentTool(name);
    assert.ok(definition);
    assert.equal(canUseCompanionAgentTool("read_only", definition).allowed, false, `${name} 必须被只读权限阻止`);
    assert.equal(readOnlyTools.some((d) => d.name === name), false);
  }
});

test("工具解析：guided 自动执行可逆低风险，其余写操作一律确认", () => {
  const tools = resolveAllCompanionAgentTools("guided");
  assert.ok(tools.length > 0);
  for (const definition of tools) {
    const auth = canUseCompanionAgentTool("guided", definition);
    assert.equal(auth.allowed, true);
    // 读取永不确认；约定类写入（提醒）是用户亲口要过的、可逆且不改学习状态，
    // guided 下也直接执行；其余写操作一律先出提案。
    const autoExecutes = definition.riskClass === "read"
      || (definition.riskClass === "reversible_low" && !definition.requiresConfirmation);
    assert.equal(
      auth.requiresConfirmation,
      !autoExecutes,
      `${definition.name}（${definition.riskClass}）在 guided 下的确认要求不符`,
    );
  }
  // 图谱聚焦与提醒的建/撤是 planner+navigation 里的免确认可逆低风险工具
  for (const name of ["companion_focus_graph", "companion_schedule_reminder", "companion_cancel_reminder"]) {
    const definition = getCompanionAgentTool(name);
    assert.ok(definition, `${name} 必须存在`);
    assert.equal(canUseCompanionAgentTool("guided", definition).requiresConfirmation, false, name);
  }
  // 提醒必须是可查可撤的：只有 schedule 没有 list/cancel 的话，用户说"不用提醒了"
  // 就只能等它自己响。
  assert.ok(getCompanionAgentTool("companion_list_reminders")?.riskClass === "read");
});

test("工具解析：full 权限 = 用户预授权，只有不可逆动作仍需确认", () => {
  // 2026-09-19 对齐权限分级原设计：full 是用户的事前授权，consequential 不再
  // 逐步确认（自动跳转/自动设置）；irreversible 仍是安全底线。
  const start = getCompanionAgentTool("companion_start_learning");
  assert.ok(start);
  assert.equal(start.requiresConfirmation, true);
  assert.deepEqual(canUseCompanionAgentTool("full", start), {
    allowed: true,
    requiresConfirmation: false,
  });
  // guided 档维持逐次确认（默认档必须保守）。
  assert.deepEqual(canUseCompanionAgentTool("guided", start), {
    allowed: true,
    requiresConfirmation: true,
  });
  const irreversible = { riskClass: "irreversible" as const, requiresConfirmation: false };
  assert.equal(canUseCompanionAgentTool("full", irreversible).requiresConfirmation, true);
});

test("工具参数：未知工具、未知字段、类型错误全部失败关闭", () => {
  assert.equal(validateCompanionAgentToolArguments("does_not_exist", {}).success, false);
  assert.equal(validateCompanionAgentToolArguments("companion_read_context", { extra: 1 }).success, false);
  assert.equal(validateCompanionAgentToolArguments("companion_pause_learning", { runId: "not-a-uuid" }).success, false);
  assert.equal(
    validateCompanionAgentToolArguments("companion_request_hint", {
      runId: "11111111-1111-4111-8111-111111111111",
      taskId: "22222222-2222-4222-8222-222222222222",
      level: 4,
    }).success,
    false,
  );
});

test("工具调用标识：越界 id/name 被阻止（fail closed）", () => {
  assert.deepEqual(boundedToolCallIdentity({ id: "call_1", name: "companion_read_context" }), {
    id: "call_1",
    name: "companion_read_context",
  });
  // provider 返回空 id（OpenAI-compatible 解析层会把缺失 id 变成 ""）
  assert.equal(boundedToolCallIdentity({ id: "", name: "companion_read_context" }), null);
  // 超出 SSE 合同上限：toolCallId ≤200、name ≤80
  assert.equal(boundedToolCallIdentity({ id: "x".repeat(201), name: "companion_read_context" }), null);
  assert.equal(boundedToolCallIdentity({ id: "call_1", name: "n".repeat(81) }), null);
  // 非字符串
  assert.equal(boundedToolCallIdentity({ id: undefined, name: "companion_read_context" }), null);
  assert.equal(boundedToolCallIdentity({ id: "call_1", name: 42 }), null);
});

test("工具参数 hash：确定性且对异常 payload 不抛错", () => {
  assert.equal(safeArgumentsHash({ a: 1, b: 2 }), safeArgumentsHash({ b: 2, a: 1 }));
  assert.notEqual(safeArgumentsHash({ a: 1 }), safeArgumentsHash({ a: 2 }));
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  assert.doesNotThrow(() => safeArgumentsHash(circular));
  assert.equal(safeArgumentsHash(circular).length, 64);
});

//
// runStreamingAgentStep 不依赖 DB（provider/onProviderDelta 全注入），这里锁住
// 三条路径：正常完成、交付管线"说停"（返回 false）、交付管线**抛错**（落库事务
// 异常/desync）。第三条是 2026-09-19 的修复：此前 rejection 被链尾吞掉，provider
// 会白读到流尾才在 finish() 暴露失败。另加 ④-b 的两条：工具步能带回 tool_calls、
// 分段符随本段第一个文本增量一起下发。

function streamingStubProvider(deltas: string[], toolCalls?: unknown[]): {
  provider: AIProvider;
  state: { emitted: number; aborted: boolean };
} {
  const state = { emitted: 0, aborted: false };
  const provider = {
    id: "stub",
    modelId: "stub-model",
    visionModelId: "stub-model",
    promptVersion: "test",
    chatCompletion: async () => { throw new Error("not used"); },
    executeAgentTurn: async () => { throw new Error("not used"); },
    chatCompletionStream: async (
      _messages: unknown,
      _options: unknown,
      signal: AbortSignal | undefined,
      onDelta: (delta: string) => void,
    ): Promise<{ content: string; toolCalls?: unknown[]; finishReason?: string }> => {
      const onAbort = (): void => { state.aborted = true; };
      signal?.addEventListener("abort", onAbort, { once: true });
      let content = "";
      for (const delta of deltas) {
        if (state.aborted || signal?.aborted) throw new Error("AI request aborted during stream");
        onDelta(delta);
        content += delta;
        state.emitted += 1;
        // 让 flushChain 的微任务链有机会运行——真实链路里是网络读的间隙。
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      if (state.aborted || signal?.aborted) throw new Error("AI request aborted during stream");
      return toolCalls ? { content, toolCalls, finishReason: "tool_calls" } : { content };
    },
  } as unknown as AIProvider;
  return { provider, state };
}

const STREAM_STEP_REQUEST = {
  role: "companion_agent",
  systemPrompt: "测试 system",
  messages: [{ role: "user" as const, content: "打个招呼" }],
  tools: [],
  maxTokens: 700,
  temperature: 0.9,
};

test("流式单步：JSON 信封被剥掉，交付管线只看到正文增量，返回完整原文", async () => {
  // json_object 模式下模型吐的是 {"reply": "…"}；流式的可见内容必须是**正文**，
  // 信封语法一个字符都不能漏给客户端（2026-09-19 实机缺主语的根因就在这条链路上）。
  const deltas = ['{"reply": "', "你好", "呀，", "今天想学点", '什么？"}'];
  const { provider, state } = streamingStubProvider(deltas);
  const seen: string[] = [];
  const result = await runStreamingAgentStep({
    provider,
    stepRequest: STREAM_STEP_REQUEST as never,
    ctxSignal: new AbortController().signal,
    timeoutMs: 5_000,
    onProviderDelta: async (delta: string) => {
      seen.push(delta);
      return true;
    },
  });
  // 返回值是**解码后的正文**（本轮回复的唯一事实来源）：下游不再按优先级从
  // 原始 JSON 里挑键——那正是"流式内容与落库正文分叉"的来源。
  assert.equal(result.content, "你好呀，今天想学点什么？");
  assert.deepEqual(result.toolCalls, []);
  assert.deepEqual(seen, ["你好", "呀，", "今天想学点", "什么？"]);
  assert.equal(state.aborted, false);
});

test("流式单步：以 `[标签]` 开头的自然回复直通，头部一个字符都不能丢", async () => {
  // 2026-09-19 收窄：头部嗅探初版只看首字符是否 `{`/`[`，于是以 `[empathetic]`
  // 这类方括号开头的正常回复也会被送进 JSON 信封解码器——解不出形状就**一个字都
  // 不下发**，那一轮会缺头（库里确有 `这么开心，是遇到什么有趣的事了吗？` /
  // `呀。今天的学习状态怎么样？` 这类落库正文）。真实信封只有 `{` / `[{` / `["`
  // 三种开头，数组里不会直接出现裸字母，所以 `[标签]` 必须走直通。
  const deltas = ["[empathetic]", "，你已经", "很努力了呀。"];
  const { provider, state } = streamingStubProvider(deltas);
  const seen: string[] = [];
  const result = await runStreamingAgentStep({
    provider,
    stepRequest: STREAM_STEP_REQUEST as never,
    ctxSignal: new AbortController().signal,
    timeoutMs: 5_000,
    onProviderDelta: async (delta: string) => {
      seen.push(delta);
      return true;
    },
  });
  // 头部原样下发（标签由下游 sanitizeCompanionVisibleText 统一剥离）。
  assert.equal(result.content, "[empathetic]，你已经很努力了呀。");
  assert.deepEqual(seen, ["[empathetic]", "，你已经", "很努力了呀。"]);
  assert.equal(state.aborted, false);
});

test("流式单步（④-b）：带工具的一步把 tool_calls 一并带回，开场白仍下发", async () => {
  // ④-b 的核心：SSE 里 delta.tool_calls 与 delta.content 并列，流式路径必须把
  // 工具调用解析出来——否则"打开复习页"这类请求会变成"她说了句我去看看，
  // 然后什么都没发生"。
  const deltas = ["好，", "这就带你过去。"];
  const { provider } = streamingStubProvider(deltas, [
    { id: "call_1", name: "companion_open_page", arguments: {} },
  ]);
  const seen: string[] = [];
  const result = await runStreamingAgentStep({
    provider,
    stepRequest: STREAM_STEP_REQUEST as never,
    ctxSignal: new AbortController().signal,
    timeoutMs: 5_000,
    onProviderDelta: async (delta: string) => {
      seen.push(delta);
      return true;
    },
  });
  assert.equal(result.content, "好，这就带你过去。");
  assert.deepEqual(result.toolCalls, [{ id: "call_1", name: "companion_open_page", arguments: {} }]);
  assert.equal(result.finishReason, "tool_calls");
  assert.deepEqual(seen, ["好，", "这就带你过去。"]);
});

test("流式单步（④-b）：分段符随本段第一个文本增量一起下发（与最终正文拼接口径一致）", async () => {
  const { provider } = streamingStubProvider(["根据你的笔记，", "今天有三张卡要复习。"]);
  const seen: string[] = [];
  await runStreamingAgentStep({
    provider,
    stepRequest: STREAM_STEP_REQUEST as never,
    ctxSignal: new AbortController().signal,
    timeoutMs: 5_000,
    separatorBefore: "\n\n",
    onProviderDelta: async (delta: string) => {
      seen.push(delta);
      return true;
    },
  });
  assert.deepEqual(seen, ["\n\n根据你的笔记，", "今天有三张卡要复习。"]);
});

test("流式单步（④-b）：本段没有文本时不下发分段符（最终正文也不会空出一段）", async () => {
  const { provider } = streamingStubProvider([], [
    { id: "call_1", name: "companion_read_context", arguments: {} },
  ]);
  const seen: string[] = [];
  await runStreamingAgentStep({
    provider,
    stepRequest: STREAM_STEP_REQUEST as never,
    ctxSignal: new AbortController().signal,
    timeoutMs: 5_000,
    separatorBefore: "\n\n",
    onProviderDelta: async (delta: string) => {
      seen.push(delta);
      return true;
    },
  });
  assert.deepEqual(seen, []);
});

test("流式单步：交付管线说停（返回 false）→ 立即中断读取，抛 CompanionStreamStoppedError", async () => {
  const deltas = ['{"reply": "', "第一段", "第二段", "第三段", "第四段", '"}'];
  const { provider, state } = streamingStubProvider(deltas);
  await assert.rejects(
    runStreamingAgentStep({
      provider,
      stepRequest: STREAM_STEP_REQUEST as never,
      ctxSignal: new AbortController().signal,
      timeoutMs: 5_000,
      onProviderDelta: async (delta: string) => delta !== "第二段",
    }),
    (error: unknown) => error instanceof CompanionStreamStoppedError,
  );
  assert.equal(state.aborted, true, "底层请求必须被中断");
  assert.ok(state.emitted < deltas.length, "不得继续消费剩余增量");
});

test("流式单步：交付管线抛错（落库异常）→ 同样立即中断，不再白读到流尾", async () => {
  const deltas = ['{"reply": "', "第一段", "第二段", "第三段", "第四段", "第五段", '"}'];
  const { provider, state } = streamingStubProvider(deltas);
  await assert.rejects(
    runStreamingAgentStep({
      provider,
      stepRequest: STREAM_STEP_REQUEST as never,
      ctxSignal: new AbortController().signal,
      timeoutMs: 5_000,
      onProviderDelta: async (delta: string) => {
        if (delta === "第二段") throw new Error("companion delta stream desync: written=1 expected=2");
        return true;
      },
    }),
    (error: unknown) => error instanceof CompanionStreamStoppedError,
  );
  // 观察项修复的核心断言：抛错路径与"说停"路径行为一致——abort 及时触发，
  // 后续增量不再进入 provider 读取循环。
  assert.equal(state.aborted, true, "底层请求必须被中断");
  assert.ok(state.emitted < deltas.length, "不得继续消费剩余增量");
});

// ─── 坍缩闸（2026-09-20）：holdUntilChars ───────────────────────────────
// 实机四条连续轮次落库 `现在是`(3)/`今天`(2)/`最近`(2)/`你`(1)，全是流式，
// 而退化闸要求 `!stepEmitted`——吐过字就永远不成立，所以一次都没拦住。
// hold 的语义就是让"这一步到底有没有下发"重新变成可成立的条件。

test("坍缩闸：整步未达阈值时一个字都不下发，onTextEmitted 不触发", async () => {
  const { provider } = streamingStubProvider(["嘿", "嘿嘿"]);
  const seen: string[] = [];
  let emitted = false;
  const result = await runStreamingAgentStep({
    provider,
    stepRequest: STREAM_STEP_REQUEST as never,
    ctxSignal: new AbortController().signal,
    timeoutMs: 5_000,
    holdUntilChars: 12,
    onTextEmitted: () => { emitted = true; },
    onProviderDelta: async (delta: string) => { seen.push(delta); return true; },
  });
  assert.deepEqual(seen, [], "短于阈值的整步不得下发任何字符");
  assert.equal(emitted, false, "stepEmitted 必须保持 false，退化闸才有重跑的机会");
  // 但正文本身不能丢——它由调用方经整段补写路径交付。
  assert.equal(result.content, "嘿嘿嘿");
});

test("坍缩闸：跨过阈值时把攒住的文本一次性按序放行，之后直通", async () => {
  const { provider } = streamingStubProvider(["今天", "学了", "18分钟", "，很稳啊"]);
  const seen: string[] = [];
  let emitted = false;
  const result = await runStreamingAgentStep({
    provider,
    stepRequest: STREAM_STEP_REQUEST as never,
    ctxSignal: new AbortController().signal,
    timeoutMs: 5_000,
    holdUntilChars: 8,
    onTextEmitted: () => { emitted = true; },
    onProviderDelta: async (delta: string) => { seen.push(delta); return true; },
  });
  // 已下发原文必须是最终正文的前缀——放行帧是攒住的整段，不是最后一个增量。
  assert.deepEqual(seen, ["今天学了18分钟", "，很稳啊"]);
  const finalText = typeof result.content === "string" ? result.content : "";
  assert.ok(finalText.length > 0 && finalText.startsWith(seen.join("")), "下发内容必须是最终正文的前缀");
  assert.equal(emitted, true);
});

test("坍缩闸：分段符只贴在真正放行的第一帧前面，不重复", async () => {
  const { provider } = streamingStubProvider(["第一段", "第二段", "第三段"]);
  const seen: string[] = [];
  await runStreamingAgentStep({
    provider,
    stepRequest: STREAM_STEP_REQUEST as never,
    ctxSignal: new AbortController().signal,
    timeoutMs: 5_000,
    separatorBefore: "\n\n",
    holdUntilChars: 5,
    onProviderDelta: async (delta: string) => { seen.push(delta); return true; },
  });
  assert.equal(seen[0], "\n\n第一段第二段", "放行帧是攒住的整段，不是最后一个增量");
  assert.equal(seen.filter((chunk) => chunk.includes("\n\n")).length, 1, "分隔符只能出现一次");
});

// ─── 扁平工具面（方案 29 §4.1）：能力不再被关键词路由关掉 ─────────────────
// 回归的正是那个 90.7% 的读数：`selectSkill()` 没命中 → 空工具面 → 单步，
// "读记忆 / 看系统状态 / 跳转"根本没出现在她面前。

test("扁平工具面：guided/full 档下写工具与读工具同时在列，与用户说了什么无关", () => {
  const guided = resolveAllCompanionAgentTools("guided").map((d) => d.name);
  const full = resolveAllCompanionAgentTools("full").map((d) => d.name);
  // 曾经这些只存在于特定技能里：不选中的技能 = 拿不到的能力。
  for (const name of ["companion_save_memory", "companion_open_page", "companion_start_learning"]) {
    assert.ok(guided.includes(name), `guided 必须能看到 ${name}`);
    assert.ok(full.includes(name), `full 必须能看到 ${name}`);
  }
  // 跨技能的组合现在可能了（以前一轮只能拿到一个技能的子集）。
  assert.ok(guided.includes("companion_read_context") && guided.includes("companion_search_notes"),
    "上下文与系统查询工具必须同时可用");
  // 抱怨 #5/#6 的那一面：看笔记、看数据、看队列、跳到页面，任何一轮都在。
  for (const name of [
    "companion_search_notes", "companion_read_note", "companion_open_note", "companion_open_page",
    "companion_get_learning_stats", "companion_list_task_queue", "companion_list_due_reviews",
    "companion_schedule_reminder", "companion_list_reminders", "companion_cancel_reminder",
  ]) {
    assert.ok(guided.includes(name), `guided 必须能看到 ${name}`);
  }
});

test("扁平工具面：read_only 档仍然只剩读工具（权限边界不因常开而放松）", () => {
  const readOnly = resolveAllCompanionAgentTools("read_only");
  assert.ok(readOnly.length > 0, "read_only 下仍要有读工具");
  assert.ok(readOnly.every((d) => d.riskClass === "read"),
    "read_only 绝不能出现任何写/动作工具");
});
/**
 * steer 的提示里到底该点名哪个工具。
 *
 * 实机 2026-09-22 场景 T：用户说「以后别主动催我复习」，她两步都只回"我记下了"，
 * `companion_set_boundary` 一次没调（tools=0，边界其实没改）。查下来不是模型不肯调，
 * 而是**这一支的提示根本没点名任何工具**：`steerableReadTools` 只收读类工具，
 * 而 action 那一支用的是泛指文案"调用合适的工具"——同一个文件上面 30 行就写着
 * "小模型对『你去调用工具』这种泛指不敏感，对『调用 companion_search_notes』会照做"。
 * 换到兜底模型也一样，因为要它做的仍然是"猜哪个工具"。
 */
test("steerableToolNames：lookup 点读类、action 点可逆写，consequential 永不点名", () => {
  const defs = [
    { name: "companion_search_notes", riskClass: "read" },
    { name: "companion_recall_memory", riskClass: "read" },
    { name: "companion_set_boundary", riskClass: "reversible_low" },
    { name: "companion_save_memory", riskClass: "reversible_low" },
    { name: "companion_start_learning", riskClass: "consequential" },
    { name: "companion_pause_learning", riskClass: "consequential" },
  ];
  assert.deepEqual(steerableToolNames(defs, "lookup"), ["companion_search_notes", "companion_recall_memory"]);
  assert.deepEqual(steerableToolNames(defs, "action"), ["companion_set_boundary", "companion_save_memory"]);
  // 这条是安全性质，不是风格：一句纠正性提示里出现 companion_start_learning，
  // 等于系统自己把用户没要过的学习运行推上桌。
  for (const kind of ["lookup", "action"] as const) {
    assert.ok(steerableToolNames(defs, kind).every((name) => !name.includes("learning")),
      `${kind} 那一支绝不能点名 consequential`);
  }
  assert.equal(steerableToolNames([...defs, ...defs], "lookup", 3).length, 3);
});

/**
 * 分段拼接必须保证"已下发原文是最终正文的前缀"。
 *
 * 实机 2026-09-22 场景 T：第 1 步的话被 hold 攒住没发出去、随后被 steer 掉，
 * 第 3 步真的调了 `companion_set_boundary` 并说出结论——边界改成功了，run 却
 * 判 `stream_full_text_diverged` 失败（最终正文以那句没发出去的话开头）。
 * 用户看到的是"报错"，而事情其实做完了——这是最难解释的一种失败。
 */
test("joinVisibleSegmentsDeduped：从没下发过的段不能排在已下发段前面", () => {
  const SEP = "\n\n";
  // 全下发 → 原样保留（顺序与分段符都不能动）
  assert.equal(joinVisibleSegmentsDeduped(["第一段话呀呀", "第二段话呀呀"], [true, true]).text,
    "第一段话呀呀" + SEP + "第二段话呀呀");
  // 未下发在前、已下发在后 → 丢前面那条，结果以已下发的那条开头
  const dropped = joinVisibleSegmentsDeduped(["嗯嗯，记住了喵。", "好了，这次是真的设上了喵"], [false, true]);
  assert.equal(dropped.text, "好了，这次是真的设上了喵");
  assert.deepEqual(dropped.dropped, ["嗯嗯，记住了喵。"]);
  // 夹在两个已下发段中间的未下发段同样丢
  assert.equal(joinVisibleSegmentsDeduped(
    ["第一段话呀呀", "第二段没发出去", "第三段话呀呀"], [true, false, true],
  ).text, "第一段话呀呀" + SEP + "第三段话呀呀");
  // 末尾的未下发段**必须保留**：那是 writeTail 正要补发的尾巴，丢了用户就没答案了
  assert.equal(joinVisibleSegmentsDeduped(
    ["第一段话呀呀", "第二段还没发出去"], [true, false],
  ).text, "第一段话呀呀" + SEP + "第二段还没发出去");
  // 原有的"复读去重"仍在：未下发且与前面保留段完全相同 → 丢
  assert.equal(joinVisibleSegmentsDeduped(
    ["复习入口准备好啦点前往", "复习入口准备好啦点前往"], [true, false],
  ).text, "复习入口准备好啦点前往");
});

/**
 * 用户要的是一个"必须动系统才算做到"的动作时，这一步的话要**整段攒住**。
 *
 * 实机 2026-09-22 场景 T：opener「嗯，这条早就设好了喵——你不问，我一个字都不提」
 * 先落到屏幕上，之后哪怕 steer 出真的 `companion_set_boundary`，也只能在同一条消息里
 * 自相矛盾（或者干脆留下一句没兑现的承诺）。事后闸救不了已经发出去的字，
 * 所以这里改的是**发不发**：动作轮里，一步结束前不落屏。
 */
test("stepHoldChars：动作轮整段攒住，普通轮仍是 12 字阈值", () => {
  assert.equal(stepHoldChars({ userAskedForAction: false }), FINAL_ANSWER_HOLD_CHARS);
  const hold = stepHoldChars({ userAskedForAction: true });
  assert.ok(hold > 10_000, "动作轮的阈值要高到一步的正文永远达不到");
  assert.ok("嗯，这条早就设好了喵——你不问，我一个字都不提。".length < hold);
});

/**
 * 动作轮可以多补一步，普通形状不行。
 * 这条额度差是**有条件的**：只有 `stepHoldChars` 把正文整段攒住之后才成立，
 * 否则第二次 steer 是在已经落屏的假话后面再接一段。
 */
test("actionSteerBudget：动作轮两次、其他形状一次", () => {
  assert.equal(actionSteerBudget({ userAskedForAction: true }), 2);
  assert.equal(actionSteerBudget({ userAskedForAction: false }), 1);
});

/**
 * "她改了但其实没改"这一类（实机 2026-09-22 场景 U）。
 *
 * 用户只要一句口头禅，她连着调了两个工具，其中一个把活跃度"调成了「活跃」"——
 * 而活跃度**本来就是** active（库里 09-20 就是 active，revision 白 +1）。
 * 她随后自己补了一句"这个是你想要的吗"，说明这不是恶意，是工具结果给了她一个
 * "已把 X 设为 Y"的**成功摘要**，而这一轮那件事根本没发生。
 * 所以工具必须区分"改成了"和"本来就是这样"。
 */
test("partitionPersonaPatch：与当前值相同的项不算改动", () => {
  assert.deepEqual(
    partitionPersonaPatch({ activeness: "active" }, { activeness: "active" }),
    { changed: {}, unchangedKeys: ["activeness"] },
  );
  assert.deepEqual(
    partitionPersonaPatch(
      { allowNudgeLearning: true, allowPlayful: true },
      { allowNudgeLearning: false, allowPlayful: true },
    ),
    { changed: { allowNudgeLearning: false }, unchangedKeys: ["allowPlayful"] },
  );
  // 当前值缺项（boundaries 从没写过的键）算改动：不能把"没设过"读成"已经是这样"。
  assert.deepEqual(
    partitionPersonaPatch({}, { catchphrase: "就这么定了" }),
    { changed: { catchphrase: "就这么定了" }, unchangedKeys: [] },
  );
});

// 实机 2026-09-22 真人轮「我接下来的任务队列里都排着什么？」：她把清单念完了，
// 但 `list_task_queue` 此前只回文字——既不给 route，`open_page` 白名单里也没有
// "任务队列"这一页，用户想点开看一眼无路可走。队列属于某一次学习运行，
// 所以"打开那轮运行"就是它该落到的地方。
test("taskQueueToolResult：有待办时带出这一轮运行页的 route", () => {
  const runId = "3f2e1369-7595-466c-af76-6cea5ee7440f";
  const result = taskQueueToolResult([
    { task_id: "t1", sequence: 2, status: "pending", label: "过一遍公式", run_phase: "active", run_id: runId },
    { task_id: "t2", sequence: 3, status: "pending", label: "错题回看", run_phase: "active", run_id: runId },
  ]);
  assert.deepEqual(result.route, { kind: "learning_run", runId });
  assert.equal(result.safeSummary, "队列里有 2 个待办任务");
  assert.deepEqual((result.value.tasks as { taskId: string }[]).map((t) => t.taskId), ["t1", "t2"]);
});

test("taskQueueToolResult：没有待办 / 拿不到 run 时不硬造 route", () => {
  assert.equal(taskQueueToolResult([]).route, undefined);
  assert.equal(taskQueueToolResult([]).safeSummary, "当前没有排着的任务");
  assert.equal(
    taskQueueToolResult([{ task_id: "t1", sequence: 1, status: "pending",
                           label: "x", run_phase: "active", run_id: null }]).route, undefined,
    "run_id 为空就不能拼出一个跳转");
});

// ─── §9.28 双额度的账目（方案 29 §12 C1 的实机回归）───────────────────────
const steerInput = {
  stepCalls: 0, toolCallCount: 0, finalAnswerOnly: false, withinBudget: true,
  userAskedForAction: false, hasUnverifiedClaims: true,
  looksLikeUnfulfilledNarration: false, lookupClaim: false,
  actionSteerAttempts: 0, actionSteerBudget: 1, lookupClaimSteered: false,
};

test("planStepSteer：形状那一步不吃掉『说查过而没查』的额度", () => {
  // 实机 2026-09-22 真人轮：第 1 步她报了个没有出处的数字（形状），第 2 步才说
  // "搜索没搜到任何相关记忆"（假阴性）。旧实现里第 1 步那次 steer 顺手把第二条额度
  // 置真，于是第 2 步那句直接交付——而库里那 10 条活记忆都还在。
  const first = planStepSteer(steerInput);
  assert.equal(first.steer, true);
  assert.equal(first.consumeAction, true);
  assert.equal(first.consumeLookup, false, "这次不是为假阴性补的，不许花那条额度");

  const second = planStepSteer({
    ...steerInput,
    hasUnverifiedClaims: false,
    lookupClaim: true,
    actionSteerAttempts: first.consumeAction ? 1 : 0,
    lookupClaimSteered: first.consumeLookup,
  });
  assert.equal(second.steer, true, "第 2 步的假阴性必须还有额度可拦");
  assert.equal(second.consumeLookup, true);
  assert.equal(second.swapToFallback, true, "假阴性那一步要换兜底模型：同档再说一遍还是会说不查");
});

test("planStepSteer：工具真跑过 / 已是强制收尾步 → 一律不补", () => {
  assert.equal(planStepSteer({ ...steerInput, toolCallCount: 1 }).steer, false);
  assert.equal(planStepSteer({ ...steerInput, finalAnswerOnly: true }).steer, false);
  assert.equal(planStepSteer({ ...steerInput, withinBudget: false }).steer, false);
  assert.equal(planStepSteer({ ...steerInput, hasUnverifiedClaims: false }).steer, false,
    "没命中任何一类就不该白烧一步");
});

test("planStepSteer：额度用尽后不再重复补同一条", () => {
  assert.equal(planStepSteer({ ...steerInput, actionSteerAttempts: 1, actionSteerBudget: 1 }).steer, false);
  assert.equal(planStepSteer({
    ...steerInput, hasUnverifiedClaims: false, lookupClaim: true, lookupClaimSteered: true,
  }).steer, false);
});
