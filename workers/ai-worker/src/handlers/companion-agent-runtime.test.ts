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
  safeArgumentsHash,
  selectSkill,
} from "./companion-agent-runtime.ts";

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

test("工具解析：full 权限仍对破坏性操作强制确认", () => {
  const start = getCompanionAgentTool("companion_start_learning");
  assert.ok(start);
  assert.equal(start.requiresConfirmation, true);
  assert.deepEqual(canUseCompanionAgentTool("full", start), {
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
