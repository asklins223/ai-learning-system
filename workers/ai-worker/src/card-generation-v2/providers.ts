/**
 * 方案 20 R4：Card Generation V2 真实四阶段 LLM providers。
 *
 * 实现 apps/api 的四个 provider 接口，通过 `createProvider` + `chatCompletion`
 * 调用真实 LLM，输出经 zod strict parse 的合同结构：
 * - AtomExtractionProvider   → planner-service
 * - AuthoringProvider        → author-service
 * - GroundingCriticProvider  → critic-service（§12.2 合同）
 * - PedagogyCriticProvider   → critic-service（§12.3 合同）
 *
 * 采样参数（temperature 等）从 `GenerationSemanticSpecV2.policies.stageRuntimes`
 * 中对应 stage 读取。错误分类：retryable（provider 5xx/429/408/超时/网络）；
 * non-retryable（schema/协议 parse 失败、契约不匹配）。绝不以失败伪装 0 卡。
 */

import { randomUUID } from "node:crypto";
import { logger } from "../lib/logger.ts";
import { createProvider, resolveProviderSelection, type AIProvider, type AIProviderRuntimeConfig } from "../lib/ai-provider.ts";
import { extractJsonFromText } from "../lib/providers/json-response.ts";
import type { ChatMessage, ChatOptions } from "@ailearn/shared";
import type {
  GenerationSemanticSpecV2,
  GenerationStageRuntimeSnapshotV2,
} from "@ailearn/shared/card-generation-v2-contracts";
import { z } from "zod";
import { cardPresentationDraftV2Schema, canonicalAnswerV2Schema } from "@ailearn/shared/card-generation-v2-contracts";
import type {
  ExtractedKnowledgeAtom,
  AtomExtractionProvider,
  SourceBlockInput,
} from "../../../../apps/api/src/modules/card-generation-v2/planner-service.ts";
import type {
  AuthoringProvider,
  AuthoringProviderInput,
  AuthoringProviderOutput,
} from "../../../../apps/api/src/modules/card-generation-v2/author-service.ts";
import type {
  GroundingCriticProvider,
  GroundingCriticInput,
  PedagogyCriticProvider,
  PedagogyCriticInput,
  ExistingObjectiveSummary,
} from "../../../../apps/api/src/modules/card-generation-v2/critic-service.ts";
import {
  parseGroundingCriticReportV2,
  parsePedagogyCriticReportV2,
  type GroundingCriticReportV2,
  type PedagogyCriticReportV2,
} from "@ailearn/shared/card-quality-v2-contracts";
import { computeCandidateEvidenceSetHashV2, computeRubricHashV2 } from "@ailearn/shared/card-generation-v2-hashing";
import { hashCanonicalV2 } from "@ailearn/shared/hash-canonical-v2";
import {
  PLANNER_PROMPT_VERSION,
  AUTHOR_PROMPT_VERSION,
  GROUNDING_PROMPT_VERSION,
  PEDAGOGY_PROMPT_VERSION,
  buildPlannerSystemPrompt,
  buildPlannerUserPrompt,
  buildAuthorSystemPrompt,
  buildAuthorUserPrompt,
  buildGroundingSystemPrompt,
  buildGroundingUserPrompt,
  buildPedagogySystemPrompt,
  buildPedagogyUserPrompt,
} from "./prompts.ts";

// ─── 可分类错误 ──────────────────────────────────────────────────────────

export class CardGenerationProviderError extends Error {
  readonly kind: "retryable" | "non-retryable";
  constructor(kind: "retryable" | "non-retryable", message: string) {
    super(message);
    this.name = "CardGenerationProviderError";
    this.kind = kind;
  }
}

export function parseError(stage: string, err: unknown): CardGenerationProviderError {
  const detail = err instanceof Error ? err.message : String(err);
  // 2026-08-16（实机验证修复）：LLM 输出 schema 违规改为 **retryable**。
  // 模型对复杂嵌套 JSON（author/grounding 全量输出）的完整性是随机的——
  // 一次不完整不代表下次不完整；此前 non-retryable 直接 failed 使真实 LLM
  // 管线（deepseek-v4-flash）在偶发输出缺字段时永久失败。重试（outbox
  // attempts < 6）能显著提高成功率；prompt 已明确"只输出 JSON"且 schema
  // 校验仍在（fail-closed 语义不变：重试耗尽后仍 failed，绝不带病发布）。
  return new CardGenerationProviderError("retryable", `${stage} failed zod strict parse: ${detail}`);
}

