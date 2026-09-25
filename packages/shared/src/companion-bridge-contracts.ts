/**
 * Main ↔ Pet Context / Event / Command Bridge V2 合同（冻结：文档 16 §14）。
 *
 * 设计原则（§14.1）：Electron main process 是 Main Window 与 Pet Window 的
 * 唯一 broker；两个 renderer 仅获得窄、强类型 preload API。四条通道严格分离：
 * 1. UI Context/Event：Main renderer → broker → Pet（短生命周期）；
 * 2. Domain Event：业务事务 outbox → Orchestrator（不经过 renderer）；
 * 3. Assistant Command：Pet → Orchestrator / Tool Gateway；
 * 4. Assistant Delivery：Orchestrator → durable inbox/SSE → Pet。
 *
 * 服务端语义（§14.2）：renderer 提交的 context 只含 pageKind/routeRef/entityRefs/
 * interactionState/graph 与 capability hints；account/device/workspace/user/
 * pageInstance 由 broker 覆盖，revision 为 canonical hash；服务端把它视为
 * 不可信提示，校验 authenticated user/workspace、lease 与 RLS 后重新 hydration。
 */

import { z } from "zod";
import type { DesktopRouteV1 } from "./desktop-ipc-contracts.ts";
import { understandingLensSchema, projectionCheckpointSchema } from "./learning-run-contracts.ts";

// ─── §14.2 Entity、Route 与 Context 合同 ─────────────────────────────────

export type EntityRefV2 =
  | { kind: "source"; sourceId: string }
  | { kind: "note"; noteId: string }
  | { kind: "card"; cardId: string }
  | { kind: "key_point"; keyPointId: string }
  | { kind: "evidence"; evidenceId: string }
  | { kind: "review_schedule"; scheduleId: string }
  | { kind: "learning_run"; runId: string }
  | { kind: "learning_task"; runId: string; taskId: string }
  | { kind: "companion_journey"; journeyId: string }
  | { kind: "assistant_session"; assistantSessionId: string }
  | { kind: "route_plan"; routePlanId: string }
  | { kind: "change_set"; changeSetId: string };

/**
 * 设置页真实存在的六个分区 id（与设置表面左侧目录同一份，不是另一套说法）。
 * 伴星说得出哪个分区，就得真的落进那个分区。
 */
export const SETTINGS_SECTION_IDS_V2 = [
  "account",
  "members",
  "appearance",
  "companion",
  "data",
  "management",
] as const;
export type SettingsSectionIdV2 = (typeof SETTINGS_SECTION_IDS_V2)[number];

export type AllowedMainRouteV2 =
  | { kind: "home" }
  | { kind: "today" }
  | { kind: "source"; sourceId?: string }
  | { kind: "note"; noteId: string }
  | { kind: "note_library" }
  | { kind: "card"; cardId: string; objectiveId: string }
  | { kind: "objective_library" }
  | { kind: "review"; scheduleId?: string }
  | { kind: "search" }
  // 方案 16 §18.1：focus_graph_node（lens）与 restore_graph_viewport
  // （restoreRun）复用 star_map 路由（graph 页按参数聚焦/恢复）。
  | { kind: "star_map"; keyPointId?: string; lens?: "current_target" | "evidence" | "provenance" | "issues"; restoreRun?: string }
  | { kind: "learning_run"; runId: string }
  | { kind: "conversation" }
  | { kind: "settings"; section?: SettingsSectionIdV2 };

export type UiTargetRefV2 =
  | { kind: "quick_capture" }
  | { kind: "source_generate_note"; sourceId: string }
  | { kind: "note_generate_cards"; noteId: string }
  | { kind: "card_evidence"; cardId: string; keyPointId?: string }
  | { kind: "run_current_task"; runId: string; taskId: string };

export type MainCommandKindV2 =
  | "open_route"
  | "focus_ui_target"
  | "graph.focus"
  | "graph.present_route"
  | "graph.advance_route"
  | "graph.restore"
  | "graph.reveal_delta";

