/**
 * 任务 05-4：CompanionVisualStateV1 —— 伴星视觉状态契约（冻结记录 01-8 §7 / 原方案 §5.2/§5.3）。
 *
 * 本文件是纯逻辑（无 React / 无 DOM），负责：
 * - 11 个视觉状态的枚举、合法性守卫与读屏标签；
 * - typed spatial actions（9 个，§5.3）白名单与「模型不能返回任意 DOM/CSS/HTML/脚本」校验；
 * - spatial action / 系统事件 → 视觉状态的权威映射（动画只表达已发生的系统状态）；
 * - assessment_handoff 语义（收起工具 / 退到场景边缘 / 独立观测环接管，表达伴星不参与判分）；
 * - reduced-motion / 资产加载失败 / hidden / quiet 的降级解析（resolveCompanionPresentation）；
 * - 状态 → 展示姿态描述（companionPoseForState），供组件静态呈现。
 *
 * 不变量：
 * - 任何视觉状态都必须由「已发生的系统事件」映射而来（eventAllowsVisualState）；
 * - assessment_handoff 只能由 assessment_started 事件表达，动画自身不得推进评估进度；
 * - committed_change 不做烟花/连胜/夸张庆功（01-8 §7）；
 * - reduced-motion 下取消飞行 / 弹性缩放 / 视差 / 持续漂浮（01-8 §9 / 02-10 §8.2）。
 */

// ─── 1. CompanionVisualStateV1 枚举 ─────────────────────────────────────

/** 11 个视觉状态（完整边界见冻结记录 01-8 §7，名称与顺序冻结不变） */
export const COMPANION_VISUAL_STATES = [
  "dormant",
  "invite_once",
  "navigate",
  "present_evidence",
  "listen",
  "co_manipulate",
  "explain",
  "assessment_handoff",
  "committed_change",
  "uncertain_or_retry",
  "exit_or_hidden",
] as const;

export type CompanionVisualStateV1 = (typeof COMPANION_VISUAL_STATES)[number];

const COMPANION_VISUAL_STATE_SET: ReadonlySet<string> = new Set(COMPANION_VISUAL_STATES);

/** 值是否为合法视觉状态（fail-closed：未知字符串不是合法状态） */
export function isCompanionVisualState(value: unknown): value is CompanionVisualStateV1 {
  return typeof value === "string" && COMPANION_VISUAL_STATE_SET.has(value);
}

/** 读屏 / 语义标签（颜色与动画都不是唯一信息载体，文字始终可用，§13.4） */
export const COMPANION_STATE_LABEL: Record<CompanionVisualStateV1, string> = {
  dormant: "待机（未召唤，静态中性锚点）",
  invite_once: "发出一次邀请",
  navigate: "正在导航星图",
  present_evidence: "正在呈现证据",
  listen: "正在倾听",
  co_manipulate: "与你共同操作",
  explain: "正在讲解",
  assessment_handoff: "已交接独立评估（伴星不参与判分）",
  committed_change: "已记录你的变化",
  uncertain_or_retry: "不确定，建议重试",
  exit_or_hidden: "已退场或隐藏",
};

// ─── 2. typed spatial actions（§5.3，9 个；与 workers 工具 manifest 同名同语义）──

/**
 * 伴星优先使用的 typed spatial actions。模型只能返回这些动作，
 * 不能返回任意 DOM、CSS、HTML 或脚本（01-3 §4 / 05-4 §5.3）。
 */
export const COMPANION_SPATIAL_ACTIONS = [
  "focus_nodes",
  "draw_route",
  "stage_scene",
  "read_prompt",
  "offer_branch",
  "show_change",
  "return_to_origin",
  "end_session",
  "propose_curiosity_save",
] as const;

export type CompanionSpatialAction = (typeof COMPANION_SPATIAL_ACTIONS)[number];

const COMPANION_SPATIAL_ACTION_SET: ReadonlySet<string> = new Set(COMPANION_SPATIAL_ACTIONS);

/** 值是否为合法 typed spatial action（fail-closed） */
export function isCompanionSpatialAction(value: unknown): value is CompanionSpatialAction {
  return typeof value === "string" && COMPANION_SPATIAL_ACTION_SET.has(value);
}

/** 标记任意 DOM/CSS/HTML/脚本形态内容的启发式子串（大小写不敏感） */
const NON_SPATIAL_MARKERS: readonly string[] = [
  "<script",
  "<style",
  "<svg",
  "<img",
  "javascript:",
  "data:text/html",
  "onerror=",
  "onclick=",
];

/**
 * 校验动作/文本是否含非 spatial 形态内容（任意 DOM/CSS/HTML/脚本字符串一律拒绝）。
 * 非字符串、空串或含标记 → true（不是合法 typed action 承载，fail-closed）。
 */
