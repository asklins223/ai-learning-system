import type { AIProvider, GenerateCardInput, EvaluateValidationInput } from "../ai-provider.ts";
import type { LearningCardOutput, EvaluateValidationOutput } from "@ailearn/shared";

export class MockProvider implements AIProvider {
  id = "mock";
  modelId = "mock-v1";
  promptVersion = "v2-mock";

  async generateCard(input: GenerateCardInput, signal?: AbortSignal): Promise<LearningCardOutput> {
    // R-007: 检查是否已取消
    if (signal?.aborted) throw new Error("aborted before generateCard");
    const candidates = input.blocks
      .filter((b) => b.type !== "code" && b.type !== "image" && b.content.trim().length > 10)
      .slice(0, 5);

    const keyPoints = candidates.map((block, idx) => {
      const firstSentence = block.content
        .replace(/\n+/g, " ")
        .split(/[。.!?！？]/)[0]
        .trim()
        .slice(0, 240);
      return {
        ordinal: idx,
        claim: `要点 ${idx + 1}：${firstSentence.slice(0, 80)}`,
        quote_text: firstSentence || block.content.slice(0, 240),
      };
    });

    if (keyPoints.length === 0) {
      return {
        title: input.noteTitle,
        summary: "（Mock provider：未找到足够文本，无法生成要点）",
        key_points: [
          {
            ordinal: 0,
            claim: "请在笔记中加入更多正文后再生成学习卡",
            quote_text: "请在笔记中加入更多正文后再生成学习卡",
          },
        ],
      };
    }

    return {
      title: input.noteTitle,
      summary: `自动摘要：本文共 ${input.blocks.length} 个块，提取 ${keyPoints.length} 个要点。`,
      key_points: keyPoints,
    };
  }

  async evaluateValidation(input: EvaluateValidationInput, signal?: AbortSignal): Promise<EvaluateValidationOutput> {
    // R-007: 检查是否已取消
    if (signal?.aborted) throw new Error("aborted before evaluateValidation");
    const overlap = simpleOverlap(input.userAnswer, input.quote);
    if (overlap > 0.6) {
      return {
        outcome: "preliminary_understanding",
        confidence: 0.9,
        feedback: "回答与原文一致，覆盖核心要点",
        covered_points: [input.claim.slice(0, 40)],
        missing_points: [],
        misunderstandings: [],
        evidence_refs: [input.quote.slice(0, 60)],
      };
    }
    if (overlap > 0.3) {
      return {
        outcome: "unclear_expression",
        confidence: 0.6,
        feedback: "部分要点命中，表达可更清晰",
        covered_points: [],
        missing_points: [input.claim.slice(0, 40)],
        misunderstandings: [],
        evidence_refs: [],
      };
    }
    if (overlap > 0.05) {
      return {
        outcome: "unclear_expression",
        confidence: 0.4,
        feedback: "与原文相关性较弱，建议回看证据",
        covered_points: [],
        missing_points: [input.claim.slice(0, 40)],
        misunderstandings: [],
        evidence_refs: [],
      };
    }
    return {
      outcome: "misunderstanding",
      confidence: 0.7,
      feedback: "未命中原文要点，存在误解",
      covered_points: [],
      missing_points: [input.claim.slice(0, 40)],
      misunderstandings: [input.claim.slice(0, 40)],
      evidence_refs: [input.quote.slice(0, 60)],
    };
  }

}

function simpleOverlap(a: string, b: string): number {
  const as = new Set(a.toLowerCase().split(/[\s,.，。；;!?！？]+/).filter(Boolean));
  const bs = b.toLowerCase().split(/[\s,.，。；;!?！？]+/).filter(Boolean);
  if (bs.length === 0) return 0;
  let hits = 0;
  for (const w of bs) if (as.has(w)) hits++;
  return hits / bs.length;
}
