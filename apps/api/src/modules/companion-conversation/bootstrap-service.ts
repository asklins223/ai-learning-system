/**
 * P2 — companion conversation bootstrap（03 §6.0）。
 *
 * 无副作用：只从 requireSession 的当前 scope 与既有 Companion account service
 * 构造响应；不创建 conversation/inbox/message，不读取 provider，不接受 query/body。
 * features 依次精确投影服务端有效能力（fail-closed），不读取 NEXT_PUBLIC_*。
 */

import { getCompanionOverview } from "../companion-shell/service.ts";
import {
  companionBootstrapResponseV1Schema,
  type CompanionBootstrapFeaturesV1,
} from "@ailearn/shared";

/** 服务端能力开关（fail-closed）。P1/P2 交付：petSurface 由
 *  COMPANION_PET_V1_ENABLED 授权（服务端账号 capability，03 §6.0
 *  要求依次精确投影，不能硬编码恒 true）；textConversation 由
 *  COMPANION_DIALOGUE_V1_ENABLED 授权（P2 主开关）；
 *  Live2D 由 COMPANION_LIVE2D_V1_ENABLED 单独授权（P4 主开关）。 */
export function getCompanionBootstrapFeatures(): CompanionBootstrapFeaturesV1 {
  const petEnabled = process.env.COMPANION_PET_V1_ENABLED === "true";
  const dialogueEnabled = process.env.COMPANION_DIALOGUE_V1_ENABLED === "true";
  const actionBridgeEnabled = process.env.COMPANION_ACTION_BRIDGE_V1_ENABLED === "true";
  const live2dEnabled = process.env.COMPANION_LIVE2D_V1_ENABLED === "true";
  const journeyEnabled = process.env.COMPANION_JOURNEY_V2 === "true";
  return {
    petSurface: petEnabled,
    textConversation: dialogueEnabled,
    voiceDialogue: dialogueEnabled && process.env.COMPANION_VOICE_DIALOGUE_V1_ENABLED === "true",
    live2d: live2dEnabled,
    learningActions: dialogueEnabled && actionBridgeEnabled,
    streamingVoice: dialogueEnabled && process.env.COMPANION_STREAMING_VOICE_V1_ENABLED === "true",
    // §10.1/§14.3（2026-08-15 接线修复）：Journey 引导 + 主动 delivery 由
    // COMPANION_JOURNEY_V2 同一开关授权（端点 fail-closed 404 对齐）。
    journey: journeyEnabled,
    deliveries: journeyEnabled,
  };
}

export async function getCompanionBootstrap(
  userId: string,
  workspaceId: string,
): Promise<{
  body: unknown;
  features: CompanionBootstrapFeaturesV1;
}> {
  const overview = await getCompanionOverview(userId, workspaceId);
  const features = getCompanionBootstrapFeatures();
  const body = companionBootstrapResponseV1Schema.parse({
    version: 1,
    userId,
    workspaceId,
    account: overview.account,
    features,
    serverTime: new Date().toISOString(),
  });
  return { body, features };
}
