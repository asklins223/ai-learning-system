/**
 * Card Generation V2 — Frontend API Client（方案 20 §17）。
 *
 * 封装所有 V2 端点的 fetch 调用，提供类型安全的请求/响应接口。
 * SSE 事件流使用 EventSource API。
 *
 * 为满足行为级测试（R7 §D）与生产接入，本模块以 `createV2Client(fetchFn)`
 * 工厂导出每个端点：`fetchFn` 可注入以便在不翻建网络栈的情况下 mock。
 * 文件底部导出的单函数名（createRun/getRun/…）是默认实例的委托，兼容既有
 * 消费者。所有 mutation 端点要求调用方提供 `X-Idempotency-Key`（服务端
 * 缺失时返回 400）。
 */

import type {
  CreateCardGenerationRunRequestV2,
  CardPlanV2,
  CandidateActionCommandV2,
  RevealCandidateRequestV2,
  CandidateRevealV2,
  ActivateCardCandidatesRequestV2,
  CardActivationReceiptV2,
} from "@ailearn/shared";
import type {
  PublicLearningCardV2,
  LearningCardRevealV2,
  RevealCardRequestV2,
  ArchiveCardRequestV2,
  InitialValidationReminderV2,
} from "@ailearn/shared";

/** V2 服务不可用（flag 未开 / 路由未注册 → 404/503）时的回退信号。 */
export function isV2UnavailableError(error: unknown): boolean {
  if (error instanceof V2ApiError) {
    return error.statusCode === 404 || error.statusCode === 503;
  }
  return false;
}

const BASE = "/api/v2";

/** Run 创建响应 */
export interface CreateRunResponse {
  runId: string;
  status: string;
}

/** Run 公共视图（serializeRunPublic 返回的 JSON） */
export interface RunPublicView {
  runId: string;
  noteId: string;
  noteVersionId: string;
  status: string;
  cardContentEpoch: number;
  semanticSpecHash: string;
  inputSnapshotHash: string;
  generationFingerprint: string;
  currentPlanVersion: number;
  reviewDraftRevision: number;
  sourceOutdated: boolean;
  error: { code: string; message: string } | null;
  createdAt: string;
  updatedAt: string;
}

/** 候选公共视图 */
export interface CandidatePublicView {
  candidateId: string;
  candidateRevisionId: string;
  revision: number;
  runId: string;
  planRevisionId: string;
  planVersion: number;
  planObjectiveLocalId: string;
  recommendation: { recommended: boolean; reasonCodes: string[] };
  objective: {
    statement: string;
    publicSummary: string;
    knowledgeForm: string;
  };
  front: { cue: string; context?: string; prompt: string };
  strategy: string;
  transformationKind: string;
  estimatedReviewSeconds: number;
  evidenceSetHash: string;
  candidateRevisionHash: string;
  /** 服务端激活闭包字段（当前 API 未下发时为 undefined，激活即被测到缺失）。 */
  candidateEvidenceBindingPlanHash?: string;
  qualityReportHashes?: string[];
  qualityState: string;
  reviewDecision: string;
  publishState: string;
  isReviewReady: boolean;
}

/** 候选审核操作响应 */
export interface CandidateActionResponse {
  runId: string;
  candidateId: string;
  candidateRevisionId: string;
  revision: number;
  candidateRevisionHash: string;
  qualityState: string;
  reviewDecision: string;
  publishState: string;
  reviewDraftRevision: number;
}

/** 生成事件 */
export interface GenerationEvent {
  eventSeq: number;
  eventType: string;
  payload: unknown;
  createdAt: string;
}

/** Public Card 读取响应（适配 /v2/cards/:cardId） */
export type PublicCardReadResponse = PublicLearningCardV2;

/** Reminder 列表响应 */
export interface ReminderListResponse {
  reminders: InitialValidationReminderV2[];
}

/** 申请一个稳定的客户端幂等键（服务端只校验存在，不要求特定格式）。 */
export function newV2IdempotencyKey(prefix: string): string {
  return `${prefix}-${globalThis.crypto.randomUUID()}`;
}

export interface V2Client {
  // ── Run 管理 ──
  createRun(
    body: CreateCardGenerationRunRequestV2,
    idempotencyKey: string,
  ): Promise<CreateRunResponse>;
  getRun(runId: string): Promise<RunPublicView>;
  getRunPlan(runId: string): Promise<CardPlanV2 | null>;
  getRunCandidates(runId: string): Promise<{ candidates: CandidatePublicView[] }>;
  cancelRun(runId: string): Promise<{ runId: string; status: string }>;
  closeRun(
    runId: string,
    expectedReviewDraftRevision: number,
  ): Promise<{ runId: string; status: string }>;

