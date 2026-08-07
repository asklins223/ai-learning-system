/**
 * Agent 上下文构建器（计划 §5.4）
 *
 * 每个 turn 从 manifest、ledger、task results 和 event summary 重建最小上下文。
 * Supervisor 不持有整篇长文的永久对话副本。
 *
 * 上下文压缩规则（计划 §5.4）：
 * - 只允许删除已经持久化且可由 hash 重新读取的信息
 * - 系统 prompt、预算、未完成任务和 hard issues 永远保留
 *
 * v2 重构：使用 ContextPacker 替代分散的硬编码截断。
 * 所有上下文片段先构建为 Section，然后统一交给 ContextPacker 压缩。
 * 超限时按信息价值分层递进压缩，而非一刀切截断。
 *
 * v3 优化：所有角色统一接入 ContextPacker（含 Critic 和 Deck Composer）。
 */

import type {
  AgentRole,
  AgentTurnRequest,
} from "@ailearn/shared";
import { isVisionUnderstandingEnabled } from "@ailearn/shared";
import type { ToolRegistry } from "./tool-registry.ts";
import { ContextPacker, type ContextSection, type InfoTier } from "./context-packer.ts";
import { estimateTokens, InputOverContextError } from "./request-packer.ts";
import type { AgentExecutionSummary } from "./event-summary.ts";
import { formatAgentExecutionSummary } from "./event-summary.ts";

/** 运行 manifest 摘要 */
export interface RunManifestSummary {
  /** 笔记标题 */
  noteTitle: string;
  /** 密度 */
  density: string;
  /** 预算摘要 */
  budgetSummary: {
    providerCallsUsed: number;
    providerCallsMax: number;
    turnsUsed: number;
    turnsMax: number;
    deadline: string;
  };
  /** coverage/task 摘要 */
  coverageSummary: {
    bundlesAssigned: number;
    bundlesDecided: number;
    bundlesRequired: number;
    candidatesExtracted: number;
    candidatesCanonical: number;
  };
  /** source/image manifest 摘要 */
  sourceSummary: {
    totalBlocks: number;
    totalImages: number;
    totalTokens: number;
  };
}

/** 候选 ledger 条目 */
export interface CandidateLedgerEntry {
  candidateId: string;
  claim: string;
  topic: string;
  importance: string;
  cognitiveType: string;
  sectionKey: string;
  candidateKind: string;
  evidenceRefIds: string[];
  validationStatus: string;
}

/** Agent task result */
export interface AgentTaskResultEntry {
  taskId: string;
  role: AgentRole;
  status: string;
  outputHash: string | null;
  outputSummary: Record<string, unknown> | null;
  errorCode: string | null;
}

/** event summary */
export interface EventSummaryEntry {
  eventType: string;
  agentRole: string | null;
  turnNo: number | null;
  toolName: string | null;
  safeDetails: Record<string, unknown>;
  createdAt: string;
}

/** Draft 摘要 */
export interface DraftSummary {
  draftVersion: number;
  contentHash: string;
  deckTitle: string;
  deckSummary: string;
  density: string;
  cardCount: number;
}

/** Quality report 摘要 */
export interface QualityReportSummary {
  draftHash: string;
  criticStatus: string;
  deterministicStatus: string;
  hardIssueCount: number;
  softIssueCount: number;
}

/** 上下文构建器输入 */
export interface ContextBuilderInput {
  role: AgentRole;
  manifest: RunManifestSummary;
  candidates: CandidateLedgerEntry[];
  taskResults: AgentTaskResultEntry[];
  events: EventSummaryEntry[];
  /** P4-5: Agent Execution Summary(模型上下文不再默认加载全部原始 Event;诊断按需读取) */
  executionSummary?: AgentExecutionSummary | null;
  draft: DraftSummary | null;
  qualityReport: QualityReportSummary | null;
  /** 未完成的 hard issues */
  hardIssues: Array<{
    code: string;
    candidateId?: string;
    patchable: boolean;
  }>;
  /** 等待中的子任务 */
  pendingTasks: Array<{
    taskId: string;
    role: AgentRole;
  }>;
}

/**
 * Agent 上下文构建器。
 *
 * 从数据库对象重建最小上下文，不持有整篇长文。
 * 使用 ContextPacker 统一管理 token 预算和压缩。
 */
