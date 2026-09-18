/**
 * Companion Agent v1 contracts.
 *
 * These contracts deliberately describe capabilities, not executable code. A
 * skill can select registered tools and add bounded policy text, but it cannot
 * introduce a new transport, arbitrary code, or an unbounded operation.
 */

import { z } from "zod";

export const COMPANION_AGENT_CONTRACT_VERSION = 1 as const;
export const COMPANION_AGENT_MAX_STEPS = 8;
export const COMPANION_AGENT_MAX_TOOL_CALLS_PER_STEP = 4;
export const COMPANION_AGENT_MAX_TOOL_CALLS = 12;
export const COMPANION_AGENT_DEADLINE_MS = 120_000;
export const COMPANION_AGENT_TOOL_TIMEOUT_MS = 10_000;

export const companionAgentPermissionLevelSchema = z.enum([
  "read_only",
  "guided",
  "full",
]);
export type CompanionAgentPermissionLevel = z.infer<
  typeof companionAgentPermissionLevelSchema
>;

export const companionAgentRiskClassSchema = z.enum([
  "read",
  "reversible_low",
  "consequential",
  "irreversible",
]);
export type CompanionAgentRiskClass = z.infer<typeof companionAgentRiskClassSchema>;

export const companionAgentToolStatusSchema = z.enum([
  "requested",
  "executing",
  "waiting_confirmation",
  "succeeded",
  "failed",
  "blocked",
  "expired",
]);
export type CompanionAgentToolStatus = z.infer<typeof companionAgentToolStatusSchema>;

export const companionAgentStepKindSchema = z.enum([
  "model",
  "tool",
  "confirmation",
  "final",
  "error",
]);
export type CompanionAgentStepKind = z.infer<typeof companionAgentStepKindSchema>;

export const companionAgentStepStatusSchema = z.enum([
  "running",
  "succeeded",
  "waiting",
  "failed",
  "cancelled",
]);
export type CompanionAgentStepStatus = z.infer<typeof companionAgentStepStatusSchema>;

/**
 * Persisted execution mode of a companion run (plan §6 "Agent 执行模式").
 *
 * - `hybrid`: a Skill was selected, so the run may loop over its tools.
 * - `single_step`: no Skill matched (plain chitchat) — one tools-less model call.
 *
 * Recorded so the run row states what actually happened instead of relying on a
 * column default that no reader could distinguish.
 */
export const companionAgentModeSchema = z.enum(["hybrid", "single_step"]);
export type CompanionAgentMode = z.infer<typeof companionAgentModeSchema>;

export const companionAgentSettingsV1Schema = z.object({
  version: z.literal(COMPANION_AGENT_CONTRACT_VERSION),
  permissionLevel: companionAgentPermissionLevelSchema,
  enabledSkillIds: z.array(z.string().regex(/^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/)).max(32),
}).strict();
export type CompanionAgentSettingsV1 = z.infer<typeof companionAgentSettingsV1Schema>;

export const companionAgentToolDefinitionV1Schema = z.object({
  version: z.literal(COMPANION_AGENT_CONTRACT_VERSION),
  name: z.string().regex(/^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/).max(80),
  toolVersion: z.string().min(1).max(40),
  description: z.string().min(1).max(800),
  parameters: z.record(z.unknown()),
  skillIds: z.array(z.string()).min(1).max(16),
  riskClass: companionAgentRiskClassSchema,
  requiresConfirmation: z.boolean(),
  maxInputChars: z.number().int().positive().max(20_000),
  maxOutputChars: z.number().int().positive().max(20_000),
}).strict();
export type CompanionAgentToolDefinitionV1 = z.infer<
  typeof companionAgentToolDefinitionV1Schema
>;

export const companionAgentSkillManifestV1Schema = z.object({
  version: z.literal(COMPANION_AGENT_CONTRACT_VERSION),
  id: z.string().regex(/^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/).max(80),
  skillVersion: z.string().min(1).max(40),
  name: z.string().min(1).max(80),
  description: z.string().min(1).max(400),
  triggerHints: z.array(z.string().min(1).max(120)).max(16),
  systemPrompt: z.string().min(1).max(12_000),
  toolNames: z.array(z.string()).max(64),
  maxSteps: z.number().int().positive().max(COMPANION_AGENT_MAX_STEPS),
  outputMaxChars: z.number().int().positive().max(20_000),
}).strict();
export type CompanionAgentSkillManifestV1 = z.infer<
  typeof companionAgentSkillManifestV1Schema
>;

/** Safe projection returned to clients; system prompt and schemas stay server-side. */
export const companionAgentSkillSummaryV1Schema = z.object({
  version: z.literal(COMPANION_AGENT_CONTRACT_VERSION),
  id: z.string(),
  skillVersion: z.string(),
  name: z.string(),
  description: z.string(),
  enabled: z.boolean(),
}).strict();
export type CompanionAgentSkillSummaryV1 = z.infer<
  typeof companionAgentSkillSummaryV1Schema
>;

export const companionAgentToolEventV1Schema = z.object({
  toolCallId: z.string().min(1).max(200),
  name: z.string().min(1).max(80),
  toolVersion: z.string().min(1).max(40),
  riskClass: companionAgentRiskClassSchema,
  status: companionAgentToolStatusSchema,
  safeLabel: z.string().min(1).max(240),
  proposalId: z.string().uuid().optional(),
  safeSummary: z.string().max(240).optional(),
  route: z.record(z.unknown()).optional(),
}).strict();
export type CompanionAgentToolEventV1 = z.infer<typeof companionAgentToolEventV1Schema>;

export const companionAgentSkillEventV1Schema = z.object({
  skillId: z.string().min(1).max(80),
  skillVersion: z.string().min(1).max(40),
  name: z.string().min(1).max(80),
  status: z.enum(["selected", "completed"]),
}).strict();
export type CompanionAgentSkillEventV1 = z.infer<typeof companionAgentSkillEventV1Schema>;

export const companionAgentBudgetSnapshotV1Schema = z.object({
  maxSteps: z.number().int().positive().max(COMPANION_AGENT_MAX_STEPS),
  maxToolCallsPerStep: z.literal(COMPANION_AGENT_MAX_TOOL_CALLS_PER_STEP),
  maxToolCalls: z.literal(COMPANION_AGENT_MAX_TOOL_CALLS),
  deadlineMs: z.literal(COMPANION_AGENT_DEADLINE_MS),
}).strict();
export type CompanionAgentBudgetSnapshotV1 = z.infer<
  typeof companionAgentBudgetSnapshotV1Schema
>;

export function canUseCompanionAgentTool(
  permission: CompanionAgentPermissionLevel,
  definition: Pick<CompanionAgentToolDefinitionV1, "riskClass" | "requiresConfirmation">,
): { allowed: boolean; requiresConfirmation: boolean; reason?: string } {
  if (definition.riskClass === "read") {
    return { allowed: true, requiresConfirmation: false };
  }
  if (permission === "read_only") {
    return { allowed: false, requiresConfirmation: false, reason: "agent permission is read_only" };
  }
  if (definition.riskClass === "irreversible") {
    return { allowed: true, requiresConfirmation: true };
  }
  if (permission === "guided") {
    const requiresConfirmation = definition.riskClass !== "reversible_low"
      || definition.requiresConfirmation;
    return { allowed: true, requiresConfirmation };
  }
  return {
    allowed: true,
    requiresConfirmation: definition.requiresConfirmation,
  };
}