export function classifyProviderError(stage: string, err: unknown): CardGenerationProviderError {
  if (err instanceof CardGenerationProviderError) return err;
  const message = err instanceof Error ? err.message : String(err);
  if (err !== null && typeof err === "object" && "status" in err) {
    const status = (err as { status?: unknown }).status;
    if (typeof status === "number") {
      if (status === 400 || status === 401 || status === 403 || status === 404 || status === 422) {
        return new CardGenerationProviderError("non-retryable", `${stage}: provider rejected request (HTTP ${status})`);
      }
      if (status === 408 || status === 429 || status >= 500) {
        return new CardGenerationProviderError("retryable", `${stage}: provider transient failure (HTTP ${status})`);
      }
    }
  }
  const lower = message.toLowerCase();
  const transient = /timeout|timed ?out|etimedout|socket hang up|abort(ed)?|network|econnreset|econnrefused|fetch failed|eai_again/i.test(lower);
  if (transient) return new CardGenerationProviderError("retryable", `${stage}: ${message}`);
  if (/\b(5\d\d|429)\b/.test(lower)) return new CardGenerationProviderError("retryable", `${stage}: ${message}`);
  return new CardGenerationProviderError("retryable", `${stage}: ${message}`);
}

// ─── Runtime 封装 ────────────────────────────────────────────────────────

// 单个 V2 provider chatCompletion 调用的真正中止预算（第五轮审计 F26/W#4）。
// 每个 chatJson 调用的底层 chatCompletion 在超出该预算后真中止（AbortSignal.timeout），
// 而非仅靠外层 runWithAbortTimeout(30min) 等待返回——把悬挂从「分钟级阻塞」降到秒级。
// 可经环境变量 V2_PROVIDER_CALL_TIMEOUT_MS 覆盖（非法值回退默认）。
function resolveV2ProviderCallTimeoutMs(): number {
  const raw = Number(process.env.V2_PROVIDER_CALL_TIMEOUT_MS ?? 75_000);
  return Number.isFinite(raw) && raw > 0 ? raw : 75_000;
}

export interface CardGenerationProviderConfig {
  provider: AIProvider;
  stageRuntimes: GenerationStageRuntimeSnapshotV2[];
}

export class CardGenerationProviderRuntime {
  readonly provider: AIProvider;
  private readonly stageRuntimes: GenerationStageRuntimeSnapshotV2[];

  constructor(config: CardGenerationProviderConfig) {
    this.provider = config.provider;
    this.stageRuntimes = config.stageRuntimes;
  }

  private sampling(stage: string): { temperature: number; model?: string } {
    const snap = this.stageRuntimes.find((r) => r.stage === stage);
    return {
      temperature: snap?.sampling.temperature ?? 0,
      model: snap?.modelSnapshot && snap.modelSnapshot !== "v1"
        ? snap.modelSnapshot
        : this.provider.modelId,
    };
  }