export function containsNonSpatialMarkup(value: unknown): boolean {
  if (typeof value !== "string") return true;
  if (value.length === 0) return true;
  const lower = value.toLowerCase();
  return NON_SPATIAL_MARKERS.some((marker) => lower.includes(marker));
}

// ─── 3. spatial action → 视觉状态映射（01-8 §6 八动作语义映射）─────────────

export const SPATIAL_ACTION_TO_STATE: Record<CompanionSpatialAction, CompanionVisualStateV1> = {
  focus_nodes: "navigate",
  draw_route: "navigate",
  stage_scene: "present_evidence",
  read_prompt: "listen",
  offer_branch: "explain",
  show_change: "co_manipulate",
  return_to_origin: "navigate",
  end_session: "exit_or_hidden",
  propose_curiosity_save: "invite_once",
};

/** 动作 → 状态；未知/非法动作 → null（fail-closed） */
export function visualStateForSpatialAction(
  action: unknown,
): CompanionVisualStateV1 | null {
  if (!isCompanionSpatialAction(action)) return null;
  return SPATIAL_ACTION_TO_STATE[action];
}

// ─── 4. 系统事件 → 视觉状态（权威映射，动画只表达已发生的系统状态）────────

/**
 * 已发生的系统事件。视觉状态必须由此映射而来；
 * UI 不得直接设置任意视觉状态而不对应某个真实系统事件。
 */
export type CompanionSystemEvent =
  | { kind: "session_idle" }
  | { kind: "invite_shown" }
  | { kind: "navigation_focused"; nodes: readonly string[] }
  | { kind: "route_drawn" }
  | { kind: "scene_staged" }
  | { kind: "prompt_read" }
  | { kind: "listening" }
  | { kind: "co_manipulating" }
  | { kind: "explaining" }
  | { kind: "branch_offered" }
  | { kind: "change_shown" }
  | { kind: "curiosity_save_proposed" }
  | { kind: "assessment_started" }
  | { kind: "commit_recorded" }
  | { kind: "retry_suggested" }
  | { kind: "session_ended" };

export const COMPANION_SYSTEM_EVENT_KINDS = [
  "session_idle",
  "invite_shown",
  "navigation_focused",
  "route_drawn",
  "scene_staged",
  "prompt_read",
  "listening",
  "co_manipulating",
  "explaining",
  "branch_offered",
  "change_shown",
  "curiosity_save_proposed",
  "assessment_started",
  "commit_recorded",
  "retry_suggested",
  "session_ended",
] as const;

export type CompanionSystemEventKind = (typeof COMPANION_SYSTEM_EVENT_KINDS)[number];

/** 系统事件 → 视觉状态（权威映射，单来源） */
export function visualStateForSystemEvent(
  event: CompanionSystemEvent,
): CompanionVisualStateV1 {
  switch (event.kind) {
    case "session_idle":
      return "dormant";
    case "invite_shown":
    case "curiosity_save_proposed":
      return "invite_once";
    case "navigation_focused":
    case "route_drawn":
      return "navigate";
    case "scene_staged":
      return "present_evidence";
    case "prompt_read":
    case "listening":
      return "listen";
    case "co_manipulating":
    case "change_shown":
      return "co_manipulate";
    case "explaining":
    case "branch_offered":
      return "explain";
    case "assessment_started":
      return "assessment_handoff";
    case "commit_recorded":
      return "committed_change";
    case "retry_suggested":
      return "uncertain_or_retry";
    case "session_ended":
      return "exit_or_hidden";
  }
}

/**
 * 诚实性守卫：事件已发生时，它权威映射到的视觉状态才能被展示。
 * 任何「事件 A 想展示状态 B」且映射不一致的组合都被拒绝（fail-closed），
 * 保证动画只表达已发生的系统状态、不伪装评估进度或 canonical 结果（01-8 §7）。
 */
export function eventAllowsVisualState(
  event: CompanionSystemEvent,
  state: CompanionVisualStateV1,
): boolean {
  return visualStateForSystemEvent(event) === state;
}

/** 事件 kind 是否允许展示该状态（等价守卫的字符串形态，便于日志/测试断言） */
export function eventKindAllowsVisualState(
  kind: CompanionSystemEventKind,
  state: CompanionVisualStateV1,
): boolean {
  return visualStateForSystemEvent({ kind } as CompanionSystemEvent) === state;
}

// ─── 5. assessment_handoff 语义（表达伴星不参与判分）─────────────────────

export interface CompanionHandoffView {
  /** 提示工具（证据卡/提示卡）已收起 */
  toolsRetracted: boolean;
  /** 伴星退到场景边缘 */
  retreatToEdge: boolean;
  /** 独立「观测环」接管验证状态 */
  observerRingActive: boolean;
}