  // ── 候选动作 ──
  candidateAction(
    runId: string,
    command: CandidateActionCommandV2,
    idempotencyKey: string,
  ): Promise<CandidateActionResponse>;

  // ── Reveal ──
  revealCandidate(
    runId: string,
    candidateId: string,
    body: RevealCandidateRequestV2,
    idempotencyKey: string,
  ): Promise<CandidateRevealV2>;

  // ── Activate ──
  activateCandidates(
    runId: string,
    body: ActivateCardCandidatesRequestV2,
    idempotencyKey: string,
  ): Promise<CardActivationReceiptV2>;

  // ── §17.6 Card / Reminder ──
  listCardsV2(): Promise<{ items: PublicLearningCardV2[] }>;
  readPublicCard(cardId: string): Promise<PublicCardReadResponse>;
  revealCardV2(
    body: RevealCardRequestV2,
    idempotencyKey: string,
  ): Promise<LearningCardRevealV2>;
  archiveCardV2(
    body: ArchiveCardRequestV2,
    idempotencyKey: string,
  ): Promise<{ cardId: string; lifecycle: string }>;
  regenerateCardV2(
    cardId: string,
    idempotencyKey: string,
  ): Promise<{ runId: string; status: string }>;
  updateCardPresentationV2(
    cardId: string,
    body: {
      expectedPublicationRevision: number;
      expectedPublicPayloadHash: string;
      patch: {
        front?: { cue?: string; context?: string; prompt: string };
        strategy?: string;
      };
    },
    idempotencyKey: string,
  ): Promise<{ cardId: string; cardRevision: number; publicationRevision: number; publicPayloadHash: string }>;
  listReadyReminders(): Promise<ReminderListResponse>;
  cancelReminder(reminderId: string): Promise<{ reminderId: string; status: string }>;

  // ── SSE ──
  createRunEventStream(
    runId: string,
    onEvent: (event: GenerationEvent) => void,
    onError?: () => void,
  ): { close: () => void };
}