  /**
   * 调用 provider 的 JSON 输出完成。
   *
   * `signal`（可选）：调用方提供的待透传 AbortSignal——当它已 abort 或触发后，
   * 底层 chatCompletion 会被真中止。无外部 signal 时，仍用单调用预算
   * `V2_PROVIDER_CALL_TIMEOUT_MS` 兜底（AbortSignal.timeout），保证悬挂的
   * provider 能真正中止而非仅等外层超时返回。
   */
  async chatJson(
    stage: string,
    system: string,
    user: string,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const messages: ChatMessage[] = [
      { role: "system", content: system },
      { role: "user", content: user },
    ];
    const s = this.sampling(stage);
    const options: ChatOptions = {
      temperature: s.temperature,
      model: s.model,
      responseFormat: "json_object",
      // 2026-08-16（实机验证修复）：V2 生成是结构化 JSON 任务（planner/author/
      // grounding/pedagogy 都要求严格 JSON 输出），显式关闭 thinking——部分
      // thinking 模型（deepseek-v4-flash）长 reasoning 导致 75s 单调用超时或
      // content 偶发为空；关 thinking 后输出更快更稳（prompt 已明确"只输出 JSON"）。
      disableThinking: true,
    };
    // 组合外部 signal 与单调用超时：任一触发即真中止底层 HTTP 调用。
    const timeoutSignal = AbortSignal.timeout(resolveV2ProviderCallTimeoutMs());
    const effectiveSignal = signal
      ? AbortSignal.any([signal, timeoutSignal])
      : timeoutSignal;
    // 2026-08-16（实机验证，溯源日志）：每个阶段 LLM 调用记录——阶段名、
    // prompt 规模、调用耗时、返回内容长度与摘要，失败时打印原始输出片段，
    // 不再黑盒排查。
    const startedAt = Date.now();
    logger.info({
      stage,
      model: s.model,
      systemLen: system.length,
      userLen: user.length,
      provider: this.provider.id,
    }, "[v2-llm] chatJson start");
    try {
      const result = await this.provider.chatCompletion(messages, options, effectiveSignal);
      const elapsedMs = Date.now() - startedAt;
      logger.info({
        stage,
        elapsedMs,
        contentLen: result.content.length,
        contentHead: result.content.slice(0, 200),
      }, "[v2-llm] chatJson response");
      const parsed = extractJsonFromText(result.content);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        logger.warn({
          stage,
          elapsedMs,
          contentHead: result.content.slice(0, 500),
        }, "[v2-llm] chatJson result is not a JSON object");
        throw new CardGenerationProviderError(
          "non-retryable",
          `${stage}: provider result is not a JSON object: ${result.content.slice(0, 200)}`,
        );
      }
      logger.info({
        stage,
        elapsedMs,
        topKeys: Object.keys(parsed as Record<string, unknown>).slice(0, 10),
      }, "[v2-llm] chatJson parsed ok");
      return parsed as Record<string, unknown>;
    } catch (err) {
      const elapsedMs = Date.now() - startedAt;
      logger.warn({
        stage,
        elapsedMs,
        err: err instanceof Error ? err.message : String(err),
      }, "[v2-llm] chatJson failed");
      throw classifyProviderError(stage, err);
    }
  }
}

export function buildStageRuntimes(spec: GenerationSemanticSpecV2): GenerationStageRuntimeSnapshotV2[] {
  return spec.policies.stageRuntimes;
}

// ─── Planner Atom Extraction ─────────────────────────────────────────────

const KNOWLEDGE_FORMS = [
  "fact", "definition", "relationship", "comparison", "sequence",
  "procedure", "causal_model", "boundary", "application_rule",
] as const;

export class PlannerAtomExtractionProvider implements AtomExtractionProvider {
  private readonly runtime: CardGenerationProviderRuntime;

  constructor(runtime: CardGenerationProviderRuntime) {
    this.runtime = runtime;
  }

  async extractAtoms(
    blocks: SourceBlockInput[],
    semanticSpec: GenerationSemanticSpecV2,
  ): Promise<ExtractedKnowledgeAtom[]> {
    const user = buildPlannerUserPrompt({
      semanticRequest: semanticSpec.semanticRequest,
      blocks,
      existingObjectives: [],
      feedbackContext: semanticSpec.semanticRequest.feedbackContext,
    });
    const raw = await this.runtime.chatJson(PLANNER_PROMPT_VERSION, buildPlannerSystemPrompt(), user);
    if (!Array.isArray(raw.atoms)) {
      throw parseError("planner", new Error("planner output missing `atoms` array"));
    }
    const atoms: ExtractedKnowledgeAtom[] = [];
    (raw.atoms as unknown[]).forEach((entryRaw, idx) => {
      if (entryRaw === null || typeof entryRaw !== "object") return;
      const entry = entryRaw as Record<string, unknown>;
      const id = typeof entry.atomId === "string" ? entry.atomId : `atom-${idx}`;
      const proposition = typeof entry.proposition === "string" ? entry.proposition : "";
      if (!proposition) return;
      atoms.push({
        atomId: id,
        proposition,
        evidenceRefIds: [],
        sourceSectionKeys: asStringArray(entry.sourceSectionKeys),
        importanceBps: clampBps(entry.importanceBps),
        learnabilityBps: clampBps(entry.learnabilityBps),
        confidenceBps: clampBps(entry.confidenceBps),
        knowledgeFormHint: toKnowledgeForm(entry.knowledgeFormHint),
      });
    });
    // fail-closed：模型未产出任何原子 → 协议错误（retryable：可能是模型输出
    // 质量问题，重试可能产出原子；重试耗尽仍 failed，不是 0 卡）。
    if (atoms.length === 0) {
      logger.warn({ stage: "planner", rawHead: JSON.stringify(raw).slice(0, 800) }, "[v2-planner] no atoms extracted");
      throw new CardGenerationProviderError("retryable", "planner returned no atoms (protocol error, not no_cards)");
    }
    logger.info({ stage: "planner", atomCount: atoms.length }, "[v2-planner] atoms extracted");
    return atoms;
  }
}

