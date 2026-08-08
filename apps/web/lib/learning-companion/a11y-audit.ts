/**
 * 阶段 08（W7）任务 08-1：A11y 与 onboarding 审计纯逻辑（§13.4 / 冻结记录 01-4）。
 *
 * 本文件是**纯逻辑**（无 React / 无 DOM / 无网络 / 无副作用源），提供：
 * - WCAG 2.2 AA 规则清单（non-text content / 语义标签 / 文本与非文本对比度 /
 *   200% zoom 重排 / 320px reflow / 键盘可达 / 无键盘陷阱 / 焦点顺序与返回 /
 *   焦点可见 / 触控目标 / 时间可调 / reduced-motion / name-role-value）；
 * - §13.4 产品硬门禁规则（onboarding 跳过同级性、引导可返回/暂停/恢复/重播、
 *   tooltip/侧板焦点不陷阱、关闭后焦点返回、live region 只播报必要状态、
 *   拖拽等价操作、screen reader 可理解、颜色/空间/动画不是唯一载体、
 *   语音输出默认不自动播放、无倒计时评分、三视口无阻断、角色状态一致性、
 *   硬偏好违反为 0）；
 * - `runA11yAudit` 聚合入口：对全部规则执行并汇总 gate
 *   （WCAG 2.2 AA serious/critical 为 0 且硬偏好违反为 0）。
 *
 * 设计约束（任务要求）：
 * - **DOM 经视图模型注入**：`DomElementView` / `OverlayView` 等描述渲染后的
 *   DOM 状态快照，由审计运行器（Playwright 钩子 / E2E）构建注入；本模块不接触
 *   document/window，因此全部检查函数都是可单测的纯函数；
 * - **审计规则与组件分离**：本模块不 import 任何组件/JSX，只依赖同目录纯逻辑
 *   （companion-visual-state.ts 的视觉状态映射、companion-control-state.ts 的
 *   控制效果解析）与 @ailearn/shared 类型契约；
 * - 每条规则一个检查函数（`check`），元数据给出规则 ID、严重级与 §13.4 映射。
 *
 * 角色状态一致性（§13.4「动画不得伪装评估进度或 canonical 结果」）：
 * - 视觉状态必须由已发生的系统事件权威映射而来（复用 `eventAllowsVisualState`）；
 * - `assessment_handoff` 只能在真实 assessment.started 后展示；
 * - `committed_change` 只能在真实 commit.recorded 后展示；
 * - LearningCard 状态徽标不能宣称理解变化而真实 trusted 事件数为 0。
 */

import {
  eventAllowsVisualState,
  type CompanionSystemEvent,
  type CompanionVisualStateV1,
} from "./companion-visual-state.ts";
import {
  resolveControlEffects,
  type CompanionControlStateSnapshot,
  type ControlEffectsInput,
} from "./companion-control-state.ts";

// ─── 1. 严重级与结果类型 ──────────────────────────────────────────────────

export type A11ySeverity = "critical" | "serious" | "moderate" | "minor";

export interface A11yProblem {
  elementId?: string;
  message: string;
}

export interface A11yRuleCheck {
  passed: boolean;
  problems: readonly A11yProblem[];
}

export interface A11yFinding extends A11yProblem {
  ruleId: string;
  severity: A11ySeverity;
}

export interface A11yRuleResult {
  ruleId: string;
  severity: A11ySeverity;
  label: string;
  passed: boolean;
  findings: readonly A11yFinding[];
}

/** 聚合 gate：WCAG 2.2 AA serious/critical 为 0 且硬偏好违反为 0（任务验收）。 */
export interface A11yGate {
  seriousCriticalCount: number;
  hardPreferenceViolations: number;
  passed: boolean;
}

export interface A11yAuditResult {
  rules: readonly A11yRuleResult[];
  gate: A11yGate;
}

// ─── 2. DOM 视图模型（由审计运行器构建注入；本模块不接触 DOM）──────────────

/** 渲染后的 DOM 元素状态快照（CSS px 几何；缺失字段 = 未知/未校验）。 */
export interface DomElementView {
  id: string;
  /** data-ui 标识（如 lc-quiet-anchor / lc-companion-panel） */
  dataUi?: string;
  tag?: string;
  role?: string;
  ariaLabel?: string;
  ariaHidden?: boolean;
  ariaLive?: "polite" | "assertive";
  tabIndex?: number;
  disabled?: boolean;
  hidden?: boolean;
  /** 显式 visible=false 表示不可见（缺省视为可见，除非 hidden） */
  visible?: boolean;
  focusable?: boolean;
  /** 是否有 focus-visible 描边（WCAG 2.4.7；缺省视为有） */
  focusVisibleStyle?: boolean;
  /** 是否为交互控件（button/input/[role=button|link]/dataUi 操作元素） */
  interactive?: boolean;
  /** 内联文本链接豁免触控目标尺寸（WCAG 2.5.8 exception） */
  inlineLink?: boolean;
  widthPx?: number;
  heightPx?: number;
  text?: string;
  /** 前景色（#rgb/#rrggbb/rgb()/rgba()） */
  color?: string;
  backgroundColor?: string;
  fontSizePx?: number;
  fontWeight?: number;
  /** 非文本图形色（WCAG 1.4.11） */
  fillColor?: string;
  strokeColor?: string;
  /** 动画名称（非空 = 该元素应用了动画） */
  animationName?: string;
  animationDurationMs?: number;
  /** 已附加 motion-reduce 静态化（motion-reduce:animate-none 等） */
  motionReduceSafe?: boolean;
  /** 音频/视频默认自动播放 */
  autoplay?: boolean;
  /** reflow/zoom：该元素可换行收缩（flex-wrap/auto-fill 网格等） */
  wrapable?: boolean;
  /** 该元素引起横向滚动（scrollWidth > clientWidth） */
  scrollsHorizontally?: boolean;
}

/** 语义标签需求（WCAG 1.3.1 / §13.4：伴星锚点、当前上下文、建议原因、忙碌/退场、页面 action）。 */
export type SemanticLabelKind =
  | "companion_anchor"
  | "current_context"
  | "suggestion_reason"
  | "busy_or_exit"
  | "page_action";

