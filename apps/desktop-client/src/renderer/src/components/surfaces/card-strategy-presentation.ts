import type { CardStrategyV2 } from "@ailearn/shared/card-generation-v2-contracts";

/** 卡型是思考策略；选择、口述等是做题时可用的作答方式。 */
export const cardStrategyPresentation: Record<CardStrategyV2, { label: string; cue: string; symbol: string }> = {
  recall: { label: "主动回忆", cue: "先从记忆里找答案", symbol: "✦" },
  cloze: { label: "关键补全", cue: "补上最关键的一环", symbol: "◈" },
  compare: { label: "对比辨析", cue: "看清相似与不同", symbol: "◐" },
  sequence: { label: "顺序重建", cue: "把步骤重新排好", symbol: "➳" },
  why: { label: "机制解释", cue: "说清背后的原因", symbol: "✳" },
  boundary: { label: "边界判断", cue: "找到成立的条件", symbol: "◇" },
  application: { label: "情境应用", cue: "把知识用到情境中", symbol: "✿" },
};

export function cardStrategyLabel(strategy: CardStrategyV2 | null | undefined): string {
  return strategy ? cardStrategyPresentation[strategy].label : "尚无学习卡";
}