export class ContextBuilder {
  private readonly toolRegistry: ToolRegistry;
  private readonly packer: ContextPacker;

  constructor(
    toolRegistry: ToolRegistry,
    options?: {
      contextWindowTokens?: number;
      reservedOutputTokens?: number;
      maxOutputTokens?: number;
    },
  ) {
    this.toolRegistry = toolRegistry;
    this.packer = new ContextPacker({
      contextWindowTokens: options?.contextWindowTokens ?? 32_768,
      reservedOutputTokens: options?.reservedOutputTokens ?? 4_096,
      maxOutputTokens: options?.maxOutputTokens,
    });
  }

  /**
   * 获取指定角色的工具 schema（R27 修复：公开方法替代私有字段访问）。
   */
  getToolSchemas(role: AgentRole): AgentTurnRequest["tools"] {
    return this.toolRegistry.getToolSchemasForRole(role);
  }

  // ─── Supervisor ────────────────────────────────────────────────────────

  /**
   * 为 Supervisor 构建 turn 请求。
   *
   * 每个 turn 从 manifest、ledger、task results 和 event summary 重建。
   * 所有片段交给 ContextPacker 统一压缩，不再分散截断。
   */
  buildSupervisorTurn(input: ContextBuilderInput, systemPrompt: string): AgentTurnRequest {
    const sections: ContextSection[] = [];

    // tier_0: 不可压缩层 — manifest、hardIssues、pendingTasks
    sections.push(this.makeSection("run_manifest", "tier_0_immutable",
      this.formatManifestSummary(input.manifest)));

    if (input.hardIssues.length > 0) {
      sections.push(this.makeSection("hard_issues", "tier_0_immutable",
        this.formatHardIssues(input.hardIssues)));
    }

    if (input.pendingTasks.length > 0) {
      sections.push(this.makeSection("pending_tasks", "tier_0_immutable",
        this.formatPendingTasks(input.pendingTasks)));
    }

    // tier_1: 关键状态 — Draft、Quality Report
    if (input.draft) {
      sections.push(this.makeSection("current_draft", "tier_1_critical",
        this.formatDraft(input.draft)));
    }

    if (input.qualityReport) {
      sections.push(this.makeSection("quality_report", "tier_1_critical",
        this.formatQualityReport(input.qualityReport)));
    }

    // tier_2: 操作记忆 — 近期 tool_result events（最近 10 条）
    const { recentToolResults, olderEvents } = this.partitionEvents(input.events);
    if (recentToolResults.length > 0) {
      sections.push(this.makeSection("recent_tool_results", "tier_2_operational",
        this.formatEventSummary(recentToolResults)));
    }

    // tier_3: 上下文记忆 — 较旧的 events（排除已在 tier_2 中的近期 tool_result）
    // P4-5: 提供 executionSummary 时默认用它替代较旧原始事件(不逐条注入),
    // 诊断时按需读取原始 Event。无 summary 时回退既有行为。
    const MAX_OLDER_EVENTS = 60;
    const summaryText = input.executionSummary ? formatAgentExecutionSummary(input.executionSummary) : null;
    if (summaryText) {
      sections.push(this.makeSection("execution_summary", "tier_3_contextual", summaryText));
      if (olderEvents.length > 0) {
        const kept = olderEvents.slice(-10);
        sections.push(this.makeSection("event_history_tail", "tier_3_contextual",
          `(保留最近 ${kept.length} 条原始事件;更早的见执行摘要)` + "\n" + this.formatEventSummary(kept)));
      }
    } else if (olderEvents.length > MAX_OLDER_EVENTS) {
      const kept = olderEvents.slice(-MAX_OLDER_EVENTS);
      const droppedCount = olderEvents.length - MAX_OLDER_EVENTS;
      const summary = `…(省略 ${droppedCount} 条更早事件)…\n`;
      sections.push(this.makeSection("event_history", "tier_3_contextual",
        summary + this.formatEventSummary(kept)));
    } else if (olderEvents.length > 0) {
      sections.push(this.makeSection("event_history", "tier_3_contextual",
        this.formatEventSummary(olderEvents)));
    }

    // tier_4: 大体积数据 — 候选全文、子任务结果全文
    if (input.candidates.length > 0) {
      sections.push(this.makeSection("candidate_ledger", "tier_4_bulk",
        this.formatCandidateLedger(input.candidates)));
    }

    if (input.taskResults.length > 0) {
      sections.push(this.makeSection("task_results", "tier_4_bulk",
        this.formatTaskResults(input.taskResults)));
    }

    return this.buildAndPack("generation_supervisor", systemPrompt, sections);
  }

