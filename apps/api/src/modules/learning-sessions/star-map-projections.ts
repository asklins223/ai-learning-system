/**
 * 阶段 07（W6）任务 07-6：理解星图两个数据平面与真实回写（§10）。
 *
 * 本文件是**两数据平面投影的纯逻辑层**（可单测，不依赖 DB，不写第二套真相）：
 *
 * - 平面一「共享知识真值」（§10.1，workspace-owned）：
 *   Source/Note/Card/Key Point/Evidence 与**确定性血缘**。唯一变化来源是
 *   canonical Publish 事件（节点发布/版本/fingerprint）与现有外键血缘
 *   （source←notes.sourceId、note←note_versions.noteId←cards.noteVersionId、
 *   card←card_key_points.cardId、key_point←evidences.keyPointId）。
 *   `replaySharedPlane` 是纯函数：相同 Publish 事件流 → 相同节点/边/hash。
 *   血缘边全部标记 provenance="foreign_key"，公测关系透镜只展示这类边
 *   （§10.2 关系透镜；§10.1 不把 relation hints 画成共享语义边）。
 *
 * - 平面二「个人学习事实及投影」（§10.1，user-private）：
 *   validation/review outcome、时间耐久、能力切面、assistance、问题标记与
 *   可隐藏航迹。唯一变化来源是现有 canonical 学习事实（validation/review/
 *   understanding outbox 事件）+ outbox/replay。`replayPersonalPlane` 是纯
 *   函数：相同事件流 → 相同耐久/切面/assistance/问题/航迹/hash。
 *
 * - 星图变化规则（§10.4）：
 *   浏览/打开/停留/收藏/朗读/看过答案**不能点亮理解**（evaluateReadOnlyInteraction
 *   恒为 0 变化）；只有 canonical validation/review outcome 改变时间耐久
 *   （reduceDurability 只消费这两类事件）；facet 变化必须能追到合格 assessment
 *   （每条 facet 观测绑定 rubricItemId + assessment 事件 hash）；practice 航迹
 *   默认只本轮 recap/短期历史，可由用户隐藏；不展示伪精确"掌握度"。
 *
 * - 四产品透镜数据视图（§10.2）：当前目标 / 证据 / 关系 / 问题；
 *   到期详情、能力切面、最近验证与 assistance cooldown 放节点详情，
 *   不各自成为全图透镜。
 *
 * - Canvas 改造原则（§10.6）：低缩放 LOD 按当前目标 / official priority /
 *   canonical gap / 重要性保留节点，不随机取样（selectLodNodes）。
 *
 * - 行动入口（§10.3）：选中 Card/Key Point 后可开始/继续航程、朗读、查看证据、
 *   召唤当前目标 Tutor、返回来源 Note/Card；Scene 连线只是 Episode Response
 *   Artifact，不会自动创建共享边（assertSceneConnectionDoesNotPublishEdge）。
 */

import { createHash } from "node:crypto";
import { CapabilityFacet } from "@ailearn/shared";
import { stableStringify } from "./canonical-events.ts";

// ─── 共享知识真值平面 ───────────────────────────────────────────────────────

export type SharedPlaneNodeType =
  | "source"
  | "note"
  | "card"
  | "key_point"
  | "evidence";

/** 确定性血缘边种类（全部由现有外键支持，非语义推断）。 */
export type SharedTruthEdgeKind =
  | "derived_from" // source → note（notes.source_id）
  | "generated_from" // note → card（cards.note_version_id → note_versions.note_id）
  | "contains" // card → key_point（card_key_points.card_id）
  | "supported_by"; // key_point → evidence（evidences.key_point_id）

/** 现有外键血缘（§10.1：唯一变化来源之一）。 */
export interface ForeignKeyLineage {
  /** 父实体类型（血缘边的 from 端） */
  parentType: SharedPlaneNodeType;
  /** 父实体 id */
  parentEntityId: string;
  /** 外键名（确定性溯源：notes.source_id / note_versions.note_id /
   *  card_key_points.card_id / evidences.key_point_id） */
  fkName: string;
}

/**
 * canonical Publish 事件（共享平面唯一变化来源，workspace-owned）。
 * 只携带 schema action、IDs、fingerprint、版本与官方优先级等安全摘要，
 * 不携带正文内容（防 payload 泄漏，与 canonical-events 白名单同原则）。
 */
export interface SharedPublishEvent {
  workspaceId: string;
  /** outbox/事件流 sequence（每 workspace 单调；重放顺序由此保证） */
  sequence: number;
  eventType: "shared.publish";
  nodeType: SharedPlaneNodeType;
  entityId: string;
  /** 确定性血缘 FK；根节点（无父）为 null */
  lineage: ForeignKeyLineage | null;
  /** content fingerprint（Publish 版本指纹；节点被重新发布时变化） */
  fingerprint: string;
  /** 版本号（单调递增） */
  version: number;
  /** official priority（0-1 或 null，供低缩放 LOD，来自 canonical 内容） */
  officialPriority: number | null;
  publishedAt: string;
}

/** 节点 id（`${nodeType}:${entityId}`） */
export function sharedNodeId(nodeType: SharedPlaneNodeType, entityId: string): string {
  return `${nodeType}:${entityId}`;
}