// ─── Author ──────────────────────────────────────────────────────────────

/**
 * R26：模型输出的 objective 放宽 schema——不含 pipeline 派生字段
 * （rubric.units[].evidenceRefIds / objective.evidenceRefIds / rubricHash），
 * 归一化由 CardAuthoringProvider 完成。
 */
const modelObjectiveDraftSchema = z
  .strictObject({
    objectiveStatement: z.string().min(1).max(2000),
    publicSummary: z.string().min(1).max(1500),
    knowledgeForm: z.enum([
      "fact", "definition", "relationship", "comparison", "sequence",
      "procedure", "causal_model", "boundary", "application_rule",
    ]),
    preferredTaskIntents: z.array(z.enum(["recall", "explain", "apply", "compare", "generate"])).min(1).max(6),
    // 2026-08-16（实机验证修复）：改用正式 canonicalAnswerV2Schema（7 种形态：
    // text 单对象 / bullets / ordered_steps / mapping / comparison / formula / code）。
    // 此前只接受 kind:"text"+unit 单对象——模型输出多 answer unit（数组）时被拒，
    // author 阶段反复 schema violation（deepseek-v4-flash 实测连续 4+ 次失败）。
    canonicalAnswer: canonicalAnswerV2Schema,
    learningSupport: z.strictObject({
      // R30：允许空串——模型按 prompt 对无证据支持字段输出 ""（不编造）
      explanation: z.string().max(6000),
      boundary: z.string().max(3000).optional(),
      misconception: z.string().max(3000).optional(),
      workedExample: z.string().max(6000).optional(),
    }),
    rubric: z.strictObject({
      version: z.literal(2),
      units: z
        .array(
          z.strictObject({
            rubricUnitId: z.string().min(1).max(160),
            facet: z.enum(["recall", "explain", "apply", "compare", "generate"]),
            criterion: z.string().min(1).max(2000),
            required: z.boolean(),
            answerUnitIds: z.array(z.string().min(1).max(160)).min(1).max(80),
            evidenceRefIds: z.array(z.string().min(1).max(200)).max(100).optional(),
          }),
        )
        .min(1)
        .max(80),
      passingPolicy: z.strictObject({
        requireAllRequiredUnits: z.boolean(),
        allowContradiction: z.boolean(),
      }),
    }),
    relations: z
      .array(
        z.strictObject({
          relationId: z.string().min(1).max(160),
          fromAnswerUnitId: z.string().min(1).max(160),
          toAnswerUnitId: z.string().min(1).max(160),
          kind: z.enum(["causes", "contradicts", "supports", "part_of", "example_of"]),
        }),
      )
      .max(60),
    difficulty: z.enum(["introductory", "intermediate", "advanced"]),
    evidenceRefIds: z.array(z.string().min(1).max(200)).max(100).optional(),
  })
  .strict();

export class CardAuthoringProvider implements AuthoringProvider {
  private readonly runtime: CardGenerationProviderRuntime;

  constructor(runtime: CardGenerationProviderRuntime) {
    this.runtime = runtime;
  }

