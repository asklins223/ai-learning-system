/**
 * Deterministic Question Fallback (计划 §7.6)
 *
 * 当 AI question 未配置、超时或 schema 失败时，生成持久化的 deterministic question。
 *
 * - 迁移自 apps/web/lib/validation-question.ts (v8)
 * - 生成完整的 GenerateValidationQuestionOutput（含 rubric items）
 * - deterministic fallback 允许 1 个 required rubric item
 * - fallback 仍必须有一个绑定 key point claim 与硬证据的 required rubric item
 * - fallback 可用于学习连续性，但 RC 报告必须分开统计 AI 与 deterministic 结果
 * - legacy 客户端自由题面只能记录历史，不能升级
 */

import {
  QuestionType,
  type QuestionType as QuestionTypeEnum,
} from "./enums.ts";
import type { GenerateValidationQuestionOutput } from "./schemas.ts";
import type { GenerateValidationQuestionInput } from "./schemas.ts";
import { assessQuestionOutput } from "./question-safety.ts";

// ─── Types ────────────────────────────────────────────────────────────────

type ClaimStructure = "conditional" | "mechanism" | "topic" | "general";

interface QuestionContext {
  /** 用户可见的问题上下文——足够理解"在问什么"，但不含 claim 的结论 */
  context: string;
  /** claim 的结构类型，用于生成有针对性的问题 */
  structure: ClaimStructure;
}

// ─── Key Point Claim Normalization ────────────────────────────────────────

const KEY_POINT_PREFIX =
  /^(?:(?:关键)?要点)\s*(?:\d+|[一二三四五六七八九十]+)\s*[：:、.．)）\-]\s*/u;

/**
 * 移除"要点 N："前缀。
 */
export function normalizeKeyPointClaim(value: string): string {
  const trimmed = value.replace(/\s+/g, " ").trim();
  const normalized = trimmed.replace(KEY_POINT_PREFIX, "").trim();
  return normalized || trimmed;
}

// ─── 结论去除工具 ─────────────────────────────────────────────────────────

/**
 * 去掉 claim 中的结论性动词及其后的内容。
 */
function stripConclusiveVerbs(text: string): string {
  const stripped = text.replace(
    /(?:揭示了?|证明了?|说明了?|表明了?|指出了?|体现了?|反映了?|证实了?|验证了?|展示了?|呈现了?|决定了?|意味着?|构成了?|形成了?).*/s,
    "",
  ).trim();
  return stripped.length >= 4 ? stripped : text;
}

/**
 * 去掉 claim 中的结论性内容，保留前提/背景。
 */
function stripConclusion(text: string): string {
  let result = text;

  // 去掉 "这是..." 总结性从句
  result = result.replace(/[，,]这是.*/s, "");

  // 去掉使役动词后的结论："X使Y" → "X"
  const causativeMatch = result.match(/^(.+?)(?:使|让|令)(.+)$/s);
  if (causativeMatch && causativeMatch[1].trim().length >= 8) {
    result = causativeMatch[1].trim();
  }

  // 去掉因果词后的内容
  result = result.replace(
    /[，,](?:从而|以|使得|导致|因此|所以|进而|便能|就能|才能|以达到|以避免|以防|防止|否则|不然|不应|不要|不能|而|这是).*/s,
    "",
  );

  // 去掉建议/推荐从句
  result = result.replace(
    /[，,](?:应|应该|需要|必须|优先|建议|推荐).*/s,
    "",
  );

  // 如果截断后太短，返回原文
  return result.trim().length >= 4 ? result.trim() : text.trim();
}

// ─── 工具函数 ─────────────────────────────────────────────────────────────

/**
 * 截断文本到指定长度，超出部分用省略号替代。
 */
function compactText(text: string, limit: number): string {
  const value = (text ?? "").replace(/\s+/g, " ").trim();
  if (value.length <= limit) return value;
  return `${value.slice(0, limit - 3).trim()}...`;
}

// ─── 上下文提取 ───────────────────────────────────────────────────────────

