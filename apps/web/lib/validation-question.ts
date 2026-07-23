/**
 * 验证题生成工具（优化版 v8）
 *
 * 核心改进（v8）：
 * 1. 新增 stripConclusion — 去掉使役动词（使/让/令）后的结论、"这是..."总结性从句
 * 2. 新增 stripConclusiveVerbs — 去掉结论性动词（揭示/证明/说明/表明/决定等）后的内容
 * 3. 新增 "之所以X，是因为Y" 结构识别 — 保留主题 X，隐藏原因 Y
 * 4. 新增 "即便/即使/无论X" 条件结构识别
 * 5. 主题类和机制类的上下文应用结论性动词去除
 * 6. 模板根据上下文长度自适应——短上下文用"这一知识点"补充
 * 7. chooseQuestionType 增加 "之所以...是因为" → explain
 *
 * v7.2 基础：
 * 1. 不再把 claim 片段当作"概念"来解释——claim 可能是条件、策略或原理，
 *    题目应自然地引用上下文，而非套用"解释以下概念"的通用模板
 * 2. 根据 claim 结构（条件类 / 机制类 / 主题类 / 一般类）生成有针对性的问题
 * 3. 题目给出足够的上下文让用户知道"在问什么"，但隐藏 claim 的结论
 */

import { normalizeKeyPointClaim } from "./card-display";

export type ValidationQuestionType = "explain" | "example" | "apply";

type ClaimStructure = "conditional" | "mechanism" | "topic" | "general";

interface QuestionContext {
  /** 用户可见的问题上下文——足够理解"在问什么"，但不含 claim 的结论 */
  context: string;
  /** claim 的结构类型，用于生成有针对性的问题 */
  structure: ClaimStructure;
}

// ─── 结论去除工具 ─────────────────────────────────────────────────────

/**
 * 去掉 claim 中的结论性动词及其后的内容。
 *
 * 结论性动词标志着"claim 的核心论断"即将出现，应予隐藏。
 * 例如：
 * - "锚定效应揭示了直觉通道的不可抑制性" → "锚定效应"
 * - "实验证明了X的有效性" → "实验"
 * - "持久性语义决定了缓存行为" → "持久性语义"
 *
 * 如果去掉后太短（< 4 字），保留原文由后续逻辑处理。
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
 *
 * 结论性内容的特征：
 * - 使役动词后的内容："X使Y" → "X"（仅当前面有足够内容时）
 * - 因果词后的内容："X，从而Y" → "X"
 * - "这是...的根源/优势" 等总结性从句
 * - 建议词后的内容："X，应Y" → "X"
 */