export type AssistantContextSnapshotV2 = {
  version: 2;
  contextId: string;
  accountSessionId: string;
  deviceSessionId: string;
  workspaceId: string;
  userId: string;
  pageInstanceId: string;
  revision: string; // canonical hash，不与 Run revision 混用
  routeRef: AllowedMainRouteV2;
  pageKind:
    | "today"
    | "source"
    | "note"
    | "card"
    | "objective"
    | "review"
    | "star_map"
    | "learning_run"
    | "conversation"
    | "settings"
    | "other";
  entityRefs: EntityRefV2[];
  interactionState: "idle" | "editing" | "formal_answer" | "processing";
  graph?: {
    lens: "current_target" | "evidence" | "provenance" | "issues";
    selectedKeyPointId: string | null;
    activeRoutePlanId: string | null;
    checkpoint: {
      version: 1;
      workspaceId: string;
      userId: string;
      token: string;
      capturedAt: string;
    };
  };
  capabilityHints: MainCommandKindV2[]; // 仅提示，不是授权
  sensitivity: "normal" | "formal_assessment" | "credential_surface";
  readableView?: PageReadableV1;
  issuedAt: string;
  expiresAt: string;
};

export type MainPageContextV2 = AssistantContextSnapshotV2;

/** Main renderer 可提交的 context 输入（安全字段由 broker 覆盖，§14.2）。 */
export type MainPageContextInputV2 = Pick<
  AssistantContextSnapshotV2,
  "routeRef" | "pageKind" | "entityRefs" | "interactionState" | "graph" | "capabilityHints" | "sensitivity" | "readableView"
>;

// ─── §14.3 UI Event、Domain Event 与 Delivery ────────────────────────────

export type MainUiEventV2 = {
  version: 2;
  eventId: string;
  pageInstanceId: string;
  pageSequence: number;
  contextRevision: string;
  commandId?: string;
  type:
    | "page.ready"
    | "route.entered"
    | "selection.changed"
    | "interaction.started"
    | "interaction.ended"
    | "command.completed"
    | "command.rejected"
    | "command.failed"
    | "graph.delta_applied";
  occurredAt: string;
  safeRefs: EntityRefV2[];
};

export type CompanionSystemEventTypeV2 =
  | "learning_run.created"
  | "learning_run.resumable"
  | "learning_run.completed"
  | "learning_run.recoverable_error"
  | "projection.ready"
  | "journey.step_changed"
  | "journey.completed"
  | "generation_job.completed"
  | "generation_job.failed"
  | "review.due";

export type CompanionSystemPayloadRefV2 =
  | { kind: "learning_run"; runId: string; eventCursor: number }
  | { kind: "projection_change"; changeSetId: string; checkpointToken: string }
  | { kind: "journey"; journeyId: string; stepRevision: number }
  | { kind: "generation_job"; jobId: string; sourceId?: string; noteId?: string }
  | { kind: "review_schedule"; scheduleId: string; scheduleGeneration: number };

export type CompanionSystemEventV2 = {
  version: 2;
  eventId: string;
  sequence: number;
  source: "learning_run" | "projection" | "journey" | "generation_job" | "review";
  workspaceId: string;
  userId: string;
  runId?: string;
  commandId?: string;
  checkpoint?: { version: 1; workspaceId: string; userId: string; token: string; capturedAt: string };
  eventType: CompanionSystemEventTypeV2;
  occurredAt: string;
  payloadRef: CompanionSystemPayloadRefV2;
};

export type AssistantDeliveryPayloadRefV2 =
  | { kind: "message"; messageId: string }
  | { kind: "proposal"; proposalId: string }
  | { kind: "action_result"; proposalId: string }
  | { kind: "system_event"; systemEventId: string; text?: string }
  /** §16.2：contentPreview 为候选内容摘要 ≤80 字，仅 UI 展示。 */
  | { kind: "memory_item"; memoryItemId: string; contentPreview?: string };

