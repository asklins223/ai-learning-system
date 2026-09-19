/**
 * Companion Agent 运行时单测（方案《将 AI 伴星升级为可扩展 Agent》§1/§2/§3/§4）。
 *
 * 覆盖运行时里不依赖 DB 的决策面——这些正是方案验收清单里"必须失败关闭"的部分：
 * - Skill 解析：只从用户启用的 Skill 中选，且选择确定；
 * - 工具与权限：只读权限禁止一切写工具，guided/full 仍保留高危确认；
 * - provider 工具调用标识：越界 id/name 必须被阻止（不得进入审计表或 SSE）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  canUseCompanionAgentTool,
  COMPANION_AGENT_MAX_STEPS,
  getCompanionAgentSkill,
  getCompanionAgentTool,
  resolveCompanionAgentTools,
  validateCompanionAgentToolArguments,
} from "@ailearn/shared";
import type { ReadContext } from "./companion-dialogue-store.ts";
import {
  boundedToolCallIdentity,
  runStreamingAgentStep,
  safeArgumentsHash,
  selectSkill,
} from "./companion-agent-runtime.ts";
import { CompanionStreamStoppedError } from "./companion-dialogue-stream.ts";
import type { AIProvider } from "../lib/ai-provider.ts";

const ALL_SKILLS = [
  "learning-context",
  "learning-tutor",
  "learning-planner",
  "companion-memory",
  "companion-navigation",
];

/** selectSkill 只读 pageContext 与 userText，其余字段与选择无关。 */
function readContext(overrides: Partial<ReadContext>): ReadContext {
  return {
    runId: "11111111-1111-4111-8111-111111111111",
    conversationId: "22222222-2222-4222-8222-222222222222",
    userId: "33333333-3333-4333-8333-333333333333",
    userMessageId: "44444444-4444-4444-8444-444444444444",
    generation: 1,
    runStatus: "accepted",
    accountEpoch: 0,
    pageContext: null,
    groundedTutorContext: null,
    userText: "",
    recentMessages: [],
    activeMemories: [],
    petProfile: null,
    nextMessageSeq: 1,
    nextEventSeq: 1,
    ...overrides,
  };
}

test("Skill 解析：grounded tutor 页面固定选 learning-tutor", () => {
  const skill = selectSkill(
    readContext({
      pageContext: { pageKind: "learning_run", requestedCapability: "grounded_tutor" },
      userText: "随便聊聊",
    }),
    { enabledSkillIds: ALL_SKILLS },
  );
  assert.equal(skill?.id, "learning-tutor");
});

test("Skill 解析：触发词命中优先，按得分与 id 稳定排序", () => {
  const skill = selectSkill(
    readContext({ userText: "帮我开始学习吧" }),
    { enabledSkillIds: ALL_SKILLS },
  );
  assert.equal(skill?.id, "learning-planner");

  // 同分时按 skill id 升序，保证同一输入永远选同一个 Skill
  const again = selectSkill(
    readContext({ userText: "帮我开始学习吧" }),
    { enabledSkillIds: ALL_SKILLS },
  );
  assert.equal(again?.id, skill?.id);
});

test("Skill 解析：用户停用的 Skill 永不被选中", () => {
  // learning-planner 的触发词命中，但用户只启用了 companion-memory
  const skill = selectSkill(
    readContext({ userText: "帮我开始学习吧" }),
    { enabledSkillIds: ["companion-memory"] },
  );
  assert.notEqual(skill?.id, "learning-planner");
  assert.ok(skill === null || skill.id === "companion-memory");

  // 全部停用 → 无 Skill（工具列表为空，退化为单步闲聊）
  assert.equal(selectSkill(readContext({ userText: "帮我开始学习吧" }), { enabledSkillIds: [] }), null);
});

test("Skill 解析：无页面上下文且无触发词 → null（普通闲聊单步完成）", () => {
  assert.equal(selectSkill(readContext({ userText: "你好呀" }), { enabledSkillIds: ALL_SKILLS }), null);
});

test("工具解析：只读权限下不存在任何写工具", () => {
  const planner = getCompanionAgentSkill("learning-planner");
  assert.ok(planner, "learning-planner 必须注册");
  const readOnlyTools = resolveCompanionAgentTools([planner], "read_only");
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
    assert.equal(resolveCompanionAgentTools([planner], "read_only").some((d) => d.name === name), false);
  }
});

test("工具解析：guided 自动执行可逆低风险，其余写操作一律确认", () => {
  const planner = getCompanionAgentSkill("learning-planner");
  assert.ok(planner);
  const tools = resolveCompanionAgentTools([planner], "guided");
  assert.ok(tools.length > 0);
  for (const definition of tools) {
    const auth = canUseCompanionAgentTool("guided", definition);
    assert.equal(auth.allowed, true);
    if (definition.riskClass === "read") {
      assert.equal(auth.requiresConfirmation, false, `${definition.name}（读取）不应要求确认`);
    } else {
      assert.equal(auth.requiresConfirmation, true, `${definition.name}（写）在 guided 下必须确认`);
    }
  }
  // 唯一的 reversible_low 工具（图谱聚焦）在 guided 下免确认
  const focus = getCompanionAgentTool("companion_focus_graph");
  assert.ok(focus);
  assert.equal(canUseCompanionAgentTool("guided", focus).requiresConfirmation, false);
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

test("Skill 清单自身满足预算上限", () => {
  for (const id of ALL_SKILLS) {
    const skill = getCompanionAgentSkill(id);
    assert.ok(skill, `${id} 必须注册`);
    assert.ok(skill.maxSteps >= 1 && skill.maxSteps <= COMPANION_AGENT_MAX_STEPS);
    // 白名单里的工具必须真实注册，且反向声明包含本 Skill
    for (const toolName of skill.toolNames) {
      const definition = getCompanionAgentTool(toolName);
      assert.ok(definition, `${id} 白名单引用了未注册工具 ${toolName}`);
      assert.ok(definition.skillIds.includes(id), `${toolName} 未声明属于 ${id}`);
    }
  }
});

// ─── 单步流式执行的中止语义（2026-09-19 观察项修复；④-b 起覆盖每一步） ────
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
    { id: "call_1", name: "companion_open_review", arguments: {} },
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
  assert.deepEqual(result.toolCalls, [{ id: "call_1", name: "companion_open_review", arguments: {} }]);
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
