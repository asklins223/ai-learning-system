/**
 * 方案 20 §23.1 — 语料共享工具。
 *
 * - `sha256Text`：exactTextHash 必须是内容真实 SHA-256（禁止占位符）；
 * - 标注辅助：`labelA`/`labelB` 双标注 + 仲裁的记录类型（台账见
 *   docs/evidence/learning-companion/20-learning-card-v2-corpus-labeling.md）。
 */

import { createHash } from "node:crypto";

export function sha256Text(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** §23.1：双标注（A/B 独立）+ 第三人仲裁记录。 */
export interface LabelingRecordV2 {
  fixtureId: string;
  /** 标注者 A：独立给出的卡数范围。 */
  labelA: { range: { min: number; max: number }; notes: string };
  /** 标注者 B：独立给出的卡数范围。 */
  labelB: { range: { min: number; max: number }; notes: string };
  /** 仲裁结论（第三人 adjudicate）。 */
  adjudicated: { range: { min: number; max: number }; notes: string };
}
