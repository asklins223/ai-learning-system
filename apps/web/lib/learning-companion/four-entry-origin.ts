/**
 * 任务 07-5：四入口共享内核与 origin-aware completion（原方案 §8/§3，W6 任务 07-5）。
 *
 * 学习卡仍是有证据的知识载体；前台只保留一个主行动「开始/继续一小段航程」，
 * Supervisor 决定本轮使用语音、排序、修复还是情境 —— 不把「动/试」做成平级玩法菜单。
 * 朗读（TTS 摘要/论点/证据）、查看证据（exact evidence + semantic support）、
 * 问一问（当前 target 有界 Tutor detour）作为内容工具存在，不必创建完整 formal Session；
 * 朗读/查看/Tutor 按实际暴露内容记录 exposure，随后开始航程必须遵守 assistance cooldown。
 *
 * 本文件是纯逻辑（无 React / 无 DOM / 无网络），负责：
 * - **originRef 冻结（PREPARE）**：`freezePrepareOrigin` 在 PREPARE 时把
 *   `originRef`、viewport/selection snapshot 和 completion summary contract 一并冻结；
 * - **四入口共享同一 Session/Episode 内核**：`star_map` / `card` / `review` / `now` /
 *   `tutor_detour` 全部从同一 `FrozenPrepareOrigin` 派生出结果一致的视图并**就地完成**，
 *   不强制跳转；每处可「在星图中查看」但只是可选动作（`starMapView.forced === false`）；
 * - **学习卡状态 ≠ 用户理解**：发布只表示资产过生成与证据 Gate；打开/收听/收藏只表示
 *   接触；Tutor 解释只产生 practice 事件；只有 trusted contract 的验证/复习事件
 *   （`classifyCardEvent` / `buildCompletionSummary`）才能改变个人理解投影；
 * - **内容工具 exposure 与 assistance cooldown**：`recordToolExposure` 按实际暴露内容
 *   记录；`resolveJourneyReadiness` 判定随后开始航程必须遵守的 cooldown 窗口。
 *
 * 不变量：
 * - 全部函数纯同步、无网络；`FrozenPrepareOrigin` 深度冻结，任何修改 fail-closed；
 * - 四入口结果一致（共享 core ref）且就地完成，星图查看永为可选（`forced` 恒为 false）；
 * - summary 变化只来自 trusted 事件，practice/contact 事件进入摘要为 0。
 */

// ─── 1. 四入口类型 ─────────────────────────────────────────────────────

/** 四入口标识：star_map（星图）/ card（卡片）/ review / now / scoped Tutor detour */
export type FourEntryId = "star_map" | "card" | "review" | "now" | "tutor_detour";

export const FOUR_ENTRY_IDS: readonly FourEntryId[] = [
  "star_map",
  "card",
  "review",
  "now",
  "tutor_detour",
];

/** 四入口归组：review 与 now 共享「此刻/复习」语义（§3 旅程 A~F 入口一致） */
export type FourEntryGroup = "star_map" | "card" | "review_now" | "tutor_detour";

export function fourEntryGroup(entry: FourEntryId): FourEntryGroup {
  if (entry === "review" || entry === "now") return "review_now";
  return entry;
}

/** 学习卡唯一主行动（§8：前台只有一个主行动，不把玩法做成平级菜单） */
export const LEARNING_CARD_PRIMARY_ACTION = "开始/继续一小段航程";

/** 内容工具（不是平级玩法；不必创建完整 formal Session 也必须可行） */
export const LEARNING_CARD_TOOLS = ["read_aloud", "view_evidence", "ask_tutor"] as const;
export type LearningCardTool = (typeof LEARNING_CARD_TOOLS)[number];

// ─── 2. 快照与 originRef ───────────────────────────────────────────────

/** 星图视口快照（与 UnderstandingUniverse 的 Viewport 同形：offsetX/offsetY/zoom） */
export interface StarMapViewportSnapshot {
  offsetX: number;
  offsetY: number;
  zoom: number;
}

/** 星图选择快照（恢复原 selection 并显影真实变化） */
export interface StarMapSelectionSnapshot {
  selectedId: string | null;
  /** 高亮节点 id（可选，恢复高亮态） */
  highlightedNodeIds?: readonly string[];
}

/** 合法 originRef（03-2 §3 已冻结类型；ephemeral 只作 originRef，正式 target 仍是 Key Point） */
export type LearningOriginRef =
  | { type: "key_point"; id: string }
  | { type: "card"; id: string }
  | { type: "review_schedule"; id: string }
  | { type: "question_suggestion"; id: string };