function extractQuestionContext(claim: string): QuestionContext {
  const normalized = normalizeKeyPointClaim(claim);

  // 1. "之所以X，是因为Y" → 上下文 = "X"
  const reasonMatch = normalized.match(/^(.+?)之所以/);
  if (reasonMatch && reasonMatch[1].trim().length >= 4) {
    return {
      context: compactText(reasonMatch[1].trim(), 70),
      structure: "general",
    };
  }

  // 2. 条件类："当X时，Y"
  const condMatch = normalized.match(/^当(.+?)(?:时[，,])/);
  if (condMatch && condMatch[1].trim().length >= 6) {
    return {
      context: `当${compactText(condMatch[1].trim(), 70)}时`,
      structure: "conditional",
    };
  }

  // 3. 条件类："如果/若X，则Y"
  const ifMatch = normalized.match(/^(如果|若)(.+?)(?:[，,])/);
  if (ifMatch && ifMatch[2].trim().length >= 6) {
    return {
      context: `${ifMatch[1]}${compactText(ifMatch[2].trim(), 70)}`,
      structure: "conditional",
    };
  }

  // 4. "即便/即使/无论X"
  const evenIfMatch = normalized.match(/^(即便|即使|无论)(.+?)(?:[，,])/);
  if (evenIfMatch && evenIfMatch[2].trim().length >= 6) {
    return {
      context: `${evenIfMatch[1]}${compactText(evenIfMatch[2].trim(), 70)}`,
      structure: "conditional",
    };
  }

  // 5. 机制类："X——Y——Z"
  const dashParts = normalized.split(/——|—/);
  if (dashParts.length > 1 && dashParts[0].trim().length >= 6) {
    return {
      context: compactText(stripConclusiveVerbs(dashParts[0].trim()), 70),
      structure: "mechanism",
    };
  }

  // 6. 主题类："X：Y"
  const colonParts = normalized.split(/[：:]/, 2);
  if (colonParts.length > 1 && colonParts[0].trim().length >= 6) {
    return {
      context: compactText(stripConclusiveVerbs(colonParts[0].trim()), 70),
      structure: "topic",
    };
  }

  // 7. 去掉因果/目的/结论从句
  const causalCut = stripConclusion(normalized);
  if (causalCut.trim().length >= 8 && causalCut.trim().length < normalized.length) {
    return {
      context: compactText(causalCut.trim(), 70),
      structure: "general",
    };
  }

  // 8. 去掉建议/推荐从句
  const recCut = normalized.replace(
    /[，,](?:应|应该|需要|必须|优先|建议|推荐).*/s,
    "",
  );
  if (recCut.trim().length >= 8 && recCut.trim().length < normalized.length) {
    return {
      context: compactText(recCut.trim(), 70),
      structure: "general",
    };
  }

  // 9. 取第一个分句
  const firstClause = normalized.split(/[，,。.！!？?]/)[0];
  if (firstClause.trim().length >= 6) {
    return {
      context: compactText(stripConclusiveVerbs(firstClause.trim()), 70),
      structure: "general",
    };
  }

  return {
    context: compactText(normalized, 70),
    structure: "general",
  };
}

// ─── 题型选择 ─────────────────────────────────────────────────────────────

/**
 * 根据 claim 的句式结构选择最合适的题型。
 */
export function chooseQuestionType(
  claim: string,
  index: number,
): QuestionTypeEnum {
  if (/之所以.*是因为/.test(claim)) {
    return (["explain", "apply", "example"] as const)[index % 3];
  }

  if (/当.+?时|如果|若|在.+?(?:下|时)|条件下|前提是|适用|边界|例外|即便|即使|无论/.test(claim)) {
    return (["apply", "explain", "example"] as const)[index % 3];
  }

  if (/(?:应|应该|需要|必须|优先|建议|推荐)/.test(claim)) {
    return (["apply", "explain", "example"] as const)[index % 3];
  }

  if (/通过|使得|导致|产生|形成|体现|表现为|能|可以/.test(claim)) {
    return (["explain", "example", "apply"] as const)[index % 3];
  }

  return (["explain", "example", "apply"] as const)[index % 3];
}

// ─── 题型 prompt 生成器 ──────────────────────────────────────────────────

function needsTopicSuffix(context: string): boolean {
  return context.length <= 10;
}

