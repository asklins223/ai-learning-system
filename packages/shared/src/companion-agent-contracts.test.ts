import assert from "node:assert/strict";
import test from "node:test";
import {
  canUseCompanionAgentTool,
  companionAgentToolEventV1Schema,
} from "./companion-agent-contracts.ts";
import {
  COMPANION_AGENT_TOOL_DEFINITIONS,
  getCompanionAgentTool,
  resolveAllCompanionAgentTools,
  validateCompanionAgentToolArguments,
} from "./companion-agent-registry.ts";

test("Agent permission levels keep hard confirmation boundaries", () => {
  const read = { riskClass: "read" as const, requiresConfirmation: false };
  const reversible = { riskClass: "reversible_low" as const, requiresConfirmation: false };
  const dangerous = { riskClass: "irreversible" as const, requiresConfirmation: false };

  assert.deepEqual(canUseCompanionAgentTool("read_only", read), {
    allowed: true,
    requiresConfirmation: false,
  });
  assert.equal(canUseCompanionAgentTool("read_only", reversible).allowed, false);
  assert.equal(canUseCompanionAgentTool("guided", reversible).requiresConfirmation, false);
  assert.equal(canUseCompanionAgentTool("guided", { ...reversible, requiresConfirmation: true }).requiresConfirmation, true);
  assert.equal(canUseCompanionAgentTool("full", dangerous).requiresConfirmation, true);
  // full = 用户预授权（2026-09-19 对齐原设计）：授权档位下不再逐步确认，
  // 只有 irreversible 仍是安全底线。
  assert.equal(canUseCompanionAgentTool("full", reversible).requiresConfirmation, false);
  assert.equal(
    canUseCompanionAgentTool("full", { riskClass: "consequential" as const, requiresConfirmation: true })
      .requiresConfirmation,
    false,
  );

  const focusGraph = getCompanionAgentTool("companion_focus_graph");
  assert.ok(focusGraph);
  assert.equal(canUseCompanionAgentTool("guided", focusGraph).requiresConfirmation, false);
});

test("扁平工具面 fail closed：read_only 只剩读工具，未知档位不会放开写工具", () => {
  const readOnly = resolveAllCompanionAgentTools("read_only");
  assert.ok(readOnly.length > 0);
  assert.ok(readOnly.every((definition) => definition.riskClass === "read"));
  assert.ok(
    resolveAllCompanionAgentTools("guided").length > readOnly.length,
    "guided 必须比 read_only 多出写工具",
  );
  assert.deepEqual(
    resolveAllCompanionAgentTools("full").map((definition) => definition.name),
    COMPANION_AGENT_TOOL_DEFINITIONS.map((definition) => definition.name),
    "full 档就是整个注册表",
  );
});

test("Tool argument validation rejects unknown and malformed calls", () => {
  assert.equal(validateCompanionAgentToolArguments("missing_tool", {}).success, false);
  assert.equal(validateCompanionAgentToolArguments("companion_read_context", { extra: true }).success, false);
  assert.equal(validateCompanionAgentToolArguments("companion_pause_learning", { runId: "not-a-uuid" }).success, false);
  const valid = validateCompanionAgentToolArguments("companion_read_history", { limit: 3 });
  assert.deepEqual(valid, { success: true, data: { limit: 3 } });
});

test("Auto-set / auto-fill 工具按权限分级走确认或直执行（2026-09-19 对齐原设计）", () => {
  for (const name of ["companion_save_memory", "companion_set_activeness"]) {
    const definition = getCompanionAgentTool(name);
    assert.ok(definition, `${name} 应已注册`);
    assert.equal(definition.riskClass, "reversible_low");
    // 注册表声明需要确认 → guided 档走提案；full 档预授权直执行；
    // read_only 档被门禁阻止。
    assert.equal(definition.requiresConfirmation, true);
    assert.equal(canUseCompanionAgentTool("read_only", definition).allowed, false);
    assert.equal(canUseCompanionAgentTool("guided", definition).requiresConfirmation, true);
    assert.equal(canUseCompanionAgentTool("full", definition).requiresConfirmation, false);
  }

  // 参数校验：kind 枚举与 DB CHECK 同源；content ≤200 字。
  assert.equal(
    validateCompanionAgentToolArguments("companion_save_memory", { kind: "preference", content: "喜欢安静地复习" }).success,
    true,
  );
  assert.equal(
    validateCompanionAgentToolArguments("companion_save_memory", { kind: "not_a_kind", content: "x" }).success,
    false,
  );
  assert.equal(
    validateCompanionAgentToolArguments("companion_save_memory", { kind: "goal", content: "x".repeat(201) }).success,
    false,
  );
  assert.equal(validateCompanionAgentToolArguments("companion_set_activeness", { activeness: "active" }).success, true);
  assert.equal(validateCompanionAgentToolArguments("companion_set_activeness", { activeness: "loud" }).success, false);

  // 记忆类工具在扁平面上每轮都在——它们曾经挂在 companion-memory 技能下，
  // 关键词没命中就根本不出现在她面前（方案 29 §4.1）。
  const guided = resolveAllCompanionAgentTools("guided").map((definition) => definition.name);
  assert.ok(guided.includes("companion_save_memory"));
  assert.ok(guided.includes("companion_set_activeness"));
});

test("Agent SSE event schemas expose only safe tool metadata", () => {
  const tool = getCompanionAgentTool("companion_open_page");
  assert.ok(tool);
  assert.equal(companionAgentToolEventV1Schema.safeParse({
    toolCallId: "call-1",
    name: tool.name,
    toolVersion: tool.toolVersion,
    riskClass: tool.riskClass,
    status: "succeeded",
    safeLabel: tool.description,
    route: { kind: "review" },
  }).success, true);
  // `agent.skill` 这个 SSE 事件类型已随技能层删除：现在每轮工具面是固定的
  // （只按权限档过滤），"选中了哪个技能"再也不是一个需要广播的事实。
});