export interface SemanticLabelRequirement {
  elementId: string;
  kind: SemanticLabelKind;
  /** 期望可访问名称；true = aria-label 或可见文本必须非空 */
  expectAccessibleName?: boolean;
}

/** 浮层视图（dialog/tooltip/guide/panel/toast）：焦点管理 / 焦点返回 / live region。 */
export interface OverlayView {
  id: string;
  kind: "dialog" | "tooltip" | "guide" | "panel" | "toast";
  /** enforced = 模态 trap；none = 非模态不 trap（onboarding tooltip/侧板必须 none） */
  focusTrap: "enforced" | "none";
  ariaModal?: boolean;
  role?: string;
  /** 触发元素 id（焦点恢复目标；打开面板的召唤按钮） */
  triggerId?: string;
  /** 关闭按钮元素 id（逃逸路径之一） */
  closeButtonId?: string;
  /** Esc 关闭已接线（逃逸路径之一） */
  escCloses?: boolean;
  /**
   * 关闭后的实际焦点元素 id：
   * undefined = 未验证（跳过）；string = 必须等于 triggerId；null = 焦点落 body（除非无 trigger）。
   */
  focusAfterCloseId?: string | null;
  /** 该浮层的 live region 元素 id 清单（只播报必要状态） */
  liveRegionIds?: readonly string[];
  /** 浮层全部内容文本（live region 冗余检测基准） */
  contentText?: string;
}

/** onboarding 每步「跳过」动作同级性视图（§13.4）。 */
export interface OnboardingSkipActionView {
  stepId: string;
  /** 该步是否存在跳过/结束引导动作（必须存在） */
  skipActionPresent: boolean;
  /** 与其他主要动作视觉同级（非弱化/隐藏） */
  visualPeer: boolean;
  /** 键盘可达（可聚焦、可 Enter/Space 触发） */
  keyboardAccessible: boolean;
  /** 读屏同级（语义 role + 可访问名称） */
  screenReaderPeer: boolean;
}

/** onboarding 可返回/暂停/恢复/主动重播视图（§13.4）。 */
export interface OnboardingNavigabilityView {
  stepId: string;
  canGoBack: boolean;
  canPause: boolean;
  canResume: boolean;
  canManuallyReplay: boolean;
}

/** 拖拽场景等价操作视图（§13.4：tap-select-place / 键盘 / Switch Control）。 */
export interface DragSceneView {
  id: string;
  hasTapSelectPlace: boolean;
  hasKeyboardEquivalent: boolean;
  hasSwitchEquivalent: boolean;
  hasScreenReaderDescription: boolean;
}

/** 图形结构（节点/关系/路线/Scene/结果）读屏可理解视图（§13.4）。 */
export interface GraphicStructureView {
  id: string;
  kind: "node" | "relation" | "route" | "scene" | "result";
  /** 文本标签或读屏描述（至少一个非空） */
  textLabel?: string;
  ariaLabel?: string;
  /** 纯 canvas 渲染（无 DOM 文本等价） → 违规 */
  canvasOnly?: boolean;
}

/** 状态指示器（颜色/空间/动画不是唯一信息载体，§13.4）。 */
export interface StatusIndicatorView {
  id: string;
  /** 仅用颜色表达状态（无文本/图标/形状/读屏标签） */
  colorOnly: boolean;
}

/** 语音输出视图（§13.4：默认不自动播放；可暂停、重听、确认、切模态）。 */
export interface VoiceOutputView {
  id: string;
  autoplay: boolean;
  canPause: boolean;
  canReplay: boolean;
  canConfirmTranscript: boolean;
  canSwitchModality: boolean;
}

/** 评分视图（§13.4：无倒计时评分、无操作速度评分）。 */
export interface ScoringView {
  id: string;
  /** 展示倒计时 / 剩余时间 */
  hasCountdown: boolean;
  /** 按操作速度 / 用时长短评分 */
  scoresBySpeed: boolean;
  /** 存在时间限制文本 */
  hasTimeLimitText: boolean;
}

/** 角色动画状态 vs 真实状态一致性视图（§13.4「动画不得伪装评估进度或 canonical 结果」）。 */
export interface RoleStateView {
  id: string;
  visualState: CompanionVisualStateV1;
  /** 触发该视觉状态的系统事件（防御性；缺省不校验事件映射） */
  systemEvent?: CompanionSystemEvent;
  session: { started: boolean; ended: boolean };
  assessment: { started: boolean; resultProduced: boolean };
  commit: { recorded: boolean };
}

/** LearningCard 状态徽标一致性（§8/07-5：活动量不得伪装成理解变化）。 */
export interface LearningCardStateView {
  id: string;
  /** 展示中的状态徽标 */
  badges: readonly {
    key: string;
    label: string;
    /** 徽标是否宣称「理解投影变化」（trusted 专属） */
    claimsUnderstandingChange: boolean;
  }[];
  /** 真实 trusted 验证/复习事件数（只有 trusted contract 事件才改变理解投影） */
  realTrustedChangeCount: number;
}

/** 硬偏好视图（§16.4 硬 Gate / §13.4：temporary_hidden/global_off 零监听零调用等）。 */
export interface HardPreferenceView {
  snapshot: CompanionControlStateSnapshot;
  controlInput: ControlEffectsInput;
  /** 当前实际渲染/活动状态 */
  rendering: {
    avatarAnimated: boolean;
    voiceOutputPlaying: boolean;
    proactiveSuggestionShown: boolean;
    inviteShown: boolean;
    observerActive: boolean;
    contextConstructed: boolean;
  };
}

export interface ReducedMotionConfig {
  prefersReducedMotion: boolean;
}

export interface ZoomConfig {
  /** 200% zoom 后的视口宽度（CSS px；WCAG 1.4.4/1.4.10 基准 320） */
  viewportWidthPx?: number;
  /** 关键操作元素 id 清单；缺省 = 全部交互元素 */
  criticalElementIds?: readonly string[];
}

export interface ReflowConfig {
  /** 判定横向溢出的视口宽度（CSS px，缺省 320） */
  viewportWidthPx?: number;
}

export interface ViewportPathView {
  viewportWidthPx: number;
  /** 该视口下主路径关键操作元素 */
  criticalActions: readonly {
    id: string;
    visible: boolean;
    inViewport: boolean;
  }[];
}

