import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { X } from "lucide-react";
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
import { companionAccountDisabled as isCompanionAccountDisabled } from "./companion-account-presence";
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
import { CompanionBubble } from "./CompanionBubble";
import { CompanionHud, type CompanionHudAction } from "./CompanionHud";
import { CompanionChatProvider, useCompanionChat } from "../../app/companion-chat-session";
import { HOME_FEATURE_ICONS } from "../home-v2/home-feature-icons";
import { getHomeFeature, type HomeFeatureId } from "../home-v2/home-feature-registry";
import { SurfaceDataState } from "../surfaces/surface-data";
import type { Live2DEmotionEvent } from "./live2d-emotion";
import "./companion-root.css";

gsap.registerPlugin(useGSAP);

// Owner-approved in-window Live2D runtime. It never creates an external pet
// window and never invents an orb or static character fallback.
const LIVE2D_RUNTIME_ALLOWED = true;

/**
 * 「被叫醒的中介帧」的入场节拍（方案 §5 第 4 项）。只等气泡落位这一下：
 * 头顶的「嗯？」是 180ms 入场的，交互台跟在它后面出现即可读出"她转过头来"，
 * 等她 900ms 的整个寿命再展开会把点击反馈拖成卡顿。
 */
const COMPANION_WAKE_BEAT_MS = 180;
const HOME_V2_FLOOR_POLYGON = normalizedHomeFloorPolygon();

/**
 * One companion for the whole system: a single persistent overlay mounted once
 * in `App`, never remounted by page switches. The home scene is the only
 * draggable context — a full-body free drag inside the viewport safe area that
 * commits a user-owned world anchor (persisted across restarts by the room
 * store). Task pages receive a fixed registry seat (`HUD_PAGES[*].seat`) with
 * on-demand interaction; the seat's side and position are tracked in a ref
 * that survives page switches. Side changes crossfade in place so the actor
 * never travels across the page's reading or answer content.
 */
function durationFor(mode: "full" | "lite" | "off", full: number) {
  return mode === "off" ? 0 : mode === "lite" ? full * 0.55 : full;
}

function speakHomeV2Cue(text: string): void {
  window.dispatchEvent(new CustomEvent("ailearn:home-v2-speak", {
    detail: { text, reason: "cue" },
  }));
}

const COMPANION_FIXED_POSE = Object.freeze({ x: 0, y: 0, rotation: 0, scaleX: 1 } as const);

/**
 * 伴星的全部呈现：whisper 面板、历史手记、交互台、功能夹、Live2D 形象。
 *
 * 外层只做一件事——把对话状态（CompanionChatProvider）供给同时消费它的气泡坞与
 * 历史抽屉。里面那棵大树保持原来的写法与动画，不因为多了一层 Provider 而重新挂载。
 */
export function CompanionRoot() {
  return (
    <CompanionChatProvider>
      <CompanionPresenceView />
    </CompanionChatProvider>
  );
}