  // ─── Extractor ─────────────────────────────────────────────────────────

  /**
   * 为 Extractor 构建 turn 请求。
   *
   * P1-08 修复：禁止截断 primary evidence 或 JSON。
   * 原代码在 exceedsContext=true 时会截断 bundle JSON，
   * 导致模型只看到部分证据，产生不完整或错误的候选。
   *
   * 修复后：当压缩后仍然超限时，抛出 InputOverContextError。
   * 上层 handler 应捕获此错误并将 run 标记为 needs_attention/input_over_context。
   * Supervisor 应通过 delegate_specialist 将 bundle 拆分为更小的子任务。
   *
   * 计划 §8.3 不变量：
   * - 超 context 必须在调用前分页、压缩或拆 task
   * - 禁止截断 primary evidence 或 JSON
   */
  buildExtractorTurn(
    role: AgentRole,
    assignedBundles: Array<{
      bundleId: string;
      sectionPath: string[];
      evidenceUnits: Array<{
        refId: string;
        kind: string;
        text: string;
        contextOnly: boolean;
        /**
         * E3（计划 §2.10）：可选图片 base64 数据。
         * 当 isVisionUnderstandingEnabled() 为 true 且 evidence 为图片类型时，
         * 由调用方从 object storage 下载并填充。
         */
        imageBase64?: string;
        imageMimeType?: string;
      }>;
    }>,
    systemPrompt: string,
  ): AgentTurnRequest {
    const bundleIds = assignedBundles.map((b) => b.bundleId);
    const bundleJsonStr = JSON.stringify(assignedBundles, null, 2);

    const sections: ContextSection[] = [];

    // tier_0: 不可压缩 — 指令文本
    const instructions = [
      "你收到了以下分配给你的 bundles。请仔细阅读数据，提取候选知识点，",
      "然后调用 record_extraction_decisions 记录决策，最后调用 complete_agent_task 完成任务。",
      "",
      `分配的 bundle IDs: ${JSON.stringify(bundleIds)}`,
      `bundle 数量: ${assignedBundles.length}`,
    ].join("\n");
    sections.push(this.makeSection("extractor_instructions", "tier_0_immutable", instructions));

    // tier_4: bundle 数据（大体积，但禁止 hash 引用化——这是 Extractor 的主输入）
    sections.push(this.makeSection("bundle_data", "tier_4_bulk", bundleJsonStr, true));

    // 统一打包
    const toolSchemas = this.toolRegistry.getToolSchemasForRole(role);
    const systemPromptTokens = estimateTokens(systemPrompt);
    const toolSchemaTokens = Math.max(1_024, Math.ceil(JSON.stringify(toolSchemas).length / 4));
    const overheadTokens = systemPromptTokens + toolSchemaTokens;

    const packed = this.packer.pack(sections, overheadTokens);

    // P1-08 修复：超限时抛出 InputOverContextError，不再截断 primary evidence。
    // 上层应通过拆分 bundle 为更小的子任务来解决。
    if (packed.exceedsContext) {
      throw new InputOverContextError({
        role,
        contextWindowTokens: this.packer.contextWindow,
        safetyMarginTokens: this.packer.safetyMargin,
        maxOutputTokens: this.packer.getMaxOutputTokens(),
        serializedInputTokens: packed.totalTokens + overheadTokens,
      });
    }

    const content = packed.content + [
      "",
      "现在请执行以下操作：",
      "1. 分析每个 bundle 的 evidenceUnits，识别可学习的知识点。",
      "2. 调用 record_extraction_decisions，提交所有候选和/或 no-candidate 决策。",
      "   - candidates 中每个候选的 evidenceRefIds 必须使用上面数据中的 refId。",
      "   - bundleIds 参数包含所有分配给你的 bundle ID。",
      "3. 调用 complete_agent_task 完成任务。",
    ].join("\n");

    // E3（计划 §2.10）：当 vision 理解开启且有图片数据时，使用 multimodal 内容
    const imageUnits = assignedBundles
      .flatMap((b) => b.evidenceUnits)
      .filter((u) => u.imageBase64);

    if (isVisionUnderstandingEnabled() && imageUnits.length > 0 && role === "vision_specialist") {
      // 构建 multimodal content：文本 + 图片引用
      const contentBlocks: Array<
        { type: "text"; text: string } |
        { type: "image_url"; image_url: { url: string; detail?: "auto" | "low" | "high" } }
      > = [
        { type: "text" as const, text: content },
      ];
      for (const unit of imageUnits) {
        if (unit.imageBase64 && unit.imageMimeType) {
          contentBlocks.push({
            type: "image_url",
            image_url: {
              url: `data:${unit.imageMimeType};base64,${unit.imageBase64}`,
              detail: "auto",
            },
          });
        }
      }
      return {
        role,
        systemPrompt,
        messages: [{ role: "user" as const, content: contentBlocks as unknown as string }],
        tools: toolSchemas,
        maxTokens: this.packer.getMaxOutputTokens(),
        temperature: 0.3,
      };
    }

    return {
      role,
      systemPrompt,
      messages: [{ role: "user", content }],
      tools: toolSchemas,
      maxTokens: this.packer.getMaxOutputTokens(),
      temperature: 0.3,
    };
  }