/**
 * assistant_deliveries.kind 的**唯一事实来源**（2026-09-16 修复）。
 *
 * 此前该集合在三处各写一遍（本文件的 TS union / zod enum、timeline 的
 * DELIVERY_KINDS、delivery-service 的入参类型），而数据库侧的
 * assistant_deliveries_kind_check 是第四份手写清单——0131 因此漏掉
 * memory_candidate，worker 记忆抽取写入该 kind 时触发 CHECK 违例并回滚整个
 * 事务（抽取在找到候选时永久失败）。迁移 0224 修正了约束，下面的集成测试
 * （assistant-deliveries-kind-constraint）断言库中约束与本清单精确相等。
 */
export const ASSISTANT_DELIVERY_KIND_VALUES = [
  "message",
  "proposal",
  "action_result",
  "system_event",
  "memory_candidate",
] as const;

export type AssistantDeliveryKindV2 = (typeof ASSISTANT_DELIVERY_KIND_VALUES)[number];

export type AssistantDeliveryV2 = {
  version: 2;
  deliveryId: string;
  /** Internal delivery segment. Some account-level deliveries are not tied to one. */
  assistantSessionId: string | null;
  userId: string;
  workspaceId: string;
  inboxSequence: number;
  dedupeKey: string;
  state:
    | "queued"
    | "delivered"
    | "displayed"
    | "acted"
    | "dismissed"
    | "snoozed"
    | "expired"
    | "suppressed";
  kind: AssistantDeliveryKindV2;
  payloadRef: AssistantDeliveryPayloadRefV2;
  displayLease: {
    deviceSessionId: string;
    leaseToken: string;
    expiresAt: string;
  } | null;
  createdAt: string;
  expiresAt: string;
};

export type AssistantDeliveryAckV2 = {
  version: 2;
  deliveryId: string;
  inboxSequence: number;
  deviceSessionId: string;
  leaseToken: string;
  transition: "displayed" | "acted" | "dismissed" | "snoozed";
  snoozedUntil?: string;
  idempotencyKey: string;
};

// ─── §14.4 Pet → Main 表面命令 ───────────────────────────────────────────

export type PetMainCommandV2 =
  | { kind: "open_route"; route: AllowedMainRouteV2 }
  | { kind: "focus_ui_target"; target: UiTargetRefV2 }
  | { kind: "graph.focus"; keyPointId: string; lens?: "current_target" | "evidence" | "provenance" | "issues" }
  | { kind: "graph.present_route"; routePlanId: string; revision: string }
  | { kind: "graph.advance_route"; routePlanId: string; ordinal: number }
  | { kind: "graph.restore"; runId: string }
  | { kind: "graph.reveal_delta"; changeSetId: string };

export type NavigationCommandEnvelopeV2 = {
  version: 2;
  scope: "navigation";
  commandId: string;
  sourceContextRevision?: string;
  expiresAt: string;
  command: Extract<PetMainCommandV2, { kind: "open_route" }>;
};

export type InPageCommandEnvelopeV2 = {
  version: 2;
  scope: "in_page";
  commandId: string;
  targetPageInstanceId: string;
  expectedContextRevision: string;
  expiresAt: string;
  command: Exclude<PetMainCommandV2, { kind: "open_route" }>;
};

export type MainCommandResultV2 = {
  version: 2;
  commandId: string;
  status: "accepted" | "completed" | "rejected" | "failed";
  pageInstanceId?: string;
  contextRevision?: string;
  resultRefs: EntityRefV2[];
  reasonCode?:
    | "stale_page"
    | "stale_context"
    | "expired"
    | "unsupported_route"
    | "target_missing"
    | "permission_denied"
    | "renderer_unavailable"
    | "internal_error";
  occurredAt: string;
};