/** 共享平面节点投影状态。 */
export interface SharedTruthNodeState {
  nodeType: SharedPlaneNodeType;
  entityId: string;
  /** 已 publish（只有已发布节点进入正式星图节点集合） */
  published: boolean;
  version: number;
  fingerprint: string;
  officialPriority: number | null;
  lineage: ForeignKeyLineage | null;
  publishedAt: string | null;
}

/** 共享平面血缘边投影（确定性 FK 血缘）。 */
export interface SharedTruthEdgeState {
  id: string;
  from: string; // `${nodeType}:${entityId}`
  to: string;
  kind: SharedTruthEdgeKind;
  /** 外键名（溯源） */
  fkName: string;
  /** 恒为 "foreign_key"：这是 FK 血缘，不是语义关系 */
  provenance: "foreign_key";
}

export interface SharedTruthPlane {
  nodes: Record<string, SharedTruthNodeState>;
  edges: Record<string, SharedTruthEdgeState>;
  /** 重放 hash：sha256(nodes, edges, eventTrace) */
  hash: string;
}

function sha256Hex(data: string): string {
  return createHash("sha256").update(data, "utf8").digest("hex");
}

function publishEventFingerprint(event: SharedPublishEvent): string {
  return sha256Hex(
    stableStringify({
      workspaceId: event.workspaceId,
      eventType: event.eventType,
      nodeType: event.nodeType,
      entityId: event.entityId,
      lineage: event.lineage,
      fingerprint: event.fingerprint,
      version: event.version,
      officialPriority: event.officialPriority,
      publishedAt: event.publishedAt,
    }),
  );
}

/** 由 FK 血缘推导血缘边种类（纯函数）。 */
export function lineageToEdgeKind(lineage: ForeignKeyLineage): SharedTruthEdgeKind {
  switch (lineage.fkName) {
    case "notes.source_id":
      return "derived_from";
    case "note_versions.note_id":
      return "generated_from";
    case "card_key_points.card_id":
      return "contains";
    case "evidences.key_point_id":
      return "supported_by";
    default:
      throw new StarMapProjectionError(
        `未知血缘外键 ${lineage.fkName}，不允许构建共享边`,
        "unknown_lineage_fk",
      );
  }
}

/** 由父子节点类型推导血缘边种类（纯函数，防御校验）。 */
export function edgeKindFor(parent: SharedPlaneNodeType, child: SharedPlaneNodeType): SharedTruthEdgeKind {
  if (parent === "source" && child === "note") return "derived_from";
  if (parent === "note" && child === "card") return "generated_from";
  if (parent === "card" && child === "key_point") return "contains";
  if (parent === "key_point" && child === "evidence") return "supported_by";
  throw new StarMapProjectionError(
    `不支持的血缘方向 ${parent} → ${child}`,
    "invalid_lineage_direction",
  );
}

/**
 * 重放共享平面（纯函数）：相同 Publish 事件流（同顺序）→ 相同节点/边/hash。
 * 事件顺序由调用方保证（DB 按 sequence 返回），reducer 按传入顺序 fold。
 */
export function replaySharedPlane(events: readonly SharedPublishEvent[]): SharedTruthPlane {
  const nodes: Record<string, SharedTruthNodeState> = {};
  const edges: Record<string, SharedTruthEdgeState> = {};
  const eventTrace: string[] = [];
  for (const event of events) {
    eventTrace.push(publishEventFingerprint(event));
    const id = sharedNodeId(event.nodeType, event.entityId);
    const cur = nodes[id];
    if (cur && event.version <= cur.version) {
      // 非新版本：不降级（重放需严格同流；防御旧版本乱序写入）
      continue;
    }
    nodes[id] = {
      nodeType: event.nodeType,
      entityId: event.entityId,
      published: true,
      version: event.version,
      fingerprint: event.fingerprint,
      officialPriority: event.officialPriority ?? cur?.officialPriority ?? null,
      lineage: event.lineage,
      publishedAt: event.publishedAt,
    };
    if (event.lineage) {
      const from = sharedNodeId(event.lineage.parentType, event.lineage.parentEntityId);
      const to = id;
      const edgeId = `${event.lineage.fkName}:${from}->${to}`;
      edges[edgeId] = {
        id: edgeId,
        from,
        to,
        kind: lineageToEdgeKind(event.lineage),
        fkName: event.lineage.fkName,
        provenance: "foreign_key",
      };
    }
  }
  const hash = sha256Hex(stableStringify({ nodes, edges, eventTrace }));
  return { nodes, edges, hash };
}

// ─── 个人学习事实及投影 ─────────────────────────────────────────────────────

/** 个人平面事件类型：canonical 学习事实 + 个人专用事实（均为可重放事件）。 */
export type PersonalPlaneEventType =
  | "validation.event" // canonical：验证 outcome（唯一改变时间耐久的来源）
  | "review.attempt" // canonical：复习 outcome（唯一改变时间耐久的来源）
  | "understanding.event" // canonical：seen/misunderstood/reviewed 等接触事件（不点亮）
  | "practice.trail" // 个人：practice 航迹（默认只本轮 recap/短期历史）
  | "assistance.recorded" // 个人：assistance 记录（cooldown 数据）
  | "question.saved" // 个人：用户主动保存的探索标记（Should）
  | "trail.visibility"; // 个人：航迹可隐藏开关

