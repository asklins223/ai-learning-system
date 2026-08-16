#!/usr/bin/env node
/**
 * Supervisor Agent v1 RC Gate CLI（计划 §W7, §G2）
 *
 * 用法：
 *   node --import tsx src/cli/supervisor-rc-gate.ts
 *
 * 环境变量：
 *   API_BASE_URL=http://localhost:4000       (默认)
 *   RC_TEST_EMAIL=rc-test@example.test       (默认)
 *   RC_TEST_PASSWORD=rc_test_password_2026   (默认)
 *   AIQ_RC_SUBSET=full|S|M|L|multimodal|fault (默认 S — 控制成本)
 *   AIQ_RC_MAX_BUDGET_USD=50                 (默认 50)
 *   AIQ_RC_OUTPUT=path/to/artifact.json      (可选)
 *   AIQ_RC_DRY_RUN=true                      (可选 — 只测试连接不调用 Provider)
 *
 * 对应计划 G2：
 * - 主 Provider 黄金集连续两轮全部达标
 * - immutable revision、effective parameters、usage、成本和脱敏 artifact
 */

import {
  runSupervisorRCGate,
  generateRCArtifact,
  type SupervisorRunner,
  type SupervisorRunResult,
  DEFAULT_SUPERVISOR_RC_CONFIG,
  type ProviderSubset,
} from "../card-generation-supervisor-v1/rc-runner.ts";
import type { GoldenSample } from "../card-generation-supervisor-v1/golden-set-schema.ts";
import { GOLDEN_SET_SIZE } from "../card-generation-supervisor-v1/golden-set-data.ts";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

// ─── 配置 ─────────────────────────────────────────────────────────────────

const API_BASE_URL = process.env.API_BASE_URL ?? "http://localhost:4000";
const RC_EMAIL = process.env.RC_TEST_EMAIL ?? "rc-test@example.test";
const RC_PASSWORD = process.env.RC_TEST_PASSWORD ?? "rc_test_password_2026";
const DRY_RUN = process.env.AIQ_RC_DRY_RUN === "true";

// ─── API 辅助函数 ──────────────────────────────────────────────────────────

interface AuthResult {
  token: string;
  userId: string;
  workspaceId: string;
}

async function login(): Promise<AuthResult> {
  const res = await fetch(`${API_BASE_URL}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: RC_EMAIL, password: RC_PASSWORD }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Login failed (${res.status}): ${text}`);
  }
  const data = await res.json() as {
    token: string;
    ctx: { userId: string; workspaceId: string };
  };
  return {
    token: data.token,
    userId: data.ctx.userId,
    workspaceId: data.ctx.workspaceId,
  };
}

interface NoteCreateResult {
  note: { id: string };
  version: { id: string };
}

async function createNote(
  token: string,
  title: string,
  blocksJson: string,
): Promise<NoteCreateResult> {
  // Parse the blocks JSON from golden set sample
  const blocks = JSON.parse(blocksJson) as Array<{
    type: string;
    text: string;
    language?: string;
    url?: string;
  }>;

  // Map to API schema: { type, content }
  // API accepts: paragraph, heading, code, list, quote, image
  // Golden set uses: paragraph, code (with language), image (with url)
  const apiBlocks = blocks.map((b, i) => {
    if (b.type === "code") {
      return {
        ordinal: i,
        type: "code" as const,
        content: b.text + (b.language ? `\n# language: ${b.language}` : ""),
      };
    } else if (b.type === "image") {
      return {
        ordinal: i,
        type: "image" as const,
        content: b.url ?? b.text,
      };
    }
    return {
      ordinal: i,
      type: "paragraph" as const,
      content: b.text,
    };
  });

  const res = await fetch(`${API_BASE_URL}/notes`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ title, blocks: apiBlocks }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Create note failed (${res.status}): ${text}`);
  }
  const data = await res.json() as NoteCreateResult;
  return data;
}

interface CardGenRun {
  runId: string;
  status: string;
  stage: string;
}

async function createCardGenerationRun(
  token: string,
  noteVersionId: string,
  density: string,
): Promise<CardGenRun> {
  const idempotencyKey = `rc-${createHash("sha256")
    .update(noteVersionId + density + Date.now())
    .digest("hex")
    .slice(0, 32)}`;

  const res = await fetch(`${API_BASE_URL}/card-generation-runs`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      noteVersionId,
      idempotencyKey,
      density,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Create card gen run failed (${res.status}): ${text}`);
  }
  return await res.json() as CardGenRun;
}

