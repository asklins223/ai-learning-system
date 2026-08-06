/**
 * 统一动态上下文压缩器（计划 §5.4, §8.3）
 *
 * 核心理念：不在每个角色/工具上分别设硬截断上限，
 * 而是在构建消息前统一计算总 token 预算，
 * 超限时按信息价值分层递进压缩。
 *
 * 压缩策略（递进，不跳级）：
 * 1. fits — 全部放入，不压缩
 * 2. summarize tier_3 — 摘要化旧 events（turn_completed、旧 tool_request）
 * 3. summarize tier_2 — 摘要化近期 tool_result events
 * 4. hash_ref tier_4 — 候选全文/子任务结果降级为 count+hash 引用（模型可通过工具重读）
 * 5. drop tier_3 — 丢弃旧 events 完全
 * 6. drop tier_2 — 丢弃近期 events 完全
 * 7. exceedsContext — 标记超限，调用方 fallback 到截断（仅 Extractor bundle 数据）
 *
 * 理论基础（计划 §5.4）：
 * - 所有上下文数据已持久化在 DB ledger/event 中
 * - 压缩只是从消息中移除，不影响持久化
 * - 模型可通过工具调用（read_candidate_ledger, read_assigned_bundles 等）按需重读
 * - 系统 prompt、预算、未完成任务和 hard issues 永远不压缩
 *
 * 不变量：
 * - 不可压缩层永远保留（systemPrompt、budget、hardIssues、pendingTasks）
 * - 压缩后必须告诉模型丢失了什么（compression_notice 前缀）
 * - 每层压缩前先检查是否已经 fits，避免不必要的压缩
 */

import { createHash } from "node:crypto";
import { estimateTokens } from "./request-packer.ts";
import { logger } from "../lib/logger.ts";

// ─── 信息分层 ──────────────────────────────────────────────────────────

/**
 * 信息层级（从低价值到高价值）。
 * 压缩时从低价值层开始丢弃/摘要化，高价值层最后才动。
 */
export type InfoTier =
  | "tier_0_immutable"    // 不可压缩：systemPrompt、budget、hardIssues、pendingTasks
  | "tier_1_critical"     // 关键状态：当前 Draft、Quality Report、coverage 摘要
  | "tier_2_operational"  // 操作记忆：tool_result events（近期）
  | "tier_3_contextual"   // 上下文记忆：tool_request events、旧 tool_result events
  | "tier_4_bulk";        // 大体积数据：候选全文、bundle evidence 全文

// ─── 上下文片段 ──────────────────────────────────────────────────────────

/** 单个上下文片段 */
export interface ContextSection {
  /** 片段标识 */
  key: string;
  /** 信息层级 */
  tier: InfoTier;
  /** 已格式化的文本内容 */
  content: string;
  /** token 估算 */
  tokenEstimate: number;
  /** 该片段的压缩等级（压缩过程中递增） */
  compressionLevel: number;
  /** 是否禁止 hash 引用化（主输入数据不能被 hash 化，如 Extractor 的 bundle 数据） */
  noHashRef?: boolean;
}

/** 压缩级别 */
export type CompressionLevel =
  | 0  // 原始全文
  | 1  // 摘要化：只保留关键字段
  | 2  // hash 引用：只保留 count + hash
  | 3; // 丢弃

// ─── 压缩结果 ──────────────────────────────────────────────────────────

/** 压缩后的上下文 */
export interface PackedContext {
  /** 合并后的消息内容 */
  content: string;
  /** 总 token 估算 */
  totalTokens: number;
  /** 是否超出 context window */
  exceedsContext: boolean;
  /** 应用的压缩级别 */
  appliedCompression: CompressionLevel;
  /** 各片段的压缩信息 */
  sectionMeta: Array<{
    key: string;
    tier: InfoTier;
    compressionLevel: number;
    originalTokens: number;
    finalTokens: number;
  }>;
  /** 压缩摘要（告诉模型丢失了什么） */
  compressionSummary: Record<string, unknown>;
}