// ─── zod schemas（strict）────────────────────────────────────────────────

export const entityRefV2Schema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("source"), sourceId: z.string().uuid() }),
  z.strictObject({ kind: z.literal("note"), noteId: z.string().uuid() }),
  z.strictObject({ kind: z.literal("card"), cardId: z.string().uuid() }),
  z.strictObject({ kind: z.literal("key_point"), keyPointId: z.string().uuid() }),
  z.strictObject({ kind: z.literal("evidence"), evidenceId: z.string().uuid() }),
  z.strictObject({ kind: z.literal("review_schedule"), scheduleId: z.string().uuid() }),
  z.strictObject({ kind: z.literal("learning_run"), runId: z.string().uuid() }),
  z.strictObject({ kind: z.literal("learning_task"), runId: z.string().uuid(), taskId: z.string().uuid() }),
  z.strictObject({ kind: z.literal("companion_journey"), journeyId: z.string().uuid() }),
  z.strictObject({ kind: z.literal("assistant_session"), assistantSessionId: z.string().uuid() }),
  z.strictObject({ kind: z.literal("route_plan"), routePlanId: z.string().uuid() }),
  z.strictObject({ kind: z.literal("change_set"), changeSetId: z.string().min(1) }),
]);

export const allowedMainRouteV2Schema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("home") }),
  z.strictObject({ kind: z.literal("today") }),
  z.strictObject({ kind: z.literal("source"), sourceId: z.string().uuid().optional() }),
  z.strictObject({ kind: z.literal("note"), noteId: z.string().uuid() }),
  z.strictObject({ kind: z.literal("note_library") }),
  z.strictObject({ kind: z.literal("card"), cardId: z.string().uuid(), objectiveId: z.string().uuid() }),
  z.strictObject({ kind: z.literal("objective_library") }),
  z.strictObject({ kind: z.literal("review"), scheduleId: z.string().uuid().optional() }),
  z.strictObject({ kind: z.literal("search") }),
  z.strictObject({
    kind: z.literal("star_map"),
    keyPointId: z.string().uuid().optional(),
    lens: z.enum(["current_target", "evidence", "provenance", "issues"]).optional(),
    restoreRun: z.string().uuid().optional(),
  }),
  z.strictObject({ kind: z.literal("learning_run"), runId: z.string().uuid() }),
  z.strictObject({ kind: z.literal("conversation") }),
  z.strictObject({
    kind: z.literal("settings"),
    section: z.enum(SETTINGS_SECTION_IDS_V2).optional(),
  }),
]);

/**
 * 伴星一句话能跳到的页面：**这一张表就是词表本身**。
 *
 * 三条各自成立、合起来才坏的事曾在同一周发生三次：
 * ① `companion_open_page` 的参数枚举手抄一份，和桌面端能落地的页面各说各话；
 * ② 「今日」「设置」在服务端是合法 route，客户端映射表里没有分支，
 *    于是按钮根本不出现（`today`/`settings` 就是这两条），她却照着一句"到了"；
 * ③ 笔记库、学习卡、查找是真实存在的页面，她的词表里却没有，
 *    只能被就近塞进"来源库/星图"——用户看到的正是"跳的不是我要的那页"。
 * 页面名一律取 HUD 那页自己的标题，别名用来接用户的口语（书架/资料库、星图/知识图谱）。
 */