/**
 * 个人平面可重放事件。payload 只存安全摘要（IDs、枚举码、计数、hash、时间），
 * 不存 raw 回答/问题原文（与 canonical-events 白名单同原则）。
 */
export interface PersonalPlaneEvent {
  workspaceId: string;
  userId: string;
  sequence: number;
  eventType: PersonalPlaneEventType;
  payload: Record<string, unknown>;
}

/** 个人事件确定性指纹（与 canonical-events.computeProjectionHash 同风格）。 */
export function computePersonalEventHash(
  event: Pick<PersonalPlaneEvent, "workspaceId" | "userId" | "eventType" | "payload">,
): string {
  return sha256Hex(
    stableStringify({
      workspaceId: event.workspaceId,
      userId: event.userId,
      eventType: event.eventType,
      payload: event.payload,
    }),
  );
}

// ─── 时间耐久（§10.4：只有 canonical validation/review outcome 改变）────────

export interface KeyPointDurabilityState {
  keyPointId: string;
  /** 是否有 canonical 验证/复习 outcome（只有它才 durable） */
  durable: boolean;
  outcome: string | null;
  confidence: number | null;
  validatedAt: string | null;
  reviewedAt: string | null;
  nextReviewAt: string | null;
  /** 触发本状态变化的最近 canonical 事件 hash（0 无事件点亮校验依据） */
  lastEventHash: string | null;
}

// ─── 能力切面（facet 变化必须能追到合格 assessment）────────────────────────

export interface FacetObservationSummary {
  /** rubric item id（opaque） */
  rubricItemId: string;
  /** 能力切面（v1 六个 facet，来自 rubric target） */
  facet: CapabilityFacet | null;
  keyPointId: string | null;
  /** 合格 assessment 观测次数（只来自 canonical validation facet summary） */
  assessmentCount: number;
  lastVerdict: string | null;
  lastConfidence: number | null;
  /** 追溯：最近合格 assessment 的 canonical 事件 hash（可追到 assessment） */
  lastAssessmentEventHash: string | null;
  rubricVersion: string | null;
}

// ─── assistance（节点详情：assistance cooldown）────────────────────────────

export interface AssistanceState {
  keyPointId: string;
  assistanceCount: number;
  lastAssistedAt: string | null;
  /** 最近 assistance 等级（none | content_assisted | practice_only） */
  lastAssistanceLevel: string | null;
  /** cooldown 截止时间（cooldown 计算属调用方策略，这里只投影原始数据） */
  cooldownUntil: string | null;
}

// ─── 问题标记（Should：用户主动保存的探索标记，user-private）──────────────

export type QuestionMarkerStatus = "open" | "archived" | "resolved";

export interface QuestionMarkerState {
  markerId: string;
  keyPointId: string | null;
  cardId: string | null;
  /** 摘要（用户主动保存的标记，只存安全摘要哈希；原文由调用方管理） */
  questionHash: string;
  savedAt: string;
  status: QuestionMarkerStatus;
  resolvedAt: string | null;
}

// ─── 可隐藏航迹（§10.4：practice 默认只本轮 recap/短期历史）────────────────

export interface TrailState {
  keyPointId: string;
  practiceCount: number;
  lastPracticeAt: string | null;
  /** 是否可见（默认当轮可见；用户可隐藏，user-private） */
  visible: boolean;
  hiddenAt: string | null;
}

export interface PersonalLearningPlane {
  durability: Record<string, KeyPointDurabilityState>;
  facets: Record<string, FacetObservationSummary>;
  assistance: Record<string, AssistanceState>;
  questions: Record<string, QuestionMarkerState>;
  trails: Record<string, TrailState>;
  /** 重放 hash：sha256(durability, facets, assistance, questions, trails, eventTrace) */
  hash: string;
}

