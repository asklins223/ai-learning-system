import assert from "node:assert/strict";
import test from "node:test";
import {
  canUseCompanionAgentTool,
  companionAgentSkillEventV1Schema,
  companionAgentToolEventV1Schema,
} from "./companion-agent-contracts.ts";
import {
  COMPANION_AGENT_DEFAULT_SKILL_IDS,
  getCompanionAgentTool,
  resolveCompanionAgentSkills,
  resolveCompanionAgentTools,
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

test("Skill resolver and tool resolver fail closed", () => {
  const skills = resolveCompanionAgentSkills({
    version: 1,
    permissionLevel: "read_only",
    enabledSkillIds: ["learning-context"],
  });
  assert.deepEqual(skills.map((skill) => skill.id), ["learning-context"]);
  assert.ok(resolveCompanionAgentTools(skills, "read_only").every((tool) => tool.riskClass === "read"));
  assert.equal(resolveCompanionAgentSkills({ version: 1, permissionLevel: "guided", enabledSkillIds: ["missing"] }).length, 0);
  assert.ok(COMPANION_AGENT_DEFAULT_SKILL_IDS.includes("learning-tutor"));
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
    // 两个工具都挂在 companion-memory skill 下（老账号的 enabledSkillIds 已包含它）。
    assert.ok(definition.skillIds.includes("companion-memory"));
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

  // companion-memory skill 清单包含新工具，且 triggerHints 能命中"帮我记住"。
  const memorySkill = resolveCompanionAgentSkills({
    version: 1,
    permissionLevel: "guided",
    enabledSkillIds: ["companion-memory"],
  });
  assert.deepEqual(memorySkill.map((skill) => skill.id), ["companion-memory"]);
  const memoryTools = resolveCompanionAgentTools(memorySkill, "guided").map((tool) => tool.name);
  assert.ok(memoryTools.includes("companion_save_memory"));
  assert.ok(memoryTools.includes("companion_set_activeness"));
});

test("Agent SSE event schemas expose only safe tool metadata", () => {
  const tool = getCompanionAgentTool("companion_open_review");
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
  assert.equal(companionAgentSkillEventV1Schema.safeParse({
    skillId: "learning-context",
    skillVersion: "1.0.0",
    name: "学习上下文",
    status: "selected",
  }).success, true);
});