function buildExplainPrompt(context: string, structure: ClaimStructure): string {
  const useHelper = needsTopicSuffix(context);

  switch (structure) {
    case "conditional":
      return `${context}，此时应该如何处理？为什么？\n请用自己的话解释你的思路和背后的原理。`;
    case "mechanism":
      if (useHelper) {
        return `关于「${context}」这一知识点，\n请用自己的话解释其核心原理——它为什么有效？背后的工作机制是什么？`;
      }
      return `关于「${context}」这一设计，\n请用自己的话解释其核心原理——它为什么有效？背后的工作机制是什么？`;
    case "topic":
      if (useHelper) {
        return `关于「${context}」这一知识点，\n请用自己的话解释其核心含义和背后的原理。`;
      }
      return `关于「${context}」，\n请用自己的话解释其核心含义和背后的原理。`;
    default:
      if (useHelper) {
        return `关于「${context}」这一知识点，\n请用自己的话解释这背后的原理和因果关系。`;
      }
      return `${context}\n请用自己的话解释这背后的原理和因果关系。`;
  }
}

function buildExamplePrompt(context: string, structure: ClaimStructure): string {
  const useHelper = needsTopicSuffix(context);

  switch (structure) {
    case "conditional":
      return `请举一个具体的实际场景：${context}。\n在这个场景中你会如何处理？请解释你的例子如何体现相关原理。`;
    case "mechanism":
      if (useHelper) {
        return `请举一个具体的例子来说明「${context}」这一知识点的原理。\n并解释你的例子如何体现其工作机制。`;
      }
      return `请举一个具体的例子来说明「${context}」的原理。\n并解释你的例子如何体现其工作机制。`;
    case "topic":
      if (useHelper) {
        return `请举一个具体的例子来说明「${context}」这一知识点。\n并解释你的例子如何体现其核心原理。`;
      }
      return `请举一个具体的例子来说明「${context}」。\n并解释你的例子如何体现其核心原理。`;
    default:
      if (useHelper) {
        return `请举一个具体的例子来说明「${context}」这一知识点。\n并解释你的例子如何体现其原理。`;
      }
      return `请举一个具体的例子来说明以下内容：\n${context}\n并解释你的例子如何体现其原理。`;
  }
}

function buildApplyPrompt(context: string, structure: ClaimStructure): string {
  const useHelper = needsTopicSuffix(context);

  switch (structure) {
    case "conditional":
      return `${context}，\n这一条件为什么重要？忽视它会带来什么后果？应该如何应对？`;
    case "mechanism":
      if (useHelper) {
        return `在实际场景中，什么情况下应该关注「${context}」这一知识点？\n如果忽视它可能出现什么问题？`;
      }
      return `在实际场景中，什么情况下应该关注「${context}」？\n如果忽视它可能出现什么问题？`;
    case "topic":
      if (useHelper) {
        return `在实际场景中，「${context}」这一知识点的适用条件是什么？\n如果忽视它可能出现什么问题？`;
      }
      return `在实际场景中，「${context}」的适用条件是什么？\n如果忽视它可能出现什么问题？`;
    default:
      if (useHelper) {
        return `关于「${context}」这一知识点，\n在实际场景中这会带来什么影响？如果忽视它可能出现什么问题？`;
      }
      return `${context}\n在实际场景中这会带来什么影响？如果忽视它可能出现什么问题？`;
  }
}

// ─── Deterministic Question Generation ────────────────────────────────────

/**
 * Build a deterministic validation question prompt from a claim.
 *
 * This is the core logic migrated from apps/web/lib/validation-question.ts (v8).
 * It generates a question that gives enough context for the user to understand
 * what's being asked, but hides the claim's conclusion.
 */
export function buildValidationPrompt(
  claim: string,
  index: number,
): { type: QuestionTypeEnum; prompt: string } {
  let normalized = normalizeKeyPointClaim(claim);

  // 问句形式的 claim：不再原样返回——原样嵌入整条 claim 必然触发安全门禁的
  // leaks_claim 检查（≥8 字符连续片段 + token overlap），导致 fallback 自我
  // 拒绝并进入不可重试的 question_blocked。改为剥掉问号后按普通 claim 走
  // 上下文提取。
  if (/[？?]\s*$/.test(normalized)) {
    normalized = normalized.replace(/[？?\s]+$/u, "");
  }

  const type = chooseQuestionType(normalized, index);
  const { context, structure } = extractQuestionContext(normalized);

  switch (type) {
    case QuestionType.EXPLAIN:
      return { type, prompt: buildExplainPrompt(context, structure) };
    case QuestionType.EXAMPLE:
      return { type, prompt: buildExamplePrompt(context, structure) };
    case QuestionType.APPLY:
      return { type, prompt: buildApplyPrompt(context, structure) };
  }
}