export const COMPANION_PAGE_DESTINATIONS_V2 = [
  { kind: "home", label: "首页", aliases: ["房间"], route: { kind: "room.home" } },
  { kind: "today", label: "今日学习", aliases: ["今天", "学习"], route: { kind: "room.today" } },
  { kind: "source", label: "来源库", aliases: ["书架", "资料库"], route: { kind: "source.library" } },
  { kind: "note_library", label: "笔记库", aliases: ["笔记"], route: { kind: "note.library" } },
  { kind: "objective_library", label: "学习卡", aliases: ["卡片", "理解目标", "理解地图"], route: { kind: "objective.library" } },
  { kind: "star_map", label: "理解星图", aliases: ["星图", "知识图谱"], route: { kind: "understanding.graph" } },
  { kind: "review", label: "复习队列", aliases: ["待复习"], route: { kind: "review.queue" } },
  { kind: "search", label: "全局搜索", aliases: ["搜索"], route: { kind: "search.global" } },
  {
    kind: "conversation",
    label: "伴星中心",
    aliases: ["对话"],
    route: { kind: "companion.center", tab: "dialogue" },
  },
  {
    kind: "settings",
    label: "设置中心",
    aliases: ["设置"],
    route: { kind: "settings.section", section: "account" },
  },
] as const satisfies readonly {
  kind: AllowedMainRouteV2["kind"];
  label: string;
  aliases: readonly string[];
  route: DesktopRouteV1;
}[];

export type CompanionPageKindV2 = (typeof COMPANION_PAGE_DESTINATIONS_V2)[number]["kind"];

export const companionPageKindValuesV2: readonly CompanionPageKindV2[] = Object.freeze(
  COMPANION_PAGE_DESTINATIONS_V2.map((page) => page.kind),
);

export function companionPageRouteV2(kind: CompanionPageKindV2): DesktopRouteV1 {
  const page = COMPANION_PAGE_DESTINATIONS_V2.find((destination) => destination.kind === kind);
  if (!page) throw new Error(`伴星页面词表里没有 ${kind}`);
  // 返回副本：词表是 `as const` 的共享对象，调用方（渲染层）拿到的是可以随便处理的一份。
  return { ...page.route };
}

export function companionPageLabelV2(kind: string): string {
  return COMPANION_PAGE_DESTINATIONS_V2.find((page) => page.kind === kind)?.label ?? kind;
}

export const uiTargetRefV2Schema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("quick_capture") }),
  z.strictObject({ kind: z.literal("source_generate_note"), sourceId: z.string().uuid() }),
  z.strictObject({ kind: z.literal("note_generate_cards"), noteId: z.string().uuid() }),
  z.strictObject({ kind: z.literal("card_evidence"), cardId: z.string().uuid(), keyPointId: z.string().uuid().optional() }),
  z.strictObject({ kind: z.literal("run_current_task"), runId: z.string().uuid(), taskId: z.string().uuid() }),
]);

/**
 * 页面可读视图（通用"读我当前这一页"）。
 *
 * 这是**任何**页面都能填的一种形状，不是某页的专用 DTO：标题 + 状态行 + 计数器 +
 * **带序号的条目列表** + 空态/报错 + 当前筛选。`items[].ordinal` 是整个形状里
 * 唯一不可省的东西——用户说"第四张""第二个星体"时，只有它在场才能把指法落到
 * 具体条目上。缺了它，这个工具又会被降级成"每页各写一个查询"。
 *
 * 载荷里**没有任何时间戳**："多久之前"一律由服务端从 context 行的 issuedAt 算。
 * 客户端自报相对时间有两个坏处：每次 publish 都是新 pageInstanceId 且旧行当场
 * revoke，一个每分钟变的字符串会把推送打成自我撤销的洪水；而且同一个读数会出现
 * 两个来源（屏幕一个、她嘴里一个）。
 *
 * 内容与 `sensitivity` 一样是不可信提示：正文由服务端按 sensitivity 二次裁剪，
 * 上限在这里钉死（工具 maxOutputChars 是 4000）。
 */
export const PAGE_READABLE_TOTAL_CHAR_BUDGET = 1_600;

export const pageReadableMetricV1Schema = z.strictObject({
  label: z.string().min(1).max(40),
  value: z.string().min(1).max(40),
});

export const pageReadableItemV1Schema = z.strictObject({
  /** 屏幕上显示的那个数（1 起）；不是数据库主键，也不参与归属校验。 */
  ordinal: z.number().int().min(1).max(99),
  label: z.string().min(1).max(120),
  /** 条目自己的状态字（"已过质量门"/"待你决定"），照抄界面文案。 */
  state: z.string().min(1).max(40).optional(),
});

