import type {
  AIProvider,
  GenerateCardInput,
  EvaluateValidationInput,
  RepairCardInput,
  ProviderUsage,
  AnalyzeImageInput,
} from "../ai-provider.ts";
import type {
  LearningCardOutput,
  EvaluateValidationOutput,
  GenerateValidationQuestionOutput,
  EvaluateRubricOutput,
  GenerateValidationQuestionInput,
  EvaluateRubricInput,
  CardMapInput,
  CardMapOutput,
  ImageInsightOutput,
} from "@ailearn/shared";

export class MockProvider implements AIProvider {
  id = "mock";
  modelId = "mock-v1";
  visionModelId = "mock-vision-v1";
  promptVersion = "v2-mock";

  // v0.6: Track usage from the last call (计划 §6.6, §10.5)
  private lastUsage: ProviderUsage | null = null;

  getLastUsage(): ProviderUsage | null {
    return this.lastUsage;
  }

  /**
   * Estimate token count for mock responses.
   * Mock doesn't call a real API, so we estimate based on input/output size.
   * Rough estimate: ~1 token per 4 chars for mixed CJK + ASCII.
   */
  private estimateUsage(inputText: string, outputText: string): ProviderUsage {
    const promptTokens = Math.ceil(inputText.length / 4);
    const completionTokens = Math.ceil(outputText.length / 4);
    return {
      totalTokens: promptTokens + completionTokens,
      promptTokens,
      completionTokens,
      requestId: null,
    };
  }

  /** M5 成本观测：统一记录 mock 调用 usage 并原样返回输出 */
  private recordUsage<T>(input: unknown, output: T): T {
    this.lastUsage = this.estimateUsage(JSON.stringify(input), JSON.stringify(output));
    return output;
  }

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