// ─── 压缩器 ──────────────────────────────────────────────────────────

/**
 * 统一动态上下文压缩器。
 *
 * 接收所有上下文片段，统一计算 token 预算，
 * 超限时按信息价值分层递进压缩。
 */
export class ContextPacker {
  private readonly contextWindowTokens: number;
  private readonly reservedOutputTokens: number;
  private readonly safetyMarginTokens: number;
  private readonly maxOutputTokens: number;

  constructor(options: {
    contextWindowTokens: number;
    reservedOutputTokens: number;
    safetyMarginTokens?: number;
    /** provider 实际最大输出 token（用于 maxTokens 计算） */
    maxOutputTokens?: number;
  }) {
    this.contextWindowTokens = options.contextWindowTokens;
    this.reservedOutputTokens = options.reservedOutputTokens;
    this.safetyMarginTokens = options.safetyMarginTokens ?? 2_048;
    this.maxOutputTokens = options.maxOutputTokens ?? options.reservedOutputTokens;
  }

  /**
   * 计算应传给 provider 的 maxTokens。
   *
   * P1-08 修复：移除 4_096 下限和 reservedOutputTokens * 2 的放大。
   * 原代码 `Math.max(4_096, Math.min(maxOutputTokens, reservedOutputTokens * 2))`
   * 在 reservedOutputTokens=4096, maxOutputTokens=8192 时返回 8192，
   * 但 availableTokens 只减去 4096，导致实际请求可能超出 contextWindow。
   *
   * 正确公式（计划 §8.3, P1-08 解决方案 #2）：
   *   maxTokens = min(roleOutputBudget, providerMaxOutput)
   *
   * 不设最低下限：小输出模型的真实上限不应被 4096 覆盖。
   * remainingContext 的检查由 request-level token hard check 负责。
   */
  getMaxOutputTokens(): number {
    return Math.min(this.maxOutputTokens, this.reservedOutputTokens);
  }

  /**
   * 可用 token = contextWindow - safety - actualMaxOutput
   *
   * P1-08 修复：使用 getMaxOutputTokens() 而非 reservedOutputTokens，
   * 确保 availableTokens 与实际请求的 maxTokens 一致。
   */
  get availableTokens(): number {
    return this.contextWindowTokens - this.safetyMarginTokens - this.getMaxOutputTokens();
  }

  /** reservedOutputTokens 的公开 getter */
  get outputBudget(): number {
    return this.reservedOutputTokens;
  }

  /** contextWindowTokens 的公开 getter（请求级检查使用） */
  get contextWindow(): number {
    return this.contextWindowTokens;
  }

  /** safetyMarginTokens 的公开 getter（请求级检查使用） */
  get safetyMargin(): number {
    return this.safetyMarginTokens;
  }