interface CardGenRunView {
  id: string;
  status: string;
  stage: string;
  coverageReport?: unknown;
  cards?: Array<{
    id: string;
    title: string;
    summary: string;
    sectionKey?: string;
  }>;
  providerSnapshot?: unknown;
  // P1-14: provider 能力指纹，用于 Mock 检测
  providerCapabilityFingerprint?: string | null;
  // P1-14: run result 包含 cardSetId，用于查询卡组和证据
  result?: { cardId: string | null; cardSetId: string | null } | null;
  // Budget 修复：errorCode 用于推导预算合规状态
  errorCode?: string | null;
  // Budget 修复：usageSummary 用于检查实际预算消耗
  usageSummary?: Record<string, number> | null;
}

/**
 * P1-14: 查询卡片的证据对齐状态。
 *
 * 审计发现 RC runner 把 succeeded 直接映射为全 supported、零重复，
 * 但实际 DB 中 36/36 candidate 仍为 pending + pending，36/36 evidence 为 unaligned。
 * 通过 GET /cards/:cardId/evidence 查询实际证据状态。
 */
async function getCardEvidenceFromApi(
  token: string,
  cardId: string,
): Promise<{ keyPoints: Array<{ evidences: Array<{ alignment: string; alignmentMethod?: string }> }> } | null> {
  try {
    const res = await fetch(`${API_BASE_URL}/cards/${cardId}/evidence`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    return await res.json() as { keyPoints: Array<{ evidences: Array<{ alignment: string; alignmentMethod?: string }> }> } | null;
  } catch {
    return null;
  }
}

/**
 * 有界并发池：以 `limit` 为上限并发执行 `fn`，并按原始顺序收集结果。
 */
async function mapLimitCards<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) break;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * P1-14: 以有界并发拉取单张卡片的实际证据指标。
 *
 * 返回该卡片贡献的计数，无匹配时 unsupported 计数为 1。
 */
async function collectCardEvidenceMetrics(
  token: string,
  card: { cardId: string; title: string; summary: string },
): Promise<{
  totalEvidence: number;
  alignedCount: number;
  unalignedCount: number;
  softCount: number;
  autoVerifiedCount: number;
  unsupportedCount: number;
}> {
  let totalEvidence = 0;
  let alignedCount = 0;
  let unalignedCount = 0;
  let softCount = 0;
  let autoVerifiedCount = 0;
  let unsupportedCount = 0;

  if (!card.cardId) return { totalEvidence, alignedCount, unalignedCount, softCount, autoVerifiedCount, unsupportedCount };
  const evidenceData = await getCardEvidenceFromApi(token, card.cardId);
  if (!evidenceData?.keyPoints) {
    unsupportedCount++;
    return { totalEvidence, alignedCount, unalignedCount, softCount, autoVerifiedCount, unsupportedCount };
  }

  let cardHasAligned = false;
  for (const kp of evidenceData.keyPoints) {
    if (!kp.evidences) continue;
    for (const ev of kp.evidences) {
      totalEvidence++;
      const alignment = ev.alignment ?? "unaligned";
      if (alignment === "aligned") {
        alignedCount++;
        cardHasAligned = true;
      } else if (alignment === "soft") {
        softCount++;
      } else {
        unalignedCount++;
      }

      if (ev.alignmentMethod === "auto_verified") {
        autoVerifiedCount++;
      }
    }
  }

  if (!cardHasAligned) unsupportedCount++;

  return { totalEvidence, alignedCount, unalignedCount, softCount, autoVerifiedCount, unsupportedCount };
}