/**
 * assessment_handoff 的可见退场视图：
 * - 仅当系统事件为 assessment_started（真实进入独立评估）时，工具收起、退到边缘、
 *   观测环接管才为 true —— 表达「伴星不参与判分」；
 * - 任何其他事件/状态组合都返回全 false，动画不得自行推进或伪装评估阶段。
 */
export function handoffViewFor(
  event: CompanionSystemEvent | null,
  state: CompanionVisualStateV1,
): CompanionHandoffView {
  const triggered = event !== null
    && event.kind === "assessment_started"
    && state === "assessment_handoff";
  return {
    toolsRetracted: triggered,
    retreatToEdge: triggered,
    observerRingActive: triggered,
  };
}

// ─── 6. reduced-motion / 加载失败 / hidden 降级（01-8 §9 / 02-10 §8）──────

export const COMPANION_MOTION_EFFECTS = [
  "fly",
  "elastic_scale",
  "parallax",
  "float",
] as const;

export type CompanionMotionEffect = (typeof COMPANION_MOTION_EFFECTS)[number];

/** reduced-motion 下取消的全部效果（飞行 / 弹性缩放 / 视差 / 持续漂浮） */
export const COMPANION_CANCELLED_EFFECTS: readonly CompanionMotionEffect[] =
  COMPANION_MOTION_EFFECTS;

export interface CompanionPresentationOptions {
  /** prefers-reduced-motion: reduce（或 animation_off 控制状态，§5.5） */
  prefersReducedMotion?: boolean;
  /** 动画资产（Rive .riv）加载成功；false → 静态立绘/图标化手势 */
  assetLoaded?: boolean;
  /** temporary_hidden / global_off 等隐藏控制状态（§5.5）：立即停渲染 */
  hidden?: boolean;
  /** quiet 未召唤：只允许静态中性锚点，不得进入 idle 动画（01-8 §7） */
  quiet?: boolean;
}

export type CompanionRenderMode = "animated" | "static" | "hidden";

/** 静态/降级时仍表达语义的图标化手势（颜色与动画不是唯一信息载体，§13.4） */
export type CompanionGestureIcon =
  | "none"
  | "point"
  | "wave"
  | "listen"
  | "ring_observe"
  | "exit";

export interface CompanionPresentation {
  state: CompanionVisualStateV1;
  renderMode: CompanionRenderMode;
  /** 是否允许动画（reduced-motion / 资产失败 → false） */
  motionEnabled: boolean;
  /** 静态呈现下用于表达语义的图标化手势（无 → "none"） */
  gestureIcon: CompanionGestureIcon;
  /** 读屏/语义标签（始终存在，不依赖视觉） */
  ariaLabel: string;
  /** reduced-motion 下被取消的效果清单（供测试断言与注释） */
  cancelledEffects: readonly CompanionMotionEffect[];
}

function gestureForState(state: CompanionVisualStateV1): CompanionGestureIcon {
  switch (state) {
    case "dormant":
    case "committed_change":
      return "none";
    case "invite_once":
      return "wave";
    case "navigate":
    case "present_evidence":
    case "co_manipulate":
    case "explain":
      return "point";
    case "listen":
      return "listen";
    case "assessment_handoff":
      return "ring_observe";
    case "uncertain_or_retry":
      return "point";
    case "exit_or_hidden":
      return "exit";
  }
}

/**
 * 解析最终呈现方案（降级逻辑）：
 * - hidden（temporary_hidden/global_off）→ 立即停渲染（hidden）；
 * - exit_or_hidden + reduced-motion → 直接消失（01-8 §7「直接消失」）；
 * - 资产加载失败 → 静态立绘 + 图标化手势（标准控件继续可用，01-8 §9）；
 * - reduced-motion → 静态呈现，取消飞行/弹性缩放/视差/持续漂浮；
 * - quiet + dormant → 静态中性锚点（不进入 idle 动画）；
 * - 其余 → 动画呈现（motionEnabled = 资产已加载且非 reduced-motion）。
 */
export function resolveCompanionPresentation(
  state: CompanionVisualStateV1,
  options: CompanionPresentationOptions = {},
): CompanionPresentation {
  const { prefersReducedMotion = false, assetLoaded = true, hidden = false, quiet = false } = options;
  const ariaLabel = COMPANION_STATE_LABEL[state];
  const cancelledEffects: readonly CompanionMotionEffect[] = prefersReducedMotion
    ? COMPANION_CANCELLED_EFFECTS
    : [];

  if (hidden) {
    return {
      state,
      renderMode: "hidden",
      motionEnabled: false,
      gestureIcon: "none",
      ariaLabel,
      cancelledEffects,
    };
  }

  if (state === "exit_or_hidden" && prefersReducedMotion) {
    return {
      state,
      renderMode: "hidden",
      motionEnabled: false,
      gestureIcon: "none",
      ariaLabel,
      cancelledEffects,
    };
  }

  const reduced = prefersReducedMotion || !assetLoaded;
  if (reduced || (quiet && state === "dormant")) {
    return {
      state,
      renderMode: "static",
      motionEnabled: false,
      gestureIcon: gestureForState(state),
      ariaLabel,
      cancelledEffects,
    };
  }

  return {
    state,
    renderMode: "animated",
    motionEnabled: true,
    gestureIcon: gestureForState(state),
    ariaLabel,
    cancelledEffects,
  };
}

