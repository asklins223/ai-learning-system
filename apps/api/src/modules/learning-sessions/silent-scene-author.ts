/**
 * 任务 14 接线：确定性 silent Scene 数据生成（最小 Scene Author，api 侧）。
 *
 * 背景：worker 侧 SceneAuthorPort 仅有接口无实现（05-1 完整 Scene Author 属
 * W4 任务 05）。为让 silent 路线**真实可达**（用户要求：做完验证就直接接，
 * 不留 fail-closed 挡着的半成品），api 侧先提供确定性生成器：
 * - 从 canonical claim 文本拆分语义片段 → ordering items（完成操作必需，
 *   01-2 §3.2 净化题面）；
 * - 同一 claim 派生 repair 变式（把一个片段标为「待修复位」，允许操作
 *   delete/replace/move——不泄漏正确顺序，formal 无中途反馈）；
 * - 确定性（同输入同输出）：shuffleStrategy、hash、ids 均从 claim 派生，
 *   不依赖 LLM/provider；后续 W4 Scene Author 接入后替换本模块。
 *
 * 输出对齐 shared scene-contracts 的 public payload 形状（前端
 * SilentProofScene/TapSelectPlaceLayer 直接消费）。
 */

import { sha256Hex } from "@ailearn/shared/content-hash";

export interface SilentSceneDataV1 {
  ordering: {
    items: Array<{ id: string; text: string }>;
    shuffleStrategy: string;
    emptySlots: number;
    dragProtocol: string;
  };
  repair: {
    brokenTokens: Array<{ id: string; text: string }>;
    operationProtocol: string;
    allowedOperations: string[];
  };
}

const ORDERING_ITEMS_MAX = 6;
const REPAIR_TOKENS_MAX = 5;

/** claim → 语义片段（句号/分号/逗号/换行拆句；空段过滤；去首尾空白）。 */
export function splitClaimIntoFragments(claim: string): string[] {
  return claim
    .split(/[。；;\n]+/)
    .map((part) => part.replace(/[,，、]/, " ").trim())
    .filter((part) => part.length >= 2)
    .slice(0, ORDERING_ITEMS_MAX);
}

/**
 * 从 claim 派生 ordering + repair 场景 public 数据（确定性）。
 * 输入不足（<2 个片段）→ 返回 null（调用方回退 text/voice，不伪造场景）。
 */
export function buildSilentSceneData(
  keyPointId: string,
  claim: string,
  sourceFingerprint: string,
): SilentSceneDataV1 | null {
  const fragments = splitClaimIntoFragments(claim);
  if (fragments.length < 2) return null;

  const seed = sha256Hex(`${keyPointId}:${claim}:${sourceFingerprint}`);
  const items = fragments.map((text, index) => ({
    id: `step-${index + 1}-${sha256Hex(`${seed}:${index}`).slice(0, 12)}`,
    text,
  }));

  // repair 变式：除首片段外各取一段作为「修复位」（不标注对错，formal 无反馈）。
  const brokenTokens = items.slice(1, REPAIR_TOKENS_MAX + 1);

  return {
    ordering: {
      items,
      shuffleStrategy: "deterministic-fragment-order",
      emptySlots: items.length,
      dragProtocol: "tap-select-place",
    },
    repair: {
      brokenTokens,
      operationProtocol: "tap-select-place",
      allowedOperations: ["delete", "replace", "move"],
    },
  };
}