    const output: LearningCardOutput = keyPoints.length === 0
      ? {
          title: input.noteTitle,
          summary: "（Mock provider：未找到足够文本，无法生成要点）",
          key_points: [
            {
              ordinal: 0,
              claim: "请在笔记中加入更多正文后再生成学习卡",
              quote_text: "请在笔记中加入更多正文后再生成学习卡",
            },
          ],
        }
      : {
          title: input.noteTitle,
          summary: `自动摘要：本文共 ${input.blocks.length} 个块，提取 ${keyPoints.length} 个要点。`,
          key_points: keyPoints,
        };
    // M5 成本观测：mock provider 也记录 usage，保证 cost_tokens 在开发/E2E 环境非空
    this.lastUsage = this.estimateUsage(JSON.stringify(input), JSON.stringify(output));
    return output;
  }

  async extractCardCandidates(
    input: CardMapInput,
    signal?: AbortSignal,
  ): Promise<CardMapOutput> {
    if (signal?.aborted) throw new Error("aborted before extractCardCandidates");
    const candidates: CardMapOutput["candidates"] = [];
    const noCandidateUnitIds: CardMapOutput["noCandidateUnitIds"] = [];

    for (const unit of input.evidenceUnits) {
      if (unit.contextOnly) continue;
      const normalized = unit.text.replace(/\s+/g, " ").trim();
      if (normalized.length < 12) {
        noCandidateUnitIds.push({ unitId: unit.refId, reason: "metadata" });
        continue;
      }
      const snippet = normalized.split(/[。.!?！？]/)[0]?.trim() || normalized;
      const localId = `c${candidates.length + 1}`;
      candidates.push({
        localId,
        claim: `该资料单元揭示的核心结论是：${snippet.slice(0, 180)}`,
        evidenceRefIds: [unit.refId],
        topic: unit.sectionPath.at(-1) ?? input.noteTitle,
        cognitiveType: "concept",
        importance: candidates.length < 3 ? "core" : "supporting",
      });
    }

    const output: CardMapOutput = {
      sectionSummary: `共处理 ${input.evidenceUnits.filter((unit) => !unit.contextOnly).length} 个主证据单元。`,
      candidates,
      noCandidateUnitIds,
    };
    this.lastUsage = this.estimateUsage(JSON.stringify(input), JSON.stringify(output));
    return output;
  }

  async analyzeImage(
    input: AnalyzeImageInput,
    signal?: AbortSignal,
  ): Promise<ImageInsightOutput> {
    if (signal?.aborted) throw new Error("aborted before analyzeImage");
    const output: ImageInsightOutput = {
      contentType: "decorative",
      decorative: true,
      caption: input.userDescription?.trim().slice(0, 1_000)
        || "Mock provider 已检查图片；未生成视觉事实。",
      ocr: [],
      facts: [],
      promptInjectionDetected: false,
      safetyFlags: ["mock_no_visual_inference"],
      unresolvedReason: null,
    };
    this.lastUsage = this.estimateUsage(
      JSON.stringify({ mimeType: input.mimeType, width: input.width, height: input.height }),
      JSON.stringify(output),
    );
    return output;
  }

  async evaluateValidation(input: EvaluateValidationInput, signal?: AbortSignal): Promise<EvaluateValidationOutput> {
    // R-007: 检查是否已取消
    if (signal?.aborted) throw new Error("aborted before evaluateValidation");
    const overlap = simpleOverlap(input.userAnswer, input.quote);
    if (overlap > 0.6) {
      return this.recordUsage(input, {
        outcome: "preliminary_understanding",
        confidence: 0.9,
        feedback: "回答与原文一致，覆盖核心要点",
        covered_points: [input.claim.slice(0, 40)],
        missing_points: [],
        misunderstandings: [],
        evidence_refs: [input.quote.slice(0, 60)],
      });
    }
    if (overlap > 0.3) {
      return this.recordUsage(input, {
        outcome: "unclear_expression",
        confidence: 0.6,
        feedback: "部分要点命中，表达可更清晰",
        covered_points: [],
        missing_points: [input.claim.slice(0, 40)],
        misunderstandings: [],
        evidence_refs: [],
      });
    }
    if (overlap > 0.05) {
      return this.recordUsage(input, {
        outcome: "unclear_expression",
        confidence: 0.4,
        feedback: "与原文相关性较弱，建议回看证据",
        covered_points: [],
        missing_points: [input.claim.slice(0, 40)],
        misunderstandings: [],
        evidence_refs: [],
      });
    }
    return this.recordUsage(input, {
      outcome: "misunderstanding",
      confidence: 0.7,
      feedback: "未命中原文要点，存在误解",
      covered_points: [],
      missing_points: [input.claim.slice(0, 40)],
      misunderstandings: [input.claim.slice(0, 40)],
      evidence_refs: [input.quote.slice(0, 60)],
    });
  }

  // v0.6: Mock question + rubric generation (计划 §7.1)
  async generateValidationQuestion(
    input: GenerateValidationQuestionInput,
    signal?: AbortSignal,
  ): Promise<GenerateValidationQuestionOutput> {
    if (signal?.aborted) throw new Error("aborted before generateValidationQuestion");

    // Mock: generate a safe question that doesn't leak the claim
    // Use the claim to build a contextual question without revealing the conclusion
    const claimSnippet = input.claim.slice(0, 30);
    const evidenceRef = input.evidenceRefs[0];
    if (!evidenceRef) {
      throw new Error("MockProvider: at least one evidence ref is required");
    }

    const questionType = input.preferredType ?? "explain";

    const questionTexts: Record<string, string> = {
      explain: `关于「${claimSnippet}…」这一知识点，\n请用自己的话解释其核心含义和背后的原理。`,
      example: `请举一个具体的例子来说明「${claimSnippet}…」这一知识点的原理。\n并解释你的例子如何体现其核心原理。`,
      apply: `在实际场景中，「${claimSnippet}…」的适用条件是什么？\n如果忽视它可能出现什么问题？`,
    };

    this.lastUsage = this.estimateUsage(
      JSON.stringify(input),
      JSON.stringify(questionTexts[questionType]),
    );

    return {
      questionType,
      question: questionTexts[questionType],
      rubricItems: [
        {
          key: "rp_1",
          criterion: "回答识别出该知识点的核心概念",
          expectedConcept: input.claim.slice(0, 80),
          weight: 3,
          required: true,
          evidenceRefId: evidenceRef.refId,
        },
        {
          key: "rp_2",
          criterion: "回答用自己的话解释了原理或因果关系",
          expectedConcept: "用自己的语言解释了知识点的原理",
          weight: 2,
          required: true,
          evidenceRefId: evidenceRef.refId,
        },
        {
          key: "rp_3",
          criterion: "回答体现了对适用场景或条件的理解",
          expectedConcept: "理解知识点的适用条件和边界",
          weight: 1,
          required: false,
          evidenceRefId: evidenceRef.refId,
        },
      ],
    };
  }

  // v0.6: Mock rubric-based evaluation (计划 §7.2)
  async evaluateRubric(
    input: EvaluateRubricInput,
    signal?: AbortSignal,
  ): Promise<EvaluateRubricOutput> {
    if (signal?.aborted) throw new Error("aborted before evaluateRubric");

    const answer = input.userAnswer.trim();
    const tooShort = answer.length < 5;

    // Compute per-item overlap using character bigrams against each criterion
    const itemResults = input.rubricItems.map((item) => {
      let verdict: "covered" | "partial" | "missing" | "contradicted" | "not_assessable";
      let confidence: number;

      if (tooShort) {
        verdict = "not_assessable";
        confidence = 0.3;
      } else {
        const overlap = charBigramOverlap(answer, item.criterion);
        if (overlap > 0.4) {
          verdict = "covered";
          confidence = 0.8;
        } else if (overlap > 0.2) {
          verdict = item.required ? "partial" : "covered";
          confidence = 0.6;
        } else {
          verdict = "missing";
          confidence = 0.4;
        }
      }

      return {
        rubricItemId: item.rubricItemId,
        verdict,
        confidence,
        rationale: `Mock 评估：回答与评分标准「${item.criterion.slice(0, 30)}」的匹配度分析`,
      };
    });

    // Overall feedback based on result distribution
    const coveredCount = itemResults.filter((r) => r.verdict === "covered").length;
    const totalCount = itemResults.length;
    const feedback =
      coveredCount === totalCount
        ? "回答较好地覆盖了核心要点"
        : coveredCount > 0
          ? "回答部分命中，表达可更清晰"
          : tooShort
            ? "回答过短，无法有效评估"
            : "回答与知识点相关性较弱，建议回看证据";

    this.lastUsage = this.estimateUsage(
      JSON.stringify(input),
      JSON.stringify({ itemResults, feedback }),
    );

    return { itemResults, feedback };
  }

  // v0.6: Mock card repair (计划 §7.7)
  async repairCard(
    input: RepairCardInput,
    signal?: AbortSignal,
  ): Promise<LearningCardOutput> {
    if (signal?.aborted) throw new Error("aborted before repairCard");

    // Mock: re-extract key points from source blocks, fixing the issues
    // by ensuring quote_text comes directly from the source
    const candidates = input.sourceBlocks
      .filter((b) => b.trim().length > 10)
      .slice(0, 5);

    const keyPoints = candidates.map((block, idx) => {
      const firstSentence = block
        .replace(/\n+/g, " ")
        .split(/[。.!?！？]/)[0]
        .trim()
        .slice(0, 240);
      return {
        ordinal: idx,
        claim: `要点 ${idx + 1}：${firstSentence.slice(0, 80)}`,
        quote_text: firstSentence || block.slice(0, 240),
      };
    });

    if (keyPoints.length === 0) {
      // If no valid source blocks, return the draft as-is
      return this.recordUsage(input, input.draft);
    }

    return this.recordUsage(input, {
      title: input.draft.title,
      summary: input.draft.summary,
      key_points: keyPoints,
    });
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

/**
 * Character bigram overlap for Chinese text.
 * Chinese text has no spaces, so word-level overlap fails.
 * Bigram (2-char) overlap is a simple but effective approximation.
 */
function charBigramOverlap(a: string, b: string): number {
  const aBigrams = new Set<string>();
  const aClean = a.replace(/\s+/g, "");
  for (let i = 0; i < aClean.length - 1; i++) {
    aBigrams.add(aClean.slice(i, i + 2));
  }
  if (aBigrams.size === 0) return 0;

  const bClean = b.replace(/\s+/g, "");
  let hits = 0;
  let total = 0;
  for (let i = 0; i < bClean.length - 1; i++) {
    total++;
    if (aBigrams.has(bClean.slice(i, i + 2))) hits++;
  }
  return total === 0 ? 0 : hits / total;
}