function CompanionPresenceView() {
  const surface = useRoomStore((state) => state.surface);
  const motionPreference = useRoomStore((state) => state.motionMode);
  const reducedMotion = useRoomStore((state) => state.reducedMotion);
  const motionMode = resolveSceneMotionMode(motionPreference, reducedMotion);
  const onboardingOpen = useRoomStore((state) => state.onboardingOpen);
  const companionMoment = useRoomStore((state) => state.companionMoment);
  const companionPosition = useRoomStore((state) => state.companionPosition);
  const companionHomeZone = useRoomStore((state) => state.companionHomeZone);
  const companionPlacementOwner = useRoomStore((state) => state.companionPlacementOwner);
  const companionUserAnchor = useRoomStore((state) => state.companionUserAnchor);
  const companionScale = useRoomStore((state) => state.companionScale);
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
   * reuses the exact current position, while a side change crossfades through
   * `seatTravelRef` without moving across the reading surface.
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
  const [live2dAttempt, setLive2dAttempt] = useState(0);
  // 设置页的「半身形象」读的是模型是否真的加载成功，只有这里知道，
  // 所以把状态同时发布到 room store，而不是让页面去猜或读服务端占位。
  const setLive2dStatus = useRoomStore((state) => state.setLive2dStatus);
  useEffect(() => { setLive2dStatus(status); }, [setLive2dStatus, status]);
  const [unavailableNoticeDismissed, setUnavailableNoticeDismissed] = useState(false);
  const [inviteTrigger, setInviteTrigger] = useState(0);
  /** 工具开始执行的次数（方案 §5 第 9 项）：递增即请求一次「看向手边」参数冲量。 */
  const [toolAttentionTrigger, setToolAttentionTrigger] = useState(0);
  /**
   * 「被叫醒的中介帧」（方案 §5 第 4 项）：点头顶先冒一个 0.9s 的「嗯？」，
   * 交互台才是随后展开的。现在没有这一下，交互台像被"点开"而不是"她转过头来"。
   */
  const [awakening, setAwakening] = useState(false);
  useEffect(() => {
    if (!awakening) return;
    const timer = window.setTimeout(() => setAwakening(false), 900);
    return () => window.clearTimeout(timer);
  }, [awakening]);
  /** 中介帧的展开节拍；卸载时清掉，避免 setState 落在已卸载的树上。 */
  const wakeTimerRef = useRef<number | null>(null);
  useEffect(() => () => {
    if (wakeTimerRef.current !== null) window.clearTimeout(wakeTimerRef.current);
  }, []);
  const [touchKind, setTouchKind] = useState<"head" | "body" | null>(null);
  const [homeCue, setHomeCue] = useState<string | null>(null);
  /** 当前气泡若源自念头（切片④），可点击让她主动开场。 */
  const [homeCueThoughtId, setHomeCueThoughtId] = useState<string | null>(null);
  const [externalModalOpen, setExternalModalOpen] = useState(false);
  const { mode, setMode, assistantEmotion, liveReply, phase: chatPhase } = useCompanionChat();
  const engaged = mode !== "closed";
  /** 聊天回复的情绪（2026-09-18 情绪接表情）：20s 内驱动 Live2D 表情。 */
  const [chatEmotion, setChatEmotion] = useState<{ emotion: string; at: number } | null>(null);
  useEffect(() => {
    if (!assistantEmotion) return;
    setChatEmotion({ emotion: assistantEmotion, at: Date.now() });
    const timer = window.setTimeout(() => setChatEmotion(null), 20_000);
    return () => window.clearTimeout(timer);
  }, [assistantEmotion]);
  // 账号级 presence（2026-09-16 裁决 3）：跨设备同步，写入走 revision CAS。
  const [accountState, setAccountState] = useState<CompanionAccountStateV1 | null>(null);
  const [accountFailure, setAccountFailure] = useState<string | null>(null);
  const [accountSaving, setAccountSaving] = useState(false);
  const workspaceScopeRevision = useRoomStore((state) => state.workspaceScopeRevision);
  const targetWorldAnchor = companionPlacementOwner === "user" && companionUserAnchor
    ? companionUserAnchor
    : COMPANION_HOME_ANCHORS[companionHomeZone];
  const hudPage = useRoomStore((state) => state.hudPage);
  const companionPolicy = HUD_PAGES[hudPage].companion;
  const homeMode = companionPolicy.mode === "home";
  const sceneKey = surface ?? "room";
  const assessmentMode = companionPolicy.mode === "assessment";
  const companionVisualOnly = companionPolicy.mode === "ambient" || assessmentMode;
  const taskSurfaceQuiet = companionVisualOnly && !engaged;
  // 页面级存在感（2026-09-16 裁决 3）：按页静音只抑制**主动**输出（气泡/提示音/
  // 提示语音），不阻断用户主动点击触发的互动；专注模式在任务面关闭时自动结束。
  const pageMuted = mutedCompanionSceneKeys.includes(sceneKey);
  const companionSilenced = pageMuted || companionFocusUntilTaskEnd;
  // globalEnabled=false 是账号级关闭：形象不出现，但用户可以在同一处重新开启。
  const companionAccountDisabled = isCompanionAccountDisabled(accountState);
  const presenceHidden = companionPolicy.mode === "hidden" || onboardingOpen || companionTemporarilyHidden || companionAccountDisabled;
  const presencePaused = presenceHidden || homeV2ModalOpen || externalModalOpen || windowState !== "visible";
  presencePausedRef.current = presencePaused;

  useEffect(() => {
    setMode("closed");
  }, [hudPage, setMode]);

  useEffect(() => {
    const sync = () => {
      const open = Array.from(document.querySelectorAll<HTMLElement>(
        "dialog[open], [role='dialog'][aria-modal='true'], [role='alertdialog'][aria-modal='true']",
      )).some((element) => !element.classList.contains("companion-chat") && !element.closest(".companion-presence"));
      setExternalModalOpen(open);
    };
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["open", "aria-modal"],
    });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!externalModalOpen) return;
    setMode("closed");
  }, [externalModalOpen, setMode]);

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
    setAccountState(null);
    setAccountFailure(null);
    void loadCompanionAccount();
  }, [loadCompanionAccount, workspaceScopeRevision]);

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
    readonly thoughtId: string | null;
  } | null => {
    if (!HOME_V2_ENABLED || companionProjection.loading || companionProjection.failure) return null;
    const proactive = companionProjection.projection?.proactiveCue;
    if (!proactive) return null;
    return {
      priority: "ordinary",
      text: proactive.text,
      zone: "rest",
      key: `ordinary:${proactive.revision}`,
      thoughtId: proactive.thoughtId ?? null,
    };
  }, [companionProjection.failure, companionProjection.loading, companionProjection.projection]);

  const projectCompanionIntoCamera = useCallback(() => {
    if (!HOME_V2_ENABLED || !homeMode || dragRef.current) return;
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
  }, [companionScale, homeMode]);
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
    if (dragRef.current || seatTravelRef.current) return;
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
      if (!HOME_V2_ENABLED || !homeMode) setCompanionPosition(next);
    }
  }, [homeMode, setCompanionPosition]);

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
  }, [companionMoment, setCompanionMoment]);

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
      setHomeCueThoughtId(null);
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
    // 念头气泡（切片④）停留更久，给用户点开主动开场的时间。
    const hideAt = prioritizedCue.priority === "ordinary"
      ? (prioritizedCue.thoughtId ? 30 : 7.4)
      : 5;
    const cueTimeline = gsap.timeline();
    cueTimeline.call(() => {
      shownCueRef.current = prioritizedCue.key;
      // Cues may choose a contextual semantic perch, but a hand-placed world
      // anchor is immutable until the user drags or explicitly resets it.
      if (!dragRef.current && placementOwnerRef.current === "semantic") {
        setCompanionHomePlacement(prioritizedCue.zone);
      }
      setHomeCue(prioritizedCue.text);
      setHomeCueThoughtId(prioritizedCue.thoughtId);
      if (prioritizedCue.priority !== "ordinary") {
        speakHomeV2Cue(prioritizedCue.text);
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
      setHomeCueThoughtId(null);
    }, undefined, hideAt);
    return () => {
      cueTimeline.kill();
      // Losing focus or opening a task cancels the cue lifecycle. Clear any
      // text already revealed so resuming cannot leave a one-shot prompt
      // pinned indefinitely after its timeline has been destroyed, and return a
      // borrowed position immediately.
      setHomeCue(null);
      setHomeCueThoughtId(null);
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

    if (HOME_V2_ENABLED && homeMode) {
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
      if (homeMode && !HOME_V2_ENABLED
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
      // fixed seats: nothing here reads user drag state.
      const seat = companionPolicy.seat;
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
      // or a placement re-run. Page switches crossfade between seats so the
      // actor never walks over reading or answer content; viewport corrections
      // may use a short positional nudge because they do not change context.
      const startX = Number(gsap.getProperty(anchor, "x")) || 0;
      const startY = Number(gsap.getProperty(anchor, "y")) || 0;
      const distance = Math.hypot(target.x - startX, target.y - startY);
      const previous = seatPlacementRef.current;
      // A null record is the first-ever surface entry (leaving home): it is a
      // real page switch and therefore uses the same seat crossfade.
      const pageSwitched = (previous === null || previous.key !== seatKey)
        && !homeMode;
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
      gsap.set(anchor, {
        left: 0,
        top: 0,
        right: "auto",
        bottom: "auto",
        autoAlpha: 1,
        force3D: true,
      });
      const fullDuration = companionSemanticTravelDuration(distance, motionModeRef.current);
      if (pageSwitched) {
        const travel = gsap.timeline({
          onComplete: () => {
            seatTravelRef.current = null;
            clampVisibleCompanion();
          },
        });
        seatTravelRef.current = travel;
        travel.to(anchor, {
          autoAlpha: 0,
          duration: 0.1,
          ease: "power2.out",
          overwrite: "auto",
        });
        travel.set(anchor, { x: target.x, y: target.y, force3D: true });
        travel.to(anchor, {
          autoAlpha: 1,
          duration: 0.16,
          ease: "power2.out",
        });
        seatPlacementRef.current = { key: seatKey, x: target.x, y: target.y };
        return;
      }
      const duration = Math.min(fullDuration, 0.3);
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
  }, [clampVisibleCompanion, companionPolicy.seat, companionPosition.x, companionPosition.y, homeMode, hudPage, projectCompanionIntoCamera, surface, targetWorldAnchor]);

  useGSAP(() => {
    if (!HOME_V2_ENABLED || !homeMode) return;
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
      homeMode,
      targetWorldAnchor.x,
      targetWorldAnchor.y,
    ],
  });

  useGSAP(() => {
    const visual = visualRef.current;
    if (!visual) return;
    if (HOME_V2_ENABLED && homeMode) {
      projectCompanionIntoCamera();
      return;
    }
    gsap.to(visual, {
      scale: companionScale * (homeMode ? 0.9 : 0.78),
      duration: durationFor(motionMode, 0.16),
      ease: motionMode === "off" ? "none" : "power2.out",
      overwrite: "auto",
      transformOrigin: "50% 100%",
      force3D: true,
      onComplete: clampVisibleCompanion,
    });
  }, { scope: rootRef, dependencies: [homeMode, motionMode, companionScale, clampVisibleCompanion, projectCompanionIntoCamera] });

  const beginDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    // Only the home scene is draggable. Task pages hold a fixed, on-demand
    // registry seat; drag handlers are not wired there (see WindowLive2D),
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

    // 一次没有跨过拖拽阈值的 pointerup 就是普通轻点。旧实现会在这里播放
    // 固定触摸音频并把随后真正负责打开业务入口的 click 吞掉，结果角色看起来
    // 永远只是个播放器。这里只记录触摸部位给 Live2D 表情，click 继续进入统一
    // 的 engaged 状态机；真实拖拽仍由上面的 shouldCommit 分支独占。
    if (HOME_V2_ENABLED && homeMode) {
      const targetBounds = event.currentTarget.getBoundingClientRect();
      const kind = companionTouchKindAt(event.clientY, targetBounds.top, targetBounds.height);
      setTouchKind(kind);
    }
    suppressInviteRef.current = false;
  };

  // 只提供当前场景最可能需要的真实入口；完整功能目录仍由房间物件承担。
  const actionItems = useMemo<readonly CompanionHudAction[]>(() => (
    [
      "continue",
      "today-review",
      "current-notebook",
    ].map((id) => {
      const feature = getHomeFeature(id as HomeFeatureId);
      return {
        id: feature.id,
        title: feature.title,
        purpose: feature.purpose,
        icon: HOME_FEATURE_ICONS[feature.icon],
      };
    })
  ), []);

  // 念头气泡点击（切片④）：她的开场消息落进会话并打开聊天抽屉。
  const openThoughtCue = useCallback(async (thoughtId: string) => {
    try {
      await window.ailearn.companion.chat.openThought({
        meta: createRequestMeta(),
        request: { version: 1, thoughtId },
      });
      setHomeCue(null);
      setHomeCueThoughtId(null);
      setMode("history");
    } catch {
      // 打不开（已点过/过期）就静默，气泡按自身时间线消失。
    }
  }, [setMode]);

  const runActionItem = useCallback((id: string) => {
    setMode("closed");
    runHomeV2Feature(id as HomeFeatureId);
  }, [runHomeV2Feature, setMode]);

  /**
   * 「看向手边」（方案 §5 第 9 项）：会话层在 HUD 里、角色层是它的兄弟节点，所以由 HUD
   * 回调把"有工具开始执行"这件事提上来，再转成 `WindowLive2D` 的一次参数冲量。
   * 用 `useCallback` 固定身份，HUD 侧那个 effect 才不会每帧重跑（虽然按节点 key 记账
   * 本身是幂等的，但没必要让它反复扫描）。
   */
  const handleAgentToolExecuting = useCallback(() => {
    setToolAttentionTrigger((value) => value + 1);
  }, []);

  // 功能夹是首页弹层：暂停（弹窗/窗口隐藏）、进入任务页或伴星不可用时收起。
  // （放在 companionUnavailable 声明之后，见该常量定义处。）

  const completionCue = companionMoment === "confirm" ? "这次学习已经收好，新的理解正回到小屋里。" : null;
  const visibleHomeCue = completionCue ?? (homeV2IntroVisible ? null : homeCue);
  const presentation = touchKind === "head"
    ? "celebrate"
    : touchKind === "body"
      ? "think"
      : companionMoment === "lamp" || companionMoment === "confirm"
        ? "celebrate"
        : engaged
          ? "invite"
          : "idle";
  const presentationEmotion: Live2DEmotionEvent | null = touchKind === "head"
    ? { emotion: "happy", intensity: 0.9 }
    : touchKind === "body"
      ? { emotion: "curious", intensity: 0.65 }
      : chatEmotion
        ? { emotion: chatEmotion.emotion, intensity: 0.5 }
        : companionMoment === "lamp" || companionMoment === "confirm"
        ? { emotion: "happy", intensity: 0.85 }
        : engaged
          ? { emotion: "curious", intensity: 0.4 }
          : null;

  // 唯一形态下的状态文案（形态切换已随 orb 一并移除）。
  const rendererLabel = status === "ready"
    ? "Live2D"
    : status === "loading"
      ? "正在准备 Live2D"
      : "Live2D 不可用";
  const companionUnavailable = !live2dRuntimeAllowed || status === "unavailable";

  /**
   * 「事件型暂停」= 失焦 + 弹窗。它与「持续条件」必须分开判：**只有发生的那一刻**才收起
   * 已经打开的那一层。
   *
   * 为什么不能当持续条件（2026-09-19 实机复核发现）：失焦的判据住在主进程
   * （`shared/window-state.ts` 要「可见且聚焦」才算 visible），经 IPC 异步送到渲染层。
   * 而"把窗口从后台点回前台"的那一下点击，本身就会带着 `windowState === "hidden"` 的旧
   * 快照进到点击处理器——按持续条件处理时，冷点击唤起的交互台会在同一帧被撤销：用户看到
   * 「嗯？」冒出来又消失，得点第二次才开。full 动效因为中间隔了 180ms 节拍侥幸躲过，
   * lite / off / 减少动效下必现。
   */
  const eventPaused = homeV2ModalOpen || externalModalOpen || windowState !== "visible";
  const eventPausedRef = useRef(eventPaused);
  useEffect(() => {
    const onset = eventPaused && !eventPausedRef.current;
    eventPausedRef.current = eventPaused;
    if (mode === "closed" || !onset) return;
    setMode("closed");
  }, [eventPaused, mode, setMode]);

  // 持续条件：页面不可见 / 账号关闭 / Live2D 不可用——只要成立就不允许交互层存在。
  useEffect(() => {
    if (mode === "closed") return;
    if (presenceHidden || companionUnavailable) setMode("closed");
  }, [companionUnavailable, mode, presenceHidden, setMode]);

  // 布局联动（2026-09-19，全任务界面）：版心是否为伴星座位让出空间，取决于
  // 伴星此刻**是否真的在场**。把运行时的缺席状态（临时隐藏 / 账号关闭 /
  // Live2D 不可用 / 注册表 hidden）发布到 `.desktop-app` 上，hud-surface.css
  // 的「动态伴星座位」段据此收窄或恢复各页版心（右侧 245px / 左侧 365px /
  // wide 版心 245px / 星图 seat-gutter 340px）——伴星在场时不压正文，缺席后
  // 版心恢复无伴星几何，不再固定占位。
  useEffect(() => {
    const app = document.querySelector<HTMLElement>(".desktop-app");
    if (!app) return undefined;
    app.classList.toggle("companion-absent", presenceHidden || companionUnavailable);
    return () => app.classList.remove("companion-absent");
  }, [companionUnavailable, presenceHidden]);

  // 分层 Escape：历史先返回更多，其余交互返回关闭态。
  useEffect(() => {
    if (mode === "closed") return;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (mode === "history") {
        event.preventDefault();
        setMode("actions");
      } else {
        event.preventDefault();
        setMode("closed");
        window.requestAnimationFrame(() => {
          anchorRef.current?.querySelector<HTMLButtonElement>(".window-live2d button")?.focus({ preventScroll: true });
        });
      }
    };
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [mode, setMode]);

  // 回复/发送占用交互台；页面 starter 只作为交互台里的上下文提示，绝不再单独
  // 漂浮成一张会遮正文的页面气泡。
  const hudOccupied = Boolean(liveReply) || chatPhase === "sending";

  return (
    <Fragment>
      {/* 存在层（aria-hidden 时整层可被 display:none）只承载角色与交互台；
          恢复类芯片必须放在层外，见组件尾部说明。 */}
      <div
      ref={rootRef}
      className="companion-presence"
      data-open={engaged || undefined}
      data-companion-unavailable={companionUnavailable || undefined}
      data-live2d-available={LIVE2D_RUNTIME_ALLOWED}
      data-surface={sceneKey}
      data-home-zone={HOME_V2_ENABLED && homeMode ? companionHomeZone : undefined}
      data-placement-owner={HOME_V2_ENABLED && homeMode ? companionPlacementOwner : undefined}
      data-user-anchor={HOME_V2_ENABLED && homeMode && companionUserAnchor
        ? `${companionUserAnchor.x},${companionUserAnchor.y}`
        : undefined}
      data-world-anchor={HOME_V2_ENABLED && homeMode
        ? `${targetWorldAnchor.x},${targetWorldAnchor.y}`
        : undefined}
      data-projection-state={HOME_V2_ENABLED && homeMode ? (dragging ? "dragging" : "tracking") : undefined}
      data-context-zone={HOME_V2_ENABLED && homeMode ? homeV2Zone : undefined}
      data-touch-kind={touchKind ?? undefined}
      data-formal-silent={assessmentMode || undefined}
      data-policy-mode={companionPolicy.mode}
      data-engaged={engaged || undefined}
      data-task-surface-quiet={taskSurfaceQuiet || undefined}
      data-presence-paused={presencePaused || undefined}
      data-external-modal={externalModalOpen || undefined}
      data-home-modal={homeV2ModalOpen || undefined}
      data-window-state={windowState}
      aria-hidden={presenceHidden || undefined}
    >
      <div ref={anchorRef} className="companion-scene-anchor">
        <div
          ref={visualRef}
          className={`companion-visual-shell${dragging ? " companion-visual-shell--dragging" : ""}`}
          data-companion-live2d-target="true"
        >
          {/* 静息时只有影子在动（方案 §5 第 3 项）。挂在**外壳**里而不是锚点里：
              房间座位上外壳是 `min(220px,20vw) × min(270px,35vh)` 且右下对齐，比锚点
              窄——影子若按锚点对中，会比她偏右几个像素。外壳才是驱动 `fitModel()`
              用来取景的那个盒。放在角色之前，所以她画在影子上面。
              只在全身取景下出现：半身取景裁掉了腿，「脚下」不在画面里。 */}
          {status === "ready" && companionPolicy.framing === "full" && !presenceHidden && !companionUnavailable ? (
            <span
              className="companion-contact-shadow"
              data-alive={motionMode === "full" && chatPhase !== "sending" && !liveReply ? true : undefined}
              aria-hidden="true"
            />
          ) : null}
          <div ref={characterMotionRef} className="companion-character-motion">
            <WindowLive2D
              key={live2dAttempt}
              active={!presenceHidden && !companionUnavailable}
              // 2026-09-16 追加裁决：任务页保留原地动作（低幅呼吸与眨眼，不位移、
              // 不出气泡），不再冻结当前帧。真正停止 ticker 的只有隐藏/弹窗/窗口不可见
              // 与用户自己的 motionMode（lite/off）或 reduced-motion。
              paused={presencePaused}
              motionMode={motionMode}
              presentation={presentation}
              emotion={presentationEmotion}
              inviteTrigger={inviteTrigger}
              toolAttentionTrigger={toolAttentionTrigger}
              onStatus={setStatus}
              // 首页全身取景；任务页半身取景（头与上半身充满容器，腿部裁出）。
              framing={companionPolicy.framing}
              // 只有首页可拖：首页落点写入用户世界锚点（重启后保留）。任务页
              // 是固定座位，只接轻点唤起，不接任何拖拽指针处理器。
              onPointerDown={companionPolicy.draggable ? beginDrag : undefined}
              onPointerMove={companionPolicy.draggable ? moveDrag : undefined}
              onPointerUp={companionPolicy.draggable ? endDrag : undefined}
              onPointerCancel={companionPolicy.draggable ? endDrag : undefined}
              onLostPointerCapture={companionPolicy.draggable ? endDrag : undefined}
              onInviteRequest={companionPolicy.interaction === "none" ? undefined : () => {
                if (suppressInviteRef.current) {
                  suppressInviteRef.current = false;
                  return;
                }
                setInviteTrigger((value) => value + 1);
                const next = mode === "closed" ? "conversation" : "closed";
                // 「被叫醒的中介帧」（方案 §5 第 4 项）：先让她在头顶冒一个「嗯？」，
                // 交互台晚一个身位再展开。只等 180ms（气泡入场落位），不等它 900ms 的
                // 全部寿命——把输入区压在动画后面近一秒会直接变成"卡"。lite / off /
                // 减少动效下按方案直接展开，不排队。
                if (next === "conversation" && motionMode === "full") {
                  setAwakening(true);
                  // 连点两次时后一次必须撤掉前一次的节拍，否则两个定时器都会
                  // `setMode("conversation")`——第二次点击等于没生效。
                  if (wakeTimerRef.current !== null) window.clearTimeout(wakeTimerRef.current);
                  wakeTimerRef.current = window.setTimeout(() => {
                    wakeTimerRef.current = null;
                    setMode("conversation");
                    window.requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>(".companion-hud__composer textarea")?.focus({ preventScroll: true }));
                  }, COMPANION_WAKE_BEAT_MS);
                  return;
                }
                setMode(next);
                if (next === "conversation") {
                  window.requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>(".companion-hud__composer textarea")?.focus({ preventScroll: true }));
                }
              }}
              ariaLabel="书桌上的 AI 伴星"
            />
          </div>
          {status === "loading" && !presenceHidden ? (
            <span className="companion-loading-state" role="status">Mao 正在来到书桌边…</span>
          ) : null}
          {companionVisualOnly && status === "ready" ? (
            <span className="companion-surface-label" aria-hidden="true">
              {assessmentMode ? "需要提示？" : "Mao · 伴星"}
            </span>
          ) : null}
          {!HOME_V2_ENABLED && !engaged ? <span className="companion-invite-label" aria-hidden="true">我在这里</span> : null}
          {/* 「被叫醒的中介帧」（方案 §5 第 4 项）：她"转过头来"的那一下。纯装饰，
              交互台自己会播报状态，所以这里不对读屏发第二遍。 */}
          {awakening ? <span className="companion-wake-bubble" aria-hidden="true">嗯？</span> : null}
        </div>

        {!presenceHidden && !companionUnavailable && companionPolicy.interaction !== "none" ? (
          <CompanionHud
            motionMode={motionMode}
            voiceEnabled={!assessmentMode}
            contextHint={companionPolicy.starter ?? null}
            actions={homeMode ? actionItems : []}
            onRunAction={runActionItem}
            onAgentToolExecuting={handleAgentToolExecuting}
            settings={{
              scale: companionScale,
              scaleMin: MIN_COMPANION_SCALE,
              scaleMax: MAX_COMPANION_SCALE,
              rendererLabel,
              pageMuted,
              taskActive: Boolean(surface),
              focusUntilTaskEnd: companionFocusUntilTaskEnd,
              accountState,
              accountSaving,
              accountFailure,
              onScale: setCompanionScale,
              onTogglePageMuted: () => setCompanionSceneMuted(sceneKey, !pageMuted),
              onToggleFocus: () => setCompanionFocusUntilTaskEnd(!companionFocusUntilTaskEnd),
              onHide: () => {
                setMode("closed");
                setCompanionTemporarilyHidden(true);
              },
              onResetPosition: resetCompanionPosition,
              onPatchAccount: (patch) => { void patchCompanionAccount(patch); },
            }}
          />
        ) : null}
        {/* 主动提示气泡与回复气泡共用头顶通道，同样不能放进裁切画布。 */}
        {HOME_V2_ENABLED && companionPolicy.proactive === "allow" && visibleHomeCue && !hudOccupied && !engaged ? (
          homeCueThoughtId ? (
            <button
              type="button"
              className="companion-cue-open"
              onClick={() => void openThoughtCue(homeCueThoughtId)}
              aria-label={`${visibleHomeCue}——点开和她聊`}
            >
              <CompanionBubble
                text={visibleHomeCue}
                tone={completionCue ? "touch" : "cue"}
                motionMode={motionMode}
              />
            </button>
          ) : (
            <CompanionBubble
              text={visibleHomeCue}
              tone={completionCue ? "touch" : "cue"}
              motionMode={motionMode}
            />
          )
        ) : null}
      </div>

      {/* 唯一形态下的失败态：Live2D 失败 + 就地一句可关闭说明（2026-09-16 裁决）。
          只在伴星在场时渲染（presenceHidden 时本就不出现），留在存在层内。 */}
      {companionUnavailable && !unavailableNoticeDismissed && !presenceHidden ? (
        <div className="companion-unavailable-notice">
          <SurfaceDataState
            kind="error"
            message="伴星暂时不可用"
            detail="学习功能不受影响。可以重新加载 Live2D，或先收起这张提示。"
            onRetry={() => {
              setUnavailableNoticeDismissed(false);
              setStatus("loading");
              setLive2dAttempt((attempt) => attempt + 1);
            }}
            action={(
            <button
              type="button"
              className="button"
              onClick={() => setUnavailableNoticeDismissed(true)}
              aria-label="关闭伴星不可用提示"
            >
              <X size={13} aria-hidden="true" />知道了
            </button>
            )}
          />
        </div>
      ) : null}
      </div>

      {/* 恢复芯片必须挂在存在层**之外**（2026-09-19 逐页审计发现）：伴星隐藏时
          `.companion-presence` 自身 aria-hidden，首页 V2 场景上该层被
          `.companion-presence[aria-hidden="true"]{display:none}` 整层收起，
          芯片在层内会变成 0×0 死元素——用户在首页隐藏伴星后就地无法唤回。
          挂到同一父级（`.desktop-app`）下保持原 bottom-right 锚位，且不被层
          的显隐连带。 */}
      {companionTemporarilyHidden ? (
        <p className="companion-restore-chip" role="status">
          <span>伴星已隐藏。</span>
          <button type="button" onClick={() => setCompanionTemporarilyHidden(false)}>
            让伴星回来
          </button>
        </p>
      ) : null}

      {companionAccountDisabled ? (
        <p className="companion-restore-chip" role="status">
          <span>伴星已按账号设置关闭。</span>
          <button type="button" disabled={accountSaving} onClick={() => void patchCompanionAccount({ globalEnabled: true })}>
            重新开启伴星
          </button>
        </p>
      ) : null}
    </Fragment>
  );
}
