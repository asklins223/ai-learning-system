import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { RotateCcw, Sparkles, X } from "lucide-react";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import {
  MAX_COMPANION_SCALE,
  MIN_COMPANION_SCALE,
  useRoomStore,
  type CompanionNormalizedAnchor,
  type CompanionPosition,
} from "../../app/room-store";
import type { CompanionAccountPatch, CompanionAccountStateV1 } from "@ailearn/shared/companion-shell-contracts";
import {
  COMPANION_INTERVENTION_OPTIONS,
  COMPANION_PRESENCE_OPTIONS,
  companionAccountDisabled as isCompanionAccountDisabled,
  quietHoursPatch,
  quietHoursWithBoundary,
} from "./companion-account-presence";
import {
  createRequestMeta,
  gatewayErrorMessage,
  unwrapGatewayResult,
} from "../../app/desktop-client";
import { resolveSceneMotionMode } from "../../scene/scene-motion";
import { useCompanionHomeProjection } from "../../app/companion-home-projection";
import { HOME_V2_ENABLED } from "../home-v2/home-v2";
import { HUD_PAGES } from "../hud/hud-pages";
import { HOME_V2_CAMERA_FRAME_EVENT } from "../home-v2/home-v2-camera";
import { useHomeV2 } from "../home-v2/HomeV2Experience";
import { normalizedHomeFloorPolygon } from "../home-v2/home-scene-profile";
import { HOME_V2_COMPANION_DRAG_EVENT } from "../home-v2/home-ambient-director";
import {
  COMPANION_HOME_ANCHORS,
  clampCompanionAnchorToPolygon,
  companionCueAllowed,
  companionPositionForNormalizedFootAnchor,
  companionPositionForProjectedFootAnchor,
  companionPointerHasPrimaryContact,
  companionSafeInset,
  companionSeatTarget,
  companionSemanticTravelDuration,
  companionTouchKindAt,
  companionTranslationBounds,
  companionViewportCorrection,
  companionWorldAnchorFromProjectedFoot,
  isCompanionActiveness,
  shouldCommitCompanionDrag,
  type CompanionCuePriority,
} from "./companion-home-placement";
import { WindowLive2D, type WindowLive2DStatus } from "./WindowLive2D";
import type { Live2DEmotionEvent } from "./live2d-emotion";

gsap.registerPlugin(useGSAP);

// Owner-approved in-window Live2D runtime. It never creates an external pet
// window and still falls back to the orb if WebGL or an asset is unavailable.
const LIVE2D_RUNTIME_ALLOWED = true;
const HOME_V2_FLOOR_POLYGON = normalizedHomeFloorPolygon();

/**
 * One companion for the whole system: a single persistent overlay mounted once
 * in `App`, never remounted by page switches. The home scene is the only
 * draggable context — a full-body free drag inside the viewport safe area that
 * commits a user-owned world anchor (persisted across restarts by the room
 * store). Task pages receive a fixed registry seat (`HUD_PAGES[*].seat`) that
 * is display-only; the seat's side and position are tracked in a ref that
 * survives page switches, so navigating never re-initializes the resident and
 * a side change travels there with a smooth hop instead of teleporting.
 */
const SCENE_COPY = {
  room: {
    kicker: "一直在桌边",
    title: "现在想从哪里继续？",
    body: "翻开桌上的研究册，接着想一想。也可以先温习学过的内容。",
    primary: "陪我继续",
    primaryIntent: "continue" as const,
    secondary: "先去复习",
    secondaryIntent: "review" as const,
  },
  study: {
    kicker: "研究进行中",
    title: "慢一点也没关系",
    body: "我会留在台灯旁。先把证据和自己的判断分开写，卡住时再点我。",
    primary: "验证这段理解",
    primaryIntent: "validate" as const,
    secondary: "看看星图",
    secondaryIntent: "graph" as const,
  },
  notebook: {
    kicker: "笔记展开了",
    title: "先留下真正改变判断的句子",
    body: "选中一段证据，就能把它折成一张以后会再遇见的学习卡。",
    primary: "继续研究",
    primaryIntent: "continue" as const,
    secondary: "查看星图",
    secondaryIntent: "graph" as const,
  },
  card: {
    kicker: "卡片正在成形",
    title: "问题要能让未来的你重新想一遍",
    body: "别只抄结论，把当时依赖的证据也留在背面。",
    primary: "回研究册",
    primaryIntent: "continue" as const,
    secondary: "今日复习",
    secondaryIntent: "review" as const,
  },
  "card-generation": {
    kicker: "候选正在整理",
    title: "先审核问题，再决定留下什么",
    body: "公开候选只负责让你判断是否值得复习；答案和激活回执仍由服务端控制。",
    primary: "回研究册",
    primaryIntent: "open-notebook" as const,
    secondary: "回到书房",
    secondaryIntent: "home" as const,
  },
  review: {
    kicker: "安静陪练",
    title: "先回忆，再翻面",
    body: "不会也没关系。真实标记模糊和不会，下一次出现的节奏才会更合适。",
    primary: "回到研究册",
    primaryIntent: "continue" as const,
    secondary: "查看星图",
    secondaryIntent: "graph" as const,
  },
  search: {
    kicker: "在资料边等你",
    title: "搜索的是证据，不只是关键词",
    body: "打开结果后，看看它来自笔记、学习卡还是原始来源。",
    primary: "回到研究册",
    primaryIntent: "continue" as const,
    secondary: "看看星图",
    secondaryIntent: "graph" as const,
  },
  graph: {
    kicker: "一起看见关系",
    title: "亮点之间的线，才是理解",
    body: "先找最孤单的概念；它通常就是下一步值得补证据的地方。",
    primary: "回到研究册",
    primaryIntent: "continue" as const,
    secondary: "查找证据",
    secondaryIntent: "search" as const,
  },
  validation: {
    kicker: "正在听你的解释",
    title: "先说清为什么，再说答案",
    body: "如果证据能支持因果链，我会和你一起把这次理解收好。",
    primary: "继续研究",
    primaryIntent: "continue" as const,
    secondary: "查看星图",
    secondaryIntent: "graph" as const,
  },
  "source-library": {
    kicker: "资料在这里",
    title: "先把来源收进来",
    body: "解析状态、来源类型和关联笔记都会来自当前工作区的服务端列表。",
    primary: "回到书房",
    primaryIntent: "home" as const,
    secondary: "打开笔记库",
    secondaryIntent: "open-notes" as const,
  },
  "source-detail": {
    kicker: "来源已展开",
    title: "从原文找到证据",
    body: "先看解析片段，再决定要不要开始写研究册。",
    primary: "打开笔记库",
    primaryIntent: "open-notes" as const,
    secondary: "回到来源库",
    secondaryIntent: "open-sources" as const,
  },
  "note-library": {
    kicker: "研究册架",
    title: "继续最近编辑的笔记",
    body: "这里列出当前工作区的真实笔记，不会用本机示例补齐。",
    primary: "回到书房",
    primaryIntent: "home" as const,
    secondary: "看看理解目标",
    secondaryIntent: "open-objectives" as const,
  },
  "objective-library": {
    kicker: "理解目标",
    title: "把结论变成可以验证的目标",
    body: "目标状态、来源血缘与下一步动作都由服务端 projection 决定。",
    primary: "回到书房",
    primaryIntent: "home" as const,
    secondary: "打开理解星图",
    secondaryIntent: "graph" as const,
  },
  "objective-detail": {
    kicker: "目标详情",
    title: "看清这条理解从哪里来",
    body: "公开摘要、来源和验证入口保持在同一个目标上下文里。",
    primary: "开始学习",
    primaryIntent: "continue" as const,
    secondary: "回到目标库",
    secondaryIntent: "open-objectives" as const,
  },
  "companion-center": {
    kicker: "伴星中心",
    title: "Mao 会在这里等你",
    body: "伴星停在呈现层：形象、真实档案摘要与存在感控制都可用；对话、记忆与提议不在伴星接入范围。",
    primary: "回到书房",
    primaryIntent: "home" as const,
    secondary: "打开设置",
    secondaryIntent: "open-settings" as const,
  },
  settings: {
    kicker: "书房设置",
    title: "把学习空间调成你的节奏",
    body: "账户、工作区、主题、无障碍和伴星偏好会在这里逐步接入。",
    primary: "回到书房",
    primaryIntent: "home" as const,
    secondary: "伴星中心",
    secondaryIntent: "open-companion-center" as const,
  },
} as const;