function payloadStr(payload: Record<string, unknown>, key: string): string | null {
  const v = payload[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}

function payloadNum(payload: Record<string, unknown>, key: string): number | null {
  const v = payload[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** 从 validation/review/understanding 事件提取 key point id（纯函数）。 */
export function eventKeyPointId(event: PersonalPlaneEvent): string | null {
  if (event.eventType === "validation.event") {
    return payloadStr(event.payload, "keyPointId");
  }
  if (event.eventType === "review.attempt") {
    return payloadStr(event.payload, "keyPointId");
  }
  if (event.eventType === "understanding.event") {
    const direct = payloadStr(event.payload, "keyPointId");
    if (direct) return direct;
    return event.payload.subjectType === "keyPoint"
      ? payloadStr(event.payload, "subjectId")
      : null;
  }
  return payloadStr(event.payload, "keyPointId");
}

/**
 * 时间耐久 reducer（§10.4）：**只有 canonical validation/review outcome 改变
 * 时间耐久**。understanding.event（seen/misunderstood）与 practice trail /
 * assistance / question 一律不改变 durable 状态。
 */
export function reduceDurability(
  state: Record<string, KeyPointDurabilityState>,
  event: PersonalPlaneEvent,
): Record<string, KeyPointDurabilityState> {
  if (event.eventType !== "validation.event" && event.eventType !== "review.attempt") {
    return state;
  }
  const keyPointId = eventKeyPointId(event);
  if (!keyPointId) return state;
  const eventHash = computePersonalEventHash(event);
  const cur = state[keyPointId] ?? {
    keyPointId,
    durable: false,
    outcome: null,
    confidence: null,
    validatedAt: null,
    reviewedAt: null,
    nextReviewAt: null,
    lastEventHash: null,
  };
  const outcome = payloadStr(event.payload, "outcomeSummary") ?? payloadStr(event.payload, "outcome");
  const confidence = payloadNum(event.payload, "confidence");
  const occurredAt = payloadStr(event.payload, "occurredAt");
  const nextReviewAt = payloadStr(event.payload, "nextReviewAt");
  state[keyPointId] = {
    ...cur,
    durable: true,
    outcome: outcome ?? cur.outcome,
    confidence: confidence ?? cur.confidence,
    validatedAt:
      event.eventType === "validation.event"
        ? (occurredAt ?? cur.validatedAt)
        : cur.validatedAt,
    reviewedAt:
      event.eventType === "review.attempt"
        ? (occurredAt ?? cur.reviewedAt)
        : cur.reviewedAt,
    nextReviewAt: nextReviewAt ?? cur.nextReviewAt,
    lastEventHash: eventHash,
  };
  return state;
}

/** facet 摘要项解析（facetSummaries 安全摘要，与 canonical-events 同形状）。 */
export function parseFacetSummary(
  raw: unknown,
  eventHash: string,
): FacetObservationSummary | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const rubricItemId = record["rubricItemId"];
  const verdict = record["verdict"];
  const confidence = record["confidence"];
  if (typeof rubricItemId !== "string" || rubricItemId.length === 0) return null;
  if (typeof verdict !== "string" || typeof confidence !== "number") return null;
  const facet = record["facet"];
  return {
    rubricItemId,
    facet:
      typeof facet === "string" && isCapabilityFacet(facet)
        ? (facet as CapabilityFacet)
        : null,
    keyPointId: typeof record["keyPointId"] === "string" ? record["keyPointId"] : null,
    assessmentCount: 1,
    lastVerdict: verdict,
    lastConfidence: confidence,
    lastAssessmentEventHash: eventHash,
    rubricVersion:
      typeof record["rubricVersion"] === "string" ? record["rubricVersion"] : null,
  };
}

function isCapabilityFacet(value: string): boolean {
  return Object.values(CapabilityFacet).includes(value as CapabilityFacet);
}

/**
 * 能力切面 reducer：只消费 canonical validation.event 的 facetSummaries 安全
 * 摘要（合格 assessment 由事件本身是 canonical validation 保证），每条观测绑定
 * rubricItemId + 事件 hash → facet 变化可追到合格 assessment。
 */
export function reduceFacets(
  state: Record<string, FacetObservationSummary>,
  event: PersonalPlaneEvent,
): Record<string, FacetObservationSummary> {
  if (event.eventType !== "validation.event") return state;
  const summaries = event.payload.facetSummaries;
  if (!Array.isArray(summaries)) return state;
  const eventHash = computePersonalEventHash(event);
  for (const raw of summaries) {
    const parsed = parseFacetSummary(raw, eventHash);
    if (!parsed) continue;
    const cur = state[parsed.rubricItemId];
    state[parsed.rubricItemId] = {
      ...(cur ?? { ...parsed, assessmentCount: 0 }),
      facet: parsed.facet ?? cur?.facet ?? null,
      keyPointId: parsed.keyPointId ?? cur?.keyPointId ?? null,
      assessmentCount: (cur?.assessmentCount ?? 0) + 1,
      lastVerdict: parsed.lastVerdict,
      lastConfidence: parsed.lastConfidence,
      lastAssessmentEventHash: eventHash,
      rubricVersion: parsed.rubricVersion ?? cur?.rubricVersion ?? null,
    };
  }
  return state;
}

/** assistance reducer（user-private；cooldownUntil 由调用方 policy 填充）。 */
export function reduceAssistance(
  state: Record<string, AssistanceState>,
  event: PersonalPlaneEvent,
): Record<string, AssistanceState> {
  if (event.eventType !== "assistance.recorded") return state;
  const keyPointId = eventKeyPointId(event);
  if (!keyPointId) return state;
  const cur = state[keyPointId] ?? {
    keyPointId,
    assistanceCount: 0,
    lastAssistedAt: null,
    lastAssistanceLevel: null,
    cooldownUntil: null,
  };
  state[keyPointId] = {
    ...cur,
    assistanceCount: cur.assistanceCount + 1,
    lastAssistedAt: payloadStr(event.payload, "occurredAt") ?? cur.lastAssistedAt,
    lastAssistanceLevel:
      payloadStr(event.payload, "assistanceLevel") ?? cur.lastAssistanceLevel,
    cooldownUntil: payloadStr(event.payload, "cooldownUntil") ?? cur.cooldownUntil,
  };
  return state;
}

/** 问题标记 reducer（user-private；Should flag 开启时才有写路径）。 */
export function reduceQuestions(
  state: Record<string, QuestionMarkerState>,
  event: PersonalPlaneEvent,
): Record<string, QuestionMarkerState> {
  if (event.eventType !== "question.saved") return state;
  const markerId = payloadStr(event.payload, "markerId");
  if (!markerId) return state;
  const savedAt = payloadStr(event.payload, "occurredAt");
  state[markerId] = {
    markerId,
    keyPointId: payloadStr(event.payload, "keyPointId"),
    cardId: payloadStr(event.payload, "cardId"),
    questionHash: payloadStr(event.payload, "questionHash") ?? "",
    savedAt: savedAt ?? "",
    status: "open",
    resolvedAt: null,
  };
  return state;
}

/** 航迹 reducer（practice 默认只本轮 recap/短期历史；可隐藏）。 */
export function reduceTrails(
  state: Record<string, TrailState>,
  event: PersonalPlaneEvent,
): Record<string, TrailState> {
  if (event.eventType === "practice.trail") {
    const keyPointId = eventKeyPointId(event);
    if (!keyPointId) return state;
    const cur = state[keyPointId] ?? {
      keyPointId,
      practiceCount: 0,
      lastPracticeAt: null,
      visible: true,
      hiddenAt: null,
    };
    state[keyPointId] = {
      ...cur,
      practiceCount: cur.practiceCount + 1,
      lastPracticeAt: payloadStr(event.payload, "occurredAt") ?? cur.lastPracticeAt,
    };
    return state;
  }
  if (event.eventType === "trail.visibility") {
    const keyPointId = eventKeyPointId(event);
    if (!keyPointId) return state;
    const cur = state[keyPointId] ?? {
      keyPointId,
      practiceCount: 0,
      lastPracticeAt: null,
      visible: true,
      hiddenAt: null,
    };
    const visible = event.payload.visible === true;
    state[keyPointId] = {
      ...cur,
      visible,
      hiddenAt: visible ? null : (payloadStr(event.payload, "occurredAt") ?? cur.hiddenAt),
    };
    return state;
  }
  return state;
}

/**
 * 个人平面重放（纯函数）：相同事件流（同顺序）→ 相同耐久/切面/assistance/
 * 问题/航迹/hash。事件顺序由调用方保证；reducer 按传入顺序 fold。
 */
export function replayPersonalPlane(
  events: readonly PersonalPlaneEvent[],
): PersonalLearningPlane {
  let durability: Record<string, KeyPointDurabilityState> = {};
  let facets: Record<string, FacetObservationSummary> = {};
  let assistance: Record<string, AssistanceState> = {};
  let questions: Record<string, QuestionMarkerState> = {};
  let trails: Record<string, TrailState> = {};
  const eventTrace: string[] = [];
  for (const event of events) {
    durability = reduceDurability({ ...durability }, event);
    facets = reduceFacets({ ...facets }, event);
    assistance = reduceAssistance({ ...assistance }, event);
    questions = reduceQuestions({ ...questions }, event);
    trails = reduceTrails({ ...trails }, event);
    eventTrace.push(computePersonalEventHash(event));
  }
  const hash = sha256Hex(
    stableStringify({ durability, facets, assistance, questions, trails, eventTrace }),
  );
  return { durability, facets, assistance, questions, trails, hash };
}

// ─── 只读 0 点亮规则（§10.4）───────────────────────────────────────────────

/** 只读交互：浏览/打开/停留/收藏/朗读/看过答案。 */
export type ReadOnlyInteraction =
  | "view"
  | "open"
  | "dwell"
  | "favorite"
  | "read_aloud"
  | "saw_answer";

export interface ReadOnlyInteractionVerdict {
  /** 恒为 false：只读交互绝不点亮理解 */
  lightsUpUnderstanding: false;
  /** 恒为 false：只读交互绝不改变任何投影状态 */
  changesProjection: false;
  reasonCode: string;
}

/**
 * 只读 0 点亮规则（纯函数）：浏览/打开/停留/收藏/朗读/看过答案均不能点亮
 * 理解，也绝不改变任何投影状态。调用方只应把此类动作记 exposure（02-8），
 * 绝不能喂给个人平面 reducer。
 */
export function evaluateReadOnlyInteraction(
  action: ReadOnlyInteraction,
): ReadOnlyInteractionVerdict {
  return {
    lightsUpUnderstanding: false,
    changesProjection: false,
    reasonCode: `read_only_${action}_zero_light_up`,
  };
}

/** 只读交互是否属于会写 projection 的事件（恒 false，防御性校验）。 */
export function isProjectionWritingInteraction(action: ReadOnlyInteraction): boolean {
  return evaluateReadOnlyInteraction(action).changesProjection;
}

export interface ZeroEventLightUpCheckInput {
  /** 重放后耐久投影 */
  durability: Record<string, KeyPointDurabilityState>;
  /** 用于校验的事件流（应与重放输入一致） */
  events: readonly PersonalPlaneEvent[];
}

export interface ZeroEventLightUpCheckResult {
  /** true = 所有 durable 节点都有对应 canonical validation/review 事件 */
  valid: boolean;
  /** 违反项：durable 但事件流中无 canonical outcome 事件的节点 */
  violations: string[];
}

/**
 * 「0 无事件点亮」验收（纯函数）：任何 durable 节点必须能追溯到一个 canonical
 * validation.event / review.attempt 事件（含 outcome）。无事件 → 无点亮。
 */
export function assertZeroEventLightUp(
  input: ZeroEventLightUpCheckInput,
): ZeroEventLightUpCheckResult {
  const canonicalKeyPoints = new Set<string>();
  for (const event of input.events) {
    if (event.eventType === "validation.event" || event.eventType === "review.attempt") {
      const kp = eventKeyPointId(event);
      if (kp) canonicalKeyPoints.add(kp);
    }
  }
  const violations: string[] = [];
  for (const [keyPointId, state] of Object.entries(input.durability)) {
    if (state.durable && !canonicalKeyPoints.has(keyPointId)) {
      violations.push(keyPointId);
    }
  }
  return { valid: violations.length === 0, violations };
}

// ─── 两平面组装视图 ─────────────────────────────────────────────────────────

export interface TwoPlaneStarMapView {
  shared: SharedTruthPlane;
  personal: PersonalLearningPlane;
  /** 共享/个人两平面分离标记（验收：两平面分离） */
  planes: { shared: "workspace_owned"; personal: "user_private" };
  /** 组合 hash（确定性） */
  hash: string;
}

/** 组装两平面视图（纯函数）。 */
export function buildTwoPlaneView(
  shared: SharedTruthPlane,
  personal: PersonalLearningPlane,
): TwoPlaneStarMapView {
  return {
    shared,
    personal,
    planes: { shared: "workspace_owned", personal: "user_private" },
    hash: sha256Hex(stableStringify({ shared: shared.hash, personal: personal.hash })),
  };
}

// ─── 四产品透镜（§10.2）─────────────────────────────────────────────────────

export type StarMapLens = "current_target" | "evidence" | "relation" | "question";

/** 当前目标透镜：Key Point + 建议路线（official scheduler 派生）。 */
export interface CurrentTargetLensView {
  lens: "current_target";
  keyPointId: string;
  cardId: string;
  /** 同 Card 的其它 Key Point（供建议路线上下文） */
  siblingKeyPointIds: string[];
  suggestedRoute: {
    keyPointId: string;
    /** 路线优先级来源（official scheduling decision） */
    prioritySource: string | null;
    nextReviewAt: string | null;
    /** silent mastery route 是否 eligible（SilentProofProfile eligibility） */
    routeEligible: boolean;
    routeReasonCode: string;
  } | null;
}

/** 证据透镜：来源/exact evidence/semantic support/版本。 */
export interface EvidenceLensItem {
  evidenceId: string;
  keyPointId: string;
  sourceId: string;
  noteId: string | null;
  /** exact evidence 摘要 hash（引用完整） */
  exactQuoteHash: string;
  /** 是否 exact evidence（引用完整 ≠ 语义支撑通过） */
  exactQuote: boolean;
  /** semantic support 报告 id + hash（独立 Grounded Answer Critic 产物） */
  semanticSupportReportId: string | null;
  semanticSupportReportHash: string | null;
  /** 证据版本（fingerprint） */
  version: string;
}

export interface EvidenceLensView {
  lens: "evidence";
  keyPointId: string;
  evidences: EvidenceLensItem[];
}

/**
 * 关系透镜（§10.2/§10.1 公测 Must）：只展示**确定性血缘**（FK provenance）。
 * relation candidate / relation hints 一律不画成共享语义边；仅在 Should flag
 * 开启时以虚线 candidate 形式可见，且不进入 formal target。
 */
export interface RelationLensView {
  lens: "relation";
  /** 确定性血缘边（FK provenance 过滤后） */
  lineageEdges: SharedTruthEdgeState[];
  /** 公测 Must：relation hints 不画成共享语义边（恒 true） */
  sharedSemanticEdgesHidden: true;
  /** 虚线 candidate（仅 Should flag 开启时非空） */
  dashedCandidates: readonly { candidateId: string; from: string; to: string; kind: string }[];
}

/** 问题透镜（Should：用户主动保存的探索标记）。 */
export interface QuestionLensView {
  lens: "question";
  enabled: boolean;
  markers: QuestionMarkerState[];
}

export interface BuildLensesInput {
  shared: SharedTruthPlane;
  personal: PersonalLearningPlane;
  /** 当前目标 Key Point（未选为 null） */
  currentTargetKeyPointId: string | null;
  /** 当前目标所在 Card（Key Point → Card 血缘反查） */
  currentTargetCardId: string | null;
  /** 建议路线（来自 official scheduler / pending schedule 派生） */
  suggestedRoute: CurrentTargetLensView["suggestedRoute"];
  /** 证据透镜输入（调用方从权威表读取 exact evidence + semantic support） */
  evidences: EvidenceLensItem[];
  /** 问题透镜 Should flag */
  questionLensEnabled: boolean;
  /** 关系治理 Should flag（关闭 → dashedCandidates 恒空） */
  relationGovernanceEnabled: boolean;
  /** 可见的虚线 candidate（仅 Should flag 开启时由调用方传入） */
  dashedCandidates: RelationLensView["dashedCandidates"];
}

/** 组装四透镜视图（纯函数；关系透镜强制 FK-only）。 */
export function buildFourLensViews(input: BuildLensesInput): {
  currentTarget: CurrentTargetLensView | null;
  evidence: EvidenceLensView;
  relation: RelationLensView;
  question: QuestionLensView;
} {
  // 当前目标透镜
  let currentTarget: CurrentTargetLensView | null = null;
  if (input.currentTargetKeyPointId) {
    const siblingKeyPointIds = Object.values(input.shared.nodes)
      .filter(
        (node) =>
          node.nodeType === "key_point" &&
          node.published &&
          node.lineage?.parentEntityId === input.currentTargetCardId &&
          node.entityId !== input.currentTargetKeyPointId,
      )
      .map((node) => node.entityId)
      .sort();
    currentTarget = {
      lens: "current_target",
      keyPointId: input.currentTargetKeyPointId,
      cardId: input.currentTargetCardId ?? "",
      siblingKeyPointIds,
      suggestedRoute: input.suggestedRoute,
    };
  }

  // 证据透镜（调用方提供精确证据列表）
  const evidence: EvidenceLensView = {
    lens: "evidence",
    keyPointId: input.currentTargetKeyPointId ?? "",
    evidences: input.evidences,
  };

  // 关系透镜：强制 FK provenance 过滤（公测 Must）
  const lineageEdges = Object.values(input.shared.edges).filter(
    (edge) => edge.provenance === "foreign_key",
  );
  const relation: RelationLensView = {
    lens: "relation",
    lineageEdges,
    sharedSemanticEdgesHidden: true,
    dashedCandidates: input.relationGovernanceEnabled
      ? input.dashedCandidates
      : [],
  };

  // 问题透镜（Should）
  const question: QuestionLensView = {
    lens: "question",
    enabled: input.questionLensEnabled,
    markers: input.questionLensEnabled ? Object.values(input.personal.questions) : [],
  };

  return { currentTarget, evidence, relation, question };
}

// ─── 节点详情（到期/能力切面/最近验证/assistance cooldown）─────────────────

export interface StarMapNodeDetail {
  nodeType: SharedPlaneNodeType;
  entityId: string;
  /** 到期详情（来自 official schedule） */
  dueReview: { due: boolean; nextReviewAt: string | null } | null;
  /** 能力切面（可追到合格 assessment） */
  facets: FacetObservationSummary[];
  /** 最近验证 */
  recentValidation: { at: string | null; outcome: string | null } | null;
  /** assistance cooldown（节点详情，不单独成透镜） */
  assistance: AssistanceState | null;
  /** 只读接触计数（理解不点亮，仅 exposure 展示） */
  exposure: { viewedCount: number; lastViewedAt: string | null } | null;
}

export interface BuildNodeDetailInput {
  nodeType: SharedPlaneNodeType;
  entityId: string;
  personal: PersonalLearningPlane;
  /** 到期详情（official schedule 派生；null = 无 schedule 信息） */
  dueReview: { due: boolean; nextReviewAt: string | null } | null;
  /** 只读 exposure 摘要（调用方从 exposure 表读；不影响投影） */
  exposure: { viewedCount: number; lastViewedAt: string | null } | null;
}

/**
 * 构建节点详情（纯函数）：到期详情、能力切面、最近验证与 assistance cooldown
 * 都放节点详情，不各自成为全图透镜（§10.2）。
 */
export function buildNodeDetail(input: BuildNodeDetailInput): StarMapNodeDetail {
  const facets = Object.values(input.personal.facets)
    .filter((f) => f.keyPointId === input.entityId)
    .sort((a, b) => a.rubricItemId.localeCompare(b.rubricItemId));
  const durability = input.personal.durability[input.entityId];
  const assistance = input.personal.assistance[input.entityId] ?? null;
  return {
    nodeType: input.nodeType,
    entityId: input.entityId,
    dueReview: input.dueReview,
    facets,
    recentValidation: durability
      ? {
          at: durability.validatedAt ?? durability.reviewedAt,
          outcome: durability.outcome,
        }
      : null,
    assistance,
    exposure: input.exposure,
  };
}

// ─── 低缩放 LOD（§10.6：保留目标/priority/gap/重要性，不随机取样）──────────

export interface LodNodeScore {
  nodeId: string;
  /** 聚合保留分（当前目标 + priority + gap + 重要性） */
  score: number;
  reasonCodes: string[];
}

export interface SelectLodNodesInput {
  currentTargetKeyPointId: string | null;
  /** 当前目标所在 Card / 建议路线上的 Key Point（锚定保留） */
  targetEntityIds: ReadonlySet<string>;
  nodes: readonly SharedTruthNodeState[];
  /** official priority（0-1；缺失为 0） */
  officialPriority: (entityId: string) => number;
  /** canonical gap 指示（如缺正式验证/证据缺口） */
  canonicalGap: (entityId: string) => boolean;
  /** 重要性（0-1） */
  importance: (entityId: string) => number;
  targetNodeCount: number;
}

/**
 * 低缩放 LOD 选择（§10.6）：按当前目标锚定 + official priority + canonical gap
 * + 重要性排序保留，**不做随机取样**。确定性纯函数：相同输入 → 相同节点集。
 */
export function selectLodNodes(input: SelectLodNodesInput): {
  selected: string[];
  scores: LodNodeScore[];
} {
  const scored: LodNodeScore[] = input.nodes
    .filter((node) => node.published)
    .map((node) => {
      const nodeId = sharedNodeId(node.nodeType, node.entityId);
      const reasonCodes: string[] = [];
      let score = 0;
      if (input.currentTargetKeyPointId === node.entityId) {
        score += 4;
        reasonCodes.push("current_target");
      }
      if (input.targetEntityIds.has(node.entityId)) {
        score += 3;
        reasonCodes.push("suggested_route");
      }
      const priority = node.officialPriority ?? input.officialPriority(node.entityId);
      if (priority > 0) {
        // §10.6 保留顺序：当前目标 > official priority > canonical gap > 重要性
        score += 3 * Math.max(0, Math.min(1, priority));
        reasonCodes.push(`official_priority:${priority.toFixed(3)}`);
      }
      if (input.canonicalGap(node.entityId)) {
        score += 1.5;
        reasonCodes.push("canonical_gap");
      }
      const importance = input.importance(node.entityId);
      if (importance > 0) {
        score += 1 * Math.max(0, Math.min(1, importance));
        reasonCodes.push(`importance:${importance.toFixed(3)}`);
      }
      return { nodeId, score, reasonCodes };
    });
  scored.sort((a, b) => b.score - a.score || a.nodeId.localeCompare(b.nodeId));
  const count = Math.max(1, Math.min(input.targetNodeCount, scored.length));
  return { selected: scored.slice(0, count).map((s) => s.nodeId), scores: scored };
}

// ─── 行动入口（§10.3）与 Scene 连线边界（§10.3/§10.1）──────────────────────

/** 选中节点后可用的星图行动。 */
export type StarMapAction =
  | "start_or_continue_journey" // 开始/继续一小段航程（Card/Key Point）
  | "read_aloud" // 朗读
  | "view_evidence" // 查看证据
  | "invoke_current_target_tutor" // 召唤当前目标 Tutor
  | "back_to_source" // 返回来源 Note/Card
  | "mark_question" // 保存问题标记（Should 开启时可见）
  | "propose_relation"; // 提议关系 candidate（Should 开启时可见；虚线）

export interface PlanNodeActionsInput {
  nodeType: SharedPlaneNodeType;
  /** Should flag：问题标记 */
  questionLensEnabled: boolean;
  /** Should flag：关系治理 */
  relationGovernanceEnabled: boolean;
}

export interface PlanNodeActionsResult {
  actions: StarMapAction[];
  /** 公测 Must：不宣称具备"关系理解"正式状态 */
  relationUnderstandingClaimed: false;
}

/**
 * 星图行动入口（§10.3，纯函数）：选中 Card/Key Point 后可开始/继续航程、
 * 朗读、查看证据、召唤当前目标 Tutor、返回来源；Source/Note 提供查看/朗读/
 * 返回入口。问题标记与关系提议只在 Should flag 开启时可见。
 */
export function planNodeActions(input: PlanNodeActionsInput): PlanNodeActionsResult {
  const actions: StarMapAction[] = [];
  switch (input.nodeType) {
    case "card":
    case "key_point":
      actions.push("start_or_continue_journey", "read_aloud", "view_evidence");
      if (input.nodeType === "key_point") {
        actions.push("invoke_current_target_tutor");
      }
      actions.push("back_to_source");
      break;
    case "note":
    case "source":
      actions.push("read_aloud", "view_evidence", "back_to_source");
      break;
    case "evidence":
      actions.push("view_evidence", "back_to_source");
      break;
  }
  if (input.questionLensEnabled) actions.push("mark_question");
  if (input.relationGovernanceEnabled) actions.push("propose_relation");
  return { actions, relationUnderstandingClaimed: false };
}

export interface SceneConnectionCheckInput {
  /** Scene 内连线（当前 Episode Response Artifact） */
  sceneConnection: { from: string; to: string };
  /** 是否试图自动创建共享边（未经验证路径发布） */
  autoPublishSharedEdge: boolean;
}

export interface SceneConnectionVerdict {
  /** Scene 连线只是 Episode Response Artifact：恒不允许自动创建共享边 */
  autoPublishSharedEdge: false;
  /** 合法去向：仅可提议为 relation candidate（虚线，走 Governance）或丢弃 */
  disposal: "candidate_proposal_only" | "discard";
  reasonCode: string;
}

/**
 * Scene 连线边界（§10.3/§10.1）：Scene 内的连线只是当前 Episode 的 Response
 * Artifact，**不会自动创建共享边**。唯一去向是丢弃，或在 Should flag 开启时
 * 提议为 relation candidate（虚线，必须走完整 Relationship Governance）。
 */
export function assertSceneConnectionDoesNotPublishEdge(
  input: SceneConnectionCheckInput,
): SceneConnectionVerdict {
  if (input.autoPublishSharedEdge) {
    throw new StarMapProjectionError(
      "Scene 连线禁止自动创建共享边",
      "scene_edge_auto_publish_denied",
    );
  }
  return {
    autoPublishSharedEdge: false,
    disposal: "candidate_proposal_only",
    reasonCode: "scene_edge_is_episode_artifact_candidate_proposal_only",
  };
}

// ─── 错误 ───────────────────────────────────────────────────────────────────

export class StarMapProjectionError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "StarMapProjectionError";
    this.code = code;
  }
}