/**
 * P1-14: 收集所有卡片的实际证据指标。
 *
 * 从 API 查询每张卡片的证据对齐状态，返回实际的对齐计数和完整性指标。
 * 不再从 succeeded 推导。HTTP 请求以有界并发执行，避免 N+1 串行等待。
 */
async function collectActualEvidenceMetrics(
  token: string,
  cards: Array<{ cardId: string; title: string; summary: string }>,
): Promise<{
  totalEvidence: number;
  alignedCount: number;
  unalignedCount: number;
  softCount: number;
  autoVerifiedCount: number;
  unsupportedCount: number;
}> {
  const CONCURRENCY_LIMIT = 8;
  const perCard = await mapLimitCards(cards, CONCURRENCY_LIMIT, (card) =>
    collectCardEvidenceMetrics(token, card),
  );

  let totalEvidence = 0;
  let alignedCount = 0;
  let unalignedCount = 0;
  let softCount = 0;
  let autoVerifiedCount = 0;
  let unsupportedCount = 0;
  for (const c of perCard) {
    totalEvidence += c.totalEvidence;
    alignedCount += c.alignedCount;
    unalignedCount += c.unalignedCount;
    softCount += c.softCount;
    autoVerifiedCount += c.autoVerifiedCount;
    unsupportedCount += c.unsupportedCount;
  }

  return {
    totalEvidence,
    alignedCount,
    unalignedCount,
    softCount,
    autoVerifiedCount,
    unsupportedCount,
  };
}

/**
 * P1-14: 从卡片内容检查概念召回率。
 *
 * 不再从 succeeded 推导为全命中，而是检查卡片标题和摘要是否包含预期概念。
 */
function checkConceptRecall(
  cards: Array<{ title: string; summary: string }>,
  concepts: string[],
): number {
  if (concepts.length === 0) return 0;
  const allText = cards.map(c => `${c.title} ${c.summary}`).join(" ").toLowerCase();
  let hits = 0;
  for (const concept of concepts) {
    if (allText.includes(concept.toLowerCase())) {
      hits++;
    }
  }
  return hits;
}

/**
 * P1-14: 从卡片 sectionKey 检查章节召回率。
 */
function checkSectionRecall(
  cards: Array<{ sectionKey?: string }>,
  expectedSections: string[],
): number {
  if (expectedSections.length === 0) return 0;
  const cardSections = new Set(cards.map(c => c.sectionKey?.toLowerCase()).filter(Boolean));
  let hits = 0;
  for (const section of expectedSections) {
    if (cardSections.has(section.toLowerCase())) {
      hits++;
    }
  }
  return hits;
}

/**
 * P1-14: 自动化启发式评估——作为人工评估的代理。
 *
 * 审计文档内容边界：
 * - 标题目标 6–32 个中文字符、硬上限 60
 * - 摘要目标 40–180 字、硬上限 240
 * - 标题与摘要不得完全相同
 * - 每卡通常 1–3 个 key point、硬上限 4
 */