function stripConclusion(text: string): string {
  let result = text;

  // 去掉 "这是..." 总结性从句
  result = result.replace(/[，,]这是.*/s, "");

  // 去掉使役动词后的结论："X使Y" → "X"
  // 仅当使役动词前有足够内容（>= 8 字）时才截断，避免过度截断
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

// ─── 上下文提取 ───────────────────────────────────────────────────────

/**
 * 从 claim 中提取问题上下文。
 *
 * 与旧版 extractConceptHint 的区别：
 * - 旧版把条件从句、破折号前缀等片段当作"概念"提取，结果往往是语法残缺的片段
 * - 新版返回一个有意义的上下文短语，并标注 claim 结构，供题目生成器使用
 * - 增加结论性内容去除，避免暴露答案
 *
 * 提取规则（按优先级）：
 * 1. 因果类 "之所以X，是因为Y" → 上下文 = "X"（保留主题，隐藏原因）
 * 2. 条件类 "当X时，Y" → 上下文 = "当X时"
 * 3. 条件类 "如果/若X，则Y" → 上下文 = "如果X"
 * 4. 条件类 "即便/即使/无论X" → 上下文 = "即便X"
 * 5. 机制类 "X——Y——Z" → 上下文 = stripConclusiveVerbs("X")（去掉结论性动词）
 * 6. 主题类 "X：Y" → 上下文 = stripConclusiveVerbs("X")
 * 7. 去掉因果/目的/结论从句（包括使役动词、"这是"等）
 * 8. 去掉建议/推荐从句
 * 9. 取第一个分句（去除结论性动词）
 */
function extractQuestionContext(claim: string): QuestionContext {
  const normalized = normalizeKeyPointClaim(claim);

  // 1. "之所以X，是因为Y" → 上下文 = "X"（保留主题，隐藏原因）
  const reasonMatch = normalized.match(/^(.+?)之所以/);
  if (reasonMatch && reasonMatch[1].trim().length >= 4) {
    return {
      context: compactText(reasonMatch[1].trim(), 70),
      structure: "general",
    };
  }

  // 2. 条件类："当X时，Y" → 上下文 = "当X时"
  const condMatch = normalized.match(/^当(.+?)(?:时[，,])/);
  if (condMatch && condMatch[1].trim().length >= 6) {
    return {
      context: `当${compactText(condMatch[1].trim(), 70)}时`,
      structure: "conditional",
    };
  }

  // 3. 条件类："如果/若X，则Y" → 上下文 = "如果X"
  const ifMatch = normalized.match(/^(如果|若)(.+?)(?:[，,])/);
  if (ifMatch && ifMatch[2].trim().length >= 6) {
    return {
      context: `${ifMatch[1]}${compactText(ifMatch[2].trim(), 70)}`,
      structure: "conditional",
    };
  }

  // 4. "即便/即使/无论X" → 条件类
  const evenIfMatch = normalized.match(/^(即便|即使|无论)(.+?)(?:[，,])/);
  if (evenIfMatch && evenIfMatch[2].trim().length >= 6) {
    return {
      context: `${evenIfMatch[1]}${compactText(evenIfMatch[2].trim(), 70)}`,
      structure: "conditional",
    };
  }

  // 5. 机制类："X——Y——Z" → 上下文 = "X"（去掉结论性动词）
  const dashParts = normalized.split(/——|—/);
  if (dashParts.length > 1 && dashParts[0].trim().length >= 6) {
    return {
      context: compactText(stripConclusiveVerbs(dashParts[0].trim()), 70),
      structure: "mechanism",
    };
  }

  // 6. 主题类："X：Y" → 上下文 = "X"（去掉结论性动词）
  const colonParts = normalized.split(/[：:]/, 2);
  if (colonParts.length > 1 && colonParts[0].trim().length >= 6) {
    return {
      context: compactText(stripConclusiveVerbs(colonParts[0].trim()), 70),
      structure: "topic",
    };
  }

  // 7. 去掉因果/目的/结论从句（包括使役动词、"这是"）
  const causalCut = stripConclusion(normalized);
  if (
    causalCut.trim().length >= 8 &&
    causalCut.trim().length < normalized.length
  ) {
    return {
      context: compactText(causalCut.trim(), 70),
      structure: "general",
    };
  }

  // 8. 去掉建议/推荐从句（stripConclusion 已包含，作为兜底）
  const recCut = normalized.replace(
    /[，,](?:应|应该|需要|必须|优先|建议|推荐).*/s,
    "",
  );
  if (
    recCut.trim().length >= 8 &&
    recCut.trim().length < normalized.length
  ) {
    return {
      context: compactText(recCut.trim(), 70),
      structure: "general",
    };
  }

  // 9. 取第一个分句（去除结论性动词）
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

// ─── 题型选择 ─────────────────────────────────────────────────────────

/**
 * 根据 claim 的句式结构选择最合适的题型。
 *
 * 不再机械地按 index % 3 分配，而是根据知识点的认知层级选择：
 * - 因果类（"之所以...是因为"）→ 优先 explain（考察因果理解）
 * - 条件边界类 → 优先 apply（考察适用条件）
 * - 实践建议类 → 优先 apply（考察场景应用）
 * - 机制原理类 → 优先 explain（考察原理理解）
 * - 其他 → 按 index 轮换保证多样性
 */
export function chooseQuestionType(
  claim: string,
  index: number,
): ValidationQuestionType {
  // 因果类 "之所以...是因为" → 优先 explain
  if (/之所以.*是因为/.test(claim)) {
    return (["explain", "apply", "example"] as const)[index % 3];
  }

  // 条件边界类 → 优先 apply
  if (/当.+?时|如果|若|在.+?(?:下|时)|条件下|前提是|适用|边界|例外|即便|即使|无论/.test(claim)) {
    return (["apply", "explain", "example"] as const)[index % 3];
  }

  // 实践建议类（含"应"/"需要"/"必须"）→ 优先 apply
  if (/(?:应|应该|需要|必须|优先|建议|推荐)/.test(claim)) {
    return (["apply", "explain", "example"] as const)[index % 3];
  }

  // 机制原理类（含"通过"/"使得"/"导致"）→ 优先 explain
  if (/通过|使得|导致|产生|形成|体现|表现为|能|可以/.test(claim)) {
    return (["explain", "example", "apply"] as const)[index % 3];
  }

  // 默认：按 index 轮换
  return (["explain", "example", "apply"] as const)[index % 3];
}

// ─── 验证题生成 ─────────────────────────────────────────────────────

/**
 * 生成验证题 prompt。
 *
 * 与旧版本的区别：
 * - 不再把 claim 片段当作"概念"来解释
 * - 根据 claim 结构（条件/机制/主题/一般）生成有针对性的自然问题
 * - 题目给出足够的上下文让用户知道"在问什么"，但隐藏 claim 的结论
 * - 新增结论性内容去除
 */
export function buildValidationPrompt(
  claim: string,
  index: number,
): { type: ValidationQuestionType; prompt: string } {
  const normalized = normalizeKeyPointClaim(claim);

  // 如果 claim 本身就是问句，直接使用
  if (/[？?]\s*$/.test(normalized)) {
    return {
      type: "explain",
      prompt: normalized,
    };
  }

  const type = chooseQuestionType(normalized, index);
  const { context, structure } = extractQuestionContext(normalized);

  switch (type) {
    case "explain":
      return { type, prompt: buildExplainPrompt(context, structure) };
    case "example":
      return { type, prompt: buildExamplePrompt(context, structure) };
    case "apply":
      return { type, prompt: buildApplyPrompt(context, structure) };
  }
}

// ─── 题型 prompt 生成器 ──────────────────────────────────────────────

/**
 * 辅助函数：根据上下文长度决定是否添加"这一知识点"补充。
 */
function needsTopicSuffix(context: string): boolean {
  return context.length <= 10;
}

function buildExplainPrompt(
  context: string,
  structure: ClaimStructure,
): string {
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

function buildExamplePrompt(
  context: string,
  structure: ClaimStructure,
): string {
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

function buildApplyPrompt(
  context: string,
  structure: ClaimStructure,
): string {
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

// ─── 工具函数 ─────────────────────────────────────────────────────────

/**
 * 截断文本到指定长度，超出部分用省略号替代。
 */
function compactText(text: string, limit: number): string {
  const value = (text ?? "").replace(/\s+/g, " ").trim();
  if (value.length <= limit) return value;
  return `${value.slice(0, limit - 3).trim()}...`;
}