/** 本 Episode schedule 结果（official policy 唯一写入权；06-5 冻结授权集合） */
export type ScheduleResultKind =
  | "create_initial"
  | "consume_pending"
  | "record_only"
  | "no_effect"
  | "none";

/** completion summary contract：在 PREPARE 时冻结（§3 origin-aware completion） */
export interface CompletionSummaryContract {
  readonly version: 1;
  /** 变化唯一来源：trusted contract 的验证/复习事件（学习卡状态 ≠ 用户理解） */
  readonly fromTrustedContractOnly: true;
  /** 能力变化摘要（只列已验证切面；无事件依据不出现，不展示伪精确掌握度） */
  readonly capabilityChangeSummary: readonly string[];
  /** 复习变化摘要（schedule 结果的事实语言描述） */
  readonly reviewChangeSummary: readonly string[];
  /** 未处理 schedule 事实（事实语言，不道德化为债务，旅程 F） */
  readonly unhandledFacts: readonly string[];
  /** 本 Episode schedule 结果（PREPARE 冻结，completion 不改写） */
  readonly scheduleResult: ScheduleResultKind;
}

/** PREPARE 冻结的 origin 快照（深度冻结，不可变） */
export interface FrozenPrepareOrigin {
  readonly entry: FourEntryId;
  /** 四入口共享的 Session/Episode 内核引用 */
  readonly sessionId: string;
  readonly episodeId: string;
  readonly targetKeyPointId: string;
  readonly originRef: Readonly<LearningOriginRef>;
  /** star_map 入口：PREPARE 时冻结的原 viewport（用于返回时恢复）；其它入口可空 */
  readonly viewportSnapshot: Readonly<StarMapViewportSnapshot> | null;
  /** star_map 入口：PREPARE 时冻结的原 selection */
  readonly selectionSnapshot: Readonly<StarMapSelectionSnapshot> | null;
  /** completion summary contract（PREPARE 冻结） */
  readonly completionSummary: Readonly<CompletionSummaryContract>;
  /** 冻结时刻（单调递增，由调用方在会话内递增提供） */
  readonly frozenEpoch: number;
}

