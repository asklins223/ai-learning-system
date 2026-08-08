/**
 * 任务 05-4：CompanionVisualStateV1 纯逻辑单测（01-8 §7 / §5.2/§5.3）。
 * 覆盖：状态合法性、只表达已发生状态、assessment_handoff 语义、降级、
 * typed spatial action 白名单（拒绝任意 DOM/CSS/HTML/脚本）。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  COMPANION_CANCELLED_EFFECTS,
  COMPANION_SPATIAL_ACTIONS,
  COMPANION_STATE_LABEL,
  COMPANION_SYSTEM_EVENT_KINDS,
  COMPANION_VISUAL_STATES,
  companionPoseForState,
  containsNonSpatialMarkup,
  eventAllowsVisualState,
  eventKindAllowsVisualState,
  handoffViewFor,
  isCompanionSpatialAction,
  isCompanionVisualState,
  resolveCompanionPresentation,
  visualStateForSpatialAction,
  visualStateForSystemEvent,
} from "./companion-visual-state.ts";

describe("状态合法性（01-8 §7 完整边界）", () => {
  it("恰好 11 个状态，名称冻结", () => {
    assert.deepEqual(COMPANION_VISUAL_STATES, [
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
    ]);
  });

  it("无重复状态名", () => {
    assert.equal(new Set(COMPANION_VISUAL_STATES).size, COMPANION_VISUAL_STATES.length);
  });

  it("每个状态都有读屏标签（颜色/动画不是唯一信息载体，§13.4）", () => {
    for (const state of COMPANION_VISUAL_STATES) {
      assert.ok(
        COMPANION_STATE_LABEL[state].length > 0,
        `状态 ${state} 缺读屏标签`,
      );
    }
  });

  it("isCompanionVisualState 拒绝未知字符串 / 非字符串（fail-closed）", () => {
    for (const state of COMPANION_VISUAL_STATES) {
      assert.equal(isCompanionVisualState(state), true);
    }
    assert.equal(isCompanionVisualState("navigate2"), false);
    assert.equal(isCompanionVisualState(""), false);
    assert.equal(isCompanionVisualState(42), false);
    assert.equal(isCompanionVisualState(null), false);
  });
});

describe("typed spatial actions（§5.3）：模型不能返回任意 DOM/CSS/HTML/脚本", () => {
  it("9 个动作白名单冻结（focus_nodes 起，end_session 止）", () => {
    assert.deepEqual(COMPANION_SPATIAL_ACTIONS, [
      "focus_nodes",
      "draw_route",
      "stage_scene",
      "read_prompt",
      "offer_branch",
      "show_change",
      "return_to_origin",
      "end_session",
      "propose_curiosity_save",
    ]);
  });

  it("isCompanionSpatialAction 拒绝任意字符串 / 脚本形态", () => {
    assert.equal(isCompanionSpatialAction("focus_nodes"), true);
    assert.equal(isCompanionSpatialAction("show_change"), true);
    assert.equal(isCompanionSpatialAction("document.body.innerHTML"), false);
    assert.equal(isCompanionSpatialAction("<script>alert(1)</script>"), false);
    assert.equal(isCompanionSpatialAction(""), false);
    assert.equal(isCompanionSpatialAction(7), false);
  });

  it("containsNonSpatialMarkup 拒绝 HTML/CSS/JS 形态内容", () => {
    assert.equal(containsNonSpatialMarkup("focus_nodes"), false);
    assert.equal(containsNonSpatialMarkup("<script>"), true);
    assert.equal(containsNonSpatialMarkup("<style>"), true);
    assert.equal(containsNonSpatialMarkup("<svg"), true);
    assert.equal(containsNonSpatialMarkup("javascript:alert(1)"), true);
    assert.equal(containsNonSpatialMarkup("data:text/html,<b>x</b>"), true);
    assert.equal(containsNonSpatialMarkup("onclick=\"x\""), true);
    assert.equal(containsNonSpatialMarkup(undefined), true);
    assert.equal(containsNonSpatialMarkup(""), true);
  });

  it("每个合法动作都映射到一个合法视觉状态", () => {
    for (const action of COMPANION_SPATIAL_ACTIONS) {
      const state = visualStateForSpatialAction(action);
      assert.ok(state !== null, `动作 ${action} 无状态映射`);
      assert.equal(isCompanionVisualState(state), true);
    }
    assert.equal(visualStateForSpatialAction("<script>x</script>"), null);
  });

  it("八动作语义映射符合 01-8 §6（导航类→navigate、倾听→listen 等）", () => {
    assert.equal(visualStateForSpatialAction("focus_nodes"), "navigate");
    assert.equal(visualStateForSpatialAction("draw_route"), "navigate");
    assert.equal(visualStateForSpatialAction("return_to_origin"), "navigate");
    assert.equal(visualStateForSpatialAction("stage_scene"), "present_evidence");
    assert.equal(visualStateForSpatialAction("read_prompt"), "listen");
    assert.equal(visualStateForSpatialAction("end_session"), "exit_or_hidden");
    assert.equal(visualStateForSpatialAction("propose_curiosity_save"), "invite_once");
  });
});

describe("只表达已发生的系统状态（01-8 §7）", () => {
  it("visualStateForSystemEvent 是权威映射，覆盖全部 16 种事件 kind", () => {
    assert.equal(COMPANION_SYSTEM_EVENT_KINDS.length, 16);
    for (const kind of COMPANION_SYSTEM_EVENT_KINDS) {
      const state = visualStateForSystemEvent({ kind } as never);
      assert.equal(isCompanionVisualState(state), true, `事件 ${kind} 未映射到合法状态`);
    }
  });

  it("事件 → 状态映射正确", () => {
    assert.equal(visualStateForSystemEvent({ kind: "session_idle" }), "dormant");
    assert.equal(visualStateForSystemEvent({ kind: "invite_shown" }), "invite_once");
    assert.equal(
      visualStateForSystemEvent({ kind: "navigation_focused", nodes: ["a"] }),
      "navigate",
    );
    assert.equal(visualStateForSystemEvent({ kind: "scene_staged" }), "present_evidence");
    assert.equal(visualStateForSystemEvent({ kind: "prompt_read" }), "listen");
    assert.equal(visualStateForSystemEvent({ kind: "commit_recorded" }), "committed_change");
    assert.equal(visualStateForSystemEvent({ kind: "retry_suggested" }), "uncertain_or_retry");
    assert.equal(visualStateForSystemEvent({ kind: "session_ended" }), "exit_or_hidden");
  });

  it("eventAllowsVisualState：只有事件权威映射到的状态才被允许展示", () => {
    // 已发生 → 允许
    assert.equal(
      eventAllowsVisualState({ kind: "assessment_started" }, "assessment_handoff"),
      true,
    );
    // 未发生（事件是别的事）→ 拒绝展示该状态
    assert.equal(
      eventAllowsVisualState({ kind: "navigation_focused", nodes: ["a"] }, "assessment_handoff"),
      false,
    );
    // 评估中不允许伪装 committed_change（canonical 结果未发生）
    assert.equal(
      eventAllowsVisualState({ kind: "assessment_started" }, "committed_change"),
      false,
    );
    // 评估中不允许伪装 retry（进度未发生）
    assert.equal(
      eventAllowsVisualState({ kind: "assessment_started" }, "uncertain_or_retry"),
      false,
    );
    // idle 不允许进入动画状态（quiet 只静态锚点）
    assert.equal(eventAllowsVisualState({ kind: "session_idle" }, "navigate"), false);
    assert.equal(eventKindAllowsVisualState("session_idle", "dormant"), true);
    assert.equal(eventKindAllowsVisualState("assessment_started", "dormant"), false);
  });
});

describe("assessment_handoff 语义（伴星不参与判分）", () => {
  it("仅 assessment_started 事件 + assessment_handoff 状态触发完整退场视图", () => {
    const view = handoffViewFor(
      { kind: "assessment_started" },
      "assessment_handoff",
    );
    assert.deepEqual(view, {
      toolsRetracted: true,
      retreatToEdge: true,
      observerRingActive: true,
    });
  });

  it("其他事件/状态组合不伪装评估交接", () => {
    assert.deepEqual(
      handoffViewFor({ kind: "navigation_focused", nodes: ["a"] }, "assessment_handoff"),
      { toolsRetracted: false, retreatToEdge: false, observerRingActive: false },
    );
    assert.deepEqual(
      handoffViewFor(null, "assessment_handoff"),
      { toolsRetracted: false, retreatToEdge: false, observerRingActive: false },
    );
    assert.deepEqual(
      handoffViewFor({ kind: "assessment_started" }, "navigate"),
      { toolsRetracted: false, retreatToEdge: false, observerRingActive: false },
    );
  });

  it("assessment_handoff 姿态：工具收起、退到边缘、观测环接管", () => {
    const pose = companionPoseForState("assessment_handoff");
    assert.equal(pose.toolVisible, false);
    assert.equal(pose.edgePosition, true);
    assert.equal(pose.observerRing, true);
  });

  it("committed_change 是弱化确认：无工具、无夸张姿态", () => {
    const pose = companionPoseForState("committed_change");
    assert.equal(pose.toolVisible, false);
    assert.equal(pose.observerRing, false);
    assert.equal(pose.edgePosition, false);
    assert.equal(pose.hand, "down");
  });

  it("全部 11 个状态都有合法姿态（pose 全字段枚举有效）", () => {
    const eyes = new Set(["open", "focus", "closed"]);
    const mouths = new Set(["neutral", "speaking", "smile"]);
    const hands = new Set(["down", "point", "ring_hold", "wave"]);
    const rings = new Set(["full", "partial", "hidden"]);
    for (const state of COMPANION_VISUAL_STATES) {
      const pose = companionPoseForState(state);
      assert.ok(eyes.has(pose.eyes), `${state} eyes`);
      assert.ok(mouths.has(pose.mouth), `${state} mouth`);
      assert.ok(hands.has(pose.hand), `${state} hand`);
      assert.ok(rings.has(pose.ring), `${state} ring`);
      assert.equal(typeof pose.comet, "boolean");
      assert.equal(typeof pose.starGlow, "boolean");
      assert.equal(typeof pose.toolVisible, "boolean");
      assert.equal(typeof pose.edgePosition, "boolean");
      assert.equal(typeof pose.observerRing, "boolean");
    }
  });
});

describe("reduced-motion / 加载失败 / hidden 降级（01-8 §9 / 02-10 §8）", () => {
  it("默认（资产已加载、无 reduced-motion、未隐藏）→ animated", () => {
    const p = resolveCompanionPresentation("navigate");
    assert.equal(p.renderMode, "animated");
    assert.equal(p.motionEnabled, true);
    assert.deepEqual(p.cancelledEffects, []);
  });

  it("reduced-motion → 静态呈现，取消飞行/弹性缩放/视差/持续漂浮", () => {
    const p = resolveCompanionPresentation("navigate", { prefersReducedMotion: true });
    assert.equal(p.renderMode, "static");
    assert.equal(p.motionEnabled, false);
    assert.deepEqual(p.cancelledEffects, COMPANION_CANCELLED_EFFECTS);
    assert.deepEqual(p.cancelledEffects, ["fly", "elastic_scale", "parallax", "float"]);
    // 静态呈现仍保留语义标签（颜色/动画不是唯一信息载体）
    assert.ok(p.ariaLabel.length > 0);
  });

  it("资产加载失败 → 静态立绘 + 图标化手势，功能继续可用", () => {
    const p = resolveCompanionPresentation("navigate", { assetLoaded: false });
    assert.equal(p.renderMode, "static");
    assert.equal(p.motionEnabled, false);
    assert.equal(p.gestureIcon, "point");
  });

  it("hidden（temporary_hidden/global_off）→ 立即停渲染", () => {
    const p = resolveCompanionPresentation("explain", { hidden: true, assetLoaded: true });
    assert.equal(p.renderMode, "hidden");
    assert.equal(p.motionEnabled, false);
  });

  it("exit_or_hidden + reduced-motion → 直接消失", () => {
    const p = resolveCompanionPresentation("exit_or_hidden", { prefersReducedMotion: true });
    assert.equal(p.renderMode, "hidden");
  });

  it("quiet + dormant → 静态中性锚点（不进入 idle 动画）", () => {
    const p = resolveCompanionPresentation("dormant", { quiet: true });
    assert.equal(p.renderMode, "static");
    assert.equal(p.motionEnabled, false);
    // quiet 未召唤不播 idle 动画：gesture 为 none（中性锚点）
    assert.equal(p.gestureIcon, "none");
  });

  it("quiet 下非 dormant 状态仍按 normal 处理（不误伤已召唤交互）", () => {
    const p = resolveCompanionPresentation("listen", { quiet: true });
    assert.equal(p.renderMode, "animated");
    assert.equal(p.motionEnabled, true);
  });
});