  // ─── Deck Composer ─────────────────────────────────────────────────────

  /**
   * 为 Deck Composer 构建 turn 请求。
   *
   * 候选数据作为 tier_4_bulk 交给 packer 处理。
   * 超限时 packer 会先压缩其他层级，最后对候选数据做 hash 引用。
   */
  buildDeckComposerTurn(
    role: AgentRole,
    config: { density: string; cardBudget: number },
    candidateSummary: string,
    systemPrompt: string,
  ): AgentTurnRequest {
    const sections: ContextSection[] = [];

    // tier_0: 不可压缩 — 指令文本
    const instructions = [
      "你收到了以下候选知识点数据。请仔细阅读数据，组织 Deck 方案，",
      "然后调用 submit_deck_proposal 提交方案，最后调用 complete_agent_task 完成任务。",
      "",
      `密度: ${config.density}`,
      `卡片预算: ${config.cardBudget}`,
    ].join("\n");
    sections.push(this.makeSection("composer_instructions", "tier_0_immutable", instructions));

    // tier_4: 候选数据（大体积，但禁止 hash 引用化——这是 Composer 的主输入）
    sections.push(this.makeSection("candidate_data", "tier_4_bulk", candidateSummary, true));

    return this.buildAndPack(role, systemPrompt, sections);
  }

  // ─── Critic ────────────────────────────────────────────────────────────

  /**
   * 为 Critic 构建 turn 请求。
   *
   * Draft、候选和证据作为 tier_4_bulk noHashRef 交给 packer 处理。
   * 超限时 packer 会先压缩指令层，但这些主输入数据不会被 hash 化。
   */
  buildCriticTurn(
    role: AgentRole,
    config: { draftHash: string },
    draftContent: string,
    candidatesContent: string,
    evidenceContent: string,
    systemPrompt: string,
  ): AgentTurnRequest {
    const sections: ContextSection[] = [];

    // tier_0: 不可压缩 — 指令文本
    const instructions = [
      "你收到了以下 Deck Draft、候选列表和证据文本。请仔细阅读数据，",
      "逐 claim 验证草稿的支撑情况，然后调用 submit_quality_report 提交报告，",
      "最后调用 complete_agent_task 完成任务。",
      "",
      `Draft Hash: ${config.draftHash}`,
    ].join("\n");
    sections.push(this.makeSection("critic_instructions", "tier_0_immutable", instructions));

    // tier_4: Draft 数据（主输入，禁止 hash 引用化）
    sections.push(this.makeSection("draft_content", "tier_4_bulk", draftContent, true));
    // tier_4: 候选列表（主输入，禁止 hash 引用化）
    sections.push(this.makeSection("candidates_content", "tier_4_bulk", candidatesContent, true));
    // tier_4: 证据文本（主输入，禁止 hash 引用化）
    sections.push(this.makeSection("evidence_content", "tier_4_bulk", evidenceContent, true));

    return this.buildAndPack(role, systemPrompt, sections, { temperature: 0.2 });
  }

