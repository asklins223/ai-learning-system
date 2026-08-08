/**
 * route-launcher.ts（阶段 06 / W5，任务 06-5：「此刻」轻量路线启动器，§9）
 *
 * 原「Today」任务入口 → 轻量路线启动器：
 * - 询问或沿用可用时间/意图/输入条件；**默认只展示一条有理由的推荐路线**，
 *   点「换一个」才生成并替换；
 * - 支持：换一个、换一组、减少数量、稍后、自由漫游、查看详细到期事实；
 * - 不要求清空、不显示红色欠账、不自动进入下一轮；
 * - 原始 FIFO Review Queue 保留为诊断、历史和回滚入口（本模块不替代它）；
 * - 非强迫恢复：长时间未使用后先询问当前可投入时间；只使用 official scheduler
 *   优先级、canonical gap 和用户当前兴趣选择少量内容；
 * - 未处理 schedule 保留事实，不因不展示而被静默完成或延期；
 * - 用户可随时停止，部分完成不受惩罚；
 * - **`later` 是合法用户选择，不是失败状态**；
 * - **`later/dismiss/stop` 不修改 schedule、偏好或理解状态**（sideEffects 全为
 *   `{kind:"none"}`，唯一允许的副作用是用户明确开始的 `begin_episode`，且它只引用
 *   official schedulingDecisionRef，不写 schedule）。
 *
 * FSRS shadow 隔离（§16.1）：本模块的输入/输出类型**不含任何 FSRS 字段**；排序与
 * 推荐理由只基于 official 事实（prioritySource / reasonCodes / dueAt / canonical）。
 *
 * 全部为纯函数：不读时钟、不改状态、不调外部服务。
 */

// ─── 常量 ──────────────────────────────────────────────────────────────────

/** 单条推荐路线最多目标数 */
export const DEFAULT_MAX_ROUTE_ITEMS = 3;
/** 非强迫恢复只选少量内容（§9） */
export const RECOVERY_MAX_ITEMS = 2;
/** 默认时间预算（分钟）：未提供可用时间时的保守估算 */
export const DEFAULT_BUDGET_MINUTES = 15;
/** 默认每个目标的估算分钟（无更精确估算时） */
export const DEFAULT_MINUTES_PER_ITEM = 5;
/** 默认「长时间未使用」阈值（天）：超过则先询问可投入时间 */
export const LONG_ABSENCE_THRESHOLD_DAYS = 3;

// ─── 类型 ──────────────────────────────────────────────────────────────────

export type RouteIntent = "stabilize" | "clarify" | "transfer" | "explore";
export type RoutePrioritySource =
  | "official_due"
  | "official_overdue"
  | "canonical_gap"
  | "user_selected";
export type RouteAuthorizedAction =
  | "create_initial"
  | "consume_pending"
  | "record_only"
  | "no_effect";
export type RouteEligibilityKind =
  | "initial_validation"
  | "scheduled_review"
  | "repair_revalidation"
  | "ad_hoc_transfer"
  | "practice";

/** 一条合法 Episode 候选（来自 official scheduler 候选集，只含 official 事实） */
export interface RouteCandidate {
  keyPointId: string;
  cardId: string;
  claim: string;
  /** official scheduling decision 引用（Episode plan 持久化字段） */
  schedulingDecisionRef: string;
  prioritySource: RoutePrioritySource;
  authorizedAction: RouteAuthorizedAction;
  eligibilityKind: RouteEligibilityKind;
  dueAt: Date | null;
  overdue: boolean;
  reasonCodes: readonly string[];
  estimatedMinutes: number;
}

/** 一条有理由的推荐路线（默认只展示一条） */
export interface RecommendedRoute {
  keyPointIds: readonly string[];
  items: readonly RouteCandidate[];
  /** 有理由的推荐文案：只基于 official 事实，不引用 FSRS */
  recommendation: string;
  estimatedMinutes: number;
  intent: RouteIntent;
  /** free_roam = 练习模式（practice-only，不影响进度） */
  mode: "recommended" | "free_roam";
}