function durationFor(mode: "full" | "lite" | "off", full: number) {
  return mode === "off" ? 0 : mode === "lite" ? full * 0.55 : full;
}

function speakHomeV2Cue(text: string, reason: "cue" | "touch"): void {
  window.dispatchEvent(new CustomEvent("ailearn:home-v2-speak", {
    detail: { text, reason },
  }));
}

const COMPANION_FIXED_POSE = Object.freeze({ x: 0, y: 0, rotation: 0, scaleX: 1 } as const);

export function CompanionPresence() {
  const surface = useRoomStore((state) => state.surface);
  const theme = useRoomStore((state) => state.theme);
  const motionPreference = useRoomStore((state) => state.motionMode);
  const reducedMotion = useRoomStore((state) => state.reducedMotion);
  const motionMode = resolveSceneMotionMode(motionPreference, reducedMotion);
  const onboardingOpen = useRoomStore((state) => state.onboardingOpen);
  const companionOpen = useRoomStore((state) => state.companionOpen);
  const companionMoment = useRoomStore((state) => state.companionMoment);
  const companionPosition = useRoomStore((state) => state.companionPosition);
  const companionHomeZone = useRoomStore((state) => state.companionHomeZone);
  const companionPlacementOwner = useRoomStore((state) => state.companionPlacementOwner);
  const companionUserAnchor = useRoomStore((state) => state.companionUserAnchor);
  const companionScale = useRoomStore((state) => state.companionScale);
  const toggleCompanion = useRoomStore((state) => state.toggleCompanion);
  const closeCompanion = useRoomStore((state) => state.closeCompanion);
  const setCompanionPosition = useRoomStore((state) => state.setCompanionPosition);
  const setCompanionHomePlacement = useRoomStore((state) => state.setCompanionHomePlacement);
  const mutedCompanionSceneKeys = useRoomStore((state) => state.mutedCompanionSceneKeys);
  const companionFocusUntilTaskEnd = useRoomStore((state) => state.companionFocusUntilTaskEnd);
  const companionTemporarilyHidden = useRoomStore((state) => state.companionTemporarilyHidden);
  const setCompanionSceneMuted = useRoomStore((state) => state.setCompanionSceneMuted);
  const setCompanionFocusUntilTaskEnd = useRoomStore((state) => state.setCompanionFocusUntilTaskEnd);
  const setCompanionTemporarilyHidden = useRoomStore((state) => state.setCompanionTemporarilyHidden);
  const setCompanionUserPlacement = useRoomStore((state) => state.setCompanionUserPlacement);
  const setCompanionScale = useRoomStore((state) => state.setCompanionScale);
  const setCompanionMoment = useRoomStore((state) => state.setCompanionMoment);
  const resetCompanionPosition = useRoomStore((state) => state.resetCompanionPosition);
  const invoke = useRoomStore((state) => state.invoke);
  const {
    runFeature: runHomeV2Feature,
    introVisible: homeV2IntroVisible,
    modalOpen: homeV2ModalOpen,
    zone: homeV2Zone,
  } = useHomeV2();
  const windowState = useRoomStore((state) => state.windowState);
  const companionProjection = useCompanionHomeProjection();
  // 2026-09-16 裁决：唯一形态 Live2D；LIVE2D_RUNTIME_ALLOWED 保留为构建期总闸，
  // 关闭时伴星不可用（隐藏 + 说明），不再有 orb 兜底。
  const live2dRuntimeAllowed = LIVE2D_RUNTIME_ALLOWED;
  const rootRef = useRef<HTMLDivElement>(null);
  const anchorRef = useRef<HTMLDivElement>(null);
  const visualRef = useRef<HTMLDivElement>(null);
  const characterMotionRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const panelFrameRef = useRef(0);
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    startPosition: CompanionPosition;
    lastPosition: CompanionPosition;
    bounds: { minX: number; maxX: number; minY: number; maxY: number };
    startWorldAnchor: CompanionNormalizedAnchor;
    activated: boolean;
    movedWithPrimaryContact: boolean;
  } | null>(null);
  const suppressInviteRef = useRef(false);
  const shownCueRef = useRef<string | null>(null);
  const anchorInitializedRef = useRef(false);
  const worldAnchorRef = useRef<CompanionNormalizedAnchor>({ ...COMPANION_HOME_ANCHORS[companionHomeZone] });
  const projectCompanionRef = useRef<() => void>(() => undefined);
  const movementTimelineRef = useRef<gsap.core.Timeline | null>(null);
  /**
   * Cross-page seat memory. The component is mounted once and never remounts,
   * so this ref — not component state, not a per-page cache — is what makes
   * the seat (side, coordinates) survive page switches without any
   * re-initialization. `key` guards the animation: a same-side page switch
   * reuses the exact current position (zero movement), while a side change
   * travels through `seatTravelRef`.
   */
  const seatPlacementRef = useRef<{ key: string; x: number; y: number } | null>(null);
  const seatTravelRef = useRef<gsap.core.Timeline | null>(null);
  /** Last placement context ("home" vs a task surface) for return-home travel. */
  const lastPlacementContextRef = useRef<"home" | "surface">("home");
  // Closure snapshots for the placement effect, which intentionally lists a
  // narrow dependency set: a drag can flip these between renders without
  // re-running the effect.
  const motionModeRef = useRef(motionMode);
  motionModeRef.current = motionMode;
  const presencePausedRef = useRef(false);
  // Cue arbitration reads placement ownership without making it an effect
  // dependency: a drag can claim ownership while a bubble is already visible.
  const placementOwnerRef = useRef(companionPlacementOwner);
  placementOwnerRef.current = companionPlacementOwner;
  const [dragging, setDragging] = useState(false);
  const [status, setStatus] = useState<WindowLive2DStatus>(() => (
    live2dRuntimeAllowed ? "loading" : "unavailable"
  ));
  // 设置页的「半身形象」读的是模型是否真的加载成功，只有这里知道，
  // 所以把状态同时发布到 room store，而不是让页面去猜或读服务端占位。
  const setLive2dStatus = useRoomStore((state) => state.setLive2dStatus);
  useEffect(() => { setLive2dStatus(status); }, [setLive2dStatus, status]);
  const [unavailableNoticeDismissed, setUnavailableNoticeDismissed] = useState(false);
  const [inviteTrigger, setInviteTrigger] = useState(0);
  const [touchKind, setTouchKind] = useState<"head" | "body" | null>(null);
  const [homeCue, setHomeCue] = useState<string | null>(null);
  // 账号级 presence（2026-09-16 裁决 3）：跨设备同步，写入走 revision CAS。
  const [accountState, setAccountState] = useState<CompanionAccountStateV1 | null>(null);
  const [accountFailure, setAccountFailure] = useState<string | null>(null);
  const [accountSaving, setAccountSaving] = useState(false);
  const targetWorldAnchor = companionPlacementOwner === "user" && companionUserAnchor
    ? companionUserAnchor
    : COMPANION_HOME_ANCHORS[companionHomeZone];
  const hudPage = useRoomStore((state) => state.hudPage);
  const sceneKey = surface ?? "room";
  const copy = SCENE_COPY[sceneKey];
  const formalAssessmentSilent = surface === "validation";
  // Ordinary task pages keep a quiet, fixed companion seat. Only formal
  // assessment stays completely silent so the answer field remains the sole
  // focus. The full whisper/actions panel remains a room-only affordance.
  const companionVisualOnly = Boolean(surface) && !formalAssessmentSilent;
  const taskSurfaceQuiet = formalAssessmentSilent;
  // 页面级存在感（2026-09-16 裁决 3）：按页静音只抑制**主动**输出（气泡/提示音/
  // 提示语音），不阻断用户主动点击触发的互动；专注模式在任务面关闭时自动结束。
  const pageMuted = mutedCompanionSceneKeys.includes(sceneKey);
  const companionSilenced = pageMuted || companionFocusUntilTaskEnd;
  // globalEnabled=false 是账号级关闭：形象不出现，但用户可以在同一处重新开启。
  const companionAccountDisabled = isCompanionAccountDisabled(accountState);
  const presenceHidden = onboardingOpen || formalAssessmentSilent || companionTemporarilyHidden || companionAccountDisabled;
  const presencePaused = presenceHidden || homeV2ModalOpen || windowState !== "visible";
  presencePausedRef.current = presencePaused;

  const loadCompanionAccount = useCallback(async () => {
    try {
      const session = await window.ailearn.auth.getState({ meta: createRequestMeta() });
      const context = unwrapGatewayResult(session);
      if (context.status !== "authenticated" || !context.workspace) {
        // 未登录 / 匿名房间不提供账号级设置，也不把它渲染成失败。
        setAccountState(null);
        setAccountFailure(null);
        return;
      }
      const response = await window.ailearn.companion.account.getState({
        meta: createRequestMeta(context.workspace.workspaceEpoch),
      });
      setAccountState(unwrapGatewayResult(response).account);
      setAccountFailure(null);
    } catch (error) {
      setAccountFailure(gatewayErrorMessage(error));
    }
  }, []);

  useEffect(() => {
    void loadCompanionAccount();
  }, [loadCompanionAccount]);

  const patchCompanionAccount = useCallback(async (patch: Omit<CompanionAccountPatch, "revision">) => {
    if (accountSaving || !accountState) return;
    setAccountSaving(true);
    try {
      const session = await window.ailearn.auth.getState({ meta: createRequestMeta() });
      const context = unwrapGatewayResult(session);
      if (context.status !== "authenticated" || !context.workspace) return;
      const response = await window.ailearn.companion.account.patchState({
        meta: createRequestMeta(context.workspace.workspaceEpoch),
        request: { ...patch, revision: accountState.revision },
      });
      setAccountState(unwrapGatewayResult(response));
      setAccountFailure(null);
    } catch (error) {
      // CAS 冲突不做自动重放：先重新读取账号状态，再由用户重新确认这次改动。
      const message = gatewayErrorMessage(error);
      await loadCompanionAccount();
      setAccountFailure(message);
    } finally {
      setAccountSaving(false);
    }
  }, [accountSaving, accountState, loadCompanionAccount]);

  // 专注到本次任务结束：任务面关闭（回到房间）时自动解除，避免变成永久静音。
  useEffect(() => {
    if (!companionFocusUntilTaskEnd) return;
    if (surface) return;
    setCompanionFocusUntilTaskEnd(false);
  }, [companionFocusUntilTaskEnd, surface, setCompanionFocusUntilTaskEnd]);

  useEffect(() => {
    if (!HOME_V2_ENABLED) return;
    window.dispatchEvent(new CustomEvent(HOME_V2_COMPANION_DRAG_EVENT, {
      detail: { active: dragging },
    }));
    return () => {
      if (!dragging) return;
      window.dispatchEvent(new CustomEvent(HOME_V2_COMPANION_DRAG_EVENT, {
        detail: { active: false },
      }));
    };
  }, [dragging]);

  const prioritizedCue = useMemo((): {
    readonly priority: CompanionCuePriority;
    readonly text: string;
    readonly zone: "desk" | "shelf" | "window" | "rest";
    readonly key: string;
  } | null => {
    if (!HOME_V2_ENABLED || companionProjection.loading || companionProjection.failure) return null;
    const proactive = companionProjection.projection?.proactiveCue;
    if (!proactive) return null;
    return { priority: "ordinary", text: proactive.text, zone: "rest", key: `ordinary:${proactive.revision}` };
  }, [companionProjection.failure, companionProjection.loading, companionProjection.projection]);

  const positionPanel = useCallback(() => {
    if (panelFrameRef.current) return;
    panelFrameRef.current = window.requestAnimationFrame(() => {
      panelFrameRef.current = 0;
      const root = rootRef.current;
      const visual = visualRef.current;
      const panel = panelRef.current;
      if (!root || !visual || !panel) return;
      const rootRect = root.getBoundingClientRect();
      const visualRect = visual.getBoundingClientRect();
      const panelWidth = panel.offsetWidth;
      const panelHeight = panel.offsetHeight;
      if (rootRect.width <= 0 || rootRect.height <= 0 || panelWidth <= 0 || panelHeight <= 0) return;

      const safe = companionSafeInset(rootRect);
      const gap = rootRect.width < 440 ? 8 : 12;
      const leftSpace = visualRect.left - rootRect.left;
      const rightSpace = rootRect.right - visualRect.right;
      const side = leftSpace >= panelWidth + gap || leftSpace >= rightSpace ? "left" : "right";
      const unclampedLeft = side === "left"
        ? visualRect.left - rootRect.left - panelWidth - gap
        : visualRect.right - rootRect.left + gap;
      const maxLeft = Math.max(safe, rootRect.width - panelWidth - safe);
      const left = Math.min(maxLeft, Math.max(safe, unclampedLeft));
      const desiredTop = visualRect.top - rootRect.top + Math.min(28, visualRect.height * 0.14);
      const maxTop = Math.max(safe, rootRect.height - panelHeight - safe);
      const top = Math.min(maxTop, Math.max(safe, desiredTop));

      panel.dataset.panelSide = side;
      panel.style.left = `${Math.round(left)}px`;
      panel.style.top = `${Math.round(top)}px`;
      panel.style.right = "auto";
      panel.style.bottom = "auto";
    });
  }, []);

  const projectCompanionIntoCamera = useCallback(() => {
    if (!HOME_V2_ENABLED || surface || dragRef.current) return;
    const root = rootRef.current;
    const anchor = anchorRef.current;
    const visual = visualRef.current;
    const scene = document.querySelector<HTMLElement>(".room-reference-frame");
    const cameraRig = scene?.querySelector<HTMLElement>(".room-camera-rig");
    if (!root || !anchor || !visual || !scene || !cameraRig) return;

    const rootRect = root.getBoundingClientRect();
    const sceneRect = scene.getBoundingClientRect();
    const projectedWorld = cameraRig.getBoundingClientRect();
    const anchorWidth = anchor.offsetWidth;
    const anchorHeight = anchor.offsetHeight;
    if (rootRect.width <= 0
      || rootRect.height <= 0
      || sceneRect.width <= 0
      || projectedWorld.width <= 0
      || projectedWorld.height <= 0
      || anchorWidth <= 0
      || anchorHeight <= 0) return;

    const target = companionPositionForProjectedFootAnchor(
      worldAnchorRef.current,
      projectedWorld,
      rootRect,
      { width: anchorWidth, height: anchorHeight },
    );
    // The companion is a room resident, so camera zoom affects both its ground
    // point and its apparent size. Its own scale preference remains multiplicative.
    const cameraScale = projectedWorld.width / sceneRect.width;
    // Full-body guarantee: the camera zoom may enlarge the character, but the
    // whole model must stay between its ground point and the viewport's top
    // safe inset. Capping the visual scale prevents a half-body crop when a
    // close-up zone pushes the character's head past the top of the window.
    const footY = target.y + anchorHeight;
    const maxVisualScale = Math.max(0.3, (footY - companionSafeInset(rootRect)) / anchorHeight);
    gsap.set(visual, {
      scale: Math.min(companionScale * 0.9 * cameraScale, maxVisualScale),
      transformOrigin: "50% 100%",
      force3D: true,
    });
    gsap.set(anchor, {
      left: 0,
      top: 0,
      right: "auto",
      bottom: "auto",
      autoAlpha: 1,
      x: target.x,
      y: target.y,
      force3D: true,
    });
    // Arbitrary user anchors can leave the current camera crop. Keep the
    // character reachable without changing the stored room coordinate; returning
    // to wide therefore restores the exact hand-placed ground point.
    const correction = companionViewportCorrection(rootRect, visual.getBoundingClientRect());
    if (Math.abs(correction.x) > 0.01 || Math.abs(correction.y) > 0.01) {
      gsap.set(anchor, {
        x: target.x + correction.x,
        y: target.y + correction.y,
        force3D: true,
      });
    }
    root.dataset.worldAnchor = `${worldAnchorRef.current.x},${worldAnchorRef.current.y}`;
    root.dataset.cameraScale = String(cameraScale);
    root.dataset.projectionState = "tracking";
    positionPanel();
  }, [companionScale, positionPanel, surface]);
  projectCompanionRef.current = projectCompanionIntoCamera;

  const commitCurrentUserPlacement = useCallback(() => {
    const root = rootRef.current;
    const visual = visualRef.current;
    if (!root || !visual) return;
    const scene = document.querySelector<HTMLElement>(".room-reference-frame");
    const sceneRect = scene?.querySelector<HTMLElement>(".room-camera-rig")?.getBoundingClientRect()
      ?? scene?.getBoundingClientRect()
      ?? root.getBoundingClientRect();
    const visualRect = visual.getBoundingClientRect();
    if (sceneRect.width <= 0 || sceneRect.height <= 0 || visualRect.width <= 0 || visualRect.height <= 0) return;
    const nextWorldAnchor = clampCompanionAnchorToPolygon(companionWorldAnchorFromProjectedFoot({
      x: (visualRect.left + visualRect.right) / 2,
      y: visualRect.bottom,
    }, sceneRect), HOME_V2_FLOOR_POLYGON);
    worldAnchorRef.current = nextWorldAnchor;
    root.dataset.worldAnchor = `${nextWorldAnchor.x},${nextWorldAnchor.y}`;
    setCompanionUserPlacement(nextWorldAnchor);
    projectCompanionRef.current();
  }, [setCompanionUserPlacement]);

  const clampVisibleCompanion = useCallback(() => {
    const root = rootRef.current;
    const anchor = anchorRef.current;
    const visual = visualRef.current;
    if (!root || !anchor || !visual) return;
    // Pointer ownership wins over all automatic placement. Clamping while a
    // drag is active feels like a hidden magnet and can overwrite the pointer
    // delta with a stale semantic-zone correction. The same protection applies
    // while a seat travel is walking: the tween's own onUpdate owns the anchor
    // until it lands on the seat.
    if (dragRef.current || seatTravelRef.current) {
      positionPanel();
      return;
    }
    const rootRect = root.getBoundingClientRect();
    const visualRect = visual.getBoundingClientRect();
    if (rootRect.width <= 0 || rootRect.height <= 0 || visualRect.width <= 0 || visualRect.height <= 0) return;
    const correction = companionViewportCorrection(rootRect, visualRect);
    if (Math.abs(correction.x) > 0.5 || Math.abs(correction.y) > 0.5) {
      const actualX = Number(gsap.getProperty(anchor, "x")) || 0;
      const actualY = Number(gsap.getProperty(anchor, "y")) || 0;
      const next = { x: actualX + correction.x, y: actualY + correction.y };
      gsap.killTweensOf(anchor, "x,y");
      gsap.set(anchor, { x: next.x, y: next.y, force3D: true });
      // V2's viewport correction is projection-only. Saving this correction as
      // a room coordinate is the old magnetic-snap bug: each camera crop would
      // slowly rewrite the user's placement. Legacy scenes retain their offset.
      if (!HOME_V2_ENABLED || surface) setCompanionPosition(next);
    }
    positionPanel();
  }, [positionPanel, setCompanionPosition, surface]);

  useEffect(() => {
    if (!presencePaused) return;
    const drag = dragRef.current;
    if (!drag) return;
    // Window hide/blur is a canceled gesture boundary. Discard ownership now,
    // before Chromium emits pointercancel/lostpointercapture while the frozen
    // frame is being captured. A canceled gesture must never become a saved
    // user anchor.
    dragRef.current = null;
    suppressInviteRef.current = true;
    setDragging(false);
    worldAnchorRef.current = { ...drag.startWorldAnchor };
    projectCompanionRef.current();
  }, [presencePaused]);

  useEffect(() => {
    if (companionMoment !== "lamp") return;
    const settle = gsap.delayedCall(1.35, () => setCompanionMoment("idle"));
    return () => { settle.kill(); };
  }, [companionMoment, setCompanionMoment, theme]);

  useEffect(() => {
    if (companionMoment !== "confirm" || surface) return;
    const settle = gsap.delayedCall(4.2, () => setCompanionMoment("idle"));
    return () => { settle.kill(); };
  }, [companionMoment, setCompanionMoment, surface]);

  useEffect(() => {
    if (!touchKind) return;
    const settle = gsap.delayedCall(1.85, () => {
      setTouchKind(null);
      setHomeCue(null);
    });
    return () => { settle.kill(); };
  }, [touchKind]);

  useEffect(() => {
    if (!HOME_V2_ENABLED || presencePaused || companionSilenced || homeV2IntroVisible || !prioritizedCue) return;
    if (shownCueRef.current === prioritizedCue.key) return;
    const activeness = isCompanionActiveness(companionProjection.projection?.profileSummary.activeness)
      ? companionProjection.projection.profileSummary.activeness
      : "quiet";
    if (prioritizedCue.priority === "ordinary") {
      let lastAt = 0;
      try {
        lastAt = Number(window.localStorage.getItem("ailearn.home-v2.last-ordinary-cue") ?? "0");
      } catch {
        // A privacy-restricted session may not expose persistent storage.
      }
      if (!companionCueAllowed({
        activeness,
        priority: prioritizedCue.priority,
        lastOrdinaryCueAt: lastAt,
        now: Date.now(),
      })) return;
    }
    const revealAt = prioritizedCue.priority === "ordinary" ? 3.2 : 1.05;
    const hideAt = prioritizedCue.priority === "ordinary" ? 7.4 : 5;
    const cueTimeline = gsap.timeline();
    cueTimeline.call(() => {
      shownCueRef.current = prioritizedCue.key;
      // Cues may choose a contextual semantic perch, but a hand-placed world
      // anchor is immutable until the user drags or explicitly resets it.
      if (!dragRef.current && placementOwnerRef.current === "semantic") {
        setCompanionHomePlacement(prioritizedCue.zone);
      }
      setHomeCue(prioritizedCue.text);
      if (prioritizedCue.priority !== "ordinary") {
        speakHomeV2Cue(prioritizedCue.text, "cue");
      }
      window.dispatchEvent(new CustomEvent("ailearn:home-v2-sound", { detail: { kind: "footstep" } }));
      if (prioritizedCue.priority === "ordinary") {
        try {
          window.localStorage.setItem("ailearn.home-v2.last-ordinary-cue", String(Date.now()));
        } catch {
          // The cue can still be shown without persisting its low-frequency gate.
        }
      }
    }, undefined, revealAt);
    cueTimeline.call(() => {
      setHomeCue(null);
    }, undefined, hideAt);
    return () => {
      cueTimeline.kill();
      // Losing focus or opening a task cancels the cue lifecycle. Clear any
      // text already revealed so resuming cannot leave a one-shot prompt
      // pinned indefinitely after its timeline has been destroyed, and return a
      // borrowed position immediately.
      setHomeCue(null);
    };
  }, [companionProjection.projection, companionSilenced, homeV2IntroVisible, presencePaused, prioritizedCue, setCompanionHomePlacement]);

  useLayoutEffect(() => {
    const root = rootRef.current;
    const anchor = anchorRef.current;
    const visual = visualRef.current;
    if (!root || !anchor || !visual) return;

    let frame = 0;
    const scheduleProjection = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(projectCompanionIntoCamera);
    };

    if (HOME_V2_ENABLED && !surface) {
      if (!anchorInitializedRef.current) {
        worldAnchorRef.current = { ...targetWorldAnchor };
        anchorInitializedRef.current = true;
      }
      if (lastPlacementContextRef.current !== "home") {
        // Returning from a task page: adopt the visual's current ground point
        // as the world anchor so the synchronous first projection below cannot
        // teleport the resident across the window. The walk timeline re-runs
        // with the same commit and carries it home smoothly.
        const cameraRig = document.querySelector<HTMLElement>(".room-camera-rig");
        const visualRect = visual.getBoundingClientRect();
        const rigRect = cameraRig?.getBoundingClientRect();
        if (rigRect && rigRect.width > 0 && rigRect.height > 0 && visualRect.width > 0 && visualRect.height > 0) {
          worldAnchorRef.current = clampCompanionAnchorToPolygon(companionWorldAnchorFromProjectedFoot({
            x: (visualRect.left + visualRect.right) / 2,
            y: visualRect.bottom,
          }, rigRect), HOME_V2_FLOOR_POLYGON);
        }
        lastPlacementContextRef.current = "home";
      }
      const observer = new ResizeObserver(scheduleProjection);
      observer.observe(root);
      observer.observe(anchor);
      observer.observe(visual);
      const cameraFrame = () => projectCompanionIntoCamera();
      window.addEventListener(HOME_V2_CAMERA_FRAME_EVENT, cameraFrame);
      window.addEventListener("resize", scheduleProjection);
      window.visualViewport?.addEventListener("resize", scheduleProjection);
      window.visualViewport?.addEventListener("scroll", scheduleProjection);
      // This synchronous first projection prevents a frame at the legacy CSS
      // anchor; camera commands subsequently publish one update per GSAP frame.
      projectCompanionIntoCamera();
      return () => {
        window.cancelAnimationFrame(frame);
        observer.disconnect();
        window.removeEventListener(HOME_V2_CAMERA_FRAME_EVENT, cameraFrame);
        window.removeEventListener("resize", scheduleProjection);
        window.visualViewport?.removeEventListener("resize", scheduleProjection);
        window.visualViewport?.removeEventListener("scroll", scheduleProjection);
      };
    }

    const placeLegacyAnchor = () => {
      if (dragRef.current) return;
      const rootRect = root.getBoundingClientRect();
      if (rootRect.width <= 0 || rootRect.height <= 0) return;
      lastPlacementContextRef.current = "surface";
      seatTravelRef.current?.kill();
      seatTravelRef.current = null;
      // Legacy (v1) home: a hand-placed user anchor wins over the zone seat.
      if (!surface && !HOME_V2_ENABLED
        && companionPlacementOwner === "user"
        && companionUserAnchor) {
        const pos = companionPositionForNormalizedFootAnchor(
          companionUserAnchor,
          { width: rootRect.width, height: rootRect.height },
          { width: anchor.offsetWidth, height: anchor.offsetHeight },
        );
        gsap.set(anchor, {
          left: 0,
          top: 0,
          right: "auto",
          bottom: "auto",
          x: pos.x,
          y: pos.y,
          force3D: true,
        });
        clampVisibleCompanion();
        return;
      }
      // The approved page registry is the source of the seat: reading pages put
      // Mao on the left so the paper owns the right, working pages the reverse.
      // Every surface publishes its own hudPage, so the registry alone decides
      // the seat and no surface list may shadow it here. Task pages are fixed,
      // display-only seats: nothing here reads user drag state.
      const seat = HUD_PAGES[hudPage].seat;
      const seatKey = `${surface ?? "room"}:${hudPage}`;
      // Pages that declare no seat (wide formal pages) fade the resident out
      // instead of pinning it to a side.
      if (seat === "none") {
        gsap.to(anchor, {
          autoAlpha: 0,
          duration: durationFor(motionModeRef.current, 0.18),
          overwrite: "auto",
        });
        seatPlacementRef.current = {
          key: seatKey,
          x: Number(gsap.getProperty(anchor, "x")) || 0,
          y: Number(gsap.getProperty(anchor, "y")) || 0,
        };
        return;
      }
      const target = companionSeatTarget(
        seat,
        { width: rootRect.width, height: rootRect.height },
        { width: anchor.offsetWidth, height: anchor.offsetHeight },
      );
      // One rule for every path — page switch, first entry from home, resize,
      // or a placement re-run that arrives while a travel is already walking:
      // if the resident is not standing on the seat, it travels there. Nothing
      // in this branch may teleport a visibly displaced character, so a killed
      // or superseded tween can only ever be continued, never flashed.
      const startX = Number(gsap.getProperty(anchor, "x")) || 0;
      const startY = Number(gsap.getProperty(anchor, "y")) || 0;
      const distance = Math.hypot(target.x - startX, target.y - startY);
      const previous = seatPlacementRef.current;
      // A null record is the first-ever surface entry (leaving home): it is a
      // real page switch and earns the full travel window and hop.
      const pageSwitched = (previous === null || previous.key !== seatKey)
        && Boolean(surface);
      const canAnimate = distance > 3
        && motionModeRef.current !== "off"
        && !presencePausedRef.current;
      if (distance <= 3) {
        // Already on the seat (same-side switch, post-correction re-run).
        if (!previous) {
          gsap.set(anchor, {
            left: 0,
            top: 0,
            right: "auto",
            bottom: "auto",
            autoAlpha: 1,
            x: target.x,
            y: target.y,
            force3D: true,
          });
        }
        seatPlacementRef.current = { key: seatKey, x: target.x, y: target.y };
        return;
      }
      if (!canAnimate) {
        // Reduced motion, paused window, or motion off: place directly.
        gsap.killTweensOf(anchor, "x,y");
        gsap.set(anchor, {
          left: 0,
          top: 0,
          right: "auto",
          bottom: "auto",
          autoAlpha: 1,
          x: target.x,
          y: target.y,
          force3D: true,
        });
        seatPlacementRef.current = { key: seatKey, x: target.x, y: target.y };
        clampVisibleCompanion();
        return;
      }
      // A page switch that changes the seat side must travel, never teleport:
      // a short hop carries the resident across the gutter.
      gsap.set(anchor, {
        left: 0,
        top: 0,
        right: "auto",
        bottom: "auto",
        autoAlpha: 1,
        force3D: true,
      });
      const fullDuration = companionSemanticTravelDuration(distance, motionModeRef.current);
      // Resizes and placement re-runs only ever need a short nudge; the long
      // cinematic window is reserved for real page switches.
      const duration = pageSwitched ? fullDuration : Math.min(fullDuration, 0.3);
      const proxy = { x: startX, y: startY };
      const travel = gsap.timeline({
        onComplete: () => { seatTravelRef.current = null; },
      });
      seatTravelRef.current = travel;
      travel.to(proxy, {
        x: target.x,
        y: target.y,
        duration,
        ease: "power2.inOut",
        overwrite: "auto",
        onUpdate: () => {
          gsap.set(anchor, { x: proxy.x, y: proxy.y, force3D: true });
        },
      }, 0);
      const pose = characterMotionRef.current;
      if (pose && pageSwitched && distance > 60) {
        travel.to(pose, {
          y: -6,
          scaleY: 1.025,
          transformOrigin: "50% 100%",
          duration: Math.min(0.18, duration * 0.34),
          ease: "power2.out",
        }, 0);
        travel.to(pose, {
          y: 2,
          scaleY: 0.92,
          duration: 0.08,
          ease: "power2.in",
        }, Math.max(0, duration - 0.1));
        travel.to(pose, {
          y: 0,
          scaleY: 1,
          duration: 0.16,
          ease: "back.out(1.4)",
        });
      }
      seatPlacementRef.current = { key: seatKey, x: target.x, y: target.y };
    };
    const observer = new ResizeObserver(() => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(placeLegacyAnchor);
    });
    observer.observe(root);
    observer.observe(anchor);
    placeLegacyAnchor();
    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [clampVisibleCompanion, companionPosition.x, companionPosition.y, hudPage, projectCompanionIntoCamera, surface, targetWorldAnchor]);

  useGSAP(() => {
    if (!HOME_V2_ENABLED || surface) return;
    const root = rootRef.current;
    const pose = characterMotionRef.current;
    if (!root || !pose || dragRef.current) return;

    movementTimelineRef.current?.kill();
    const target = targetWorldAnchor;
    const current = worldAnchorRef.current;
    const projectedWorld = document.querySelector<HTMLElement>(".room-camera-rig")?.getBoundingClientRect();
    const travelDistance = projectedWorld
      ? Math.hypot(
          (target.x - current.x) * projectedWorld.width,
          (target.y - current.y) * projectedWorld.height,
        )
      : Math.hypot(target.x - current.x, target.y - current.y) * 1_000;
    const duration = companionSemanticTravelDuration(travelDistance, motionMode);

    if (presencePaused || motionMode === "off") {
      worldAnchorRef.current = { ...target };
      gsap.set(pose, {
        ...COMPANION_FIXED_POSE,
        scaleY: 1,
        transformOrigin: "50% 100%",
      });
      root.dataset.companionMotionPhase = "settled";
      projectCompanionIntoCamera();
      return;
    }

    // A page switch can leave the visual parked at a task-page seat while the
    // stored anchor already describes home. When that gap exists the resident
    // must travel — including a user-owned anchor, whose final foot point the
    // walk preserves exactly.
    const walkAnchor = anchorRef.current;
    const walkRootRect = root.getBoundingClientRect();
    let visualGap = 0;
    if (walkAnchor && projectedWorld && walkRootRect.width > 0 && walkAnchor.offsetWidth > 0) {
      const targetVisual = companionPositionForProjectedFootAnchor(
        target,
        projectedWorld,
        walkRootRect,
        { width: walkAnchor.offsetWidth, height: walkAnchor.offsetHeight },
      );
      visualGap = Math.hypot(
        targetVisual.x - (Number(gsap.getProperty(walkAnchor, "x")) || 0),
        targetVisual.y - (Number(gsap.getProperty(walkAnchor, "y")) || 0),
      );
    }
    const returnTravel = visualGap > 2;

    if ((companionPlacementOwner === "user" && !returnTravel) || (duration === 0 && !returnTravel)) {
      // Room focus never changes a user-placed companion's foot point or
      // orientation. The model keeps its authored forward-facing pose.
      worldAnchorRef.current = { ...target };
      gsap.set(pose, {
        ...COMPANION_FIXED_POSE,
        scaleY: 1,
        transformOrigin: "50% 100%",
        overwrite: "auto",
      });
      root.dataset.companionMotionPhase = "settled";
      projectCompanionIntoCamera();
      return;
    }

    root.dataset.companionMotionPhase = "travelling";
    const timeline = gsap.timeline({
      onComplete: () => {
        movementTimelineRef.current = null;
        root.dataset.companionMotionPhase = "settled";
        projectCompanionIntoCamera();
      },
      onInterrupt: () => { root.dataset.companionMotionPhase = "interrupted"; },
    });
    movementTimelineRef.current = timeline;
    gsap.set(pose, { ...COMPANION_FIXED_POSE, scaleY: 1, transformOrigin: "50% 100%" });
    timeline.to(worldAnchorRef.current, {
      x: target.x,
      y: target.y,
      duration,
      ease: "power2.inOut",
      overwrite: "auto",
      onUpdate: projectCompanionIntoCamera,
    }, 0);
    timeline.to(pose, {
      x: 0,
      y: -6,
      rotation: 0,
      scaleY: 1.025,
      duration: Math.min(0.18, duration * 0.34),
      ease: "power2.out",
      overwrite: "auto",
    }, 0);
    if (motionMode === "full") {
      timeline.to(pose, {
        y: -3,
        rotation: 0,
        duration: Math.max(0.14, duration * 0.5),
        ease: "sine.inOut",
      }, Math.min(0.18, duration * 0.34));
    }
    timeline.to(pose, {
      x: 0,
      y: 2,
      rotation: 0,
      scaleX: 1,
      scaleY: 0.92,
      duration: motionMode === "lite" ? 0.08 : 0.11,
      ease: "power2.in",
    }, Math.max(0, duration - 0.04));
    timeline.to(pose, {
      y: 0,
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      duration: motionMode === "lite" ? 0.14 : 0.22,
      ease: "back.out(1.2)",
    });
    return () => timeline.kill();
  }, {
    scope: rootRef,
    dependencies: [
      companionPlacementOwner,
      motionMode,
      presencePaused,
      projectCompanionIntoCamera,
      surface,
      targetWorldAnchor.x,
      targetWorldAnchor.y,
    ],
  });

  useEffect(() => {
    const root = rootRef.current;
    const visual = visualRef.current;
    const panel = panelRef.current;
    if (!root || !visual || !panel) return;
    const observer = new ResizeObserver(positionPanel);
    observer.observe(root);
    observer.observe(visual);
    observer.observe(panel);
    window.addEventListener("resize", positionPanel);
    window.visualViewport?.addEventListener("resize", positionPanel);
    window.visualViewport?.addEventListener("scroll", positionPanel);
    positionPanel();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", positionPanel);
      window.visualViewport?.removeEventListener("resize", positionPanel);
      window.visualViewport?.removeEventListener("scroll", positionPanel);
      window.cancelAnimationFrame(panelFrameRef.current);
      panelFrameRef.current = 0;
    };
  }, [companionOpen, companionScale, positionPanel, surface]);

  useGSAP(() => {
    const visual = visualRef.current;
    if (!visual) return;
    if (HOME_V2_ENABLED && !surface) {
      projectCompanionIntoCamera();
      return;
    }
    gsap.to(visual, {
      scale: companionScale * (surface ? 0.95 : 0.9),
      duration: durationFor(motionMode, 0.16),
      ease: motionMode === "off" ? "none" : "power2.out",
      overwrite: "auto",
      transformOrigin: "50% 100%",
      force3D: true,
      onUpdate: positionPanel,
      onComplete: clampVisibleCompanion,
    });
  }, { scope: rootRef, dependencies: [surface, motionMode, companionScale, clampVisibleCompanion, positionPanel, projectCompanionIntoCamera] });

  useGSAP(() => {
    const panel = panelRef.current;
    if (!panel) return;
    gsap.to(panel, {
      autoAlpha: companionOpen ? 1 : 0,
      y: companionOpen ? 0 : 12,
      scale: companionOpen ? 1 : 0.97,
      duration: durationFor(motionMode, 0.36),
      ease: companionOpen ? "power3.out" : "power2.in",
      overwrite: "auto",
      transformOrigin: "82% 100%",
    });
  }, { scope: rootRef, dependencies: [companionOpen, motionMode] });

  const beginDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    // Only the home scene is draggable. Task pages hold a fixed, display-only
    // registry seat; the handlers are not even wired there (see WindowLive2D),
    // so this guard is a second line of defence, not the gate itself.
    if (surface) return;
    if (!event.isPrimary || event.button !== 0) return;
    if (dragRef.current && dragRef.current.pointerId !== event.pointerId) return;
    const root = rootRef.current;
    const anchor = anchorRef.current;
    const visual = visualRef.current;
    if (!root || !anchor || !visual) return;

    const rootBounds = root.getBoundingClientRect();
    const startPosition: CompanionPosition = {
      x: Number(gsap.getProperty(anchor, "x")) || 0,
      y: Number(gsap.getProperty(anchor, "y")) || 0,
    };
    // Pointer-down, not the drag threshold, owns the visible pose. Otherwise an
    // in-flight semantic walk can continue underneath the user's hand.
    movementTimelineRef.current?.kill();
    movementTimelineRef.current = null;
    gsap.killTweensOf(anchor, "x,y,left,top");
    const visualBounds = visual.getBoundingClientRect();
    const bounds = companionTranslationBounds(startPosition, rootBounds, visualBounds);
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startPosition,
      lastPosition: startPosition,
      bounds,
      startWorldAnchor: { ...worldAnchorRef.current },
      activated: false,
      movedWithPrimaryContact: false,
    };
    suppressInviteRef.current = false;
  };

  const moveDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (!companionPointerHasPrimaryContact(event.buttons)) {
      // A move with no primary contact belongs to a stale capture (commonly
      // after blur/hide), not to the drag that created this record. Cancel it
      // before a later lostpointercapture can promote semantic placement to a
      // user-owned anchor.
      dragRef.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      suppressInviteRef.current = true;
      setDragging(false);
      worldAnchorRef.current = { ...drag.startWorldAnchor };
      projectCompanionRef.current();
      return;
    }
    drag.movedWithPrimaryContact = true;
    if (!drag.activated) {
      if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) <= 4) return;
      drag.activated = true;
      suppressInviteRef.current = true;
      const root = rootRef.current;
      const anchor = anchorRef.current;
      const visual = visualRef.current;
      if (!root || !anchor || !visual) return;
      const rootBounds = root.getBoundingClientRect();
      gsap.killTweensOf(anchor, "x,y,left,top");
      drag.startPosition = {
        x: Number(gsap.getProperty(anchor, "x")) || 0,
        y: Number(gsap.getProperty(anchor, "y")) || 0,
      };
      drag.lastPosition = drag.startPosition;
      drag.bounds = companionTranslationBounds(drag.startPosition, rootBounds, visual.getBoundingClientRect());
      gsap.set(anchor, { x: drag.startPosition.x, y: drag.startPosition.y, force3D: true });
      setDragging(true);
      root.dataset.projectionState = "dragging";
      if (characterMotionRef.current) {
        gsap.to(characterMotionRef.current, {
          y: -7,
          rotation: 0,
          scaleX: 1,
          scaleY: 0.985,
          duration: durationFor(motionMode, 0.14),
          ease: "power2.out",
          overwrite: "auto",
        });
      }
    }
    const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
    const nextPosition = {
      x: clamp(drag.startPosition.x + event.clientX - drag.startX, drag.bounds.minX, drag.bounds.maxX),
      y: clamp(drag.startPosition.y + event.clientY - drag.startY, drag.bounds.minY, drag.bounds.maxY),
    };
    drag.lastPosition = nextPosition;
    if (anchorRef.current) gsap.set(anchorRef.current, { x: nextPosition.x, y: nextPosition.y, force3D: true });
    const root = rootRef.current;
    const visual = visualRef.current;
    const cameraRig = document.querySelector<HTMLElement>(".room-camera-rig");
    if (root && visual && cameraRig && anchorRef.current) {
      const projectedWorld = cameraRig.getBoundingClientRect();
      const visualRect = visual.getBoundingClientRect();
      const clampedAnchor = clampCompanionAnchorToPolygon(companionWorldAnchorFromProjectedFoot({
        x: (visualRect.left + visualRect.right) / 2,
        y: visualRect.bottom,
      }, projectedWorld), HOME_V2_FLOOR_POLYGON);
      worldAnchorRef.current = clampedAnchor;
      // Ride the floor boundary in real time: re-project the clamped foot so
      // the visible position always equals what a release would commit. The
      // character follows the pointer inside the legal floor, sticks at its
      // edge, and never jumps on release — the drag ends exactly where the
      // character visibly stands.
      const rootRect = root.getBoundingClientRect();
      const riding = companionPositionForProjectedFootAnchor(
        clampedAnchor,
        projectedWorld,
        rootRect,
        { width: anchorRef.current.offsetWidth, height: anchorRef.current.offsetHeight },
      );
      gsap.set(anchorRef.current, { x: riding.x, y: riding.y, force3D: true });
      drag.lastPosition = riding;
    }
    if (rootRef.current) {
      rootRef.current.dataset.worldAnchor = `${worldAnchorRef.current.x},${worldAnchorRef.current.y}`;
      rootRef.current.dataset.projectionState = "dragging";
    }
    positionPanel();
  };

  const endDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (drag?.pointerId !== event.pointerId) return;
    // Clear first: releasePointerCapture may synchronously emit
    // lostpointercapture. That second event must observe the gesture as closed
    // instead of committing it (or opening the invite) a second time.
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    const shouldCommit = shouldCommitCompanionDrag(
      event.type as "pointerup" | "pointercancel" | "lostpointercapture",
      drag.activated,
      drag.movedWithPrimaryContact,
    );
    if (shouldCommit) {
      // Drags only exist on the home scene, where the drop commits a world
      // anchor through the room store (survives restarts). Task pages are
      // fixed registry seats and are never dragged.
      commitCurrentUserPlacement();
      setDragging(false);
      if (rootRef.current) rootRef.current.dataset.projectionState = "tracking";
      const pose = characterMotionRef.current;
      if (pose) {
        movementTimelineRef.current?.kill();
        const landing = gsap.timeline();
        movementTimelineRef.current = landing;
        landing
          .to(pose, {
            y: 2,
            rotation: 0,
            scaleX: 1,
            scaleY: 0.91,
            duration: durationFor(motionMode, 0.1),
            ease: "power2.in",
            overwrite: "auto",
          })
          .to(pose, {
            y: 0,
            rotation: 0,
            scaleX: 1,
            scaleY: 1,
            duration: durationFor(motionMode, 0.2),
            ease: "back.out(1.2)",
          });
      }
      window.requestAnimationFrame(projectCompanionRef.current);
      return;
    }
    setDragging(false);
    worldAnchorRef.current = { ...drag.startWorldAnchor };
    projectCompanionRef.current();
    const pose = characterMotionRef.current;
    if (pose) {
      gsap.to(pose, {
        y: 0,
        rotation: 0,
        scaleX: 1,
        scaleY: 1,
        duration: durationFor(motionMode, 0.16),
        ease: "power2.out",
        overwrite: "auto",
      });
    }
    if (event.type !== "pointerup") {
      suppressInviteRef.current = true;
      return;
    }

    if (HOME_V2_ENABLED && !surface) {
      const targetBounds = event.currentTarget.getBoundingClientRect();
      const kind = companionTouchKindAt(event.clientY, targetBounds.top, targetBounds.height);
      suppressInviteRef.current = true;
      setTouchKind(kind);
      const text = kind === "head" ? "嗯？我听见你啦。" : "要一起开始学习吗？";
      setHomeCue(text);
      setInviteTrigger((value) => value + 1);
      speakHomeV2Cue(text, "touch");
    }
  };

  const completionCue = companionMoment === "confirm" ? "这次学习已经收好，新的理解正回到小屋里。" : null;
  const visibleHomeCue = completionCue ?? (homeV2IntroVisible ? null : homeCue);
  const presentation = touchKind === "head"
    ? "celebrate"
    : touchKind === "body"
      ? "think"
      : companionMoment === "lamp" || companionMoment === "confirm"
        ? "celebrate"
        : companionOpen
          ? "invite"
          : "idle";
  const presentationEmotion: Live2DEmotionEvent | null = touchKind === "head"
    ? { emotion: "happy", intensity: 0.9 }
    : touchKind === "body"
      ? { emotion: "curious", intensity: 0.65 }
      : companionMoment === "lamp" || companionMoment === "confirm"
        ? { emotion: "happy", intensity: 0.85 }
        : companionOpen
          ? { emotion: "curious", intensity: 0.4 }
          : null;

  // 唯一形态下的状态文案（形态切换已随 orb 一并移除）。
  const rendererLabel = status === "ready"
    ? "Live2D"
    : status === "loading"
      ? "正在准备 Live2D"
      : "Live2D 不可用";
  const companionUnavailable = !live2dRuntimeAllowed || status === "unavailable";

  const interactionCopy = companionMoment === "confirm"
    ? "服务端结果已经确认。这次学习已安全写入，可以回到复习队列继续。"
    : companionMoment === "lamp"
    ? theme === "night"
      ? "台灯亮了。光只落在桌面上，我们可以安静地继续。"
      : "窗边的自然光回来了，眼睛也能松一点。"
    : companionMoment === "ambient"
      ? "窗外的声音会在你进入任务时自动安静下来。"
      : copy.body;
  const runCompanionAction = (kind: "primary" | "secondary") => {
    if (HOME_V2_ENABLED && !surface) {
      runHomeV2Feature(kind === "primary" ? "continue" : "today-review");
      return;
    }
    invoke(kind === "primary" ? copy.primaryIntent : copy.secondaryIntent);
  };

  // The mockup gives each page one short line of Mao narration. It is a HUD
  // label, not a second conversation surface, so it yields to the whisper panel.
  const hudBubble = companionVisualOnly || formalAssessmentSilent ? null : HUD_PAGES[hudPage].bubble ?? null;

  return (
    <div
      ref={rootRef}
      className="companion-presence"
      data-open={companionOpen}
      data-companion-unavailable={companionUnavailable || undefined}
      data-live2d-available={LIVE2D_RUNTIME_ALLOWED}
      data-surface={sceneKey}
      data-home-zone={HOME_V2_ENABLED && !surface ? companionHomeZone : undefined}
      data-placement-owner={HOME_V2_ENABLED && !surface ? companionPlacementOwner : undefined}
      data-user-anchor={HOME_V2_ENABLED && !surface && companionUserAnchor
        ? `${companionUserAnchor.x},${companionUserAnchor.y}`
        : undefined}
      data-world-anchor={HOME_V2_ENABLED && !surface
        ? `${targetWorldAnchor.x},${targetWorldAnchor.y}`
        : undefined}
      data-projection-state={HOME_V2_ENABLED && !surface ? (dragging ? "dragging" : "tracking") : undefined}
      data-context-zone={HOME_V2_ENABLED && !surface ? homeV2Zone : undefined}
      data-touch-kind={touchKind ?? undefined}
      data-formal-silent={formalAssessmentSilent || undefined}
      data-task-surface-quiet={taskSurfaceQuiet || undefined}
      aria-hidden={presenceHidden || undefined}
    >
      {!companionVisualOnly ? <aside
        ref={panelRef}
        className="companion-whisper"
        aria-label="AI 伴星建议"
        aria-hidden={!companionOpen}
        inert={!companionOpen}
      >
        <button className="companion-whisper__close" type="button" onClick={closeCompanion} aria-label="收起伴星">
          <X size={15} aria-hidden="true" />
        </button>
        <span className="companion-whisper__kicker"><Sparkles size={13} aria-hidden="true" />{copy.kicker}</span>
        <h2>{copy.title}</h2>
        <p>{interactionCopy}</p>
        <div className="companion-whisper__actions">
          <button type="button" className="companion-action companion-action--primary" onClick={() => runCompanionAction("primary")}>{copy.primary}</button>
          <button type="button" className="companion-action" onClick={() => runCompanionAction("secondary")}>{copy.secondary}</button>
        </div>
        <details className="companion-whisper__settings">
          <summary>大小 <small>{rendererLabel}</small></summary>
          <label className="companion-scale-control">
            <span>伴星大小 <output>{Math.round(companionScale * 100)}%</output></span>
            <input
              type="range"
              min={MIN_COMPANION_SCALE}
              max={MAX_COMPANION_SCALE}
              step="0.01"
              value={companionScale}
              onChange={(event) => setCompanionScale(Number(event.currentTarget.value))}
              aria-label="调整伴星大小"
            />
          </label>
          <div className="companion-presence-controls" role="group" aria-label="伴星打扰控制">
            <button
              type="button"
              aria-pressed={pageMuted}
              onClick={() => setCompanionSceneMuted(sceneKey, !pageMuted)}
            >
              {pageMuted ? "恢复本页提示" : "在此页保持安静"}
            </button>
            {surface ? (
              <button
                type="button"
                aria-pressed={companionFocusUntilTaskEnd}
                onClick={() => setCompanionFocusUntilTaskEnd(!companionFocusUntilTaskEnd)}
              >
                {companionFocusUntilTaskEnd ? "结束专注静音" : "专注到本次任务结束"}
              </button>
            ) : null}
            <button type="button" onClick={() => setCompanionTemporarilyHidden(true)}>
              暂时隐藏伴星
            </button>
          </div>
          <div className="companion-account-controls" role="group" aria-label="账号级伴星设置">
            <span className="companion-account-controls__title">
              账号设置
              <small>
                {accountFailure ? "读取失败" : !accountState ? "读取中…" : `修订 ${accountState.revision}${accountSaving ? " · 保存中" : ""}`}
              </small>
            </span>
            <div className="companion-presence-controls" role="group" aria-label="在线状态">
              {COMPANION_PRESENCE_OPTIONS.map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={accountState?.presence?.presence === value}
                  disabled={!accountState || accountSaving}
                  onClick={() => void patchCompanionAccount({ presence: { presence: value } })}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="companion-presence-controls" role="group" aria-label="主动介入强度">
              {COMPANION_INTERVENTION_OPTIONS.map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={accountState?.interventionLevel === value}
                  disabled={!accountState || accountSaving}
                  onClick={() => void patchCompanionAccount({ interventionLevel: value })}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="companion-quiet-hours">
              <label>
                <input
                  type="checkbox"
                  checked={Boolean(accountState?.quietHours)}
                  disabled={!accountState || accountSaving}
                  onChange={(event) => {
                    const enabled = event.currentTarget.checked;
                    void patchCompanionAccount({
                      quietHours: quietHoursPatch(
                        enabled,
                        Intl.DateTimeFormat().resolvedOptions().timeZone,
                      ),
                    });
                  }}
                />
                <span>静默时段</span>
              </label>
              {accountState?.quietHours ? (
                <>
                  <input
                    type="time"
                    value={accountState.quietHours.startLocal}
                    disabled={accountSaving}
                    aria-label="静默时段开始"
                    onChange={(event) => {
                      const next = quietHoursWithBoundary(accountState.quietHours!, "startLocal", event.currentTarget.value);
                      if (next) void patchCompanionAccount({ quietHours: next });
                    }}
                  />
                  <span aria-hidden="true">→</span>
                  <input
                    type="time"
                    value={accountState.quietHours.endLocal}
                    disabled={accountSaving}
                    aria-label="静默时段结束"
                    onChange={(event) => {
                      const next = quietHoursWithBoundary(accountState.quietHours!, "endLocal", event.currentTarget.value);
                      if (next) void patchCompanionAccount({ quietHours: next });
                    }}
                  />
                </>
              ) : null}
            </div>
            {accountState ? (
              <div className="companion-presence-controls" role="group" aria-label="账号级开关">
                <button
                  type="button"
                  aria-pressed={!accountState.globalEnabled}
                  disabled={accountSaving}
                  onClick={() => void patchCompanionAccount({ globalEnabled: !accountState.globalEnabled })}
                >
                  {accountState.globalEnabled ? "关闭伴星（账号级）" : "开启伴星（账号级）"}
                </button>
              </div>
            ) : null}
            {accountFailure ? <p className="companion-account-controls__failure" role="status">{accountFailure}</p> : null}
          </div>
          <div className="companion-whisper__footer">
            <span>直接拖动角色 · 大小自动保存</span>
            <button
              type="button"
              className="companion-reset-position"
              onClick={() => {
                resetCompanionPosition();
              }}
            >
              <RotateCcw size={12} aria-hidden="true" />重置位置
            </button>
          </div>
        </details>
      </aside> : null}

      <div ref={anchorRef} className="companion-scene-anchor">
        {hudBubble && !companionOpen && !presenceHidden && !companionUnavailable ? (
          <div className="speech" role="status">
            <b>MAO · 页面联动</b>
            {hudBubble}
          </div>
        ) : null}
        <div
          ref={visualRef}
          className={`companion-visual-shell${dragging ? " companion-visual-shell--dragging" : ""}`}
          data-companion-live2d-target="true"
        >
          <div ref={characterMotionRef} className="companion-character-motion">
            <WindowLive2D
              active={!presenceHidden && !companionUnavailable}
              // 2026-09-16 追加裁决：任务页保留原地动作（低幅呼吸与眨眼，不位移、
              // 不出气泡），不再冻结当前帧。真正停止 ticker 的只有隐藏/弹窗/窗口不可见
              // 与用户自己的 motionMode（lite/off）或 reduced-motion。
              paused={presencePaused}
              motionMode={motionMode}
              presentation={presentation}
              emotion={presentationEmotion}
              inviteTrigger={inviteTrigger}
              onStatus={setStatus}
              // 首页全身取景；任务页半身取景（头与上半身充满容器，腿部裁出）。
              framing={surface ? "bust" : "full"}
              // 只有首页可拖：首页落点写入用户世界锚点（重启后保留）。任务页
              // 是固定座位，不接任何指针处理器——WindowLive2D 在没有处理器时
              // 也不会渲染可交互按钮层，拖拽暗示随 UI 一起消失。
              onPointerDown={surface ? undefined : beginDrag}
              onPointerMove={surface ? undefined : moveDrag}
              onPointerUp={surface ? undefined : endDrag}
              onPointerCancel={surface ? undefined : endDrag}
              onLostPointerCapture={surface ? undefined : endDrag}
              onInviteRequest={companionVisualOnly ? undefined : () => {
                if (suppressInviteRef.current) {
                  suppressInviteRef.current = false;
                  return;
                }
                if (companionOpen) {
                  setInviteTrigger((value) => value + 1);
                  if (HOME_V2_ENABLED && !surface) speakHomeV2Cue("我在这儿，想从哪里开始？", "touch");
                } else {
                  toggleCompanion();
                  if (HOME_V2_ENABLED && !surface) speakHomeV2Cue("我在这儿，想从哪里开始？", "touch");
                }
              }}
              ariaLabel="书桌上的 AI 伴星"
            />
          </div>
          {companionVisualOnly ? <span className="companion-surface-label" aria-hidden="true">Mao · 伴星</span> : null}
          {HOME_V2_ENABLED && visibleHomeCue ? <span className="companion-home-cue" role="status">{visibleHomeCue}</span> : null}
          {!HOME_V2_ENABLED && !companionOpen ? <span className="companion-invite-label" aria-hidden="true">我在这里</span> : null}
        </div>
      </div>

      {/* 唯一形态下的失败态：隐藏形象 + 就地一句可关闭说明（2026-09-16 裁决）。
          不回退光球或替身立绘；关闭后本次会话不再重复提示。 */}
      {companionTemporarilyHidden && !formalAssessmentSilent ? (
        <p className="companion-restore-chip" role="status">
          <span>伴星已隐藏。</span>
          <button type="button" onClick={() => setCompanionTemporarilyHidden(false)}>
            让伴星回来
          </button>
        </p>
      ) : null}

      {companionAccountDisabled && !formalAssessmentSilent ? (
        <p className="companion-restore-chip" role="status">
          <span>伴星已按账号设置关闭。</span>
          <button type="button" disabled={accountSaving} onClick={() => void patchCompanionAccount({ globalEnabled: true })}>
            重新开启伴星
          </button>
        </p>
      ) : null}

      {companionUnavailable && !unavailableNoticeDismissed && !presenceHidden ? (
        <p className="companion-unavailable-notice" role="status">
          <span>伴星暂时不可用，学习功能不受影响。</span>
          <button
            type="button"
            onClick={() => setUnavailableNoticeDismissed(true)}
            aria-label="关闭伴星不可用提示"
          >
            <X size={13} aria-hidden="true" />知道了
          </button>
        </p>
      ) : null}
    </div>
  );
}