// ─── 7. 状态 → 展示姿态描述（供 CompanionAvatar 静态呈现）─────────────────

export interface CompanionPose {
  /** 眼睛形态 */
  eyes: "open" | "focus" | "closed";
  /** 嘴形态 */
  mouth: "neutral" | "speaking" | "smile";
  /** 手部姿态 */
  hand: "down" | "point" | "ring_hold" | "wave";
  /** 导航环（可变形态） */
  ring: "full" | "partial" | "hidden";
  /** 围巾式彗尾可见 */
  comet: boolean;
  /** 发光星纹 */
  starGlow: boolean;
  /** 提示工具（证据卡/提示卡）可见 */
  toolVisible: boolean;
  /** 退到场景边缘（assessment_handoff） */
  edgePosition: boolean;
  /** 独立观测环接管（assessment_handoff） */
  observerRing: boolean;
}

/**
 * 视觉状态 → 展示姿态（静态数据，纯函数）。
 * 姿态只表达已发生的状态语义；不含任何「评估进度 / canonical 结果」暗示。
 */
export function companionPoseForState(state: CompanionVisualStateV1): CompanionPose {
  switch (state) {
    case "dormant":
      return {
        eyes: "closed",
        mouth: "neutral",
        hand: "down",
        ring: "hidden",
        comet: true,
        starGlow: false,
        toolVisible: false,
        edgePosition: false,
        observerRing: false,
      };
    case "invite_once":
      return {
        eyes: "open",
        mouth: "smile",
        hand: "wave",
        ring: "partial",
        comet: true,
        starGlow: true,
        toolVisible: false,
        edgePosition: false,
        observerRing: false,
      };
    case "navigate":
      return {
        eyes: "focus",
        mouth: "neutral",
        hand: "point",
        ring: "full",
        comet: true,
        starGlow: true,
        toolVisible: false,
        edgePosition: false,
        observerRing: false,
      };
    case "present_evidence":
      return {
        eyes: "open",
        mouth: "neutral",
        hand: "ring_hold",
        ring: "partial",
        comet: true,
        starGlow: true,
        toolVisible: true,
        edgePosition: false,
        observerRing: false,
      };
    case "listen":
      return {
        eyes: "open",
        mouth: "neutral",
        hand: "down",
        ring: "partial",
        comet: true,
        starGlow: true,
        toolVisible: true,
        edgePosition: false,
        observerRing: false,
      };
    case "co_manipulate":
      return {
        eyes: "focus",
        mouth: "neutral",
        hand: "ring_hold",
        ring: "full",
        comet: true,
        starGlow: true,
        toolVisible: true,
        edgePosition: false,
        observerRing: false,
      };
    case "explain":
      return {
        eyes: "focus",
        mouth: "speaking",
        hand: "point",
        ring: "full",
        comet: true,
        starGlow: true,
        toolVisible: true,
        edgePosition: false,
        observerRing: false,
      };
    case "assessment_handoff":
      // 工具收起、退到边缘、观测环接管 —— 表达「伴星不参与判分」的可见退场
      return {
        eyes: "open",
        mouth: "neutral",
        hand: "down",
        ring: "partial",
        comet: true,
        starGlow: true,
        toolVisible: false,
        edgePosition: true,
        observerRing: true,
      };
    case "committed_change":
      // 弱化短确认：不做烟花/连胜/夸张庆功（01-8 §7）
      return {
        eyes: "open",
        mouth: "smile",
        hand: "down",
        ring: "full",
        comet: true,
        starGlow: true,
        toolVisible: false,
        edgePosition: false,
        observerRing: false,
      };
    case "uncertain_or_retry":
      return {
        eyes: "open",
        mouth: "neutral",
        hand: "point",
        ring: "partial",
        comet: true,
        starGlow: true,
        toolVisible: true,
        edgePosition: false,
        observerRing: false,
      };
    case "exit_or_hidden":
      return {
        eyes: "closed",
        mouth: "neutral",
        hand: "wave",
        ring: "hidden",
        comet: true,
        starGlow: false,
        toolVisible: false,
        edgePosition: false,
        observerRing: false,
      };
  }
}