/** 到期事实（无道德化语言；「查看详细到期事实」输出） */
export interface DueFact {
  keyPointId: string;
  claim: string;
  dueAt: Date | null;
  overdue: boolean;
  prioritySource: RoutePrioritySource;
  reasonCodes: readonly string[];
  /** 到期事实描述（不出现欠账/失败等词） */
  factText: string;
}

/** 唯一允许的副作用：用户明确开始的 Episode（引用 official decision，不写 schedule） */
export type RouteSideEffect =
  | { kind: "begin_episode"; keyPointId: string; schedulingDecisionRef: string }
  | { kind: "none" };

export type RouteLaunchPhase =
  | "ask_time"      // 先询问当前可投入时间（首次/长时间未使用）
  | "recommend"     // 展示默认推荐路线（一条，有理由）
  | "viewing_due"   // 查看详细到期事实
  | "free_roam"     // 自由漫游（practice-only）
  | "done";         // 用户停止/完成；部分完成不受惩罚

export interface RouteLaunchState {
  phase: RouteLaunchPhase;
  /** official 候选（不可变；任何动作都不修改这些 schedule 事实） */
  candidates: readonly RouteCandidate[];
  /** 已展示/已排除的目标（换一个/换一组/关闭后不再自动推荐） */
  excludedKeyPointIds: readonly string[];
  /** 用户选择「稍后」的目标（合法选择；不修改 schedule） */
  laterKeyPointIds: readonly string[];
  currentRoute: RecommendedRoute | null;
  availableMinutes: number | null;
  intent: RouteIntent | null;
  interestKeyPointIds: readonly string[];
  now: Date;
  lastUsedAt: Date | null;
  sideEffects: readonly RouteSideEffect[];
  /** 本状态输出给用户的文本（推荐文案/到期事实/提示） */
  output: string;
}

export interface RouteLaunchContext {
  candidates: readonly RouteCandidate[];
  now: Date;
  lastUsedAt?: Date | null;
  intent?: RouteIntent | null;
  /** 已知可用时间（沿用）；未知则进入 ask_time */
  availableMinutes?: number | null;
  interestKeyPointIds?: readonly string[];
  longAbsenceThresholdDays?: number;
}

// ─── 内部排序 ──────────────────────────────────────────────────────────────

/** 排序键：official 调度优先级（overdue 最高），user_selected 紧随 due 之后 */
function priorityRank(source: RoutePrioritySource): number {
  switch (source) {
    case "official_overdue":
      return 0;
    case "official_due":
    case "user_selected":
      return 1;
    case "canonical_gap":
      return 2;
  }
}