export interface A11yAuditInput {
  elements?: readonly DomElementView[];
  overlays?: readonly OverlayView[];
  semanticLabelRequirements?: readonly SemanticLabelRequirement[];
  onboardingSteps?: readonly OnboardingSkipActionView[];
  onboardingNavigability?: readonly OnboardingNavigabilityView[];
  dragScenes?: readonly DragSceneView[];
  graphicStructures?: readonly GraphicStructureView[];
  statusIndicators?: readonly StatusIndicatorView[];
  roleStates?: readonly RoleStateView[];
  learningCards?: readonly LearningCardStateView[];
  voiceOutputs?: readonly VoiceOutputView[];
  scoring?: readonly ScoringView[];
  hardPreference?: HardPreferenceView;
  reducedMotion?: ReducedMotionConfig;
  zoom?: ZoomConfig;
  reflow?: ReflowConfig;
  viewports?: readonly ViewportPathView[];
}

// ─── 3. 工具：颜色与对比度（WCAG 2.2 AA 1.4.3 / 1.4.11）────────────────────

interface Rgb {
  r: number;
  g: number;
  b: number;
  /** alpha 0..1；<1 时不参与可靠对比度计算 */
  a?: number;
}

/** 解析 #rgb / #rrggbb / rgb() / rgba() / 百分比 rgb()；不支持 → null。 */
export function parseColor(input: string): Rgb | null {
  const value = input.trim().toLowerCase();
  if (value.startsWith("#")) {
    const hex = value.slice(1);
    if (/^[0-9a-f]{3}$/.test(hex)) {
      return {
        r: parseInt(hex[0] + hex[0], 16),
        g: parseInt(hex[1] + hex[1], 16),
        b: parseInt(hex[2] + hex[2], 16),
      };
    }
    if (/^[0-9a-f]{6}$/.test(hex)) {
      return {
        r: parseInt(hex.slice(0, 2), 16),
        g: parseInt(hex.slice(2, 4), 16),
        b: parseInt(hex.slice(4, 6), 16),
      };
    }
    return null;
  }
  const integer = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})(?:\s*,\s*([\d.]+)\s*)?\)$/.exec(value);
  if (integer) {
    return {
      r: clampChannel(Number(integer[1])),
      g: clampChannel(Number(integer[2])),
      b: clampChannel(Number(integer[3])),
      ...(integer[4] !== undefined ? { a: clamp01(Number(integer[4])) } : {}),
    };
  }
  const percent = /^rgba?\(\s*([\d.]+)%\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%(?:\s*,\s*([\d.]+)\s*)?\)$/.exec(value);
  if (percent) {
    return {
      r: clampChannel(Math.round((Number(percent[1]) / 100) * 255)),
      g: clampChannel(Math.round((Number(percent[2]) / 100) * 255)),
      b: clampChannel(Math.round((Number(percent[3]) / 100) * 255)),
      ...(percent[4] !== undefined ? { a: clamp01(Number(percent[4])) } : {}),
    };
  }
  return null;
}

function clampChannel(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.min(255, Math.max(0, Math.round(value)));
}

function clamp01(value: number): number {
  if (Number.isNaN(value)) return 1;
  return Math.min(1, Math.max(0, value));
}

