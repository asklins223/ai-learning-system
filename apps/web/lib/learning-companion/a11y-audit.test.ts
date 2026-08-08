/**
 * 阶段 08（W7）任务 08-1：A11y 与 onboarding 审计纯逻辑单测（§13.4 / WCAG 2.2 AA）。
 *
 * 覆盖：
 * - 颜色/对比度工具（parseColor / relativeLuminance / contrastRatio /
 *   isLargeText / textContrastThreshold）；
 * - WCAG 2.2 AA 每条规则的通过/失败样本（非文本、语义标签、文本与非文本对比度、
 *   200% zoom、320px reflow、键盘可达、键盘陷阱、焦点返回、焦点可见、触控目标、
 *   计时评分、reduced-motion、name-role-value）；
 * - §13.4 硬门禁：onboarding 跳过同级性、引导可返回/暂停/恢复/重播、
 *   tooltip/侧板焦点不陷阱、关闭后焦点返回、live region 只播报必要状态、
 *   拖拽等价操作、screen reader 可理解、颜色非唯一载体、语音不自动播放、
 *   三视口无阻断、角色状态一致性（动画不伪装评估进度/canonical 结果）、
 *   硬偏好违反为 0；
 * - runA11yAudit 聚合 gate（WCAG serious/critical 为 0 且硬偏好违反为 0）；
 * - 审计模块零副作用（纯逻辑，无 DOM/网络/随机源）。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import {
  DEFAULT_COMPANION_CONTROL_SNAPSHOT,
  type CompanionControlStateSnapshot,
  type ControlEffectsInput,
} from "./companion-control-state.ts";
import type { CompanionSystemEvent } from "./companion-visual-state.ts";
import {
  A11Y_RULES,
  contrastRatio,
  findRuleResult,
  isLargeText,
  parseColor,
  relativeLuminance,
  runA11yAudit,
  textContrastThreshold,
  type A11yAuditInput,
  type A11yAuditResult,
  type DomElementView,
  type OnboardingSkipActionView,
  type OverlayView,
  type RoleStateView,
} from "./a11y-audit.ts";

// ─── fixtures ────────────────────────────────────────────────────────────

function el(overrides: Partial<DomElementView> & { id: string }): DomElementView {
  return { ...overrides };
}

function ruleResult(result: A11yAuditResult, ruleId: string) {
  const rule = findRuleResult(result, ruleId);
  assert.ok(rule, `规则 ${ruleId} 存在`);
  return rule!;
}

function button(id: string, overrides: Partial<DomElementView> = {}): DomElementView {
  return el({
    id,
    tag: "button",
    interactive: true,
    focusable: true,
    focusVisibleStyle: true,
    tabIndex: 0,
    widthPx: 48,
    heightPx: 48,
    text: id,
    ...overrides,
  });
}

const quietUnsummonedInput: ControlEffectsInput = {
  presence: "quiet",
  surfaceActive: false,
  validActiveReason: false,
};

const snapshot = (overrides: Partial<CompanionControlStateSnapshot> = {}): CompanionControlStateSnapshot => ({
  ...DEFAULT_COMPANION_CONTROL_SNAPSHOT,
  ...overrides,
});

// ─── 1. 颜色与对比度工具 ─────────────────────────────────────────────────

describe("对比度工具（WCAG 1.4.3/1.4.11）", () => {
  it("parseColor 解析 #rgb / #rrggbb / rgb() / rgba() / 百分比，未知返回 null", () => {
    assert.deepEqual(parseColor("#fff"), { r: 255, g: 255, b: 255 });
    assert.deepEqual(parseColor("#000000"), { r: 0, g: 0, b: 0 });
    assert.deepEqual(parseColor("rgb(0, 0, 0)"), { r: 0, g: 0, b: 0 });
    assert.deepEqual(parseColor("rgb(255,255,255)"), { r: 255, g: 255, b: 255 });
    assert.deepEqual(parseColor("rgba(10, 20, 30, 0.5)"), { r: 10, g: 20, b: 30, a: 0.5 });
    assert.deepEqual(parseColor("rgb(50%, 0%, 0%)"), { r: 128, g: 0, b: 0 });
    assert.equal(parseColor("tomato"), null);
    assert.equal(parseColor("#12"), null);
  });

  it("relativeLuminance 符合 WCAG 边界：黑 0、白 1", () => {
    assert.equal(relativeLuminance({ r: 0, g: 0, b: 0 }), 0);
    assert.equal(relativeLuminance({ r: 255, g: 255, b: 255 }), 1);
  });

  it("contrastRatio：黑/白 21:1；同色 1:1；半透明不可可靠计算返回 null", () => {
    assert.ok(contrastRatio("#000000", "#ffffff") !== null);
    assert.ok(Math.abs((contrastRatio("#000000", "#ffffff") ?? 0) - 21) < 0.01);
    assert.ok(Math.abs((contrastRatio("#ffffff", "#ffffff") ?? 0) - 1) < 0.01);
    assert.equal(contrastRatio("rgba(0,0,0,0.5)", "#ffffff"), null);
    assert.equal(contrastRatio("tomato", "#ffffff"), null);
  });

  it("textContrastThreshold：大文本 3:1，普通文本 4.5:1", () => {
    assert.equal(isLargeText(24, 400), true);
    assert.equal(isLargeText(18.66, 700), true);
    assert.equal(isLargeText(18.66, 400), false);
    assert.equal(isLargeText(16, 700), false);
    assert.equal(textContrastThreshold(24, 400), 3);
    assert.equal(textContrastThreshold(16, 400), 4.5);
  });
});

// ─── 2. WCAG 2.2 AA 规则 ─────────────────────────────────────────────────

describe("wcag-1.1.1 非文本内容替代文本", () => {
  it("img/role=img 有 aria-label 或文本 → 通过", () => {
    const result = runA11yAudit({
      elements: [
        el({ id: "img-1", tag: "img", ariaLabel: "伴星立绘" }),
        el({ id: "img-2", tag: "img", text: "alt 文本" }),
        el({ id: "decor", tag: "svg", role: "img", ariaHidden: true }),
      ],
    });
    assert.equal(ruleResult(result, "wcag-1.1.1-non-text-content").passed, true);
  });

  it("img 无替代文本 → 违规；aria-hidden 装饰豁免", () => {
    const result = runA11yAudit({
      elements: [el({ id: "img-x", tag: "img" })],
    });
    assert.equal(ruleResult(result, "wcag-1.1.1-non-text-content").passed, false);
  });
});

describe("wcag-1.3.1 语义标签（伴星锚点/上下文/建议原因/忙碌退场/页面 action）", () => {
  it("全部需求元素有可访问名称 → 通过", () => {
    const result = runA11yAudit({
      elements: [
        el({ id: "anchor", role: "button", ariaLabel: "召唤学习伴星" }),
        el({ id: "context", role: "status", text: "当前上下文：复习卡片" }),
        el({ id: "reason", role: "note", text: "建议原因：该卡 3 天后到期" }),
        el({ id: "busy", role: "status", ariaLabel: "伴星忙碌中" }),
        el({ id: "action", role: "button", text: "开始航程" }),
      ],
      semanticLabelRequirements: [
        { elementId: "anchor", kind: "companion_anchor" },
        { elementId: "context", kind: "current_context" },
        { elementId: "reason", kind: "suggestion_reason" },
        { elementId: "busy", kind: "busy_or_exit" },
        { elementId: "action", kind: "page_action" },
      ],
    });
    assert.equal(ruleResult(result, "wcag-1.3.1-info-relationships").passed, true);
  });

  it("任一语义元素缺名称或未渲染 → 违规", () => {
    const missingName = runA11yAudit({
      elements: [el({ id: "anchor", role: "button" })],
      semanticLabelRequirements: [{ elementId: "anchor", kind: "companion_anchor" }],
    });
    assert.equal(ruleResult(missingName, "wcag-1.3.1-info-relationships").passed, false);

    const notRendered = runA11yAudit({
      elements: [],
      semanticLabelRequirements: [{ elementId: "missing", kind: "page_action" }],
    });
    assert.equal(ruleResult(notRendered, "wcag-1.3.1-info-relationships").passed, false);
  });
});

describe("wcag-1.4.3 文本对比度", () => {
  it("黑字白底（21:1）与 #767676 白底（≈4.55:1）普通文本 → 通过", () => {
    const result = runA11yAudit({
      elements: [
        el({ id: "t1", text: "标题", color: "#000000", backgroundColor: "#ffffff", fontSizePx: 16, fontWeight: 400 }),
        el({ id: "t2", text: "正文", color: "#767676", backgroundColor: "#ffffff", fontSizePx: 16, fontWeight: 400 }),
      ],
    });
    assert.equal(ruleResult(result, "wcag-1.4.3-contrast-minimum").passed, true);
  });

  it("对比度不足（#888 白底 ≈3.55:1 普通文本）→ 违规", () => {
    const result = runA11yAudit({
      elements: [
        el({ id: "t3", text: "正文", color: "#888888", backgroundColor: "#ffffff", fontSizePx: 16, fontWeight: 400 }),
      ],
    });
    assert.equal(ruleResult(result, "wcag-1.4.3-contrast-minimum").passed, false);
  });

  it("同色文本大文本也违规；#888 白底大文本（≈3.55:1 ≥ 3:1）→ 通过", () => {
    const normalLarge = runA11yAudit({
      elements: [
        el({ id: "t4", text: "大字", color: "#888888", backgroundColor: "#ffffff", fontSizePx: 24, fontWeight: 400 }),
      ],
    });
    assert.equal(ruleResult(normalLarge, "wcag-1.4.3-contrast-minimum").passed, true);
  });
});

describe("wcag-1.4.11 非文本对比度", () => {
  it("图形对比度 ≥ 3:1 → 通过", () => {
    const result = runA11yAudit({
      elements: [
        el({ id: "g1", fillColor: "#000000", backgroundColor: "#ffffff" }),
        el({ id: "g2", strokeColor: "#1a1a1a", backgroundColor: "#ffffff" }),
      ],
    });
    assert.equal(ruleResult(result, "wcag-1.4.11-non-text-contrast").passed, true);
  });

  it("浅灰图形白底（<3:1）→ 违规", () => {
    const result = runA11yAudit({
      elements: [el({ id: "g3", fillColor: "#cccccc", backgroundColor: "#ffffff" })],
    });
    assert.equal(ruleResult(result, "wcag-1.4.11-non-text-contrast").passed, false);
  });
});

describe("wcag-1.4.4 200% zoom 不丢功能", () => {
  it("zoom 后关键操作可见且可换行 → 通过", () => {
    const result = runA11yAudit({
      elements: [
        button("zoom-btn", { widthPx: 400, heightPx: 44, wrapable: true }),
        button("zoom-btn2", { widthPx: 48, heightPx: 48 }),
      ],
      zoom: { viewportWidthPx: 320 },
    });
    assert.equal(ruleResult(result, "wcag-1.4.4-resize-text").passed, true);
  });

  it("固定宽度超过 320px 视口且不可换行 → 违规", () => {
    const result = runA11yAudit({
      elements: [button("wide", { widthPx: 420, heightPx: 44, wrapable: false })],
      zoom: { viewportWidthPx: 320 },
    });
    assert.equal(ruleResult(result, "wcag-1.4.4-resize-text").passed, false);
  });

  it("zoom 下关键操作不可见 → 违规", () => {
    const result = runA11yAudit({
      elements: [button("hidden-zoom", { hidden: true })],
      zoom: { viewportWidthPx: 320 },
    });
    assert.equal(ruleResult(result, "wcag-1.4.4-resize-text").passed, false);
  });
});

describe("wcag-1.4.10 320px reflow 无横向滚动", () => {
  it("无横向滚动元素 → 通过", () => {
    const result = runA11yAudit({ elements: [button("ok", { widthPx: 300, wrapable: true })] });
    assert.equal(ruleResult(result, "wcag-1.4.10-reflow").passed, true);
  });

  it("引起横向滚动 → 违规", () => {
    const result = runA11yAudit({
      elements: [el({ id: "overflow", scrollsHorizontally: true, wrapable: false })],
    });
    assert.equal(ruleResult(result, "wcag-1.4.10-reflow").passed, false);
  });

  it("固定宽度 > 320 且不可换行 → 违规", () => {
    const result = runA11yAudit({
      elements: [el({ id: "wide", widthPx: 500, wrapable: false, visible: true })],
    });
    assert.equal(ruleResult(result, "wcag-1.4.10-reflow").passed, false);
  });
});

describe("wcag-2.1.1 键盘可达", () => {
  it("可聚焦按钮 → 通过；disabled 按钮豁免", () => {
    const result = runA11yAudit({
      elements: [button("a", {}), button("d", { disabled: true, focusable: false })],
    });
    assert.equal(ruleResult(result, "wcag-2.1.1-keyboard").passed, true);
  });

  it("交互控件不可聚焦或负 tabIndex → 违规", () => {
    const notFocusable = runA11yAudit({ elements: [button("b", { focusable: false })] });
    assert.equal(ruleResult(notFocusable, "wcag-2.1.1-keyboard").passed, false);
    const negativeTab = runA11yAudit({ elements: [button("c", { tabIndex: -1 })] });
    assert.equal(ruleResult(negativeTab, "wcag-2.1.1-keyboard").passed, false);
  });
});

describe("wcag-2.1.2 无键盘陷阱（focus trap）", () => {
  it("非模态浮层（focusTrap=none）不 trap → 通过", () => {
    const overlay: OverlayView = {
      id: "panel",
      kind: "panel",
      focusTrap: "none",
      ariaModal: false,
    };
    const result = runA11yAudit({ overlays: [overlay] });
    assert.equal(ruleResult(result, "wcag-2.1.2-no-keyboard-trap").passed, true);
  });

  it("模态浮层强制 trap 且有逃逸路径（关闭按钮/Esc/触发元素）→ 通过", () => {
    const withClose: OverlayView = {
      id: "dialog-close",
      kind: "dialog",
      focusTrap: "enforced",
      closeButtonId: "close-btn",
    };
    const withEsc: OverlayView = {
      id: "dialog-esc",
      kind: "dialog",
      focusTrap: "enforced",
      escCloses: true,
    };
    const result = runA11yAudit({ overlays: [withClose, withEsc] });
    assert.equal(ruleResult(result, "wcag-2.1.2-no-keyboard-trap").passed, true);
  });

  it("模态浮层强制 trap 但无任何逃逸路径 → 违规（焦点被困住）", () => {
    const trapped: OverlayView = {
      id: "dialog-trap",
      kind: "dialog",
      focusTrap: "enforced",
      ariaModal: true,
    };
    const result = runA11yAudit({ overlays: [trapped] });
    assert.equal(ruleResult(result, "wcag-2.1.2-no-keyboard-trap").passed, false);
    assert.equal(
      ruleResult(result, "wcag-2.1.2-no-keyboard-trap").findings[0]?.severity,
      "serious",
    );
  });
});

describe("wcag-2.4.3 焦点顺序 / 关闭后焦点返回", () => {
  it("关闭后焦点回到触发位置 → 通过；未提供 focusAfterCloseId 视为未验证", () => {
    const overlay: OverlayView = {
      id: "panel",
      kind: "panel",
      focusTrap: "none",
      triggerId: "summon",
      focusAfterCloseId: "summon",
    };
    const notVerified: OverlayView = { id: "panel2", kind: "panel", focusTrap: "none" };
    const result = runA11yAudit({ overlays: [overlay, notVerified] });
    assert.equal(ruleResult(result, "wcag-2.4.3-focus-order").passed, true);
  });

  it("关闭后焦点落在别处 → 违规", () => {
    const overlay: OverlayView = {
      id: "panel",
      kind: "panel",
      focusTrap: "none",
      triggerId: "summon",
      focusAfterCloseId: "somewhere-else",
    };
    const result = runA11yAudit({ overlays: [overlay] });
    assert.equal(ruleResult(result, "wcag-2.4.3-focus-order").passed, false);
  });
});

describe("wcag-2.4.7 焦点可见", () => {
  it("有焦点样式 → 通过", () => {
    const result = runA11yAudit({ elements: [button("f", { focusVisibleStyle: true })] });
    assert.equal(ruleResult(result, "wcag-2.4.7-focus-visible").passed, true);
  });

  it("交互控件无 focus-visible 样式 → 违规", () => {
    const result = runA11yAudit({ elements: [button("f2", { focusVisibleStyle: false })] });
    assert.equal(ruleResult(result, "wcag-2.4.7-focus-visible").passed, false);
  });
});

describe("wcag-2.5.8 触控目标 ≥44×44 CSS px", () => {
  it("48×48 按钮与 44×44 → 通过；内联文本链接豁免", () => {
    const result = runA11yAudit({
      elements: [
        button("big", { widthPx: 48, heightPx: 48 }),
        button("exact", { widthPx: 44, heightPx: 44 }),
        button("link", { widthPx: 30, heightPx: 20, inlineLink: true }),
      ],
    });
    assert.equal(ruleResult(result, "wcag-2.5.8-target-size").passed, true);
  });

  it("宽度或高度 < 44 → 违规", () => {
    const result = runA11yAudit({
      elements: [
        button("small-w", { widthPx: 40, heightPx: 48 }),
        button("small-h", { widthPx: 48, heightPx: 32 }),
      ],
    });
    assert.equal(ruleResult(result, "wcag-2.5.8-target-size").passed, false);
  });
});

describe("wcag-2.2.1 无倒计时评分 / 无操作速度评分", () => {
  it("无倒计时、无速度评分 → 通过", () => {
    const result = runA11yAudit({
      scoring: [{ id: "score", hasCountdown: false, scoresBySpeed: false, hasTimeLimitText: false }],
    });
    assert.equal(ruleResult(result, "wcag-2.2.1-timing-adjustable").passed, true);
    assert.equal(ruleResult(result, "no-timed-scoring").passed, true);
  });

  it("出现倒计时或速度评分 → 两条规则都违规", () => {
    const withCountdown = runA11yAudit({
      scoring: [{ id: "score", hasCountdown: true, scoresBySpeed: false, hasTimeLimitText: false }],
    });
    assert.equal(ruleResult(withCountdown, "wcag-2.2.1-timing-adjustable").passed, false);
    assert.equal(ruleResult(withCountdown, "no-timed-scoring").passed, false);

    const bySpeed = runA11yAudit({
      scoring: [{ id: "score", hasCountdown: false, scoresBySpeed: true, hasTimeLimitText: true }],
    });
    assert.equal(ruleResult(bySpeed, "no-timed-scoring").passed, false);
  });
});

describe("wcag-2.3.3 reduced-motion 完整支持", () => {
  it("reduced-motion 未启用或动画已静态化 → 通过", () => {
    const noPreference = runA11yAudit({
      elements: [el({ id: "anim", animationName: "lc-float", motionReduceSafe: false })],
    });
    assert.equal(ruleResult(noPreference, "wcag-2.3.3-animation-from-interactions").passed, true);

    const safe = runA11yAudit({
      reducedMotion: { prefersReducedMotion: true },
      elements: [el({ id: "anim2", animationName: "lc-float", motionReduceSafe: true })],
    });
    assert.equal(ruleResult(safe, "wcag-2.3.3-animation-from-interactions").passed, true);
  });

  it("reduced-motion 下仍有未静态化的动画 → 违规", () => {
    const result = runA11yAudit({
      reducedMotion: { prefersReducedMotion: true },
      elements: [el({ id: "anim3", animationName: "lc-float", motionReduceSafe: false })],
    });
    assert.equal(ruleResult(result, "wcag-2.3.3-animation-from-interactions").passed, false);
  });
});

describe("wcag-4.1.2 name-role-value", () => {
  it("按钮有名称 → 通过", () => {
    const result = runA11yAudit({ elements: [button("named", { ariaLabel: "开始航程" })] });
    assert.equal(ruleResult(result, "wcag-4.1.2-name-role-value").passed, true);
  });

  it("无名称的交互控件 → 违规", () => {
    const result = runA11yAudit({ elements: [button("anon", { ariaLabel: undefined, text: undefined })] });
    assert.equal(ruleResult(result, "wcag-4.1.2-name-role-value").passed, false);
  });
});

// ─── 3. §13.4 产品硬门禁 ─────────────────────────────────────────────────

describe("onboarding-skip-parity：跳过在每一步都是视觉/键盘/读屏同级动作", () => {
  it("每步都有同级跳过动作 → 通过", () => {
    const steps: OnboardingSkipActionView[] = ["boundaries", "companionship", "starting-point", "sample-flow", "trusted-handoff", "finish"].map(
      (stepId) => ({
        stepId,
        skipActionPresent: true,
        visualPeer: true,
        keyboardAccessible: true,
        screenReaderPeer: true,
      }),
    );
    const result = runA11yAudit({ onboardingSteps: steps });
    assert.equal(ruleResult(result, "onboarding-skip-parity").passed, true);
  });

  it("某步缺少跳过动作 → 违规（每一步都必须有）", () => {
    const result = runA11yAudit({
      onboardingSteps: [
        {
          stepId: "boundaries",
          skipActionPresent: false,
          visualPeer: true,
          keyboardAccessible: true,
          screenReaderPeer: true,
        },
      ],
    });
    assert.equal(ruleResult(result, "onboarding-skip-parity").passed, false);
  });

  it("跳过动作视觉弱化 / 键盘不可达 / 读屏不同级 → 违规", () => {
    const visuallyHidden = runA11yAudit({
      onboardingSteps: [
        {
          stepId: "boundaries",
          skipActionPresent: true,
          visualPeer: false,
          keyboardAccessible: true,
          screenReaderPeer: true,
        },
      ],
    });
    assert.equal(ruleResult(visuallyHidden, "onboarding-skip-parity").passed, false);

    const notKeyboard = runA11yAudit({
      onboardingSteps: [
        {
          stepId: "companionship",
          skipActionPresent: true,
          visualPeer: true,
          keyboardAccessible: false,
          screenReaderPeer: true,
        },
      ],
    });
    assert.equal(ruleResult(notKeyboard, "onboarding-skip-parity").passed, false);

    const notScreenReader = runA11yAudit({
      onboardingSteps: [
        {
          stepId: "finish",
          skipActionPresent: true,
          visualPeer: true,
          keyboardAccessible: true,
          screenReaderPeer: false,
        },
      ],
    });
    assert.equal(ruleResult(notScreenReader, "onboarding-skip-parity").passed, false);
  });
});

describe("onboarding-navigability：引导可返回/暂停/恢复/主动重播", () => {
  it("全部步骤四能力齐备 → 通过", () => {
    const result = runA11yAudit({
      onboardingNavigability: [
        { stepId: "boundaries", canGoBack: true, canPause: true, canResume: true, canManuallyReplay: true },
        { stepId: "finish", canGoBack: true, canPause: true, canResume: true, canManuallyReplay: true },
      ],
    });
    assert.equal(ruleResult(result, "onboarding-navigability").passed, true);
  });

  it("不能返回/暂停/恢复/重播 → 违规", () => {
    const noPause = runA11yAudit({
      onboardingNavigability: [
        { stepId: "sample-flow", canGoBack: true, canPause: false, canResume: true, canManuallyReplay: true },
      ],
    });
    assert.equal(ruleResult(noPause, "onboarding-navigability").passed, false);

    const noReplay = runA11yAudit({
      onboardingNavigability: [
        { stepId: "finish", canGoBack: true, canPause: true, canResume: true, canManuallyReplay: false },
      ],
    });
    assert.equal(ruleResult(noReplay, "onboarding-navigability").passed, false);
  });
});

describe("onboarding-no-focus-trap：tooltip/侧板焦点不陷阱", () => {
  it("guide/tooltip/panel 非模态（focusTrap=none）→ 通过", () => {
    const result = runA11yAudit({
      overlays: [
        { id: "guide", kind: "guide", focusTrap: "none", ariaModal: false },
        { id: "tooltip", kind: "tooltip", focusTrap: "none" },
        { id: "panel", kind: "panel", focusTrap: "none" },
      ],
    });
    assert.equal(ruleResult(result, "onboarding-no-focus-trap").passed, true);
  });

  it("guide/tooltip/panel 强制 trap 焦点 → 违规（会困住键盘用户）", () => {
    const result = runA11yAudit({
      overlays: [
        { id: "guide-trap", kind: "guide", focusTrap: "enforced", ariaModal: true },
      ],
    });
    assert.equal(ruleResult(result, "onboarding-no-focus-trap").passed, false);
    assert.equal(
      ruleResult(result, "onboarding-no-focus-trap").findings[0]?.severity,
      "critical",
    );
  });
});

describe("focus-return-on-close：关闭后焦点回原触发位置", () => {
  it("关闭后焦点回到触发按钮 → 通过", () => {
    const result = runA11yAudit({
      overlays: [
        { id: "panel", kind: "panel", focusTrap: "none", triggerId: "summon", focusAfterCloseId: "summon" },
      ],
    });
    assert.equal(ruleResult(result, "focus-return-on-close").passed, true);
  });

  it("关闭后焦点未回触发位置（含 null=body）→ 违规", () => {
    const elsewhere = runA11yAudit({
      overlays: [
        { id: "panel", kind: "panel", focusTrap: "none", triggerId: "summon", focusAfterCloseId: "other" },
      ],
    });
    assert.equal(ruleResult(elsewhere, "focus-return-on-close").passed, false);

    const lostToBody = runA11yAudit({
      overlays: [
        { id: "panel", kind: "panel", focusTrap: "none", triggerId: "summon", focusAfterCloseId: null },
      ],
    });
    assert.equal(ruleResult(lostToBody, "focus-return-on-close").passed, false);
  });
});

describe("live-region-minimal：live region 只播报必要状态", () => {
  const region = el({ id: "live", ariaLive: "polite", text: "面板已打开" });

  it("单个 polite live region、播报内容与面板内容不同 → 通过", () => {
    const result = runA11yAudit({
      elements: [region],
      overlays: [
        {
          id: "panel",
          kind: "panel",
          focusTrap: "none",
          liveRegionIds: ["live"],
          contentText: "这里是面板的全部内容正文",
        },
      ],
    });
    assert.equal(ruleResult(result, "live-region-minimal").passed, true);
  });

  it("live region 重复播报面板全部内容 → 违规", () => {
    const duplicated = runA11yAudit({
      elements: [el({ id: "live", ariaLive: "polite", text: "面板的全部内容正文" })],
      overlays: [
        {
          id: "panel",
          kind: "panel",
          focusTrap: "none",
          liveRegionIds: ["live"],
          contentText: "面板的全部内容正文",
        },
      ],
    });
    assert.equal(ruleResult(duplicated, "live-region-minimal").passed, false);
  });

  it("超过 2 个 live region 或缺少 aria-live → 违规", () => {
    const tooMany = runA11yAudit({
      elements: [
        el({ id: "r1", ariaLive: "polite" }),
        el({ id: "r2", ariaLive: "polite" }),
        el({ id: "r3", ariaLive: "polite" }),
      ],
      overlays: [
        {
          id: "panel",
          kind: "panel",
          focusTrap: "none",
          liveRegionIds: ["r1", "r2", "r3"],
          contentText: "内容",
        },
      ],
    });
    assert.equal(ruleResult(tooMany, "live-region-minimal").passed, false);

    const noLive = runA11yAudit({
      elements: [el({ id: "r", ariaLive: undefined })],
      overlays: [
        { id: "panel", kind: "panel", focusTrap: "none", liveRegionIds: ["r"], contentText: "内容" },
      ],
    });
    assert.equal(ruleResult(noLive, "live-region-minimal").passed, false);
  });
});

describe("drag-equivalents：拖拽有 tap-select-place/键盘/Switch 等价", () => {
  it("全部等价操作齐备 → 通过", () => {
    const result = runA11yAudit({
      dragScenes: [
        {
          id: "order-scene",
          hasTapSelectPlace: true,
          hasKeyboardEquivalent: true,
          hasSwitchEquivalent: true,
          hasScreenReaderDescription: true,
        },
      ],
    });
    assert.equal(ruleResult(result, "drag-equivalents").passed, true);
  });

  it("缺 tap-select-place / 键盘 / Switch → 违规", () => {
    const noTap = runA11yAudit({
      dragScenes: [
        {
          id: "scene",
          hasTapSelectPlace: false,
          hasKeyboardEquivalent: true,
          hasSwitchEquivalent: true,
          hasScreenReaderDescription: true,
        },
      ],
    });
    assert.equal(ruleResult(noTap, "drag-equivalents").passed, false);

    const noSwitch = runA11yAudit({
      dragScenes: [
        {
          id: "scene",
          hasTapSelectPlace: true,
          hasKeyboardEquivalent: true,
          hasSwitchEquivalent: false,
          hasScreenReaderDescription: true,
        },
      ],
    });
    assert.equal(ruleResult(noSwitch, "drag-equivalents").passed, false);
  });
});

describe("screen-reader-comprehension：节点/关系/路线/Scene/结果可理解", () => {
  it("全部图形结构有文本/读屏描述 → 通过", () => {
    const result = runA11yAudit({
      graphicStructures: [
        { id: "node-1", kind: "node", textLabel: "恒星" },
        { id: "rel-1", kind: "relation", ariaLabel: "恒星 连接 行星" },
        { id: "route-1", kind: "route", textLabel: "路线：3 步" },
        { id: "scene-1", kind: "scene", textLabel: "场景：排序" },
        { id: "result-1", kind: "result", textLabel: "结果：已锁定" },
      ],
    });
    assert.equal(ruleResult(result, "screen-reader-comprehension").passed, true);
  });

  it("纯 canvas 或完全无描述 → 违规", () => {
    const canvas = runA11yAudit({
      graphicStructures: [{ id: "node-c", kind: "node", canvasOnly: true }],
    });
    assert.equal(ruleResult(canvas, "screen-reader-comprehension").passed, false);

    const noLabel = runA11yAudit({
      graphicStructures: [{ id: "scene-x", kind: "scene" }],
    });
    assert.equal(ruleResult(noLabel, "screen-reader-comprehension").passed, false);
  });
});

describe("not-color-only：颜色/空间位置/动画不是唯一信息载体", () => {
  it("状态指示器有文本/图标 → 通过", () => {
    const result = runA11yAudit({
      statusIndicators: [{ id: "status", colorOnly: false }],
    });
    assert.equal(ruleResult(result, "not-color-only").passed, true);
  });

  it("仅用颜色表达状态 → 违规", () => {
    const result = runA11yAudit({
      statusIndicators: [{ id: "status", colorOnly: true }],
    });
    assert.equal(ruleResult(result, "not-color-only").passed, false);
  });
});

describe("voice-autoplay-off：语音输出默认不自动播放且可暂停/重听/确认/切模态", () => {
  it("默认不自动播放且全部控制齐备 → 通过", () => {
    const result = runA11yAudit({
      voiceOutputs: [
        {
          id: "voice",
          autoplay: false,
          canPause: true,
          canReplay: true,
          canConfirmTranscript: true,
          canSwitchModality: true,
        },
      ],
    });
    assert.equal(ruleResult(result, "voice-autoplay-off").passed, true);
  });

  it("自动播放或缺任一控制 → 违规", () => {
    const autoplay = runA11yAudit({
      voiceOutputs: [
        {
          id: "voice",
          autoplay: true,
          canPause: true,
          canReplay: true,
          canConfirmTranscript: true,
          canSwitchModality: true,
        },
      ],
    });
    assert.equal(ruleResult(autoplay, "voice-autoplay-off").passed, false);

    const noPause = runA11yAudit({
      voiceOutputs: [
        {
          id: "voice",
          autoplay: false,
          canPause: false,
          canReplay: true,
          canConfirmTranscript: true,
          canSwitchModality: true,
        },
      ],
    });
    assert.equal(ruleResult(noPause, "voice-autoplay-off").passed, false);
  });
});

describe("viewport-390-768-1440：三视口无主路径阻断", () => {
  it("三视口下主路径关键操作全部可见且在视口内 → 通过", () => {
    const viewports = [390, 768, 1440].map((viewportWidthPx) => ({
      viewportWidthPx,
      criticalActions: [
        { id: "primary-action", visible: true, inViewport: true },
        { id: "nav", visible: true, inViewport: true },
      ],
    }));
    const result = runA11yAudit({ viewports });
    assert.equal(ruleResult(result, "viewport-390-768-1440").passed, true);
  });

  it("390px 下主路径操作不可见或超出视口 → 违规", () => {
    const result = runA11yAudit({
      viewports: [
        {
          viewportWidthPx: 390,
          criticalActions: [{ id: "primary-action", visible: false, inViewport: false }],
        },
        {
          viewportWidthPx: 768,
          criticalActions: [{ id: "primary-action", visible: true, inViewport: true }],
        },
        {
          viewportWidthPx: 1440,
          criticalActions: [{ id: "primary-action", visible: true, inViewport: true }],
        },
      ],
    });
    assert.equal(ruleResult(result, "viewport-390-768-1440").passed, false);
  });
});

describe("role-state-consistency：角色状态与真实 Session/assessment/commit 状态一致", () => {
  function role(overrides: Partial<RoleStateView> & { id: string }): RoleStateView {
    return {
      visualState: "dormant",
      session: { started: false, ended: false },
      assessment: { started: false, resultProduced: false },
      commit: { recorded: false },
      ...overrides,
    };
  }

  it("committed_change 由 commit_recorded 事件映射且真实 commit 已记录 → 通过", () => {
    const result = runA11yAudit({
      roleStates: [
        role({
          id: "avatar",
          visualState: "committed_change",
          systemEvent: { kind: "commit_recorded" },
          commit: { recorded: true },
        }),
      ],
    });
    assert.equal(ruleResult(result, "role-state-consistency").passed, true);
  });

  it("assessment_handoff 展示但真实 assessment 未开始 → 违规（动画伪装评估进度）", () => {
    const result = runA11yAudit({
      roleStates: [role({ id: "avatar", visualState: "assessment_handoff" })],
    });
    assert.equal(ruleResult(result, "role-state-consistency").passed, false);
    assert.ok(
      ruleResult(result, "role-state-consistency").findings[0]?.message.includes("评估"),
    );
  });

  it("committed_change 展示但真实 commit 未记录 → 违规（动画伪装 canonical 结果）", () => {
    const result = runA11yAudit({
      roleStates: [role({ id: "avatar", visualState: "committed_change" })],
    });
    assert.equal(ruleResult(result, "role-state-consistency").passed, false);
  });

  it("视觉状态与已发生系统事件不匹配 → 违规（权威映射守卫）", () => {
    const mismatched: CompanionSystemEvent = { kind: "session_ended" };
    const result = runA11yAudit({
      roleStates: [
        role({
          id: "avatar",
          visualState: "committed_change",
          systemEvent: mismatched,
          commit: { recorded: true },
        }),
      ],
    });
    assert.equal(ruleResult(result, "role-state-consistency").passed, false);
  });

  it("assessment 真实开始时展示 handoff（映射一致）→ 通过", () => {
    const result = runA11yAudit({
      roleStates: [
        role({
          id: "avatar",
          visualState: "assessment_handoff",
          systemEvent: { kind: "assessment_started" },
          assessment: { started: true, resultProduced: false },
        }),
      ],
    });
    assert.equal(ruleResult(result, "role-state-consistency").passed, true);
  });

  it("学习卡徽标宣称理解变化但真实 trusted 事件为 0 → 违规（活动量伪装成知识成长）", () => {
    const result = runA11yAudit({
      learningCards: [
        {
          id: "card-1",
          badges: [
            { key: "trusted", label: "已验证 2 次", claimsUnderstandingChange: true },
            { key: "practice", label: "练习 3 次", claimsUnderstandingChange: false },
          ],
          realTrustedChangeCount: 0,
        },
      ],
    });
    assert.equal(ruleResult(result, "role-state-consistency").passed, false);
  });

  it("学习卡徽标真实 trusted 事件 > 0 → 通过", () => {
    const result = runA11yAudit({
      learningCards: [
        {
          id: "card-2",
          badges: [{ key: "trusted", label: "已验证 2 次", claimsUnderstandingChange: true }],
          realTrustedChangeCount: 2,
        },
      ],
    });
    assert.equal(ruleResult(result, "role-state-consistency").passed, true);
  });
});

describe("hard-preference-zero：硬偏好违反为 0（§16.4 硬 Gate）", () => {
  it("quiet 未召唤、无 hidden，零渲染 → 通过", () => {
    const result = runA11yAudit({
      hardPreference: {
        snapshot: snapshot(),
        controlInput: quietUnsummonedInput,
        rendering: {
          avatarAnimated: false,
          voiceOutputPlaying: false,
          proactiveSuggestionShown: false,
          inviteShown: false,
          observerActive: false,
          contextConstructed: false,
        },
      },
    });
    assert.equal(ruleResult(result, "hard-preference-zero").passed, true);
  });

  it("global_off 下仍渲染角色动画/语音/邀请/observer/context → 违规", () => {
    const result = runA11yAudit({
      hardPreference: {
        snapshot: snapshot({ globalOff: true, temporaryHidden: true }),
        controlInput: quietUnsummonedInput,
        rendering: {
          avatarAnimated: true,
          voiceOutputPlaying: true,
          proactiveSuggestionShown: true,
          inviteShown: true,
          observerActive: true,
          contextConstructed: true,
        },
      },
    });
    const rule = ruleResult(result, "hard-preference-zero");
    assert.equal(rule.passed, false);
    assert.ok(rule.findings.length >= 5, `应至少 5 项硬偏好违反，实际 ${rule.findings.length}`);
  });

  it("voice_output_off 下仍播放语音 → 违规", () => {
    const result = runA11yAudit({
      hardPreference: {
        snapshot: snapshot({ voiceOutputOff: true }),
        controlInput: quietUnsummonedInput,
        rendering: {
          avatarAnimated: false,
          voiceOutputPlaying: true,
          proactiveSuggestionShown: false,
          inviteShown: false,
          observerActive: false,
          contextConstructed: false,
        },
      },
    });
    assert.equal(ruleResult(result, "hard-preference-zero").passed, false);
  });

  it("animation_off 下仍渲染角色动画 → 违规", () => {
    const result = runA11yAudit({
      hardPreference: {
        snapshot: snapshot({ animationOff: true }),
        controlInput: quietUnsummonedInput,
        rendering: {
          avatarAnimated: true,
          voiceOutputPlaying: false,
          proactiveSuggestionShown: false,
          inviteShown: false,
          observerActive: false,
          contextConstructed: false,
        },
      },
    });
    assert.equal(ruleResult(result, "hard-preference-zero").passed, false);
  });

  it("quiet 未召唤（surfaceActive=false）仍挂 observer/构造 context → 违规", () => {
    const result = runA11yAudit({
      hardPreference: {
        snapshot: snapshot(),
        controlInput: quietUnsummonedInput,
        rendering: {
          avatarAnimated: false,
          voiceOutputPlaying: false,
          proactiveSuggestionShown: false,
          inviteShown: false,
          observerActive: true,
          contextConstructed: true,
        },
      },
    });
    assert.equal(ruleResult(result, "hard-preference-zero").passed, false);
  });

  it("page_muted 下仍显示主动建议 → 违规", () => {
    const result = runA11yAudit({
      hardPreference: {
        snapshot: snapshot({ pageMuted: true }),
        controlInput: { presence: "active", surfaceActive: true, validActiveReason: true },
        rendering: {
          avatarAnimated: false,
          voiceOutputPlaying: false,
          proactiveSuggestionShown: true,
          inviteShown: false,
          observerActive: false,
          contextConstructed: false,
        },
      },
    });
    assert.equal(ruleResult(result, "hard-preference-zero").passed, false);
  });
});

// ─── 4. 聚合入口与 gate ──────────────────────────────────────────────────

describe("runA11yAudit 聚合 gate", () => {
  it("空输入（无任何快照）：未确认 → fail closed，gate.passed=false", () => {
    const result = runA11yAudit({});
    assert.equal(result.rules.length, A11Y_RULES.length);
    // security_review LOW：未提供快照 → 视为「未确认」违规（fail closed），gate 不通过。
    assert.equal(result.gate.passed, false);
    assert.ok(
      result.gate.seriousCriticalCount > 0 || result.gate.hardPreferenceViolations > 0,
      "空输入必须在 gate 层产生未确认违规",
    );
  });

  it("违规样本：gate 正确累计 serious/critical 与硬偏好违反", () => {
    const result = runA11yAudit({
      elements: [button("small", { widthPx: 30, heightPx: 30 })], // wcag-2.5.8 serious
      overlays: [
        { id: "guide", kind: "guide", focusTrap: "enforced" }, // onboarding-no-focus-trap critical
      ],
      hardPreference: {
        snapshot: snapshot({ globalOff: true, temporaryHidden: true }),
        controlInput: quietUnsummonedInput,
        rendering: {
          avatarAnimated: true,
          voiceOutputPlaying: false,
          proactiveSuggestionShown: false,
          inviteShown: false,
          observerActive: false,
          contextConstructed: false,
        },
      },
    });
    assert.equal(result.gate.passed, false);
    assert.ok(result.gate.seriousCriticalCount > 0);
    assert.ok(result.gate.hardPreferenceViolations > 0);
    // critical/serious findings 全部计入 seriousCriticalCount
    const totalSeriousCritical = result.rules.reduce(
      (count, rule) =>
        count
        + rule.findings.filter(
          (finding) => finding.severity === "serious" || finding.severity === "critical",
        ).length,
      0,
    );
    assert.equal(result.gate.seriousCriticalCount, totalSeriousCritical);
  });

  it("规则注册表完整覆盖任务要求的规则 ID", () => {
    const ids = new Set(A11Y_RULES.map((rule) => rule.id));
    for (const expected of [
      "wcag-1.1.1-non-text-content",
      "wcag-1.3.1-info-relationships",
      "wcag-1.4.3-contrast-minimum",
      "wcag-1.4.4-resize-text",
      "wcag-1.4.10-reflow",
      "wcag-1.4.11-non-text-contrast",
      "wcag-2.1.1-keyboard",
      "wcag-2.1.2-no-keyboard-trap",
      "wcag-2.4.3-focus-order",
      "wcag-2.4.7-focus-visible",
      "wcag-2.5.8-target-size",
      "wcag-2.2.1-timing-adjustable",
      "wcag-2.3.3-animation-from-interactions",
      "wcag-4.1.2-name-role-value",
      "onboarding-skip-parity",
      "onboarding-navigability",
      "onboarding-no-focus-trap",
      "focus-return-on-close",
      "live-region-minimal",
      "drag-equivalents",
      "screen-reader-comprehension",
      "not-color-only",
      "voice-autoplay-off",
      "no-timed-scoring",
      "viewport-390-768-1440",
      "role-state-consistency",
      "hard-preference-zero",
    ]) {
      assert.ok(ids.has(expected), `规则 ${expected} 应在注册表中`);
    }
  });
});

// ─── 5. 零副作用（纯逻辑，无 DOM/网络/随机源）────────────────────────────

describe("a11y-audit.ts 零副作用", () => {
  it("源码不含 DOM/网络/持久化/随机源：可注入视图模型离线运行", () => {
    const source = readFileSync(
      fileURLToPath(new URL("./a11y-audit.ts", import.meta.url)),
      "utf8",
    );
    for (const forbidden of [
      "fetch(",
      "new XMLHttpRequest",
      "new WebSocket",
      "navigator.",
      "window.",
      "document.",
      "localStorage",
      "sessionStorage",
      "indexedDB",
      "Math.random",
      "setTimeout(",
      "setInterval(",
      "requestAnimationFrame",
      "new Audio(",
      "navigator.mediaDevices",
      "from \"react\"",
    ]) {
      assert.ok(!source.includes(forbidden), `a11y-audit.ts 出现副作用源 "${forbidden}"`);
    }
  });

  it("同一视图模型输入恒得同一输出（纯同步确定函数）", () => {
    const input: A11yAuditInput = {
      elements: [button("b1", { widthPx: 48, heightPx: 48, ariaLabel: "开始" })],
      overlays: [
        { id: "panel", kind: "panel", focusTrap: "none", triggerId: "b1", focusAfterCloseId: "b1" },
      ],
      onboardingSteps: [
        { stepId: "boundaries", skipActionPresent: true, visualPeer: true, keyboardAccessible: true, screenReaderPeer: true },
      ],
    };
    const first = runA11yAudit(input);
    for (let i = 0; i < 3; i += 1) {
      assert.deepEqual(runA11yAudit(input).gate, first.gate);
    }
  });
});