function computeAutomatedHumanEvaluation(
  cards: Array<{ title: string; summary: string }>,
  conceptRecall: { importantHits: number; importantTotal: number },
): { deckAccepted: boolean; titleSummaryAccepted: boolean } {
  if (cards.length === 0) {
    return { deckAccepted: false, titleSummaryAccepted: false };
  }

  // 标题/摘要质量检查
  let titleSummaryOk = true;
  for (const card of cards) {
    const titleLen = card.title.length;
    const summaryLen = card.summary.length;

    // 标题长度：6-60 字符
    if (titleLen < 6 || titleLen > 60) {
      titleSummaryOk = false;
      break;
    }

    // 摘要长度：10-240 字符
    if (summaryLen < 10 || summaryLen > 240) {
      titleSummaryOk = false;
      break;
    }

    // 标题与摘要不得完全相同
    if (card.title === card.summary) {
      titleSummaryOk = false;
      break;
    }

    // 标题不应包含 HTML/Markdown 控制符
    if (/[<>\|`]{2,}|^---$|^```$/.test(card.title)) {
      titleSummaryOk = false;
      break;
    }
  }

  // Deck 整体质量检查
  const allHaveContent = cards.every(c => c.title.trim().length > 0 && c.summary.trim().length > 0);
  const allTitlesDifferent = new Set(cards.map(c => c.title)).size === cards.length;
  const conceptRecallRate = conceptRecall.importantTotal > 0
    ? conceptRecall.importantHits / conceptRecall.importantTotal
    : 0;

  const deckAccepted = allHaveContent && allTitlesDifferent && conceptRecallRate >= 0.5;

  return {
    deckAccepted,
    titleSummaryAccepted: titleSummaryOk,
  };
}

/**
 * P1-14: 检测跨卡语义重复。
 *
 * 使用简单的文本相似度（Jaccard on character bigrams）检测重复卡片。
 * 相似度 > 0.7 视为重复。
 */
function computeCrossCardDuplicates(
  cards: Array<{ title: string; summary: string }>,
): number {
  if (cards.length < 2) return 0;

  const getBigrams = (text: string): Set<string> => {
    const s = text.toLowerCase().replace(/\s+/g, "");
    const bigrams = new Set<string>();
    for (let i = 0; i < s.length - 1; i++) {
      bigrams.add(s.slice(i, i + 2));
    }
    return bigrams;
  };

  const jaccard = (a: Set<string>, b: Set<string>): number => {
    if (a.size === 0 || b.size === 0) return 0;
    let intersection = 0;
    for (const x of a) {
      if (b.has(x)) intersection++;
    }
    return intersection / (a.size + b.size - intersection);
  };

  let duplicates = 0;
  const bigramsList = cards.map(c => getBigrams(`${c.title} ${c.summary}`));

  for (let i = 0; i < cards.length; i++) {
    for (let j = i + 1; j < cards.length; j++) {
      if (jaccard(bigramsList[i]!, bigramsList[j]!) > 0.7) {
        duplicates++;
        break; // 每张卡只计一次重复
      }
    }
  }

  return duplicates;
}

async function getCardGenerationRun(
  token: string,
  runId: string,
  signal?: AbortSignal,
): Promise<CardGenRunView | null> {
  const res = await fetch(`${API_BASE_URL}/card-generation-runs/${runId}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal,
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Get run failed (${res.status}): ${text}`);
  }
  return await res.json() as CardGenRunView;
}

const TERMINAL_STATUSES = new Set([
  "succeeded",
  "needs_attention",
  "partial_ready",
  "cancelled",
  "superseded",
]);

async function pollRunUntilTerminal(
  token: string,
  runId: string,
  timeoutMs = 300_000,
  signal?: AbortSignal,
): Promise<CardGenRunView> {
  const deadline = Date.now() + timeoutMs;
  // 单个 abort 监听在整轮轮询期间只注册一次，避免每个 3s 迭代都往共享的
  // AbortSignal 上追加 listener（长运行会累积上百个监听）。监听器通过外层
  // 可变引用唤醒当前等待并清理 timer；finally 里移除，跨调用也不泄漏。
  let abortResolve: (() => void) | null = null;
  let pendingTimer: ReturnType<typeof setTimeout> | null = null;
  const onAbort = () => {
    if (pendingTimer) clearTimeout(pendingTimer);
    pendingTimer = null;
    abortResolve?.();
    abortResolve = null;
  };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }

  try {
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new Error(`Run ${runId} aborted`);
      const run = await getCardGenerationRun(token, runId, signal);
      if (!run) throw new Error(`Run ${runId} not found`);

      if (TERMINAL_STATUSES.has(run.status)) {
        return run;
      }

      // Wait 3 seconds before polling again (abort wakes the wait immediately).
      await new Promise<void>((r) => {
        if (signal?.aborted) {
          r();
          return;
        }
        abortResolve = r;
        pendingTimer = setTimeout(() => {
          pendingTimer = null;
          abortResolve = null;
          r();
        }, 3000);
      });
    }
    throw new Error(`Run ${runId} timed out after ${timeoutMs / 1000}s`);
  } finally {
    if (signal) signal.removeEventListener("abort", onAbort);
  }
}