function compareKeyPointId(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// ─── 到期事实文本（无红账）─────────────────────────────────────────────────

function describeDueFact(candidate: RouteCandidate, now: Date): string {
  const days = candidate.dueAt
    ? Math.max(0, Math.floor((now.getTime() - candidate.dueAt.getTime()) / (24 * 60 * 60 * 1_000)))
    : 0;
  const dueText = candidate.overdue
    ? `已到期 ${days} 天`
    : candidate.dueAt
      ? `今天到期`
      : `无到期安排`;
  return (
    `${candidate.claim}（${candidate.keyPointId}）：${dueText}；` +
    `官方调度优先级 ${candidate.prioritySource}；原因：${candidate.reasonCodes.join("、")}`
  );
}

// ─── 推荐文案（只基于 official 事实）───────────────────────────────────────

function buildRecommendation(route: RecommendedRoute): string {
  if (route.mode === "free_roam") {
    return "自由漫游 · 练习模式，不影响进度（不消费 schedule）。";
  }
  const dueCount = route.items.filter(
    (c) => c.prioritySource === "official_due" || c.prioritySource === "official_overdue",
  ).length;
  const first = route.keyPointIds[0];
  const name = route.keyPointIds.join("、");
  const time = `预计 ${route.estimatedMinutes} 分钟`;
  if (dueCount > 0) {
    return (
      `有 ${dueCount} 个到期复习目标（${name}），${time}；` +
      `按官方调度优先级，推荐从 ${first} 开始。`
    );
  }
  if (route.intent === "explore") {
    return `自由练习建议（${name}），${time}；不改变任何进度。`;
  }
  return `没有到期复习；推荐从 ${first} 巩固一个能力切面（${name}），${time}。`;
}

// ─── 构建推荐路线（内部）───────────────────────────────────────────────────

export interface BuildRouteOptions {
  now: Date;
  availableMinutes?: number | null;
  intent?: RouteIntent | null;
  interestKeyPointIds?: readonly string[];
  excludeKeyPointIds?: readonly string[];
  laterKeyPointIds?: readonly string[];
  maxItems?: number;
  freeRoam?: boolean;
}

/**
 * 从合法候选构建一条推荐路线（默认只生成一条；§9）。
 * 排序只使用 official 事实（prioritySource + 兴趣 + 确定性 keyPointId）；
 * 受可用时间预算裁剪；freeRoam 模式强制 practice-only 文案。
 */
export function buildRecommendedRoute(
  candidates: readonly RouteCandidate[],
  opts: BuildRouteOptions,
): RecommendedRoute | null {
  const exclude = new Set(opts.excludeKeyPointIds ?? []);
  const later = new Set(opts.laterKeyPointIds ?? []);
  const interest = new Set(opts.interestKeyPointIds ?? []);
  const maxItems = Math.max(1, opts.maxItems ?? DEFAULT_MAX_ROUTE_ITEMS);
  const budgetMinutes = opts.availableMinutes ?? DEFAULT_BUDGET_MINUTES;
  const intent = opts.intent ?? "stabilize";

  const eligible = candidates
    .filter((c) => !exclude.has(c.keyPointId) && !later.has(c.keyPointId))
    .map((c) => ({ candidate: c, rank: priorityRank(c.prioritySource) }))
    .sort((a, b) => {
      const interestA = interest.has(a.candidate.keyPointId) ? -1 : 0;
      const interestB = interest.has(b.candidate.keyPointId) ? -1 : 0;
      if (interestA !== interestB) return interestA - interestB;
      if (a.rank !== b.rank) return a.rank - b.rank;
      return compareKeyPointId(a.candidate.keyPointId, b.candidate.keyPointId);
    });

  const items: RouteCandidate[] = [];
  let usedMinutes = 0;
  for (const entry of eligible) {
    if (items.length >= maxItems) break;
    const minutes = Math.max(1, entry.candidate.estimatedMinutes);
    if (usedMinutes + minutes > budgetMinutes) continue;
    items.push(entry.candidate);
    usedMinutes += minutes;
  }
  if (items.length === 0) return null;

  const route: RecommendedRoute = {
    keyPointIds: items.map((c) => c.keyPointId),
    items,
    recommendation: "",
    estimatedMinutes: usedMinutes,
    intent,
    mode: opts.freeRoam === true ? "free_roam" : "recommended",
  };
  route.recommendation = buildRecommendation(route);
  return route;
}

// ─── 非强迫恢复判定 ────────────────────────────────────────────────────────

/**
 * 是否应先询问可投入时间：首次进入（无 lastUsedAt）或长时间未使用
 * （now - lastUsedAt ≥ 阈值，默认 3 天）→ true（§9 非强迫恢复）。
 */
export function shouldAskTimeFirst(
  lastUsedAt: Date | null,
  now: Date,
  thresholdDays = LONG_ABSENCE_THRESHOLD_DAYS,
): boolean {
  if (lastUsedAt === null) return true;
  const elapsedDays = (now.getTime() - lastUsedAt.getTime()) / (24 * 60 * 60 * 1_000);
  return elapsedDays >= thresholdDays;
}

// ─── 状态机动作 ────────────────────────────────────────────────────────────

/** 创建启动器：默认只生成并展示一条推荐路线；长时间未使用/未知时间 → ask_time */
export function createRouteLauncher(context: RouteLaunchContext): RouteLaunchState {
  const now = context.now;
  const lastUsedAt = context.lastUsedAt ?? null;
  const threshold = context.longAbsenceThresholdDays ?? LONG_ABSENCE_THRESHOLD_DAYS;
  const knownTime =
    context.availableMinutes !== undefined && context.availableMinutes !== null;

  if (!knownTime && shouldAskTimeFirst(lastUsedAt, now, threshold)) {
    return {
      phase: "ask_time",
      candidates: [...context.candidates],
      excludedKeyPointIds: [],
      laterKeyPointIds: [],
      currentRoute: null,
      availableMinutes: null,
      intent: context.intent ?? null,
      interestKeyPointIds: [...(context.interestKeyPointIds ?? [])],
      now,
      lastUsedAt,
      sideEffects: [],
      output: "这轮想投入多久？3 / 10 / 20 分钟或自定义（不开始也可以，随时能回来）。",
    };
  }

  const route = buildRecommendedRoute(context.candidates, {
    now,
    availableMinutes: knownTime ? context.availableMinutes : null,
    intent: context.intent ?? null,
    interestKeyPointIds: context.interestKeyPointIds ?? [],
  });
  return {
    phase: "recommend",
    candidates: [...context.candidates],
    excludedKeyPointIds: [],
    laterKeyPointIds: [],
    currentRoute: route,
    availableMinutes: knownTime ? (context.availableMinutes ?? null) : null,
    intent: context.intent ?? null,
    interestKeyPointIds: [...(context.interestKeyPointIds ?? [])],
    now,
    lastUsedAt,
    sideEffects: [],
    output: route === null ? "暂时没有可推荐的路线；可以自由漫游或稍后再来。" : route.recommendation,
  };
}

/** 回答可用时间（非强迫恢复的关键一步） */
export function answerAvailableTime(state: RouteLaunchState, minutes: number): RouteLaunchState {
  if (!Number.isFinite(minutes)) {
    return { ...state, output: "请输入有效的分钟数（3 / 10 / 20 或自定义）。" };
  }
  const rounded = Math.floor(minutes);
  if (rounded <= 0) {
    // 0 分钟 = 现在不开始；合法，不产生任何副作用
    return {
      ...state,
      phase: "done",
      availableMinutes: null,
      sideEffects: [...state.sideEffects, { kind: "none" }],
      output: "好的，稍后再来也可以；进度不会有任何变化。",
    };
  }
  const route = buildRecommendedRoute(state.candidates, {
    now: state.now,
    availableMinutes: rounded,
    intent: state.intent,
    interestKeyPointIds: state.interestKeyPointIds,
  });
  return {
    ...state,
    phase: "recommend",
    availableMinutes: rounded,
    currentRoute: route,
    sideEffects: [...state.sideEffects, { kind: "none" }],
    output: route === null
      ? "这个时长内没有合适的推荐；可以自由漫游或缩短时长。"
      : route.recommendation,
  };
}

/** 回答意图（沿用/更新输入条件） */
export function answerIntent(state: RouteLaunchState, intent: RouteIntent): RouteLaunchState {
  if (state.phase !== "recommend" && state.phase !== "ask_time") {
    return { ...state, output: state.output };
  }
  const route = buildRecommendedRoute(state.candidates, {
    now: state.now,
    availableMinutes: state.availableMinutes,
    intent,
    interestKeyPointIds: state.interestKeyPointIds,
    excludeKeyPointIds: state.excludedKeyPointIds,
    laterKeyPointIds: state.laterKeyPointIds,
  });
  return {
    ...state,
    phase: "recommend",
    intent,
    currentRoute: route,
    output: route === null ? "这个意图下暂无推荐；可以自由漫游或稍后再来。" : route.recommendation,
  };
}

/** 换一个：排除当前推荐目标，生成并替换成一条新推荐（不自动连续换） */
export function replaceRoute(state: RouteLaunchState): RouteLaunchState {
  const excluded = new Set(state.excludedKeyPointIds);
  for (const id of state.currentRoute?.keyPointIds ?? []) excluded.add(id);
  const route = buildRecommendedRoute(state.candidates, {
    now: state.now,
    availableMinutes: state.availableMinutes,
    intent: state.intent,
    interestKeyPointIds: state.interestKeyPointIds,
    excludeKeyPointIds: [...excluded],
    laterKeyPointIds: state.laterKeyPointIds,
  });
  return {
    ...state,
    phase: "recommend",
    excludedKeyPointIds: [...excluded],
    currentRoute: route,
    sideEffects: [...state.sideEffects, { kind: "none" }],
    output: route === null
      ? "没有更多可换的目标了；可以自由漫游、查看到期事实或稍后再来。"
      : route.recommendation,
  };
}

/** 换一组：排除当前推荐 + 全部历史排除 + later，换成一批不同目标组合 */
export function shiftGroup(state: RouteLaunchState): RouteLaunchState {
  const excluded = new Set(state.excludedKeyPointIds);
  for (const id of state.currentRoute?.keyPointIds ?? []) excluded.add(id);
  const route = buildRecommendedRoute(state.candidates, {
    now: state.now,
    availableMinutes: state.availableMinutes,
    intent: state.intent,
    interestKeyPointIds: state.interestKeyPointIds,
    excludeKeyPointIds: [...excluded],
    laterKeyPointIds: state.laterKeyPointIds,
    maxItems: DEFAULT_MAX_ROUTE_ITEMS,
  });
  const isDifferent =
    route !== null &&
    (state.currentRoute === null ||
      route.keyPointIds.some((id) => !state.currentRoute!.keyPointIds.includes(id)));
  return {
    ...state,
    phase: "recommend",
    excludedKeyPointIds: [...excluded],
    currentRoute: isDifferent ? route : null,
    sideEffects: [...state.sideEffects, { kind: "none" }],
    output:
      route === null || !isDifferent
        ? "没有更多可换的一组目标了；可以自由漫游或稍后再来。"
        : `换了一组：${route.recommendation}`,
  };
}

/** 减少数量：把当前推荐缩短到前 targetCount 个目标 */
export function shrinkRoute(state: RouteLaunchState, targetCount: number): RouteLaunchState {
  const route = state.currentRoute;
  if (route === null) {
    return { ...state, output: "当前没有可缩短的推荐路线。" };
  }
  const count = Math.max(1, Math.floor(targetCount));
  const items = route.items.slice(0, count);
  const shrunk: RecommendedRoute = {
    ...route,
    keyPointIds: items.map((c) => c.keyPointId),
    items,
    estimatedMinutes: items.reduce((sum, c) => sum + Math.max(1, c.estimatedMinutes), 0),
  };
  shrunk.recommendation = buildRecommendation(shrunk);
  return {
    ...state,
    phase: "recommend",
    currentRoute: shrunk,
    sideEffects: [...state.sideEffects, { kind: "none" }],
    output: `已缩短为 ${items.length} 个目标：${shrunk.recommendation}`,
  };
}

/**
 * 稍后：把目标从当前推荐中移走并记入 later（合法用户选择，不是失败状态）。
 * **不修改 schedule、偏好或理解状态**（sideEffects 只追加 {kind:"none"}）。
 */
export function deferLater(state: RouteLaunchState, keyPointId: string): RouteLaunchState {
  const route = state.currentRoute;
  if (route === null || !route.keyPointIds.includes(keyPointId)) {
    return { ...state, output: state.output };
  }
  const items = route.items.filter((c) => c.keyPointId !== keyPointId);
  const later = new Set(state.laterKeyPointIds);
  later.add(keyPointId);
  if (items.length === 0) {
    // 目标全部稍后：不自动进入下一轮，不生成替代（§9「不自动进入下一轮」）
    return {
      ...state,
      laterKeyPointIds: [...later],
      currentRoute: null,
      sideEffects: [...state.sideEffects, { kind: "none" }],
      output: "这条路线先不开始；可以换一个、自由漫游或稍后再来。",
    };
  }
  const next: RecommendedRoute = {
    ...route,
    keyPointIds: items.map((c) => c.keyPointId),
    items,
    estimatedMinutes: items.reduce((sum, c) => sum + Math.max(1, c.estimatedMinutes), 0),
  };
  next.recommendation = buildRecommendation(next);
  return {
    ...state,
    laterKeyPointIds: [...later],
    currentRoute: next,
    sideEffects: [...state.sideEffects, { kind: "none" }],
    output: `已把 ${keyPointId} 稍后（不改变任何进度）；剩余：${next.recommendation}`,
  };
}

/** 关闭当前推荐（dismiss）：不自动推荐下一条，不产生任何副作用 */
export function dismissRoute(state: RouteLaunchState): RouteLaunchState {
  const excluded = new Set(state.excludedKeyPointIds);
  for (const id of state.currentRoute?.keyPointIds ?? []) excluded.add(id);
  return {
    ...state,
    phase: "recommend",
    excludedKeyPointIds: [...excluded],
    currentRoute: null,
    sideEffects: [...state.sideEffects, { kind: "none" }],
    output: "已关闭这条推荐；可以换一个、查看到期事实、自由漫游或稍后再来。",
  };
}

/** 查看详细到期事实（不改变任何 schedule；事实语言，无红色欠账） */
export function viewDueFacts(state: RouteLaunchState): RouteLaunchState {
  const facts: DueFact[] = state.candidates
    .filter((c) => c.dueAt !== null || c.overdue)
    .map((c) => ({
      keyPointId: c.keyPointId,
      claim: c.claim,
      dueAt: c.dueAt,
      overdue: c.overdue,
      prioritySource: c.prioritySource,
      reasonCodes: c.reasonCodes,
      factText: describeDueFact(c, state.now),
    }))
    .sort((a, b) => {
      const rankA = a.overdue ? 0 : 1;
      const rankB = b.overdue ? 0 : 1;
      if (rankA !== rankB) return rankA - rankB;
      return compareKeyPointId(a.keyPointId, b.keyPointId);
    });
  const body =
    facts.length === 0
      ? "当前没有到期的复习安排。"
      : facts.map((f) => `- ${f.factText}`).join("\n");
  return {
    ...state,
    phase: "viewing_due",
    currentRoute: null,
    sideEffects: [...state.sideEffects, { kind: "none" }],
    output: `到期事实（仅事实，不影响进度）：\n${body}`,
  };
}

/** 自由漫游：practice-only，不影响进度，不消费 schedule */
export function startFreeRoam(state: RouteLaunchState): RouteLaunchState {
  const route = buildRecommendedRoute(state.candidates, {
    now: state.now,
    availableMinutes: state.availableMinutes,
    intent: "explore",
    interestKeyPointIds: state.interestKeyPointIds,
    excludeKeyPointIds: state.excludedKeyPointIds,
    laterKeyPointIds: state.laterKeyPointIds,
    maxItems: RECOVERY_MAX_ITEMS,
    freeRoam: true,
  });
  return {
    ...state,
    phase: "free_roam",
    currentRoute: route,
    sideEffects: [...state.sideEffects, { kind: "none" }],
    output: route === null
      ? "自由漫游暂无可练习内容；稍后再来也可以。"
      : route.recommendation,
  };
}

/** 停止：部分完成不受惩罚；**不自动进入下一轮** */
export function stop(state: RouteLaunchState): RouteLaunchState {
  return {
    ...state,
    phase: "done",
    currentRoute: null,
    sideEffects: [...state.sideEffects, { kind: "none" }],
    output: "已停止；今天做到这里就很好。随时可以再回来。",
  };
}

/** 显式请求下一轮才进入下一轮（绝不自动）：重新生成推荐，排除已展示目标 */
export function requestNextRound(state: RouteLaunchState): RouteLaunchState {
  const route = buildRecommendedRoute(state.candidates, {
    now: state.now,
    availableMinutes: state.availableMinutes,
    intent: state.intent,
    interestKeyPointIds: state.interestKeyPointIds,
    excludeKeyPointIds: state.excludedKeyPointIds,
    laterKeyPointIds: state.laterKeyPointIds,
  });
  return {
    ...state,
    phase: "recommend",
    currentRoute: route,
    sideEffects: [...state.sideEffects, { kind: "none" }],
    output: route === null
      ? "没有更多可推荐的目标了；可以自由漫游或结束。"
      : `下一轮：${route.recommendation}`,
  };
}

/**
 * 用户明确开始一个目标：唯一允许的副作用（引用 official decisionRef）。
 * 它**不写 schedule**——schedule 修改只由 official 决策 + commit 阶段决定。
 */
export function selectToBegin(state: RouteLaunchState, keyPointId: string): RouteLaunchState {
  const route = state.currentRoute;
  const target = route?.items.find((c) => c.keyPointId === keyPointId);
  if (target === undefined) {
    return { ...state, output: "该目标不在当前推荐路线中；请先选择一条路线。" };
  }
  const effect: RouteSideEffect = {
    kind: "begin_episode",
    keyPointId,
    schedulingDecisionRef: target.schedulingDecisionRef,
  };
  return {
    ...state,
    sideEffects: [...state.sideEffects, effect],
    output: `开始 ${keyPointId}。`,
  };
}