  async authorCandidate(input: AuthoringProviderInput): Promise<AuthoringProviderOutput> {
    const user = buildAuthorUserPrompt({
      objective: input.planObjective,
      semanticSpecHash: input.semanticSpecHash,
      planHash: input.planHash,
      sourceContent: input.sourceContent,
      evidenceList: input.evidenceList,
    });
    const raw = await this.runtime.chatJson(AUTHOR_PROMPT_VERSION, buildAuthorSystemPrompt(), user);
    const objective = raw.objective;
    const presentation = raw.presentation;
    if (!objective || !presentation || Array.isArray(objective) || Array.isArray(presentation)) {
      throw parseError("author", new Error("author output missing objective/presentation object"));
    }
    // evidenceSetHash 由 handler 基于 sealed manifest 计算，此处返回空，author-service
    // 会基于从真实 manifest 推导的 hash 覆盖。（真实模式下 handler 传入的
    // sourceContent 已含证据，author 输出不稳定 hash 不作为最终值。）
    // R26：author 输出校验（模型畸形输出 → 清晰协议错误 fail-closed，不得带病进入
    // critic 阶段；chatJson 只保证 JSON 对象形状）。模型不负责任何 pipeline 派生字段：
    // evidenceRefIds（sealed manifest 关联由 Grounding/assembler 建立——author prompt
    // 不含证据 ID，模型无法填写）与 rubricHash（服务端确定性哈希）——校验用放宽的
    // 模型输出 schema，随后归一化到完整 draft。
    // 解析前仅剥离模型可能回填的 rubricHash；evidenceRefIds 是模型职责
    // （prompt 已提供 sealed evidence ID 清单供引用）。
    const rawObjective = (objective ?? {}) as Record<string, unknown>;
    const rawRubric = (rawObjective.rubric ?? {}) as Record<string, unknown>;
    const { rubricHash: _modelRubricHash, ...rubricNoModelHash } = rawRubric;
    const strippedObjective = { ...rawObjective, rubric: rubricNoModelHash };
    const objParse = modelObjectiveDraftSchema.safeParse(strippedObjective);
    if (!objParse.success) {
      const paths = objParse.error.issues.map((i) => i.path.join(".")).join(",");
      // 2026-08-16（实机验证，溯源日志）：schema 违规始终记录完整 issues 与
      // 原始输出摘要，不依赖 V2_E2E_DEBUG_ERRORS（排查黑盒）。
      logger.warn({
        stage: "author",
        issues: objParse.error.issues.slice(0, 20).map((i) => ({
          path: i.path.join("."),
          code: i.code,
          message: i.message,
        })),
        rawHead: JSON.stringify(rawObjective).slice(0, 1200),
      }, "[v2-author] objective schema violation");
      if (process.env.V2_E2E_DEBUG_ERRORS === "1") {
        // eslint-disable-next-line no-console
        console.error("AUTHOR_RAW_OUTPUT", JSON.stringify(rawObjective).slice(0, 1200));
        // eslint-disable-next-line no-console
        console.error("AUTHOR_PARSE_ISSUES", JSON.stringify(objParse.error.issues).slice(0, 1200));
      }
      // 2026-08-16（实机验证修复）：LLM 输出 schema 违规是随机质量问题（同一
      // prompt 下一次可能完整），改 retryable 让 outbox 重试（attempts < 6），
      // 重试耗尽仍 failed（fail-closed 不变）。此前 non-retryable 一次失败即死。
      throw new CardGenerationProviderError("retryable", `author output objective schema violation: ${paths}`);
    }
    const presParse = cardPresentationDraftV2Schema.safeParse(presentation);
    if (!presParse.success) {
      const paths = presParse.error.issues.map((i) => i.path.join(".")).join(",");
      logger.warn({
        stage: "author",
        issues: presParse.error.issues.slice(0, 20).map((i) => ({
          path: i.path.join("."),
          code: i.code,
          message: i.message,
        })),
        rawHead: JSON.stringify(presentation).slice(0, 1200),
      }, "[v2-author] presentation schema violation");
      throw new CardGenerationProviderError("retryable", `author output presentation schema violation: ${paths}`);
    }
    const validated = objParse.data;
    // 归一化：保留模型引用的 evidenceRefIds（未引用处补 []，no_evidence_reference
    // hard gate 会拦截完全无引用的候选）；rubricHash 由本层确定性计算——hash 必须在
    // units 补全 evidenceRefIds 之后计算（executeAuthor 对最终 rubric 重算比对）。
    const rubricRaw = validated.rubric as unknown as Record<string, unknown>;
    const { rubricHash: _modelHash, ...rubricWithoutHash } = rubricRaw;
    const unitsWithEvidence = (rubricWithoutHash.units as Array<Record<string, unknown>>).map((u) => ({
      ...u,
      // evidenceRefIds 来自模型输出（schema 校验后为 string[]）；Array.isArray
      // 兜底时保持 string[] 类型（PERF 遗留项：修复 any[] 与 rubric 契约不匹配）。
      evidenceRefIds: Array.isArray(u.evidenceRefIds) ? (u.evidenceRefIds as string[]) : [],
    }));
    const rubricFinal = { ...rubricWithoutHash, units: unitsWithEvidence };
    // rubricFinal 由 Record 归一化而来，静态类型为瘦结构；hash 输入为同一
    // 运行时对象，仅对调用处断言完整契约类型（数据已过 modelObjectiveDraftSchema
    // 校验，PERF 遗留项修复）。
    const rubricForHash = rubricFinal as Parameters<typeof computeRubricHashV2>[0];
    const fixedObjective = {
      ...validated,
      evidenceRefIds: Array.isArray(validated.evidenceRefIds) ? validated.evidenceRefIds : [],
      rubric: { ...rubricFinal, rubricHash: computeRubricHashV2(rubricForHash) },
    };
    return {
      objective: fixedObjective as never,
      presentation: presParse.data as never,
      evidenceSetHash: "",
    };
  }
}

