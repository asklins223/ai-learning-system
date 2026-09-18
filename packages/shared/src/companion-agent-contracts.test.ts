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