/**
 * Generate a full deterministic question with rubric items.
 *
 * This is the v0.6 fallback: when AI question generation fails, this function
 * produces a persistent question with:
 * - A required rubric item bound to the key point claim and hard evidence
 * - A deterministic artifact/generator identity and fingerprint
 * - The same safety gate as AI questions
 *
 * The deterministic fallback allows 1 required rubric item (vs 2-5 for AI).
 */
/**
 * 从 claim 提取一个"泄漏安全"的短主题片段：取归一化后前 6 个字符并追加省略号。
 * 6 < MIN_FRAGMENT_LENGTH(8)，连续片段检查必然通过；追加"…"保证该片段不会与
 * claim 的任何完整 token 相等，token overlap 也趋近于 0。
 */
function safeTopicSnippet(claim: string): string {
  const compact = normalizeKeyPointClaim(claim).replace(/\s+/g, "");
  const snippet = compact.slice(0, 6);
  return snippet.length > 0 ? `${snippet}…` : "";
}

export function generateDeterministicQuestion(
  input: GenerateValidationQuestionInput,
  index = 0,
): GenerateValidationQuestionOutput {
  const { claim, quote, evidenceRefs } = input;

  if (evidenceRefs.length === 0) {
    throw new Error("deterministic question requires at least one evidence ref");
  }

  const evidenceRef = evidenceRefs[0];
  const allowedEvidenceRefIds = evidenceRefs.map((ref) => ref.refId);

  const buildOutput = (
    type: QuestionTypeEnum,
    prompt: string,
  ): GenerateValidationQuestionOutput => ({
    questionType: type,
    question: prompt,
    rubricItems: [
      {
        key: "det_1",
        criterion: "回答用自己的话解释了该知识点的核心原理或因果关系",
        expectedConcept: claim,
        weight: 3,
        required: true,
        evidenceRefId: evidenceRef.refId,
      },
    ],
  });

  const passesGate = (candidate: GenerateValidationQuestionOutput): boolean =>
    assessQuestionOutput({
      output: candidate,
      claim,
      quote,
      allowedEvidenceRefIds,
    }).passed;

  // 第一档：完整上下文提取模板（多分句 claim 通常在此通过）。
  const { type, prompt } = buildValidationPrompt(claim, index);
  const primary = buildOutput(type, prompt);
  if (passesGate(primary)) return primary;

  // 第二档：单短句/短 claim 的上下文与 claim 本体等价，会触发 leaks_claim。
  // 退化为"安全短主题"模板：只嵌入 ≤6 字符的主题前缀（低于门禁的 8 字符
  // 连续片段阈值），题面保持可回答性但不泄漏结论（计划 §7.6：fallback 必须
  // 通过与 AI 相同的 hard gate，而不是放宽门禁）。
  const topic = safeTopicSnippet(claim);
  if (topic.length > 0) {
    const topicPrompt =
      `关于「${topic}」相关的这一知识点，\n` +
      `请用自己的话完整说明：它的核心结论是什么？为什么成立？适用条件或边界是什么？`;
    const topical = buildOutput(QuestionType.EXPLAIN, topicPrompt);
    if (passesGate(topical)) return topical;
  }

  // 第三档：完全不含 claim 派生内容的通用题面（按要点序号定位）。
  // 该题面不含任何 claim/quote 片段，门禁必然通过，保证 deterministic
  // fallback 是全函数——benign claim 永远不会落入不可重试的 question_blocked。
  const genericPrompt =
    `请回忆本学习卡中的第 ${index + 1} 个要点，\n` +
    `用自己的话完整说明：它的核心结论是什么？为什么成立？适用条件或边界是什么？`;
  return buildOutput(QuestionType.EXPLAIN, genericPrompt);
}