  /**
   * 打包上下文片段，超限时递进压缩。
   *
   * @param sections 所有上下文片段
   * @param systemPromptTokens system prompt + tool schema 已占用的 token
   * @returns 压缩后的上下文
   */
  pack(
    sections: ContextSection[],
    systemPromptTokens: number,
  ): PackedContext {
    const budgetForContext = this.availableTokens - systemPromptTokens;
    // 复制 sections 数组，避免修改调用方传入的原始数组
    const workingSections = sections.map((s) => ({ ...s }));
    const sectionMeta = workingSections.map((s) => ({
      key: s.key,
      tier: s.tier,
      compressionLevel: 0,
      originalTokens: s.tokenEstimate,
      finalTokens: s.tokenEstimate,
    }));

    // 计算初始总 token
    let totalTokens = workingSections.reduce((sum, s) => sum + s.tokenEstimate, 0);

    // Level 0: 检查是否已 fits
    if (totalTokens <= budgetForContext) {
      return {
        content: workingSections.map((s) => s.content).join("\n\n"),
        totalTokens,
        exceedsContext: false,
        appliedCompression: 0,
        sectionMeta,
        compressionSummary: {},
      };
    }

    // 超限，开始递进压缩
    const compressionSummary: Record<string, unknown> = {};

    // Level 1: 摘要化 tier_3（旧 tool_request、turn_completed events → 只保留 count）
    {
      let changed = false;
      for (let i = 0; i < workingSections.length; i++) {
        const s = workingSections[i]!;
        if (s.tier === "tier_3_contextual" && s.compressionLevel < 1) {
          // 摘要化 tier_3：只保留 count
          const summary = this.summarizeSection(s, 1);
          workingSections[i] = summary;
          sectionMeta[i]!.compressionLevel = 1;
          sectionMeta[i]!.finalTokens = summary.tokenEstimate;
          totalTokens -= (s.tokenEstimate - summary.tokenEstimate);
          changed = true;
        }
      }
      if (changed) {
        compressionSummary.tier_3_summarized = true;
        if (totalTokens <= budgetForContext) {
          return this.buildResult(workingSections, sectionMeta, totalTokens, 1, compressionSummary, systemPromptTokens);
        }
      }
    }

    // Level 2: 摘要化 tier_2 (近期 tool_result events → 只保留 status)
    {
      let changed = false;
      for (let i = 0; i < workingSections.length; i++) {
        const s = workingSections[i]!;
        if (s.tier === "tier_2_operational" && s.compressionLevel < 1) {
          const summary = this.summarizeSection(s, 1);
          workingSections[i] = summary;
          sectionMeta[i]!.compressionLevel = 1;
          sectionMeta[i]!.finalTokens = summary.tokenEstimate;
          totalTokens -= (s.tokenEstimate - summary.tokenEstimate);
          changed = true;
        }
      }
      if (changed) {
        compressionSummary.tier_2_summarized = true;
        if (totalTokens <= budgetForContext) {
          return this.buildResult(workingSections, sectionMeta, totalTokens, 1, compressionSummary, systemPromptTokens);
        }
      }
    }

    // Level 3: hash 化 tier_4 (候选全文、bundle evidence → count + hash)
    // 跳过 noHashRef 的 section（如 Extractor 的 bundle 数据是主输入，不能被 hash 化）
    {
      let changed = false;
      for (let i = 0; i < workingSections.length; i++) {
        const s = workingSections[i]!;
        if (s.tier === "tier_4_bulk" && s.compressionLevel < 2 && !s.noHashRef) {
          const hashed = this.summarizeSection(s, 2);
          workingSections[i] = hashed;
          sectionMeta[i]!.compressionLevel = 2;
          sectionMeta[i]!.finalTokens = hashed.tokenEstimate;
          totalTokens -= (s.tokenEstimate - hashed.tokenEstimate);
          changed = true;
        }
      }
      if (changed) {
        compressionSummary.tier_4_hash_only = true;
        if (totalTokens <= budgetForContext) {
          return this.buildResult(workingSections, sectionMeta, totalTokens, 2, compressionSummary, systemPromptTokens);
        }
      }
    }

    // Level 4: 丢弃 tier_3 完全
    {
      let changed = false;
      for (let i = 0; i < workingSections.length; i++) {
        const s = workingSections[i]!;
        if (s.tier === "tier_3_contextual" && sectionMeta[i]!.compressionLevel < 3) {
          workingSections[i] = { ...s, content: "", tokenEstimate: 0, compressionLevel: 3 };
          sectionMeta[i]!.compressionLevel = 3;
          sectionMeta[i]!.finalTokens = 0;
          totalTokens -= s.tokenEstimate;
          changed = true;
        }
      }
      if (changed) {
        compressionSummary.tier_3_dropped = true;
        if (totalTokens <= budgetForContext) {
          return this.buildResult(workingSections, sectionMeta, totalTokens, 3, compressionSummary, systemPromptTokens);
        }
      }
    }

    // Level 5: 丢弃 tier_2 完全
    {
      let changed = false;
      for (let i = 0; i < workingSections.length; i++) {
        const s = workingSections[i]!;
        if (s.tier === "tier_2_operational" && sectionMeta[i]!.compressionLevel < 3) {
          workingSections[i] = { ...s, content: "", tokenEstimate: 0, compressionLevel: 3 };
          sectionMeta[i]!.compressionLevel = 3;
          sectionMeta[i]!.finalTokens = 0;
          totalTokens -= s.tokenEstimate;
          changed = true;
        }
      }
      if (changed) {
        compressionSummary.tier_2_dropped = true;
        if (totalTokens <= budgetForContext) {
          return this.buildResult(workingSections, sectionMeta, totalTokens, 3, compressionSummary, systemPromptTokens);
        }
      }
    }

    // 最终：仍然超限，标记为 exceedsContext
    // tier_0 和 tier_1 永远不压缩
    compressionSummary.still_exceeds = true;
    compressionSummary.budget = budgetForContext;
    compressionSummary.actual = totalTokens;
    return this.buildResult(workingSections, sectionMeta, totalTokens, 3, compressionSummary, systemPromptTokens);
  }