export function createV2Client(fetchFn?: typeof fetch): V2Client {
  const doFetch: typeof fetch =
    fetchFn ?? ((input, init) => fetch(input, init));

  async function postJson<T>(
    path: string,
    body: unknown,
    idempotencyKey?: string,
  ): Promise<T> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (idempotencyKey) headers["x-idempotency-key"] = idempotencyKey;
    const res = await doFetch(`${BASE}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      credentials: "same-origin",
    });
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      throw new V2ApiError(
        String(err.error ?? "unknown"),
        String(err.message ?? `HTTP ${res.status}`),
        res.status,
      );
    }
    return res.json() as Promise<T>;
  }

  async function getJson<T>(path: string): Promise<T> {
    const res = await doFetch(`${BASE}${path}`, {
      method: "GET",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
    });
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      throw new V2ApiError(
        String(err.error ?? "unknown"),
        String(err.message ?? `HTTP ${res.status}`),
        res.status,
      );
    }
    return res.json() as Promise<T>;
  }

  return {
    // ─── Run 管理 ──────────────────────────────────────────────────────
    createRun: (body, idempotencyKey) =>
      postJson<CreateRunResponse>("/card-generation-runs", body, idempotencyKey),
    getRun: (runId) => getJson<RunPublicView>(`/card-generation-runs/${runId}`),
    getRunPlan: (runId) =>
      getJson<CardPlanV2 | null>(`/card-generation-runs/${runId}/plan`),
    getRunCandidates: (runId) =>
      getJson<{ candidates: CandidatePublicView[] }>(
        `/card-generation-runs/${runId}/candidates`,
      ),
    cancelRun: (runId) => postJson(`/card-generation-runs/${runId}/cancel`, {}),
    closeRun: (runId, expectedReviewDraftRevision) =>
      postJson(`/card-generation-runs/${runId}/close`, {
        expectedReviewDraftRevision,
      }),

    // ─── 候选动作 ───────────────────────────────────────────────────────
    candidateAction: (runId, command, idempotencyKey) =>
      postJson<CandidateActionResponse>(
        `/card-generation-runs/${runId}/candidate-actions`,
        command,
        idempotencyKey,
      ),

    // ─── Reveal ─────────────────────────────────────────────────────────
    revealCandidate: (runId, candidateId, body, idempotencyKey) =>
      postJson<CandidateRevealV2>(
        `/card-generation-runs/${runId}/candidates/${candidateId}/reveal`,
        body,
        idempotencyKey,
      ),

    // ─── Activate ─────────────────────────────────────────────────────
    activateCandidates: (runId, body, idempotencyKey) =>
      postJson<CardActivationReceiptV2>(
        `/card-generation-runs/${runId}/activate`,
        body,
        idempotencyKey,
      ),

    // ─── §17.6 Card / Reminder ─────────────────────────────────────────
    listCardsV2: () => getJson<{ items: PublicLearningCardV2[] }>(`/cards`),
    readPublicCard: (cardId) => getJson<PublicCardReadResponse>(`/cards/${cardId}`),
    revealCardV2: (body, idempotencyKey) =>
      postJson<LearningCardRevealV2>(
        `/cards/${body.cardId}/reveal`,
        body,
        idempotencyKey,
      ),
    archiveCardV2: (body, idempotencyKey) =>
      postJson<{ cardId: string; lifecycle: string }>(
        `/cards/${body.cardId}/archive`,
        body,
        idempotencyKey,
      ),
    regenerateCardV2: (cardId, idempotencyKey) =>
      postJson<{ runId: string; status: string }>(
        `/cards/${cardId}/regeneration-runs`,
        {},
        idempotencyKey,
      ),
    updateCardPresentationV2: (cardId, body, idempotencyKey) =>
      postJson<{ cardId: string; cardRevision: number; publicationRevision: number; publicPayloadHash: string }>(
        `/cards/${cardId}/revisions`,
        body,
        idempotencyKey,
      ),
    listReadyReminders: () =>
      getJson<ReminderListResponse>(`/initial-validation-reminders?status=ready`),
    cancelReminder: (reminderId) =>
      postJson<{ reminderId: string; status: string }>(
        `/initial-validation-reminders/${reminderId}/cancel`,
        {},
      ),

    // ─── SSE ──────────────────────────────────────────────────────────
    createRunEventStream: (runId, onEvent, onError) => {
      const url = `${BASE}/card-generation-runs/${runId}/events/stream`;
      // eslint-disable-next-line no-undef
      const es = new EventSource(url, { withCredentials: true });

      es.onmessage = (ev) => {
        try {
          const data = JSON.parse(ev.data) as GenerationEvent;
          onEvent(data);
        } catch {
          // ignore parse errors
        }
      };

      es.onerror = () => {
        if (onError) onError();
        es.close();
      };

      return { close: () => es.close() };
    },
  };
}

export class V2ApiError extends Error {
  readonly code: string;
  readonly statusCode: number;
  constructor(code: string, message: string, statusCode: number) {
    super(message);
    this.name = "V2ApiError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

// ─── 默认单例客户端（保持既有函数签名兼容）────────────────────────────
const defaultClient: V2Client = createV2Client();

export async function createRun(
  body: CreateCardGenerationRunRequestV2,
  idempotencyKey: string,
): Promise<CreateRunResponse> {
  return defaultClient.createRun(body, idempotencyKey);
}

export async function getRun(runId: string): Promise<RunPublicView> {
  return defaultClient.getRun(runId);
}

export async function getRunPlan(runId: string): Promise<CardPlanV2 | null> {
  return defaultClient.getRunPlan(runId);
}

export async function getRunCandidates(
  runId: string,
): Promise<{ candidates: CandidatePublicView[] }> {
  return defaultClient.getRunCandidates(runId);
}

export async function cancelRun(runId: string): Promise<{ runId: string; status: string }> {
  return defaultClient.cancelRun(runId);
}

export async function closeRun(
  runId: string,
  expectedReviewDraftRevision: number,
): Promise<{ runId: string; status: string }> {
  return defaultClient.closeRun(runId, expectedReviewDraftRevision);
}

export async function candidateAction(
  runId: string,
  command: CandidateActionCommandV2,
  idempotencyKey: string,
): Promise<CandidateActionResponse> {
  return defaultClient.candidateAction(runId, command, idempotencyKey);
}

export async function revealCandidate(
  runId: string,
  candidateId: string,
  body: RevealCandidateRequestV2,
  idempotencyKey: string,
): Promise<CandidateRevealV2> {
  return defaultClient.revealCandidate(runId, candidateId, body, idempotencyKey);
}

export async function activateCandidates(
  runId: string,
  body: ActivateCardCandidatesRequestV2,
  idempotencyKey: string,
): Promise<CardActivationReceiptV2> {
  return defaultClient.activateCandidates(runId, body, idempotencyKey);
}

export function createRunEventStream(
  runId: string,
  onEvent: (event: GenerationEvent) => void,
  onError?: () => void,
): { close: () => void } {
  return defaultClient.createRunEventStream(runId, onEvent, onError);
}