export const pageReadableV1Schema = z
  .strictObject({
    /** 页面自登记的种类标识，仅用于日志与"她复述我在哪页"。 */
    pageId: z.string().min(1).max(40),
    title: z.string().min(1).max(120),
    statusLine: z.string().min(1).max(160).optional(),
    metrics: z.array(pageReadableMetricV1Schema).max(6).optional(),
    items: z.array(pageReadableItemV1Schema).max(12).optional(),
    notice: z.string().min(1).max(200).optional(),
    filters: z.array(pageReadableMetricV1Schema).max(6).optional(),
  })
  .superRefine((value, ctx) => {
    const used
      = value.pageId.length
        + value.title.length
        + (value.statusLine?.length ?? 0)
        + (value.notice?.length ?? 0)
        + (value.metrics ?? []).reduce((n, m) => n + m.label.length + m.value.length, 0)
        + (value.items ?? []).reduce((n, i) => n + i.label.length + (i.state?.length ?? 0), 0)
        + (value.filters ?? []).reduce((n, f) => n + f.label.length + f.value.length, 0);
    if (used > PAGE_READABLE_TOTAL_CHAR_BUDGET) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["title"],
        message: `readable view exceeds ${PAGE_READABLE_TOTAL_CHAR_BUDGET} chars`,
      });
    }
  });

export type PageReadableV1 = z.infer<typeof pageReadableV1Schema>;
export type PageReadableItemV1 = z.infer<typeof pageReadableItemV1Schema>;
export type PageReadableMetricV1 = z.infer<typeof pageReadableMetricV1Schema>;

/** Main renderer 提交的 context 输入（§14.2：安全字段由 broker 覆盖）。 */
export const mainPageContextInputV2Schema = z.strictObject({
  routeRef: allowedMainRouteV2Schema,
  pageKind: z.enum([
    "today", "source", "note", "card", "objective", "review", "star_map",
    "learning_run", "conversation", "settings", "other",
  ]),
  entityRefs: z.array(entityRefV2Schema).max(64),
  interactionState: z.enum(["idle", "editing", "formal_answer", "processing"]),
  graph: z
    .strictObject({
      lens: understandingLensSchema,
      selectedKeyPointId: z.string().uuid().nullable(),
      activeRoutePlanId: z.string().uuid().nullable(),
      checkpoint: projectionCheckpointSchema,
    })
    .optional(),
  capabilityHints: z
    .array(z.enum([
      "open_route", "focus_ui_target", "graph.focus", "graph.present_route",
      "graph.advance_route", "graph.restore", "graph.reveal_delta",
    ]))
    .max(16),
  sensitivity: z.enum(["normal", "formal_assessment", "credential_surface"]),
  /** 这一页此刻显示给用户的可读视图；没有有效调用方的页面不发。 */
  readableView: pageReadableV1Schema.optional(),
});

export const assistantContextSnapshotV2Schema = mainPageContextInputV2Schema
  .extend({
    version: z.literal(2),
    contextId: z.string().min(1),
    accountSessionId: z.string().min(1),
    deviceSessionId: z.string().min(1),
    workspaceId: z.string().uuid(),
    userId: z.string().uuid(),
    pageInstanceId: z.string().min(1),
    revision: z.string().min(1),
    issuedAt: z.string().min(1),
    expiresAt: z.string().min(1),
  })
  .strict();

/**
 * 续租的响应（文档 16 §14.2：`renewPageContext → { revision, expiresAt }`）。
 *
 * 它与 publish 的快照**不是同一个形状**：服务端 `renewContext` 只回这两个字段
 * （行里没存 accountSessionId/deviceSessionId，凑不出完整快照）。客户端拿
 * `assistantContextSnapshotV2Schema` 去解它必然失败，而那次失败的后果是清掉本地
 * 上下文并停掉续租定时器——屏上内容不变时渲染层不会再推一次，于是她从此读不到
 * 这一页（本仓实测：`expires_at - issued_at` 恒为 30＋10 秒，即只续上一拍）。
 */