  /**
   * 摘要化一个片段。
   *
   * Level 1: 尝试解析 JSON，只保留关键字段（type, count, status）
   * Level 2: 只保留 count + hash 引用
   */
  private summarizeSection(section: ContextSection, level: CompressionLevel): ContextSection {
    if (level === 1) {
      // Level 1: 摘要化 — 尝试解析 JSON 并只保留关键字段
      try {
        const parsed = JSON.parse(section.content) as Record<string, unknown>;
        const summarized: Record<string, unknown> = {
          type: parsed.type ?? section.key,
          _summarized: true,
        };
        // 保留 count 类字段
        if (typeof parsed.count === "number") summarized.count = parsed.count;
        // 保留 status 类字段
        if (typeof parsed.status === "string") summarized.status = parsed.status;
        // 保留 event 数组的摘要
        if (Array.isArray(parsed.events)) {
          summarized.event_count = parsed.events.length;
          // 只保留最近 3 条 event 的 type
          summarized.recent_types = parsed.events.slice(-3).map((e: Record<string, unknown>) => e.type);
        }
        // 保留候选数组的摘要
        if (Array.isArray(parsed.candidates)) {
          summarized.candidate_count = parsed.candidates.length;
          summarized.candidate_ids = parsed.candidates.slice(0, 10).map((c: Record<string, unknown>) => c.id);
        }
        // 保留 results 数组的摘要
        if (Array.isArray(parsed.results)) {
          summarized.result_count = parsed.results.length;
        }
        const content = JSON.stringify(summarized);
        return {
          ...section,
          content,
          tokenEstimate: estimateTokens(content),
          compressionLevel: level,
        };
      } catch {
        // 不是 JSON，按段落边界截断到 500 字符
        const truncated = truncateAtBoundary(section.content, 500) + "…[summarized]";
        return {
          ...section,
          content: truncated,
          tokenEstimate: estimateTokens(truncated),
          compressionLevel: level,
        };
      }
    }

    // Level 2: hash 引用 — 只保留 count + hash
    const count = this.extractCount(section.content);
    const hash = this.shortHash(section.content);
    const content = JSON.stringify({
      type: section.key,
      _hash_ref: true,
      count,
      hash,
      message: "数据已压缩为 hash 引用，可通过工具按需读取",
    });
    return {
      ...section,
      content,
      tokenEstimate: estimateTokens(content),
      compressionLevel: level,
    };
  }