/** sRGB → 相对亮度（WCAG 公式）。 */
export function relativeLuminance(rgb: Rgb): number {
  const toLinear = (channel: number): number => {
    const s = channel / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return (
    0.2126 * toLinear(rgb.r)
    + 0.7152 * toLinear(rgb.g)
    + 0.0722 * toLinear(rgb.b)
  );
}

/**
 * WCAG 对比度（1.4.3）。任一颜色无法解析或含半透明 alpha → null（不可可靠计算）。
 */
export function contrastRatio(foreground: string, background: string): number | null {
  const fg = parseColor(foreground);
  const bg = parseColor(background);
  if (!fg || !bg) return null;
  if ((fg.a !== undefined && fg.a < 1) || (bg.a !== undefined && bg.a < 1)) return null;
  const l1 = relativeLuminance(fg);
  const l2 = relativeLuminance(bg);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

/** 大文本判定（WCAG 1.4.3：≥24px，或 ≥18.66px 且 bold）。 */
export function isLargeText(fontSizePx: number, fontWeight = 400): boolean {
  return fontSizePx >= 24 || (fontSizePx >= 18.66 && fontWeight >= 700);
}

/** 文本对比度阈值：大文本 3:1，普通文本 4.5:1（WCAG 2.2 AA）。 */
export function textContrastThreshold(fontSizePx: number, fontWeight = 400): number {
  return isLargeText(fontSizePx, fontWeight) ? 3 : 4.5;
}

// ─── 4. 视图辅助 ──────────────────────────────────────────────────────────

function isVisible(element: DomElementView): boolean {
  return element.hidden !== true && element.visible !== false;
}

function isInteractive(element: DomElementView): boolean {
  return (
    element.interactive === true
    || element.tag === "button"
    || element.tag === "input"
    || element.role === "button"
    || element.role === "link"
  );
}

function isDecorative(element: DomElementView): boolean {
  return element.ariaHidden === true;
}

function accessibleNameOf(element: DomElementView): string {
  const label = element.ariaLabel ?? "";
  const text = element.text ?? "";
  return [label, text].map((part) => part.trim()).filter(Boolean).join(" ");
}

/** 在 overlay 的 live region 上收集播报文本（拼接元素文本）。 */
function liveRegionText(
  overlay: OverlayView,
  elements: readonly DomElementView[],
): string {
  return (overlay.liveRegionIds ?? [])
    .map((id) => elements.find((element) => element.id === id)?.text ?? "")
    .join(" ");
}

// ─── 5. WCAG 2.2 AA 规则检查函数 ──────────────────────────────────────────

/** wcag-1.1.1：非文本内容（img / role=img）有替代文本（装饰除外）。 */
export function auditNonTextContent(input: A11yAuditInput): A11yRuleCheck {
  const problems: A11yProblem[] = [];
  for (const element of input.elements ?? []) {
    const isGraphic = element.tag === "img" || element.role === "img";
    if (!isGraphic || isDecorative(element)) continue;
    if (accessibleNameOf(element).trim() === "") {
      problems.push({
        elementId: element.id,
        message: `非文本内容「${element.id}」没有替代文本（aria-label/alt/文本）`,
      });
    }
  }
  return { passed: problems.length === 0, problems };
}

/** wcag-1.3.1 + §13.4 语义标签：伴星锚点/当前上下文/建议原因/忙碌退场/页面 action。 */
export function auditSemanticLabels(input: A11yAuditInput): A11yRuleCheck {
  const problems: A11yProblem[] = [];
  for (const requirement of input.semanticLabelRequirements ?? []) {
    const element = (input.elements ?? []).find((item) => item.id === requirement.elementId);
    if (!element) {
      problems.push({
        elementId: requirement.elementId,
        message: `语义标签需求（${requirement.kind}）指向的元素未渲染`,
      });
      continue;
    }
    if (requirement.expectAccessibleName !== false && accessibleNameOf(element).trim() === "") {
      problems.push({
        elementId: requirement.elementId,
        message: `「${requirement.kind}」语义元素「${requirement.elementId}」缺少可访问名称`,
      });
    }
  }
  return { passed: problems.length === 0, problems };
}

/** wcag-1.4.3：文本对比度（大文本 3:1，普通 4.5:1）。 */
export function auditTextContrast(input: A11yAuditInput): A11yRuleCheck {
  const problems: A11yProblem[] = [];
  for (const element of input.elements ?? []) {
    if (!element.color || !element.backgroundColor || element.fontSizePx === undefined) continue;
    if (accessibleNameOf(element).trim() === "" && (element.text ?? "").trim() === "") continue;
    const ratio = contrastRatio(element.color, element.backgroundColor);
    if (ratio === null) continue; // 半透明/未知颜色：无法可靠判定，跳过
    const threshold = textContrastThreshold(element.fontSizePx, element.fontWeight);
    if (ratio < threshold) {
      problems.push({
        elementId: element.id,
        message: `文本对比度 ${ratio.toFixed(2)}:1 低于 ${threshold}:1（WCAG 2.2 AA 1.4.3）`,
      });
    }
  }
  return { passed: problems.length === 0, problems };
}

/** wcag-1.4.11：非文本（图形/图标/边框）对比度 ≥ 3:1。 */
export function auditNonTextContrast(input: A11yAuditInput): A11yRuleCheck {
  const problems: A11yProblem[] = [];
  for (const element of input.elements ?? []) {
    const foreground = element.fillColor ?? element.strokeColor;
    if (!foreground || !element.backgroundColor) continue;
    const ratio = contrastRatio(foreground, element.backgroundColor);
    if (ratio === null) continue;
    if (ratio < 3) {
      problems.push({
        elementId: element.id,
        message: `非文本图形对比度 ${ratio.toFixed(2)}:1 低于 3:1（WCAG 2.2 AA 1.4.11）`,
      });
    }
  }
  return { passed: problems.length === 0, problems };
}

/** wcag-1.4.4：200% zoom（320px 视口）不丢功能 —— 关键操作可见且不因固定宽度溢出。 */
export function auditZoom200(input: A11yAuditInput): A11yRuleCheck {
  const viewportWidth = input.zoom?.viewportWidthPx ?? 320;
  const criticalIds = input.zoom?.criticalElementIds;
  const elements = input.elements ?? [];
  const candidates = criticalIds
    ? criticalIds
        .map((id) => elements.find((element) => element.id === id))
        .filter((element): element is DomElementView => element !== undefined)
    : elements.filter((element) => isInteractive(element));
  const problems: A11yProblem[] = [];
  for (const element of candidates) {
    if (!isVisible(element)) {
      problems.push({
        elementId: element.id,
        message: `200% zoom 下关键操作「${element.id}」不可见`,
      });
      continue;
    }
    if (
      element.widthPx !== undefined
      && element.widthPx > viewportWidth
      && element.wrapable !== true
    ) {
      problems.push({
        elementId: element.id,
        message: `200% zoom 下「${element.id}」固定宽度 ${element.widthPx}px 超过视口 ${viewportWidth}px 且不可换行，功能可能丢失`,
      });
    }
  }
  return { passed: problems.length === 0, problems };
}

/** wcag-1.4.10：320px 重排无横向滚动、无主路径阻断。 */
export function auditReflow320(input: A11yAuditInput): A11yRuleCheck {
  const viewportWidth = input.reflow?.viewportWidthPx ?? 320;
  const problems: A11yProblem[] = [];
  for (const element of input.elements ?? []) {
    if (element.scrollsHorizontally === true) {
      problems.push({
        elementId: element.id,
        message: `「${element.id}」在窄视口引起横向滚动（reflow 阻断）`,
      });
      continue;
    }
    if (
      element.widthPx !== undefined
      && element.widthPx > viewportWidth
      && element.wrapable !== true
      && isVisible(element)
    ) {
      problems.push({
        elementId: element.id,
        message: `「${element.id}」宽度 ${element.widthPx}px 超过 ${viewportWidth}px 视口且不可换行`,
      });
    }
  }
  return { passed: problems.length === 0, problems };
}

/** wcag-2.1.1：全部交互控件键盘可达（可聚焦、非负 tabIndex）。 */
export function auditKeyboardAccessible(input: A11yAuditInput): A11yRuleCheck {
  const problems: A11yProblem[] = [];
  for (const element of input.elements ?? []) {
    if (!isInteractive(element) || element.disabled === true || !isVisible(element)) continue;
    if (element.focusable === false || (element.tabIndex !== undefined && element.tabIndex < 0)) {
      problems.push({
        elementId: element.id,
        message: `交互控件「${element.id}」键盘不可达（不可聚焦或负 tabIndex）`,
      });
    }
  }
  return { passed: problems.length === 0, problems };
}

/** wcag-2.1.2：无键盘陷阱 —— 模态浮层（focusTrap=enforced）必须存在逃逸路径。 */
export function auditNoKeyboardTrap(input: A11yAuditInput): A11yRuleCheck {
  const problems: A11yProblem[] = [];
  for (const overlay of input.overlays ?? []) {
    if (overlay.focusTrap !== "enforced") continue;
    const hasEscapePath =
      overlay.closeButtonId !== undefined
      || overlay.escCloses === true
      || overlay.triggerId !== undefined;
    if (!hasEscapePath) {
      problems.push({
        elementId: overlay.id,
        message: `模态浮层「${overlay.id}」强制 trap 焦点但没有关闭/Esc/触发元素逃逸路径`,
      });
    }
  }
  return { passed: problems.length === 0, problems };
}

/** wcag-2.4.3：关闭后焦点回到原触发位置（含所有浮层）。 */
export function auditFocusReturn(input: A11yAuditInput): A11yRuleCheck {
  const problems: A11yProblem[] = [];
  for (const overlay of input.overlays ?? []) {
    if (overlay.focusAfterCloseId === undefined) continue; // 未验证
    if (overlay.triggerId !== undefined && overlay.focusAfterCloseId !== overlay.triggerId) {
      problems.push({
        elementId: overlay.id,
        message: `浮层「${overlay.id}」关闭后焦点落在「${overlay.focusAfterCloseId}」，未回到触发位置「${overlay.triggerId}」`,
      });
    }
  }
  return { passed: problems.length === 0, problems };
}

/** wcag-2.4.7：焦点可见（focus-visible 描边）。 */
export function auditFocusVisible(input: A11yAuditInput): A11yRuleCheck {
  const problems: A11yProblem[] = [];
  for (const element of input.elements ?? []) {
    if (!isInteractive(element) || element.disabled === true || !isVisible(element)) continue;
    if (element.focusable !== false && element.focusVisibleStyle === false) {
      problems.push({
        elementId: element.id,
        message: `交互控件「${element.id}」没有可见的键盘焦点样式（WCAG 2.4.7）`,
      });
    }
  }
  return { passed: problems.length === 0, problems };
}

/** wcag-2.5.8：触控目标 ≥ 44×44 CSS px（内联文本链接豁免）。 */
export function auditTouchTargetSize(input: A11yAuditInput): A11yRuleCheck {
  const problems: A11yProblem[] = [];
  for (const element of input.elements ?? []) {
    if (!isInteractive(element) || element.disabled === true || !isVisible(element)) continue;
    if (element.inlineLink === true) continue; // WCAG 2.5.8 exception：内联文本
    if (element.widthPx === undefined || element.heightPx === undefined) continue;
    if (element.widthPx < 44 || element.heightPx < 44) {
      problems.push({
        elementId: element.id,
        message: `触控目标「${element.id}」尺寸 ${element.widthPx}×${element.heightPx}px 小于 44×44 CSS px`,
      });
    }
  }
  return { passed: problems.length === 0, problems };
}

/** wcag-2.2.1 + §13.4：无倒计时评分、无操作速度评分（时间可调/无时间限制）。 */
export function auditNoCountdownScoring(input: A11yAuditInput): A11yRuleCheck {
  const problems: A11yProblem[] = [];
  for (const scoring of input.scoring ?? []) {
    if (scoring.hasCountdown || scoring.hasTimeLimitText) {
      problems.push({
        elementId: scoring.id,
        message: `评分「${scoring.id}」包含倒计时/剩余时间，违反「无倒计时评分」`,
      });
    }
    if (scoring.scoresBySpeed) {
      problems.push({
        elementId: scoring.id,
        message: `评分「${scoring.id}」按操作速度/用时评分，违反「无操作速度评分」`,
      });
    }
  }
  return { passed: problems.length === 0, problems };
}

/** wcag-2.3.3：reduced-motion 下交互动画必须可关闭（未静态化 → 违规）。 */
export function auditReducedMotion(input: A11yAuditInput): A11yRuleCheck {
  if (input.reducedMotion?.prefersReducedMotion !== true) {
    return { passed: true, problems: [] };
  }
  const problems: A11yProblem[] = [];
  for (const element of input.elements ?? []) {
    if (element.animationName === undefined || element.animationName === "") continue;
    if (element.motionReduceSafe !== true) {
      problems.push({
        elementId: element.id,
        message: `reduced-motion 下「${element.id}」仍启用动画「${element.animationName}」且未静态化`,
      });
    }
  }
  return { passed: problems.length === 0, problems };
}

/** wcag-4.1.2：交互控件有可访问名称（name/role/value）。 */
export function auditNameRoleValue(input: A11yAuditInput): A11yRuleCheck {
  const problems: A11yProblem[] = [];
  for (const element of input.elements ?? []) {
    if (!isInteractive(element) || element.disabled === true) continue;
    if (accessibleNameOf(element).trim() === "") {
      problems.push({
        elementId: element.id,
        message: `交互控件「${element.id}」缺少可访问名称（WCAG 4.1.2）`,
      });
    }
  }
  return { passed: problems.length === 0, problems };
}

// ─── 6. §13.4 产品硬门禁规则检查函数 ─────────────────────────────────────

/** onboarding 跳过在每一步都是视觉、键盘、读屏同级动作（§13.4）。 */
export function auditOnboardingSkipParity(input: A11yAuditInput): A11yRuleCheck {
  const problems: A11yProblem[] = [];
  for (const step of input.onboardingSteps ?? []) {
    if (!step.skipActionPresent) {
      problems.push({
        elementId: step.stepId,
        message: `引导步骤「${step.stepId}」没有跳过/结束引导动作（每一步都必须有同级跳过动作）`,
      });
      continue;
    }
    if (!step.visualPeer) {
      problems.push({
        elementId: step.stepId,
        message: `引导步骤「${step.stepId}」的跳过动作视觉上被弱化/隐藏，不是同级动作`,
      });
    }
    if (!step.keyboardAccessible) {
      problems.push({
        elementId: step.stepId,
        message: `引导步骤「${step.stepId}」的跳过动作键盘不可达`,
      });
    }
    if (!step.screenReaderPeer) {
      problems.push({
        elementId: step.stepId,
        message: `引导步骤「${step.stepId}」的跳过动作对读屏不同级（缺 role 或可访问名称）`,
      });
    }
  }
  return { passed: problems.length === 0, problems };
}

/** 引导可返回、暂停、恢复和主动重播（§13.4），不用困住焦点的 tooltip 链。 */
export function auditOnboardingNavigability(input: A11yAuditInput): A11yRuleCheck {
  const problems: A11yProblem[] = [];
  for (const step of input.onboardingNavigability ?? []) {
    if (!step.canGoBack) {
      problems.push({ elementId: step.stepId, message: `引导步骤「${step.stepId}」不能返回上一步` });
    }
    if (!step.canPause) {
      problems.push({ elementId: step.stepId, message: `引导步骤「${step.stepId}」不能暂停` });
    }
    if (!step.canResume) {
      problems.push({ elementId: step.stepId, message: `引导步骤「${step.stepId}」不能恢复` });
    }
    if (!step.canManuallyReplay) {
      problems.push({ elementId: step.stepId, message: `引导步骤「${step.stepId}」不能主动重播` });
    }
  }
  return { passed: problems.length === 0, problems };
}

/** onboarding tooltip/侧板焦点不陷阱（§13.4）：guide/tooltip/panel 必须 focusTrap=none。 */
export function auditOnboardingNoFocusTrap(input: A11yAuditInput): A11yRuleCheck {
  const problems: A11yProblem[] = [];
  for (const overlay of input.overlays ?? []) {
    if (overlay.kind !== "guide" && overlay.kind !== "tooltip" && overlay.kind !== "panel") {
      continue;
    }
    if (overlay.focusTrap === "enforced") {
      problems.push({
        elementId: overlay.id,
        message: `onboarding/侧板浮层「${overlay.id}」强制 trap 焦点，会困住键盘用户（应为非模态 focusTrap=none）`,
      });
    }
  }
  return { passed: problems.length === 0, problems };
}

/** 关闭面板后焦点回到原触发位置（§13.4）。 */
export function auditFocusReturnOnClose(input: A11yAuditInput): A11yRuleCheck {
  const problems: A11yProblem[] = [];
  for (const overlay of input.overlays ?? []) {
    if (overlay.triggerId === undefined || overlay.focusAfterCloseId === undefined) continue;
    if (overlay.focusAfterCloseId !== overlay.triggerId) {
      problems.push({
        elementId: overlay.id,
        message: `关闭「${overlay.id}」后焦点未回到触发位置「${overlay.triggerId}」`,
      });
    }
  }
  return { passed: problems.length === 0, problems };
}

/** live region 只播报必要状态（§13.4）：数量受限、不重复播报面板内容。 */
export function auditLiveRegionMinimal(input: A11yAuditInput): A11yRuleCheck {
  const elements = input.elements ?? [];
  const problems: A11yProblem[] = [];
  for (const overlay of input.overlays ?? []) {
    const regionIds = overlay.liveRegionIds ?? [];
    if (regionIds.length > 2) {
      problems.push({
        elementId: overlay.id,
        message: `浮层「${overlay.id}」有 ${regionIds.length} 个 live region，超出必要播报（最多 2：状态 + 错误）`,
      });
    }
    for (const id of regionIds) {
      const region = elements.find((element) => element.id === id);
      if (!region) {
        problems.push({ elementId: id, message: `live region「${id}」未渲染` });
        continue;
      }
      if (region.ariaLive !== "polite" && region.ariaLive !== "assertive") {
        problems.push({ elementId: id, message: `live region「${id}」缺少 aria-live` });
      }
    }
    const regionText = liveRegionText(overlay, elements).trim();
    const content = (overlay.contentText ?? "").trim();
    if (regionText !== "" && content !== "" && regionText === content) {
      problems.push({
        elementId: overlay.id,
        message: `live region 重复播报了面板全部内容，违反「只播报必要状态」`,
      });
    }
  }
  return { passed: problems.length === 0, problems };
}

/** 所有拖拽有 tap-select-place、键盘和 Switch 等价操作（§13.4）。 */
export function auditDragEquivalents(input: A11yAuditInput): A11yRuleCheck {
  const problems: A11yProblem[] = [];
  for (const scene of input.dragScenes ?? []) {
    if (!scene.hasTapSelectPlace) {
      problems.push({ elementId: scene.id, message: `拖拽场景「${scene.id}」没有 tap-select-place 等价操作` });
    }
    if (!scene.hasKeyboardEquivalent) {
      problems.push({ elementId: scene.id, message: `拖拽场景「${scene.id}」没有键盘等价操作` });
    }
    if (!scene.hasSwitchEquivalent) {
      problems.push({ elementId: scene.id, message: `拖拽场景「${scene.id}」没有 Switch Control/单手等价操作` });
    }
    if (!scene.hasScreenReaderDescription) {
      problems.push({ elementId: scene.id, message: `拖拽场景「${scene.id}」没有读屏等价描述` });
    }
  }
  return { passed: problems.length === 0, problems };
}

/** screen reader 可理解节点、关系、路线、Scene 和结果（§13.4）。 */
export function auditScreenReaderComprehension(input: A11yAuditInput): A11yRuleCheck {
  const problems: A11yProblem[] = [];
  for (const structure of input.graphicStructures ?? []) {
    if (structure.canvasOnly === true) {
      problems.push({
        elementId: structure.id,
        message: `图形结构「${structure.id}」（${structure.kind}）纯 canvas 渲染，读屏不可理解`,
      });
      continue;
    }
    const label = `${structure.textLabel ?? ""}${structure.ariaLabel ?? ""}`.trim();
    if (label === "") {
      problems.push({
        elementId: structure.id,
        message: `图形结构「${structure.id}」（${structure.kind}）没有文本/读屏等价描述`,
      });
    }
  }
  return { passed: problems.length === 0, problems };
}

/** 颜色、空间位置和动画不是唯一信息载体（§13.4）。 */
export function auditNotColorOnly(input: A11yAuditInput): A11yRuleCheck {
  const problems: A11yProblem[] = [];
  for (const indicator of input.statusIndicators ?? []) {
    if (indicator.colorOnly) {
      problems.push({
        elementId: indicator.id,
        message: `状态指示器「${indicator.id}」仅用颜色表达，颜色是唯一信息载体`,
      });
    }
  }
  return { passed: problems.length === 0, problems };
}

/** 语音输出默认不自动播放；可暂停、重听、确认 transcript、切换模态（§13.4）。 */
export function auditVoiceAutoplay(input: A11yAuditInput): A11yRuleCheck {
  const problems: A11yProblem[] = [];
  for (const voice of input.voiceOutputs ?? []) {
    if (voice.autoplay) {
      problems.push({ elementId: voice.id, message: `语音输出「${voice.id}」默认自动播放（§13.4 禁止）` });
    }
    if (!voice.canPause) {
      problems.push({ elementId: voice.id, message: `语音输出「${voice.id}」不能暂停` });
    }
    if (!voice.canReplay) {
      problems.push({ elementId: voice.id, message: `语音输出「${voice.id}」不能重听` });
    }
    if (!voice.canConfirmTranscript) {
      problems.push({ elementId: voice.id, message: `语音输出「${voice.id}」不能确认 transcript` });
    }
    if (!voice.canSwitchModality) {
      problems.push({ elementId: voice.id, message: `语音输出「${voice.id}」不能切换模态` });
    }
  }
  return { passed: problems.length === 0, problems };
}

/** 390/768/1440 三视口无主路径阻断（§13.4）。 */
export function auditViewportNoBlock(input: A11yAuditInput): A11yRuleCheck {
  const problems: A11yProblem[] = [];
  for (const viewport of input.viewports ?? []) {
    for (const action of viewport.criticalActions) {
      if (!action.visible) {
        problems.push({
          elementId: action.id,
          message: `视口 ${viewport.viewportWidthPx}px 下主路径关键操作「${action.id}」不可见（阻断）`,
        });
      } else if (!action.inViewport) {
        problems.push({
          elementId: action.id,
          message: `视口 ${viewport.viewportWidthPx}px 下主路径关键操作「${action.id}」超出视口（阻断）`,
        });
      }
    }
  }
  return { passed: problems.length === 0, problems };
}

/**
 * 角色状态与真实 Session/assessment/commit 状态的一致性（§13.4）。
 * 动画不得伪装评估进度或 canonical 结果：
 * - 视觉状态必须由已发生的系统事件权威映射（eventAllowsVisualState）；
 * - assessment_handoff 需要真实 assessment.started；
 * - committed_change 需要真实 commit.recorded；
 * - LearningCard 徽标宣称理解变化时真实 trusted 事件必须 > 0。
 */
export function auditRoleStateConsistency(input: A11yAuditInput): A11yRuleCheck {
  const problems: A11yProblem[] = [];
  for (const role of input.roleStates ?? []) {
    if (role.systemEvent !== undefined && !eventAllowsVisualState(role.systemEvent, role.visualState)) {
      problems.push({
        elementId: role.id,
        message: `视觉状态「${role.visualState}」与已发生的系统事件「${role.systemEvent.kind}」不匹配（动画伪装系统状态）`,
      });
    }
    if (role.visualState === "assessment_handoff" && role.assessment.started !== true) {
      problems.push({
        elementId: role.id,
        message: "展示 assessment_handoff（独立评估接管）但真实 assessment 尚未开始，动画伪装评估进度",
      });
    }
    if (role.visualState === "committed_change" && role.commit.recorded !== true) {
      problems.push({
        elementId: role.id,
        message: "展示 committed_change 但真实 commit 未记录，动画伪装 canonical 结果",
      });
    }
  }
  for (const card of input.learningCards ?? []) {
    for (const badge of card.badges) {
      if (badge.claimsUnderstandingChange && card.realTrustedChangeCount === 0) {
        problems.push({
          elementId: card.id,
          message: `学习卡徽标「${badge.label}」宣称理解变化，但真实 trusted 事件数为 0（活动量伪装成知识成长）`,
        });
      }
    }
  }
  return { passed: problems.length === 0, problems };
}

/** 硬偏好违反为 0（§16.4 硬 Gate + §13.4）：hidden/off 零渲染零调用、quiet 未召唤零 observer。 */
export function auditHardPreference(input: A11yAuditInput): A11yRuleCheck {
  if (input.hardPreference === undefined) {
    // security_review LOW 修复：hard 偏好审计未提供快照 → 视为「未确认」（fail closed），
    // 不能把未采样快照当作零违规通过。
    return {
      passed: false,
      problems: [
        { message: "hard 偏好审计缺少快照（未确认）→ fail closed" },
      ],
    };
  }
  const { snapshot, controlInput, rendering } = input.hardPreference;
  const effects = resolveControlEffects(snapshot, controlInput);
  const problems: A11yProblem[] = [];

  if (rendering.avatarAnimated && !effects.animationEnabled) {
    problems.push({
      message: "animationOff/temporary_hidden/global_off 下仍渲染角色动画（硬偏好违反）",
    });
  }
  if (rendering.voiceOutputPlaying && !effects.voiceOutputEnabled) {
    problems.push({
      message: "voice_output_off/temporary_hidden/global_off 下仍播放语音输出（硬偏好违反）",
    });
  }
  if (rendering.proactiveSuggestionShown && effects.proactiveSuppressed) {
    problems.push({
      message: "page_muted/suggestion_paused/temporary_hidden/global_off 下仍显示主动建议（硬偏好违反）",
    });
  }
  if (rendering.inviteShown && effects.surfaceHidden) {
    problems.push({ message: "temporary_hidden/global_off 下仍展示邀请（硬偏好违反）" });
  }
  if (rendering.observerActive && !effects.observerMounted) {
    problems.push({
      message: "quiet 未召唤/page_context_off/temporary_hidden/global_off 下 observer 仍在活动（硬偏好违反）",
    });
  }
  if (rendering.contextConstructed && !effects.contextConstructible) {
    problems.push({
      message: "quiet 未召唤/page_context_off/temporary_hidden/global_off 下仍在构造 context（硬偏好违反）",
    });
  }
  return { passed: problems.length === 0, problems };
}

// ─── 7. 规则注册表与聚合入口 ──────────────────────────────────────────────

export interface A11yRuleMeta {
  id: string;
  severity: A11ySeverity;
  label: string;
  check: (input: A11yAuditInput) => A11yRuleCheck;
}

/**
 * WCAG 2.2 AA 规则 + §13.4 产品硬门禁规则的完整注册表。
 * 硬门禁违反按 critical 计数（任务验收：serious/critical 为 0）。
 */
export const A11Y_RULES: readonly A11yRuleMeta[] = [
  {
    id: "wcag-1.1.1-non-text-content",
    severity: "serious",
    label: "非文本内容有替代文本（1.1.1）",
    check: auditNonTextContent,
  },
  {
    id: "wcag-1.3.1-info-relationships",
    severity: "serious",
    label: "语义标签：伴星锚点/当前上下文/建议原因/忙碌退场/页面 action（1.3.1 + §13.4）",
    check: auditSemanticLabels,
  },
  {
    id: "wcag-1.4.3-contrast-minimum",
    severity: "serious",
    label: "文本对比度 AA（1.4.3：普通 4.5:1 / 大文本 3:1）",
    check: auditTextContrast,
  },
  {
    id: "wcag-1.4.4-resize-text",
    severity: "serious",
    label: "200% zoom 不丢功能（1.4.4）",
    check: auditZoom200,
  },
  {
    id: "wcag-1.4.10-reflow",
    severity: "serious",
    label: "320px 重排无横向滚动（1.4.10）",
    check: auditReflow320,
  },
  {
    id: "wcag-1.4.11-non-text-contrast",
    severity: "serious",
    label: "非文本对比度 3:1（1.4.11）",
    check: auditNonTextContrast,
  },
  {
    id: "wcag-2.1.1-keyboard",
    severity: "serious",
    label: "全部操作键盘可达（2.1.1）",
    check: auditKeyboardAccessible,
  },
  {
    id: "wcag-2.1.2-no-keyboard-trap",
    severity: "serious",
    label: "无键盘陷阱（2.1.2）",
    check: auditNoKeyboardTrap,
  },
  {
    id: "wcag-2.4.3-focus-order",
    severity: "serious",
    label: "焦点顺序与关闭后焦点返回（2.4.3）",
    check: auditFocusReturn,
  },
  {
    id: "wcag-2.4.7-focus-visible",
    severity: "serious",
    label: "焦点可见（2.4.7）",
    check: auditFocusVisible,
  },
  {
    id: "wcag-2.5.8-target-size",
    severity: "serious",
    label: "触控目标 ≥44×44 CSS px（2.5.8）",
    check: auditTouchTargetSize,
  },
  {
    id: "wcag-2.2.1-timing-adjustable",
    severity: "serious",
    label: "无倒计时评分、无操作速度评分（2.2.1 + §13.4）",
    check: auditNoCountdownScoring,
  },
  {
    id: "wcag-2.3.3-animation-from-interactions",
    severity: "serious",
    label: "reduced-motion 完整支持（2.3.3 + §13.4）",
    check: auditReducedMotion,
  },
  {
    id: "wcag-4.1.2-name-role-value",
    severity: "serious",
    label: "控件有名称/角色/值（4.1.2）",
    check: auditNameRoleValue,
  },
  // ── §13.4 产品硬门禁（critical）────────────────────────────────────────
  {
    id: "onboarding-skip-parity",
    severity: "critical",
    label: "跳过在每一步都是视觉、键盘和读屏同级动作",
    check: auditOnboardingSkipParity,
  },
  {
    id: "onboarding-navigability",
    severity: "critical",
    label: "引导可返回、暂停、恢复和主动重播",
    check: auditOnboardingNavigability,
  },
  {
    id: "onboarding-no-focus-trap",
    severity: "critical",
    label: "onboarding tooltip/侧板焦点不陷阱",
    check: auditOnboardingNoFocusTrap,
  },
  {
    id: "focus-return-on-close",
    severity: "critical",
    label: "关闭后焦点回到原触发位置",
    check: auditFocusReturnOnClose,
  },
  {
    id: "live-region-minimal",
    severity: "critical",
    label: "live region 只播报必要状态",
    check: auditLiveRegionMinimal,
  },
  {
    id: "drag-equivalents",
    severity: "critical",
    label: "拖拽有 tap-select-place、键盘和 Switch 等价操作",
    check: auditDragEquivalents,
  },
  {
    id: "screen-reader-comprehension",
    severity: "critical",
    label: "screen reader 可理解节点/关系/路线/Scene/结果",
    check: auditScreenReaderComprehension,
  },
  {
    id: "not-color-only",
    severity: "critical",
    label: "颜色、空间位置和动画不是唯一信息载体",
    check: auditNotColorOnly,
  },
  {
    id: "voice-autoplay-off",
    severity: "critical",
    label: "语音输出默认不自动播放；可暂停、重听、确认、切模态",
    check: auditVoiceAutoplay,
  },
  {
    id: "no-timed-scoring",
    severity: "critical",
    label: "无倒计时评分、无操作速度评分（§13.4 硬门禁）",
    check: auditNoCountdownScoring,
  },
  {
    id: "viewport-390-768-1440",
    severity: "critical",
    label: "390/768/1440 三视口无主路径阻断",
    check: auditViewportNoBlock,
  },
  {
    id: "role-state-consistency",
    severity: "critical",
    label: "角色状态与真实 Session/assessment/commit 状态一致（动画不伪装评估进度或 canonical 结果）",
    check: auditRoleStateConsistency,
  },
  {
    id: "hard-preference-zero",
    severity: "critical",
    label: "硬偏好违反为 0（§16.4 硬 Gate）",
    check: auditHardPreference,
  },
];

/**
 * 聚合审计入口：对全部规则执行，汇总 findings 与 gate。
 *
 * gate.passed = WCAG 2.2 AA serious/critical 为 0 且硬偏好违反为 0（任务验收）。
 */
export function runA11yAudit(input: A11yAuditInput): A11yAuditResult {
  const rules: A11yRuleResult[] = A11Y_RULES.map((meta) => {
    const check = meta.check(input);
    const findings: A11yFinding[] = check.problems.map((problem) => ({
      ...problem,
      ruleId: meta.id,
      severity: meta.severity,
    }));
    return {
      ruleId: meta.id,
      severity: meta.severity,
      label: meta.label,
      passed: check.passed,
      findings,
    };
  });

  const seriousCriticalCount = rules.reduce(
    (count, rule) =>
      count
      + rule.findings.filter(
        (finding) => finding.severity === "serious" || finding.severity === "critical",
      ).length,
    0,
  );
  const hardPreferenceViolations = rules.find((rule) => rule.ruleId === "hard-preference-zero")
    ?.findings.length ?? 0;

  return {
    rules,
    gate: {
      seriousCriticalCount,
      hardPreferenceViolations,
      passed: seriousCriticalCount === 0 && hardPreferenceViolations === 0,
    },
  };
}

/** 取单条规则结果（测试/工具用）。 */
export function findRuleResult(result: A11yAuditResult, ruleId: string): A11yRuleResult | undefined {
  return result.rules.find((rule) => rule.ruleId === ruleId);
}