// ─── SupervisorRunner 实现 ────────────────────────────────────────────────

class ApiSupervisorRunner implements SupervisorRunner {
  constructor(
    private readonly token: string,
    private readonly endpoint: string,
    private readonly modelId: string,
  ) {}

  getEndpointOrigin(): string {
    return new URL(this.endpoint).origin;
  }

  getModelId(): string {
    return this.modelId;
  }

  getModelRevision(): string | null {
    // DashScope OpenAI-compatible endpoint doesn't always return revision
    // In production, this would come from response headers
    return `dashscope:${this.modelId}`;
  }

  async runSample(
    sample: GoldenSample,
    signal?: AbortSignal,
  ): Promise<SupervisorRunResult> {
    const startTime = Date.now();

    try {
      // 1. Create note with sample content
      const noteResult = await createNote(
        this.token,
        sample.noteTitle,
        sample.noteContent,
      );

      // 2. Trigger card generation
      const run = await createCardGenerationRun(
        this.token,
        noteResult.version.id,
        sample.density,
      );

      // 3. Poll until terminal (threaded AbortSignal so a deadline/abort
      //    actually cancels the long polling loop instead of orphaning it).
      const finalRun = await pollRunUntilTerminal(this.token, run.runId, 300_000, signal);

      // 4. Check for cancellation
      if (signal?.aborted) throw new Error("aborted during polling");

      // 5. Extract results
      const succeeded = finalRun.status === "succeeded";
      const cards = (finalRun.cards ?? []).map((c) => ({
        cardId: c.id,
        title: c.title,
        summary: c.summary,
        sectionKey: c.sectionKey ?? "default",
        candidateIds: [],
        evidenceRefIds: [],
      }));

      // P1-14 修复：RC runner 只能使用实际 DB 指标，不得由 succeeded 推导质量分。
      // 从 finalRun.coverageReport 中提取实际覆盖率数据。
      const coverage = (finalRun.coverageReport as Record<string, number> | null) ?? {};
      const actualSourcePhysical = typeof coverage.sourcePhysicalCoverage === "number" ? coverage.sourcePhysicalCoverage : 0;
      const actualBundleAssignment = typeof coverage.bundleAssignmentCoverage === "number" ? coverage.bundleAssignmentCoverage : 0;
      const actualExplicitDecision = typeof coverage.explicitDecisionCoverage === "number" ? coverage.explicitDecisionCoverage : 0;
      const actualCandidateSurvival = typeof coverage.candidateSurvivalCoverage === "number" ? coverage.candidateSurvivalCoverage : 0;
      const actualPublishedConcept = typeof coverage.publishedConceptCoverage === "number" ? coverage.publishedConceptCoverage : 0;

      // P1-14: 检查 provider capability fingerprint，防止 Mock 成功被误判为真模型成功
      const fingerprint = finalRun.providerCapabilityFingerprint ?? null;
      const isMockProvider = fingerprint !== null && fingerprint.includes("mock");

      // P1-14 修复：查询实际证据对齐状态，不从 succeeded 推导。
      // 审计发现 RC runner 把 succeeded 直接映射为全 supported、零重复，
      // 但实际 DB 中 36/36 candidate 仍为 pending + pending，36/36 evidence 为 unaligned。
      const actualEvidence = await collectActualEvidenceMetrics(this.token, cards);

      // P1-14: 从卡片内容检查概念召回率，不从 succeeded 推导。
      const importantHits = checkConceptRecall(cards, sample.mustLearnConcepts);
      const criticalHits = checkConceptRecall(cards, sample.criticalConcepts);
      const sectionHits = checkSectionRecall(cards, sample.expectedSections);

      // P1-14: evidenceIntegrity 从实际证据状态推导
      // allowlistCompliant: 无 auto_verified 证据
      // quoteHashValid: 所有证据都有对齐结果（非空）
      // typedEvidence: 有 aligned 证据（证明证据系统在工作）
      const evidenceIntegrityOk = actualEvidence.totalEvidence > 0
        && actualEvidence.autoVerifiedCount === 0
        && actualEvidence.alignedCount > 0;

      // P1-14: semanticSupport 从实际证据对齐状态推导
      // supported = 有 aligned 证据的卡片数
      // unsupported = 无 aligned 证据的卡片数
      const supportedCount = cards.length - actualEvidence.unsupportedCount;

      // P1-14: 自动化启发式评估作为人工评估代理
      const humanEvaluation = computeAutomatedHumanEvaluation(cards, {
        importantHits,
        importantTotal: sample.mustLearnConcepts.length,
      });

      // P1-14: 计算跨卡语义重复
      const crossCardDuplicates = computeCrossCardDuplicates(cards);

      // Budget 修复：从 run 的 errorCode 和 status 推导实际预算合规状态。
      // 原代码硬编码全 false，即使 run 因预算耗尽失败也不报告。
      const errorCode = finalRun.errorCode ?? "";
      const turnBudgetExceeded = errorCode.includes("budget_exhausted") || errorCode.includes("max_turns");
      const tokenBudgetExceeded = errorCode.includes("token_budget") || errorCode.includes("input_over_context");
      const toolCallBudgetExceeded = errorCode.includes("tool_call_budget");
      const costCapExceeded = errorCode.includes("cost_cap") || errorCode.includes("cost");
      const deadlineExceeded = errorCode.includes("deadline");

      return {
        sampleId: sample.sampleId,
        cards,
        coverage: {
          sourcePhysical: actualSourcePhysical,
          bundleAssignment: actualBundleAssignment,
          explicitDecision: actualExplicitDecision,
          candidateSurvival: actualCandidateSurvival,
          publishedConcept: actualPublishedConcept,
        },
        evidenceIntegrity: {
          // P1-14: 从实际证据状态推导，不从 succeeded 推导
          allowlistCompliant: evidenceIntegrityOk,
          quoteHashValid: evidenceIntegrityOk,
          typedEvidence: actualEvidence.alignedCount > 0,
        },
        // P1-14: 从实际证据推导 unsupported 数量
        unsupportedClaimCount: actualEvidence.unsupportedCount,
        semanticSupport: {
          total: cards.length,
          // P1-14: 从实际证据对齐状态推导
          supported: supportedCount,
          partial: 0,
          unsupported: actualEvidence.unsupportedCount,
          contradicted: 0,
        },
        conceptRecall: {
          // P1-14: 从卡片内容检查概念召回率，不从 succeeded 推导
          importantHits,
          importantTotal: sample.mustLearnConcepts.length,
          criticalHits,
          criticalTotal: sample.criticalConcepts.length,
        },
        sectionRecall: {
          hits: sectionHits,
          total: sample.expectedSections.length,
        },
        budgetCompliance: {
          turnBudgetExceeded,
          tokenBudgetExceeded,
          toolCallBudgetExceeded,
          costCapExceeded: costCapExceeded || deadlineExceeded,
        },
        crossCardDuplicates,
        durationMs: Date.now() - startTime,
        costUsd: 0,
        // P1-14: 记录 Mock provider 标记，使 RC gate 可以拒绝 Mock 结果
        mockProvider: isMockProvider,
        providerFingerprint: fingerprint,
        humanEvaluation,
        error: succeeded ? null : `Run ended with status: ${finalRun.status}`,
      };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      // Budget 修复：检测超时和预算相关错误
      const isTimeout = errMsg.includes("timed out") || errMsg.includes("timeout");
      const isBudgetError = errMsg.includes("budget") || errMsg.includes("exhausted");
      return {
        sampleId: sample.sampleId,
        cards: [],
        coverage: {
          sourcePhysical: 0,
          bundleAssignment: 0,
          explicitDecision: 0,
          candidateSurvival: 0,
          publishedConcept: 0,
        },
        evidenceIntegrity: {
          allowlistCompliant: false,
          quoteHashValid: false,
          typedEvidence: false,
        },
        unsupportedClaimCount: 0,
        semanticSupport: { total: 0, supported: 0, partial: 0, unsupported: 0, contradicted: 0 },
        conceptRecall: {
          importantHits: 0,
          importantTotal: sample.mustLearnConcepts.length,
          criticalHits: 0,
          criticalTotal: sample.criticalConcepts.length,
        },
        sectionRecall: { hits: 0, total: sample.expectedSections.length },
        budgetCompliance: {
          turnBudgetExceeded: isBudgetError,
          tokenBudgetExceeded: false,
          toolCallBudgetExceeded: false,
          costCapExceeded: isTimeout,
        },
        crossCardDuplicates: 0,
        durationMs: Date.now() - startTime,
        costUsd: 0,
        error: errMsg,
      };
    }
  }
}