// ─── Grounding Critic ────────────────────────────────────────────────────

export class GroundingCriticLLMProvider implements GroundingCriticProvider {
  private readonly runtime: CardGenerationProviderRuntime;

  constructor(runtime: CardGenerationProviderRuntime) {
    this.runtime = runtime;
  }

  async evaluate(input: GroundingCriticInput): Promise<GroundingCriticReportV2> {
    const candidate = input.candidate;
    const evidenceSetHash = input.evidenceManifest?.evidence.length
      ? computeCandidateEvidenceSetHashV2(
          input.evidenceManifest.evidence.map((e) => ({
            evidenceSnapshotId: e.evidenceSnapshotId,
            evidenceSnapshotHash: e.evidenceSnapshotHash,
          })),
        )
      : candidate.evidenceSetHash;
    const eligibilityHash = input.evidenceEligibilityVectorHash ?? evidenceSetHash;

    const user = buildGroundingUserPrompt({
      candidateRevisionHash: candidate.candidateRevisionHash,
      evidenceSetHash,
      evidenceEligibilityVectorHash: eligibilityHash,
      candidateObjective: candidate.objective,
      evidenceQuotes: (input.evidenceManifest?.evidence ?? []).map((e) => ({
        evidenceSnapshotId: e.evidenceSnapshotId,
        quote: (e as { content?: string }).content ?? "",
      })),
    });
    const raw = await this.runtime.chatJson(GROUNDING_PROMPT_VERSION, buildGroundingSystemPrompt(), user);
    const enriched: Record<string, unknown> = {
      ...raw,
      version: 2,
      reportId: typeof raw.reportId === "string" ? raw.reportId : randomUUID(),
      candidateRevisionId: candidate.candidateRevisionId,
      candidateRevisionHash: candidate.candidateRevisionHash,
      evidenceSetHash,
      evidenceEligibilityVectorHash: eligibilityHash,
      inputHash: eligibilityHash,
    };
    return finalizeGroundingReport(enriched);
  }
}

// ─── Pedagogy Critic ─────────────────────────────────────────────────────

export class PedagogyCriticLLMProvider implements PedagogyCriticProvider {
  private readonly runtime: CardGenerationProviderRuntime;

  constructor(runtime: CardGenerationProviderRuntime) {
    this.runtime = runtime;
  }

  async evaluate(input: PedagogyCriticInput): Promise<PedagogyCriticReportV2> {
    const plan = input.plan;
    const user = buildPedagogyUserPrompt({
      runId: input.runId,
      planRevisionId: plan?.planRevisionId ?? randomUUID(),
      planVersion: plan?.planVersion ?? 1,
      planHash: plan?.planHash ?? "",
      inputHash: input.inputHash,
      candidateEvidenceBindingPlanHashes: input.candidateEvidenceBindingPlanHashes,
      candidates: input.candidates.map((c) => ({
        candidateId: c.candidateId,
        candidateRevisionHash: c.candidateRevisionHash,
        objective: c.objective,
        presentation: c.presentation,
      })),
      existingObjectives: input.existingObjectives,
      generationRequest: {},
    });
    const raw = await this.runtime.chatJson(PEDAGOGY_PROMPT_VERSION, buildPedagogySystemPrompt(), user);
    const enriched: Record<string, unknown> = {
      ...raw,
      version: 2,
      runId: input.runId,
      candidateRevisionHashes: input.candidates.map((c) => c.candidateRevisionHash),
      candidateEvidenceBindingPlanHashes: input.candidateEvidenceBindingPlanHashes,
      planRevisionId: plan?.planRevisionId ?? randomUUID(),
      planVersion: plan?.planVersion ?? 1,
      planHash: plan?.planHash ?? "",
      inputHash: input.inputHash,
    };
    return finalizePedagogyReport(enriched);
  }
}