  // ─── 辅助方法 ──────────────────────────────────────────────────────────

  /**
   * 统一的打包 + 构建请求方法。
   *
   * 所有角色共享：token 估算 → packer 压缩 → 构建 AgentTurnRequest。
   * maxTokens 统一使用 packer.getMaxOutputTokens()。
   *
   * P1-08 修复：压缩后仍然超限时抛出 InputOverContextError。
   * 原代码忽略 exceedsContext 直接发送请求，导致 Provider 报错或截断。
   * 现在由上层 handler 捕获并进入 needs_attention。
   */
  private buildAndPack(
    role: AgentRole,
    systemPrompt: string,
    sections: ContextSection[],
    options?: { temperature?: number },
  ): AgentTurnRequest {
    const toolSchemas = this.toolRegistry.getToolSchemasForRole(role);
    const systemPromptTokens = estimateTokens(systemPrompt);
    const toolSchemaTokens = Math.max(1_024, Math.ceil(JSON.stringify(toolSchemas).length / 4));
    const overheadTokens = systemPromptTokens + toolSchemaTokens;

    const packed = this.packer.pack(sections, overheadTokens);

    // P1-08 修复：压缩后仍然超限时抛出错误，不再忽略 exceedsContext。
    if (packed.exceedsContext) {
      throw new InputOverContextError({
        role,
        contextWindowTokens: this.packer.contextWindow,
        safetyMarginTokens: this.packer.safetyMargin,
        maxOutputTokens: this.packer.getMaxOutputTokens(),
        serializedInputTokens: packed.totalTokens + overheadTokens,
      });
    }

    return {
      role,
      systemPrompt,
      messages: [{ role: "user", content: packed.content }],
      tools: toolSchemas,
      maxTokens: this.packer.getMaxOutputTokens(),
      temperature: options?.temperature ?? 0.3,
    };
  }

  /** 构建一个 ContextSection */
  private makeSection(key: string, tier: InfoTier, content: string, noHashRef?: boolean): ContextSection {
    return {
      key,
      tier,
      content,
      tokenEstimate: estimateTokens(content),
      compressionLevel: 0,
      noHashRef,
    };
  }

  /**
   * 将 events 按近期/旧分区。
   *
   * 修复：原实现使用 Set<EventSummaryEntry>（对象引用相等性），
   * 如果上游对 events 做了 .map() 转换，引用断裂会导致分区失败。
   * 改为基于索引分区，避免引用相等性依赖。
   */
  private partitionEvents(events: EventSummaryEntry[]): {
    recentToolResults: EventSummaryEntry[];
    olderEvents: EventSummaryEntry[];
  } {
    const toolResultIndices: number[] = [];
    events.forEach((e, i) => {
      if (e.eventType === "tool_result" || e.eventType === "security_event") {
        toolResultIndices.push(i);
      }
    });

    // 最近 10 条 tool_result 的索引集合
    const recentIndices = new Set(toolResultIndices.slice(-10));

    const recentToolResults: EventSummaryEntry[] = [];
    const olderEvents: EventSummaryEntry[] = [];

    events.forEach((e, i) => {
      if (recentIndices.has(i)) {
        recentToolResults.push(e);
      } else {
        olderEvents.push(e);
      }
    });

    return { recentToolResults, olderEvents };
  }

  /** 格式化 manifest 摘要 */
  private formatManifestSummary(manifest: RunManifestSummary): string {
    return JSON.stringify({
      type: "run_manifest",
      noteTitle: manifest.noteTitle,
      density: manifest.density,
      budget: manifest.budgetSummary,
      coverage: manifest.coverageSummary,
      source: manifest.sourceSummary,
    });
  }

  /** 格式化候选 ledger */
  private formatCandidateLedger(candidates: CandidateLedgerEntry[]): string {
    return JSON.stringify({
      type: "candidate_ledger",
      count: candidates.length,
      candidates: candidates.map((c) => ({
        id: c.candidateId,
        claim: c.claim,
        topic: c.topic,
        importance: c.importance,
        kind: c.candidateKind,
        status: c.validationStatus,
        evidenceRefs: c.evidenceRefIds.length,
      })),
    });
  }