export interface PrepareOriginInput {
  entry: FourEntryId;
  sessionId: string;
  episodeId: string;
  targetKeyPointId: string;
  originRef: LearningOriginRef;
  viewportSnapshot?: StarMapViewportSnapshot | null;
  selectionSnapshot?: StarMapSelectionSnapshot | null;
  completionSummary: CompletionSummaryContract;
  frozenEpoch: number;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Object.getOwnPropertyNames(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

function assertValidOriginRef(originRef: LearningOriginRef): void {
  if (!["key_point", "card", "review_schedule", "question_suggestion"].includes(originRef.type)) {
    throw new Error(`invalid originRef type: ${(originRef as LearningOriginRef).type}`);
  }
  if (typeof originRef.id !== "string" || originRef.id.length === 0) {
    throw new Error("originRef.id must be a non-empty string");
  }
}

/**
 * PREPARE 时冻结 origin 快照（§3：originRef、viewport/selection snapshot 和
 * completion summary contract 在 PREPARE 时冻结）。
 *
 * 规则：
 * - `star_map` 入口必须携带原 viewport/selection snapshot（返回时恢复原视口），
 *   缺失 → 抛错（fail closed）；
 * - 其余入口的 viewport/selection 可为空（就地完成，不强制跳转星图）；
 * - 返回对象被**深度冻结**，任何后续修改 fail-closed。
 */
export function freezePrepareOrigin(input: PrepareOriginInput): FrozenPrepareOrigin {
  if (!FOUR_ENTRY_IDS.includes(input.entry)) {
    throw new Error(`invalid four-entry id: ${input.entry}`);
  }
  assertValidOriginRef(input.originRef);
  if (typeof input.sessionId !== "string" || input.sessionId.length === 0) {
    throw new Error("sessionId must be a non-empty string");
  }
  if (typeof input.episodeId !== "string" || input.episodeId.length === 0) {
    throw new Error("episodeId must be a non-empty string");
  }
  if (typeof input.targetKeyPointId !== "string" || input.targetKeyPointId.length === 0) {
    throw new Error("targetKeyPointId must be a non-empty string");
  }
  if (input.entry === "star_map" && input.viewportSnapshot == null) {
    throw new Error("star_map entry requires a frozen viewport snapshot");
  }
  if (input.entry === "star_map" && input.selectionSnapshot == null) {
    throw new Error("star_map entry requires a frozen selection snapshot");
  }
  if (input.completionSummary.fromTrustedContractOnly !== true) {
    throw new Error("completion summary must come from trusted contract only");
  }
  const viewport = input.viewportSnapshot == null ? null : deepFreeze(input.viewportSnapshot);
  const selection = input.selectionSnapshot == null ? null : deepFreeze(input.selectionSnapshot);
  return deepFreeze({
    entry: input.entry,
    sessionId: input.sessionId,
    episodeId: input.episodeId,
    targetKeyPointId: input.targetKeyPointId,
    originRef: deepFreeze({ ...input.originRef }),
    viewportSnapshot: viewport,
    selectionSnapshot: selection,
    completionSummary: deepFreeze({ ...input.completionSummary }),
    frozenEpoch: input.frozenEpoch,
  });
}

// ─── 3. 四入口视图解析（结果一致且就地完成）────────────────────────────

export type DetourOutcome = "return_to_episode" | "keep_as_practice" | "explicit_end";

/** 每处可「在星图中查看」但不强制跳转（§3 四入口） */
export interface StarMapOptionalView {
  /** 是否提供「在星图中查看」入口（star_map 入口本身已在星图 → false） */
  available: boolean;
  /** 永为 false：绝不强制跳转（星图不是唯一入口，§10.6） */
  readonly forced: false;
  readonly label: string;
}

export interface FourEntryCoreRef {
  readonly sessionId: string;
  readonly episodeId: string;
  readonly targetKeyPointId: string;
  readonly originRef: Readonly<LearningOriginRef>;
}

/** 四入口解析出的视图（全部从同一 FrozenPrepareOrigin 派生 → 结果一致且就地完成） */
export interface FourEntryView {
  readonly entry: FourEntryId;
  readonly group: FourEntryGroup;
  /** 共享内核引用（四入口一致的判定依据） */
  readonly core: FourEntryCoreRef;
  /** 就地完成（completion 不强制跳页；§3.3~3.8 origin-aware completion） */
  readonly completedInPlace: true;
  readonly starMapView: StarMapOptionalView;
  /** star_map：恢复原 viewport（PREPARE 冻结值） */
  readonly restoredViewport: Readonly<StarMapViewportSnapshot> | null;
  /** star_map：恢复原 selection（PREPARE 冻结值） */
  readonly restoredSelection: Readonly<StarMapSelectionSnapshot> | null;
  /** star_map：显影真实变化（只有 trusted 验证/复习事件依据的变化） */
  readonly revealRealChange: boolean;
  /** card：能力/复习变化摘要（来自冻结 contract） */
  readonly capabilityChangeSummary: readonly string[];
  readonly reviewChangeSummary: readonly string[];
  /** review/now：本 Episode schedule 结果与未处理事实 */
  readonly scheduleResult: ScheduleResultKind;
  readonly unhandledFacts: readonly string[];
  /** tutor_detour：回到原 Episode / 保留为练习 / 明确结束 */
  readonly detourOutcome: DetourOutcome | null;
}

export interface ResolveEntryViewOptions {
  /** tutor_detour 入口：用户选择的三选一结局（Must 固定动作，07-7） */
  detourOutcome?: DetourOutcome;
}

/**
 * 从冻结 origin 解析四入口视图（同一内核、结果一致、就地完成）。
 *
 * 入口语义（任务 07-5 / §3.3~3.8）：
 * - `star_map`：恢复原 viewport/zoom/selection 并显影真实变化；
 * - `card`：返回当前卡片显示能力/复习变化摘要（来自 PREPARE 冻结 contract）；
 * - `review`/`now`：展示本 Episode schedule 结果与未处理事实；
 * - `tutor_detour`：回到原 Episode / 保留为练习 / 明确结束（三选一，明确结束）。
 */
export function resolveEntryView(
  frozen: Readonly<FrozenPrepareOrigin>,
  options: ResolveEntryViewOptions = {},
): FourEntryView {
  const core: FourEntryCoreRef = {
    sessionId: frozen.sessionId,
    episodeId: frozen.episodeId,
    targetKeyPointId: frozen.targetKeyPointId,
    originRef: frozen.originRef,
  };
  const inStarMap = frozen.entry === "star_map";
  const starMapView: StarMapOptionalView = {
    available: !inStarMap,
    forced: false,
    label: "在星图中查看",
  };

  const base = {
    entry: frozen.entry,
    group: fourEntryGroup(frozen.entry),
    core,
    completedInPlace: true as const,
    starMapView,
    restoredViewport: null as Readonly<StarMapViewportSnapshot> | null,
    restoredSelection: null as Readonly<StarMapSelectionSnapshot> | null,
    revealRealChange: false,
    capabilityChangeSummary: [] as readonly string[],
    reviewChangeSummary: [] as readonly string[],
    scheduleResult: "none" as ScheduleResultKind,
    unhandledFacts: [] as readonly string[],
    detourOutcome: null as DetourOutcome | null,
  };

  switch (frozen.entry) {
    case "star_map": {
      if (frozen.viewportSnapshot == null || frozen.selectionSnapshot == null) {
        // freeze 已保证非空；防御性 fail closed
        throw new Error("star_map view requires a frozen viewport/selection snapshot");
      }
      return {
        ...base,
        restoredViewport: frozen.viewportSnapshot,
        restoredSelection: frozen.selectionSnapshot,
        revealRealChange: true,
      };
    }
    case "card":
      return {
        ...base,
        capabilityChangeSummary: frozen.completionSummary.capabilityChangeSummary,
        reviewChangeSummary: frozen.completionSummary.reviewChangeSummary,
        scheduleResult: frozen.completionSummary.scheduleResult,
      };
    case "review":
    case "now":
      return {
        ...base,
        scheduleResult: frozen.completionSummary.scheduleResult,
        unhandledFacts: frozen.completionSummary.unhandledFacts,
      };
    case "tutor_detour": {
      const outcome = options.detourOutcome ?? "return_to_episode";
      if (
        outcome !== "return_to_episode" &&
        outcome !== "keep_as_practice" &&
        outcome !== "explicit_end"
      ) {
        throw new Error(`invalid detour outcome: ${outcome}`);
      }
      return { ...base, detourOutcome: outcome };
    }
  }
}

/** 四入口结果一致：全部视图共享同一 Session/Episode 内核引用（§3 四入口） */
export function fourEntriesShareCore(views: readonly Readonly<FourEntryView>[]): boolean {
  if (views.length === 0) return true;
  const first = views[0];
  return views.every(
    (view) =>
      view.core.sessionId === first.core.sessionId &&
      view.core.episodeId === first.core.episodeId &&
      view.core.targetKeyPointId === first.core.targetKeyPointId,
  );
}

// ─── 4. 学习卡状态 ≠ 用户理解（§8 / 07-5）──────────────────────────────

/**
 * 学习卡事件分类。只有 trusted contract 的验证/复习事件能改变个人理解投影：
 * - `asset_published`：资产过生成与证据 Gate（是资产状态，不是理解）；
 * - `opened` / `listened` / `favorited`：只表示接触；
 * - `tutor_explained`：Tutor 解释只产生 practice 事件；
 * - `trusted_validation` / `trusted_review`：唯一能改变理解投影的来源。
 */
export type CardEventKind =
  | "asset_published"
  | "opened"
  | "listened"
  | "favorited"
  | "tutor_explained"
  | "trusted_validation"
  | "trusted_review";

export type UnderstandingProjectionEffect =
  | "no_change"
  | "practice_event"
  | "understanding_change";

export function classifyCardEvent(kind: CardEventKind): UnderstandingProjectionEffect {
  switch (kind) {
    case "trusted_validation":
    case "trusted_review":
      return "understanding_change";
    case "tutor_explained":
      return "practice_event";
    default:
      return "no_change";
  }
}

/** 学习卡状态事件（供组件/摘要消费：事件 → 理解投影效果） */
export interface CardStateEvent {
  kind: CardEventKind;
  atEpoch: number;
}

/**
 * 从学习卡事件序列投影理解效果（学习卡状态 ≠ 用户理解）：
 * - 无 trusted 事件 → 0 理解投影变化（发布/打开/收听/收藏只是接触）；
 * - Tutor 解释 → 只产生 practice 事件；
 * - trusted 验证/复习 → understandingChange（唯一变化来源）。
 */
export function projectCardStateEffects(events: readonly CardStateEvent[]): {
  understandingChange: number;
  practiceEvents: number;
  contactOnly: number;
} {
  let understandingChange = 0;
  let practiceEvents = 0;
  let contactOnly = 0;
  for (const event of events) {
    const effect = classifyCardEvent(event.kind);
    if (effect === "understanding_change") understandingChange += 1;
    else if (effect === "practice_event") practiceEvents += 1;
    else contactOnly += 1;
  }
  return { understandingChange, practiceEvents, contactOnly };
}

/** completion 变化事件：只有 trusted 事件进入摘要 */
export type CompletionEvent =
  | { kind: "trusted_validation"; facet: string }
  | { kind: "trusted_review"; facet: string; scheduleNote?: string }
  | { kind: "practice"; facet?: string }
  | { kind: "contact" };

export interface CompletionSummaryView {
  readonly capabilityChangeSummary: readonly string[];
  readonly reviewChangeSummary: readonly string[];
  readonly scheduleResult: ScheduleResultKind;
  readonly unhandledFacts: readonly string[];
  /** 变化全部来自 trusted contract（练习/接触事件进入摘要为 0） */
  readonly fromTrustedContractOnly: true;
}

/**
 * 依据 PREPARE 冻结的 contract 构建 completion summary（origin-aware completion）。
 * 只接受 trusted 验证/复习事件；practice/contact 事件进入摘要为 0（§10.4
 * 浏览/打开/停留/收藏/朗读/看过答案不能点亮理解）。
 */
export function buildCompletionSummary(
  contract: Readonly<CompletionSummaryContract>,
  events: readonly CompletionEvent[],
): CompletionSummaryView {
  const capability = new Set<string>();
  const review = new Set<string>();
  for (const event of events) {
    if (event.kind === "trusted_validation") {
      if (event.facet.length > 0) capability.add(event.facet);
    } else if (event.kind === "trusted_review") {
      if (event.facet.length > 0) capability.add(event.facet);
      if (event.scheduleNote && event.scheduleNote.length > 0) review.add(event.scheduleNote);
    }
    // practice / contact：不进入摘要
  }
  return {
    capabilityChangeSummary: [...capability].sort(),
    reviewChangeSummary: [...review].sort(),
    scheduleResult: contract.scheduleResult,
    unhandledFacts: contract.unhandledFacts,
    fromTrustedContractOnly: true,
  };
}

// ─── 5. 内容工具 exposure 与 assistance cooldown（§8 / 07-5）───────────

/** 一次内容工具的实际暴露记录（朗读/查看/Tutor 按实际暴露内容记录 exposure，02-8） */
export interface ToolExposureRecord {
  tool: LearningCardTool;
  /** learning-unit exposure 键（02-8 contentExposureKey 语义） */
  contentExposureKey: string;
  /** 暴露发生的时刻（与 frozenEpoch 同刻尺） */
  atEpoch: number;
}

/** 记录一次内容工具 exposure（纯记录函数；是否调用由「实际暴露」决定） */
export function recordToolExposure(input: ToolExposureRecord): ToolExposureRecord {
  if (!LEARNING_CARD_TOOLS.includes(input.tool)) {
    throw new Error(`invalid learning card tool: ${input.tool}`);
  }
  if (typeof input.contentExposureKey !== "string" || input.contentExposureKey.length === 0) {
    throw new Error("contentExposureKey must be a non-empty string");
  }
  return { ...input };
}

export interface JourneyReadiness {
  /** 是否处于 assistance cooldown（随后开始航程必须遵守） */
  readonly inAssistanceCooldown: boolean;
  /** cooldown 截止时刻（无活跃 exposure → null） */
  readonly cooldownUntilEpoch: number | null;
  /** 冷却期内开始航程 → practice_only（不制造「已掌握」；旅程 E 冷却后再独立验证） */
  readonly journeyMode: "formal" | "practice_only";
  /** 是否可能产生 trusted 验证/复习（改变理解投影） */
  readonly trustedEligible: boolean;
}

/**
 * 判定随后开始航程必须遵守的 assistance cooldown（§8：朗读/查看/Tutor 按实际暴露
 * 内容记录 exposure，随后开始航程必须遵守 assistance cooldown）。
 *
 * - 无 exposure → `formal`（可 trusted 验证）；
 * - 存在 exposure 且 `nowEpoch` 在 `atEpoch + cooldownWindowEpochs` 内 →
 *   `practice_only`（不制造「已掌握」，旅程 E）；
 * - exposure 已过 cooldown 窗口 → 冷却后再独立验证（恢复 `formal`）。
 */
export function resolveJourneyReadiness(
  exposures: readonly ToolExposureRecord[],
  options: { nowEpoch: number; cooldownWindowEpochs: number },
): JourneyReadiness {
  const active = exposures
    .filter((exposure) => options.nowEpoch < exposure.atEpoch + options.cooldownWindowEpochs)
    .sort((left, right) => left.atEpoch - right.atEpoch);
  if (active.length === 0) {
    return {
      inAssistanceCooldown: false,
      cooldownUntilEpoch: null,
      journeyMode: "formal",
      trustedEligible: true,
    };
  }
  const cooldownUntilEpoch = active[active.length - 1].atEpoch + options.cooldownWindowEpochs;
  return {
    inAssistanceCooldown: true,
    cooldownUntilEpoch,
    journeyMode: "practice_only",
    trustedEligible: false,
  };
}
