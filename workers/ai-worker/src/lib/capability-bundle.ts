/**
 * R2: CapabilityBundle — adapter that combines multiple capability providers.
 *
 * Replaces CompositeAIProvider as the way to pass multiple providers to
 * AgentRuntime. Instead of combining into a single AIProvider interface,
 * each capability is held separately, allowing task-specific routing.
 *
 * Migration strategy (§3.8):
 * - R2: bundle is optional on AgentRuntimeConfig; old provider path retained
 * - R3: agent/roles/*.ts and agent/tools/*.ts migrate to bundle
 * - R5: provider field and CompositeAIProvider deleted; bundle is sole path
 *
 * @see docs/plans/provider-registry-refactor.md §3.8, §3.9
 */

import type {
  ProviderCapability,
  AgentTurnCapability,
  TextGenerationCapability,
  VisionCapability,
  ProviderRuntimeConfig,
} from "@ailearn/shared";
import { createCapabilityProvider } from "./provider-factory.ts";
import type { AIGovernanceContext } from "./governance.ts";
import { resolveProviderForTask } from "./governance.ts";

/**
 * Adapter that combines multiple capability providers.
 * Replaces CompositeAIProvider as the way to pass multiple providers to AgentRuntime.
 */
export interface CapabilityBundle {
  /** Agent 工具调用（Supervisor / Specialist 角色使用） */
  agentTurn: AgentTurnCapability;
  /** 文本生成（验证评估、题目生成等轻量任务） */
  textGeneration: TextGenerationCapability;
  /** 视觉理解（图片分析） */
  vision: VisionCapability;
  /** 能力快照（fingerprint 固化到 run） */
  capability: ProviderCapability;
}

/**
 * R3: Build a CapabilityBundle from the governance context using task routing.
 *
 * Uses resolveProviderForTask() to determine which provider to use for each
 * capability slot, enabling different providers for different task types
 * (e.g., expensive model for card generation, free model for validation).
 *
 * Returns null when the provider cannot be created (e.g., missing API key),
 * causing the caller to fall back to the old createProvider path.
 *
 * @see docs/plans/provider-registry-refactor.md §3.8
 */
export async function buildCapabilityBundle(
  govCtx: AIGovernanceContext,
): Promise<CapabilityBundle | null> {
  // R3: Use resolveProviderForTask to route each capability to the correct provider.
  const agentRes = resolveProviderForTask(govCtx, "card_generation");
  const textRes = resolveProviderForTask(govCtx, "evaluate_validation");
  const visionRes = resolveProviderForTask(govCtx, "analyze_image");

  // Create agent_turn provider
  const agentProvider = createCapabilityProvider(
    agentRes.providerName,
    "agent_turn",
    agentRes.providerConfig as ProviderRuntimeConfig,
  );
  if (!agentProvider) return null;

  // Create text_generation provider (may differ from agent_turn in R3+)
  const textProvider = createCapabilityProvider(
    textRes.providerName,
    "text_generation",
    textRes.providerConfig as ProviderRuntimeConfig,
  );
  if (!textProvider) return null;

  // Create vision provider (may be a different platform from text)
  const visionProvider = createCapabilityProvider(
    visionRes.providerName,
    "vision",
    visionRes.providerConfig as ProviderRuntimeConfig,
  );
  if (!visionProvider) return null;

  // Extract capability snapshot from agent provider
  const agentCap = agentProvider as unknown as { getCapabilities?: () => ProviderCapability };
  const capability = agentCap.getCapabilities?.();
  if (!capability) return null;

  return {
    agentTurn: agentProvider as unknown as AgentTurnCapability,
    textGeneration: textProvider as unknown as TextGenerationCapability,
    vision: visionProvider as unknown as VisionCapability,
    capability,
  };
}