  /** 格式化子任务结果 */
  private formatTaskResults(results: AgentTaskResultEntry[]): string {
    return JSON.stringify({
      type: "task_results",
      count: results.length,
      results: results.map((r) => ({
        taskId: r.taskId,
        role: r.role,
        status: r.status,
        outputHash: r.outputHash,
        outputSummary: r.outputSummary,
        errorCode: r.errorCode,
      })),
    });
  }

  /**
   * 格式化 event summary
   *
   * 做单条 event 的 safeDetails 截断（MAX_EVENT_DETAIL_CHARS），
   * 防止一条超大 tool_result 撑爆整个 section。
   * 总量截断交给 ContextPacker 统一管理。
   * 另外做优先级精简（省略 tool_request 的 args、省略 null 字段）。
   */
  private formatEventSummary(events: EventSummaryEntry[]): string {
    // 单条 event 的 safeDetails 截断上限（字符）
    // 防止一条超大 tool_result（如 submit_deck_draft 的完整返回）
    // 撑爆整个 section，导致 packer 摘要化整个 section 丢失所有近期记忆
    const MAX_EVENT_DETAIL_CHARS = 2_000;
    const formatted = events.map((e) => {
      const skipDetails = e.eventType === "tool_request";

      let result: Record<string, unknown> | undefined;
      if (!skipDetails && e.safeDetails && Object.keys(e.safeDetails).length > 0) {
        let details = e.safeDetails;
        if (e.eventType === "tool_result") {
          const isOk = details.success !== false;
          if (isOk && details.result != null) {
            details = { result: details.result };
          } else if (!isOk && details.error != null) {
            details = { error: details.error };
          }
        }

        // 截断 safeDetails：超长时只保留 preview
        const json = JSON.stringify(details);
        if (json.length <= MAX_EVENT_DETAIL_CHARS) {
          result = details;
        } else {
          result = { _truncated: true, _preview: json.slice(0, MAX_EVENT_DETAIL_CHARS) + "…" };
        }
      }

      const entry: Record<string, unknown> = {
        type: e.eventType,
        turn: e.turnNo,
        tool: e.toolName,
      };
      if (e.agentRole != null) entry.role = e.agentRole;
      if (result !== undefined) entry.result = result;
      const ts = Date.parse(e.createdAt);
      if (!Number.isNaN(ts)) entry.at = Math.floor(ts / 1000);
      return entry;
    });

    return JSON.stringify({
      type: "event_summary",
      count: formatted.length,
      events: formatted,
    });
  }

  /** 格式化 Draft */
  private formatDraft(draft: DraftSummary): string {
    return JSON.stringify({
      type: "current_draft",
      version: draft.draftVersion,
      hash: draft.contentHash,
      title: draft.deckTitle,
      summary: draft.deckSummary,
      density: draft.density,
      cardCount: draft.cardCount,
    });
  }

  /** 格式化 Quality report */
  private formatQualityReport(report: QualityReportSummary): string {
    return JSON.stringify({
      type: "quality_report",
      draftHash: report.draftHash,
      criticStatus: report.criticStatus,
      deterministicStatus: report.deterministicStatus,
      hardIssues: report.hardIssueCount,
      softIssues: report.softIssueCount,
    });
  }

  /** 格式化 hard issues（永远保留） */
  private formatHardIssues(issues: Array<{ code: string; candidateId?: string; patchable: boolean }>): string {
    return JSON.stringify({
      type: "hard_issues",
      count: issues.length,
      issues,
    });
  }

  /** 格式化等待中的子任务（永远保留） */
  private formatPendingTasks(tasks: Array<{ taskId: string; role: AgentRole }>): string {
    return JSON.stringify({
      type: "pending_tasks",
      count: tasks.length,
      tasks,
    });
  }
}

// P1-08 修复：truncateJsonSafely 和 countNeededCloseBraces 已移除。
// 原代码在 exceedsContext=true 时截断 primary evidence JSON，
// 现在改为抛出 InputOverContextError，由上层 handler 处理。