  /** 从 JSON 字符串中提取 count */
  private extractCount(content: string): number | undefined {
    try {
      const parsed = JSON.parse(content) as Record<string, unknown>;
      if (typeof parsed.count === "number") return parsed.count;
      if (Array.isArray(parsed.events)) return parsed.events.length;
      if (Array.isArray(parsed.candidates)) return parsed.candidates.length;
      if (Array.isArray(parsed.results)) return parsed.results.length;
      if (Array.isArray(parsed.issues)) return parsed.issues.length;
      if (Array.isArray(parsed.tasks)) return parsed.tasks.length;
      return undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * 基于 SHA-256 的短 hash 引用（前 16 hex 字符 = 64 位）。
   *
   * 修复：原 quickHash 使用 32 位 djb2 变体，碰撞率高。
   * 改用 SHA-256 截断到 64 位，碰撞概率从 ~1/4G 降到 ~1/16E。
   */
  private shortHash(input: string): string {
    return createHash("sha256").update(input, "utf8").digest("hex").slice(0, 16);
  }

  /**
   * 构建最终结果。
   *
   * @param sections 压缩后的 sections（workingSections 传入，仅读取，不修改）
   */
  private buildResult(
    sections: ContextSection[],
    sectionMeta: Array<{ key: string; tier: InfoTier; compressionLevel: number; originalTokens: number; finalTokens: number }>,
    _totalTokens: number,
    appliedCompression: CompressionLevel,
    compressionSummary: Record<string, unknown>,
    systemPromptTokens: number = 0,
  ): PackedContext {
    // 过滤掉被完全丢弃的片段
    const activeSections = sections.filter((s) => s.content.length > 0);

    // 构建压缩声明（告诉模型丢失了什么）
    const droppedKeys = sectionMeta
      .filter((m) => m.compressionLevel >= 3)
      .map((m) => m.key);
    const summarizedKeys = sectionMeta
      .filter((m) => m.compressionLevel === 1)
      .map((m) => m.key);
    const hashRefKeys = sectionMeta
      .filter((m) => m.compressionLevel === 2)
      .map((m) => m.key);

    let prefix = "";
    if (droppedKeys.length > 0 || summarizedKeys.length > 0 || hashRefKeys.length > 0) {
      const parts: string[] = [];
      if (summarizedKeys.length > 0) parts.push(`summarized: ${summarizedKeys.join(", ")}`);
      if (hashRefKeys.length > 0) parts.push(`hash_ref: ${hashRefKeys.join(", ")}`);
      if (droppedKeys.length > 0) parts.push(`dropped: ${droppedKeys.join(", ")}`);
      prefix = JSON.stringify({ type: "compression_notice", parts }) + "\n\n";
    }

    const content = prefix + activeSections.map((s) => s.content).join("\n\n");
    const finalTokens = estimateTokens(content);

    // 可观测性：压缩触发时记录结构化日志
    if (appliedCompression > 0 || compressionSummary.still_exceeds) {
      const originalTotal = sectionMeta.reduce((sum, m) => sum + m.originalTokens, 0);
      logger.info(
        {
          appliedCompression,
          originalTokens: originalTotal,
          finalTokens,
          budget: this.availableTokens - systemPromptTokens,
          exceeds: compressionSummary.still_exceeds ?? false,
          summarized: summarizedKeys,
          hashRef: hashRefKeys,
          dropped: droppedKeys,
        },
        "ContextPacker 压缩触发",
      );
    }

    return {
      content,
      totalTokens: finalTokens,
      exceedsContext: finalTokens > this.availableTokens - systemPromptTokens,
      appliedCompression,
      sectionMeta,
      compressionSummary,
    };
  }
}

/**
 * 在段落/句子边界处截断文本，避免在词或 JSON 结构中间截断。
 *
 * 优先在换行符处截断，其次在句号/分号处，最后在空格处。
 * 如果找不到任何边界，退化为硬截断。
 */
function truncateAtBoundary(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;

  // 优先在换行符处截断
  const newlineIdx = text.lastIndexOf("\n", maxChars);
  if (newlineIdx > maxChars * 0.5) return text.slice(0, newlineIdx);

  // 其次在句号或分号处截断
  for (let i = maxChars; i > maxChars * 0.5; i--) {
    const ch = text[i];
    if (ch === "." || ch === ";" || ch === "," || ch === "}") {
      return text.slice(0, i + 1);
    }
  }

  // 最后在空格处截断
  const spaceIdx = text.lastIndexOf(" ", maxChars);
  if (spaceIdx > maxChars * 0.5) return text.slice(0, spaceIdx);

  // 退化为硬截断
  return text.slice(0, maxChars);
}