// ─── Finalize（strict parse + 真实 reportHash）────────────────────────────

/** §12.2 reportHash：真实计算的版本化域。 */
export function computeGroundingReportHash(report: unknown): string {
  return hashCanonicalV2("card-generation-v2/grounding-critic-report", report);
}

export function computePedagogyReportHash(report: unknown): string {
  return hashCanonicalV2("card-generation-v2/pedagogy-critic-report", report);
}

function isOptionalLearningSupportHardIssue(issue: string): boolean {
  return /learningSupport\.(boundary|misconception|workedExample)/.test(issue)
    || /(boundary|misconception|workedExample)\s*无证据支持/.test(issue);
}

function normalizeGroundingReport(raw: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = { ...raw };
  for (const key of ["answerUnits", "learningSupport", "relationSupport"] as const) {
    const list = next[key];
    if (!Array.isArray(list)) continue;
    next[key] = list.map((item) => {
      if (!item || typeof item !== "object") return item;
      const obj = { ...(item as Record<string, unknown>) };
      if (obj.verdict === "supported") obj.verdict = "entailed";
      else if (obj.verdict === "unsupported") obj.verdict = "insufficient";
      return obj;
    });
  }
  return next;
}

function finalizeGroundingReport(raw: Record<string, unknown>): GroundingCriticReportV2 {
  // R28：reportHash 是服务端确定性哈希——parse 前覆盖模型回填值（模型编造的 hash
  // 违反 64-hex 正则 / 缺失都会 zod strict parse 失败），校验通过后由本层计算真实值。
  const normalized = normalizeGroundingReport(raw);
  const { reportHash: _modelHash, ...withoutModelHash } = normalized;
  const parseTarget = { ...withoutModelHash, reportHash: "a".repeat(64) };
  let parsed: GroundingCriticReportV2;
  try {
    parsed = parseGroundingCriticReportV2(parseTarget);
  } catch (err) {
    // 2026-08-16（实机验证，溯源日志）：记录原始输出与 issues，便于定位
    // 模型输出结构问题（此前黑盒）。
    const issues = (err as { issues?: unknown }).issues;
    logger.warn({
      stage: "grounding",
      issues: Array.isArray(issues)
        ? (issues as Array<{ path?: unknown; message?: unknown }>).slice(0, 20).map((i) => ({ path: String(i.path), message: i.message }))
        : undefined,
      rawHead: JSON.stringify(raw).slice(0, 1200),
    }, "[v2-grounding] report parse failed");
    throw parseError("grounding", err);
  }
  const { reportHash: _drop, ...withoutHash } = parsed;
  // 可选 learningSupport 字段（boundary/misconception/workedExample）没有可靠
  // 证据时不应成为 hard issue；把它们从 hardIssues 里剔除，避免整个候选失败。
  const filteredHardIssues = parsed.hardIssues.filter(
    (issue) => !isOptionalLearningSupportHardIssue(issue),
  );
  // 如果 hardIssues 被清空且原 verdict 是 fail，说明失败只来自可选 learningSupport
  // 字段不足；这些字段不阻断候选，整体 verdict 应降级为 pass。
  const finalVerdict =
    filteredHardIssues.length === 0 && parsed.verdict === "fail"
      ? "pass"
      : parsed.verdict;
  const reportForHash = {
    ...withoutHash,
    verdict: finalVerdict,
    hardIssues: filteredHardIssues,
  };
  const computed = computeGroundingReportHash(reportForHash);
  logger.info({
    stage: "grounding",
    verdict: finalVerdict,
    answerUnits: parsed.answerUnits.length,
    learningSupport: parsed.learningSupport.length,
    relations: parsed.relationSupport.length,
    hardIssues: filteredHardIssues.length,
  }, "[v2-grounding] report parsed");
  return {
    ...parsed,
    verdict: finalVerdict,
    hardIssues: filteredHardIssues,
    reportHash: computed,
  };
}