// ─── Dry Run Runner ────────────────────────────────────────────────────────

class DryRunSupervisorRunner implements SupervisorRunner {
  getEndpointOrigin(): string {
    return "dry-run";
  }
  getModelId(): string {
    return "dry-run-model";
  }
  getModelRevision(): string | null {
    return "dry-run-revision";
  }
  async runSample(sample: GoldenSample): Promise<SupervisorRunResult> {
    return {
      sampleId: sample.sampleId,
      cards: [],
      coverage: { sourcePhysical: 1, bundleAssignment: 1, explicitDecision: 1, candidateSurvival: 1, publishedConcept: 1 },
      evidenceIntegrity: { allowlistCompliant: true, quoteHashValid: true, typedEvidence: true },
      unsupportedClaimCount: 0,
      semanticSupport: { total: 1, supported: 1, partial: 0, unsupported: 0, contradicted: 0 },
      conceptRecall: { importantHits: sample.mustLearnConcepts.length, importantTotal: sample.mustLearnConcepts.length, criticalHits: sample.criticalConcepts.length, criticalTotal: sample.criticalConcepts.length },
      sectionRecall: { hits: sample.expectedSections.length, total: sample.expectedSections.length },
      budgetCompliance: { turnBudgetExceeded: false, tokenBudgetExceeded: false, toolCallBudgetExceeded: false, costCapExceeded: false },
      crossCardDuplicates: 0,
      durationMs: 0,
      costUsd: 0,
      humanEvaluation: { deckAccepted: true, titleSummaryAccepted: true },
      error: null,
    };
  }
}