export const assistantContextRenewResultV2Schema = z
  .object({
    revision: z.string().min(1),
    expiresAt: z.string().min(1),
  })
  .strict();
export type AssistantContextRenewResultV2 = z.infer<typeof assistantContextRenewResultV2Schema>;

export const mainUiEventV2Schema = z.strictObject({
  version: z.literal(2),
  eventId: z.string().min(1),
  pageInstanceId: z.string().min(1),
  pageSequence: z.number().int().min(0),
  contextRevision: z.string().min(1),
  commandId: z.string().min(1).optional(),
  type: z.enum([
    "page.ready", "route.entered", "selection.changed",
    "interaction.started", "interaction.ended",
    "command.completed", "command.rejected", "command.failed",
    "graph.delta_applied",
  ]),
  occurredAt: z.string().min(1),
  safeRefs: z.array(entityRefV2Schema).max(64),
});

export const companionSystemEventV2Schema = z.strictObject({
  version: z.literal(2),
  eventId: z.string().min(1),
  sequence: z.number().int().min(0),
  source: z.enum(["learning_run", "projection", "journey", "generation_job", "review"]),
  workspaceId: z.string().uuid(),
  userId: z.string().uuid(),
  runId: z.string().uuid().optional(),
  commandId: z.string().min(1).optional(),
  checkpoint: projectionCheckpointSchema.optional(),
  eventType: z.enum([
    "learning_run.created", "learning_run.resumable", "learning_run.completed",
    "learning_run.recoverable_error", "projection.ready", "journey.step_changed",
    "journey.completed", "generation_job.completed", "generation_job.failed",
    "review.due",
  ]),
  occurredAt: z.string().min(1),
  payloadRef: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("learning_run"), runId: z.string().uuid(), eventCursor: z.number().int().min(0) }),
    z.strictObject({ kind: z.literal("projection_change"), changeSetId: z.string().min(1), checkpointToken: z.string().min(1) }),
    z.strictObject({ kind: z.literal("journey"), journeyId: z.string().uuid(), stepRevision: z.number().int().min(0) }),
    z.strictObject({ kind: z.literal("generation_job"), jobId: z.string().uuid(), sourceId: z.string().uuid().optional(), noteId: z.string().uuid().optional() }),
    z.strictObject({ kind: z.literal("review_schedule"), scheduleId: z.string().uuid(), scheduleGeneration: z.number().int().min(0) }),
  ]),
});

export const assistantDeliveryV2Schema = z.strictObject({
  version: z.literal(2),
  deliveryId: z.string().min(1),
  assistantSessionId: z.string().uuid().nullable(),
  userId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  inboxSequence: z.number().int().min(0),
  dedupeKey: z.string().min(1),
  state: z.enum([
    "queued", "delivered", "displayed", "acted", "dismissed", "snoozed", "expired", "suppressed",
  ]),
  kind: z.enum(ASSISTANT_DELIVERY_KIND_VALUES),
  payloadRef: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("message"), messageId: z.string().uuid() }),
    z.strictObject({ kind: z.literal("proposal"), proposalId: z.string().uuid() }),
    z.strictObject({ kind: z.literal("action_result"), proposalId: z.string().uuid() }),
    z.strictObject({ kind: z.literal("system_event"), systemEventId: z.string().min(1), text: z.string().min(1).max(240).optional() }),
    z.strictObject({ kind: z.literal("memory_item"), memoryItemId: z.string().uuid(), contentPreview: z.string().min(1).max(80).optional() }),
  ]),
  displayLease: z
    .strictObject({
      deviceSessionId: z.string().min(1),
      leaseToken: z.string().min(1),
      expiresAt: z.string().min(1),
    })
    .nullable(),
  createdAt: z.string().min(1),
  expiresAt: z.string().min(1),
});