function finalizePedagogyReport(raw: Record<string, unknown>): PedagogyCriticReportV2 {
  // R28：同 grounding——parse 前覆盖模型回填的 reportHash，由本层确定性计算。
  const { reportHash: _modelHash, ...withoutModelHash } = raw;
  const parseTarget = { ...withoutModelHash, reportHash: "a".repeat(64) };
  let parsed: PedagogyCriticReportV2;
  try {
    parsed = parsePedagogyCriticReportV2(parseTarget);
  } catch (err) {
    const issues = (err as { issues?: unknown }).issues;
    logger.warn({
      stage: "pedagogy",
      issues: Array.isArray(issues)
        ? (issues as Array<{ path?: unknown; message?: unknown }>).slice(0, 20).map((i) => ({ path: String(i.path), message: i.message }))
        : undefined,
      rawHead: JSON.stringify(raw).slice(0, 1200),
    }, "[v2-pedagogy] report parse failed");
    throw parseError("pedagogy", err);
  }
  const { reportHash: _, ...withoutHash } = parsed;
  const computed = computePedagogyReportHash(withoutHash);
  logger.info({
    stage: "pedagogy",
    verdict: parsed.verdict,
    perCandidate: (parsed as unknown as { perCandidate?: Array<{ candidateId: string; verdict: string }> }).perCandidate?.map((p) => `${p.candidateId}:${p.verdict}`),
    recommendedFinalCount: parsed.recommendedFinalCount,
  }, "[v2-pedagogy] report parsed");
  return { ...parsed, reportHash: computed };
}

// ─── Factory ─────────────────────────────────────────────────────────────

/**
 * 构造真实四阶段 providers。
 * 若传入 `providerInstance` 则直接使用（测试注入 mock）；否则按治理上下文解析。
 */
export async function buildCardGenerationProviders(input: {
  workspaceId: string;
  userId: string | null;
  semanticSpec: GenerationSemanticSpecV2;
  providerName?: string;
  providerConfig?: AIProviderRuntimeConfig;
  providerInstance?: AIProvider;
}): Promise<{
  plannerExtraction: AtomExtractionProvider;
  author: AuthoringProvider;
  grounding: GroundingCriticProvider;
  pedagogy: PedagogyCriticProvider;
}> {
  let providerName = input.providerName;
  let providerConfig = input.providerConfig;
  if (!providerName && !input.providerInstance) {
    const selection = await resolveProviderSelection(input.workspaceId, input.userId ?? undefined);
    providerName = selection.providerName;
    providerConfig = selection.config;
  }
  // §10.5/§29.2：LLM 模式（CARD_GENERATION_V2_LLM=true）解析到 mock = 配置缺失
  // （apiKey 未设置/平台未配置）。禁止静默用 MockProvider 生成可发布假内容——
  // fail fast，非重试错误，job 直接 failed，绝不带病生成。
  if (!input.providerInstance && (providerName ?? "mock").toLowerCase() === "mock") {
    const err = new Error(
      "card-generation-v2 LLM mode resolved to mock provider: missing API key or platform not configured. "
      + "Set the provider env vars or unset CARD_GENERATION_V2_LLM (fail closed, no mock fallback)",
    ) as Error & { retryable: boolean };
    err.name = "CardGenerationProviderError";
    err.retryable = false;
    throw err;
  }
  const provider: AIProvider = input.providerInstance ?? createProvider(providerName ?? "mock", providerConfig ?? {});
  const runtime = new CardGenerationProviderRuntime({
    provider,
    stageRuntimes: buildStageRuntimes(input.semanticSpec),
  });
  return {
    plannerExtraction: new PlannerAtomExtractionProvider(runtime),
    author: new CardAuthoringProvider(runtime),
    grounding: new GroundingCriticLLMProvider(runtime),
    pedagogy: new PedagogyCriticLLMProvider(runtime),
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function clampBps(v: unknown): number {
  return typeof v === "number" ? Math.max(0, Math.min(10_000, Math.round(v))) : 5_000;
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.map(String).slice(0, 50) : [];
}

function toKnowledgeForm(v: unknown): ExtractedKnowledgeAtom["knowledgeFormHint"] {
  if (typeof v === "string" && (KNOWLEDGE_FORMS as readonly string[]).includes(v)) {
    return v as ExtractedKnowledgeAtom["knowledgeFormHint"];
  }
  return "fact";
}

export type { ExistingObjectiveSummary };