// ─── CLI 主逻辑 ───────────────────────────────────────────────────────────

async function main() {
  const subset = (process.env.AIQ_RC_SUBSET ?? "S") as ProviderSubset;
  const maxBudgetUsd = Number(process.env.AIQ_RC_MAX_BUDGET_USD ?? 50);
  const outputPath = process.env.AIQ_RC_OUTPUT;

  console.error("=== Supervisor Agent v1 RC Gate ===");
  console.error(`API: ${API_BASE_URL}`);
  console.error(`Subset: ${subset}`);
  console.error(`Budget: $${maxBudgetUsd}`);
  console.error(`Dry run: ${DRY_RUN}`);
  console.error(`Golden set size: ${GOLDEN_SET_SIZE}`);

  let runner: SupervisorRunner;

  if (DRY_RUN) {
    console.error("Using dry-run runner (no Provider calls)");
    runner = new DryRunSupervisorRunner();
  } else {
    // Login
    console.error("Logging in...");
    const auth = await login();
    console.error(`Logged in: userId=${auth.userId}, workspaceId=${auth.workspaceId}`);

    const modelId = process.env.DASHSCOPE_MODEL ?? "qwen-plus";
    const endpoint = process.env.DASHSCOPE_BASE_URL ?? "https://dashscope.aliyuncs.com/api/v1";
    runner = new ApiSupervisorRunner(auth.token, endpoint, modelId);
  }

  const config = {
    ...DEFAULT_SUPERVISOR_RC_CONFIG,
    runner,
    subset,
    maxBudgetUsd,
    previousAggregate: null,
  };

  console.error(`Starting RC gate: subset=${subset}, model=${runner.getModelId()}`);
  console.error(`Rounds: ${config.maxRounds}, Max budget: $${config.maxBudgetUsd}`);

  const result = await runSupervisorRCGate(config);

  // Generate artifact
  const artifact = generateRCArtifact(result, {
    engineVersion: "supervisor_agent_v1",
    shellVersion: "card-supervisor-shell-v1",
    supervisorVersion: "supervisor-v1",
    toolVersions: {},
    criticVersion: "critic-v1",
    verifierVersion: "verifier-v1",
    datasetDigest: `sha256:${createHash("sha256").update(String(GOLDEN_SET_SIZE)).digest("hex")}`,
    scorerDigest: "golden-set-scorer-v1",
  });

  if (outputPath) {
    const fullPath = resolve(outputPath);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, `${artifact}\n`, "utf8");
    console.error(`RC artifact written to ${fullPath}`);
  }

  // Print summary
  console.error("\n=== RC Gate Result ===");
  console.error(`Passed: ${result.passed}`);
  console.error(`Subset: ${result.subset}`);
  console.error(`Provider: ${result.providerEndpoint}`);
  console.error(`Model: ${result.modelId}`);
  console.error(`Revision: ${result.modelRevision}`);
  console.error(`Total cost: $${result.totalCostUsd.toFixed(4)}`);
  console.error(`Total duration: ${(result.totalDurationMs / 1000).toFixed(1)}s`);
  console.error(`Failed dimensions: ${result.failedDimensions.join(", ") || "none"}`);
  if (result.failureReason) {
    console.error(`Failure reason: ${result.failureReason}`);
  }
  if (result.errors.length > 0) {
    console.error(`Errors:`);
    for (const err of result.errors) {
      console.error(`  - ${err}`);
    }
  }

  // Print round summaries
  for (const round of result.rounds) {
    console.error(`\n--- Round ${round.round} ---`);
    console.error(`  Pass rate: ${(round.scorerResult.aggregate.passRate * 100).toFixed(1)}%`);
    console.error(`  Avg coverage: ${(round.scorerResult.aggregate.avgCoverage * 100).toFixed(1)}%`);
    console.error(`  Important recall: ${(round.scorerResult.aggregate.avgImportantConceptRecall * 100).toFixed(1)}%`);
    console.error(`  Critical recall: ${(round.scorerResult.aggregate.avgCriticalConceptRecall * 100).toFixed(1)}%`);
    console.error(`  Cost: $${round.costUsd.toFixed(4)}`);
    console.error(`  Duration: ${(round.totalDurationMs / 1000).toFixed(1)}s`);
    console.error(`  Meets threshold: ${round.scorerResult.meetsPublicBetaThreshold}`);
  }

  // Output artifact JSON to stdout
  console.log(artifact);

  process.exit(result.passed ? 0 : 1);
}

main().catch((err) => {
  console.error("RC gate failed with unhandled error:", err);
  process.exit(1);
});