export const assistantDeliveryAckV2Schema = z.strictObject({
  version: z.literal(2),
  deliveryId: z.string().min(1),
  inboxSequence: z.number().int().min(0),
  deviceSessionId: z.string().min(1),
  leaseToken: z.string().min(1),
  transition: z.enum(["displayed", "acted", "dismissed", "snoozed"]),
  snoozedUntil: z.string().min(1).optional(),
  idempotencyKey: z.string().min(1).max(200),
});

export const petMainCommandV2Schema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("open_route"), route: allowedMainRouteV2Schema }),
  z.strictObject({ kind: z.literal("focus_ui_target"), target: uiTargetRefV2Schema }),
  z.strictObject({
    kind: z.literal("graph.focus"),
    keyPointId: z.string().uuid(),
    lens: understandingLensSchema.optional(),
  }),
  z.strictObject({ kind: z.literal("graph.present_route"), routePlanId: z.string().uuid(), revision: z.string().min(1) }),
  z.strictObject({ kind: z.literal("graph.advance_route"), routePlanId: z.string().uuid(), ordinal: z.number().int().min(0) }),
  z.strictObject({ kind: z.literal("graph.restore"), runId: z.string().uuid() }),
  z.strictObject({ kind: z.literal("graph.reveal_delta"), changeSetId: z.string().min(1) }),
]);

export const navigationCommandEnvelopeV2Schema = z.strictObject({
  version: z.literal(2),
  scope: z.literal("navigation"),
  commandId: z.string().min(1),
  sourceContextRevision: z.string().min(1).optional(),
  expiresAt: z.string().min(1),
  command: petMainCommandV2Schema.refine((c) => c.kind === "open_route"),
});

export const inPageCommandEnvelopeV2Schema = z.strictObject({
  version: z.literal(2),
  scope: z.literal("in_page"),
  commandId: z.string().min(1),
  targetPageInstanceId: z.string().min(1),
  expectedContextRevision: z.string().min(1),
  expiresAt: z.string().min(1),
  command: petMainCommandV2Schema.refine((c) => c.kind !== "open_route"),
});

export const mainCommandResultV2Schema = z.strictObject({
  version: z.literal(2),
  commandId: z.string().min(1),
  status: z.enum(["accepted", "completed", "rejected", "failed"]),
  pageInstanceId: z.string().min(1).optional(),
  contextRevision: z.string().min(1).optional(),
  resultRefs: z.array(entityRefV2Schema).max(64),
  reasonCode: z.enum([
    "stale_page", "stale_context", "expired", "unsupported_route",
    "target_missing", "permission_denied", "renderer_unavailable", "internal_error",
  ]).optional(),
  occurredAt: z.string().min(1),
});

// ─── 类型推导 ────────────────────────────────────────────────────────────

export type MainPageContextInput = z.infer<typeof mainPageContextInputV2Schema>;
export type AssistantContextSnapshot = z.infer<typeof assistantContextSnapshotV2Schema>;
export type MainUiEvent = z.infer<typeof mainUiEventV2Schema>;
export type CompanionSystemEvent = z.infer<typeof companionSystemEventV2Schema>;
export type AssistantDelivery = z.infer<typeof assistantDeliveryV2Schema>;
export type AssistantDeliveryAck = z.infer<typeof assistantDeliveryAckV2Schema>;
export type PetMainCommand = z.infer<typeof petMainCommandV2Schema>;
export type NavigationCommandEnvelope = z.infer<typeof navigationCommandEnvelopeV2Schema>;
export type InPageCommandEnvelope = z.infer<typeof inPageCommandEnvelopeV2Schema>;
export type MainCommandResult = z.infer<typeof mainCommandResultV2Schema>;
