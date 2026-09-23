import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type ReactNode,
} from "react";
import gsap from "gsap";
import { CustomEase } from "gsap/CustomEase";
import { useGSAP } from "@gsap/react";
import {
  ArrowLeft,
  ArrowRight,
  Clock3,
  Eye,
  EyeOff,
  KeyRound,
  LampDesk,
  LockKeyhole,
  LoaderCircle,
  LogIn,
  Mail,
  MoonStar,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Sun,
  Sunset,
  Ticket,
  UserRound,
  UserPlus,
} from "lucide-react";
import type {
  AILearnDesktopApiM2,
  RuntimeSnapshotV1,
  WorkspaceSummaryV1,
} from "@ailearn/shared/desktop-ipc-contracts";
import {
  decideBootstrapGatewayFailure,
  decideRuntimeGate,
  decideSessionGate,
  gateErrorPolicy,
  inspectDesktopContract,
  type AuthenticatedDesktopSession,
  type ReadyDesktopSession,
  type ReauthenticationDesktopSession,
} from "../app/desktop-gate";
import {
  createRequestMeta,
  RendererGatewayError,
  setCurrentWorkspaceEpoch,
  unwrapGatewayResult,
} from "../app/desktop-client";
import {
  clearAccountSignOutNotice,
  peekAccountSignOutNotice,
} from "../app/account-signout";
import {
  subscribeGateInvalidation,
  type GateInvalidationCode,
} from "../app/gate-invalidation";
import {
  establishRequiredRuntimeSubscription,
  type RequiredRuntimeSubscription,
} from "../app/runtime-gate-subscription";
import { mediaAssetUrl, useLearningRoomManifest } from "../media/learning-room-manifest";
import { sceneMotionDuration, type SceneMotionMode } from "../scene/scene-motion";
import { useRoomStore } from "../app/room-store";
import { HudFirstSpaceScene } from "./hud/HudFirstSpace";
import { requestSpaceMenu, requestSpaceMenuRefresh } from "./hud/space-menu-events";
/**
 * 登录页那张氛围画布是**整个渲染层里唯一还在活的 pixi.js 引用**（`scene/*-pixi*` 那条链
 * 已经没有人 import 了，只剩自己的测试）。它以前静态引入，于是 pixi 的全部运行时被拖进
 * 首屏那一个 eager chunk 里解析——而这块画布只是好看，不参与任何交互与判据。
 * 改成 lazy 之后 pixi 离开首包；`fallback={null}` 是刻意的：画布晚到一帧只是没有背景，
 * 不该在登录界面上闪一块占位。类型仍然静态引入（type-only，编译期就擦掉，不产生运行时边）。
 */
const AuthAmbientCanvas = lazy(() =>
  import("./AuthAmbientCanvas").then((module) => ({ default: module.AuthAmbientCanvas })),
);
import type { AuthAmbientLampCue } from "./AuthAmbientCanvas";
import { MIN_PASSWORD_LENGTH, validateAuthForm } from "./auth-form-validation";
import {
  AUTH_SCENE_OPTIONS,
  authSceneLabel,
  formatAuthSceneClock,
  resolveAuthScene,
  resolveAuthSceneFromDate,
  type AuthScenePreference,
  type AuthSceneTime,
} from "./auth-scene-time";
import "./desktop-access-gate.css";

gsap.registerPlugin(useGSAP, CustomEase);

const gateSurfaceEase = CustomEase.create("ailearn-gate-surface", "0.16,1,0.3,1");

type RetryAction = "bootstrap" | "connect" | "reload" | null;

type BlockedView = {
  phase: "blocked";
  title: string;
  detail: string;
  retryAction: RetryAction;
  retryAfter?: string;
};

type GateView =
  | { phase: "loading"; title: string; detail: string; stage?: string }
  | BlockedView
  | { phase: "auth"; mode: "login" | "register"; serviceNotice?: string }
  | { phase: "reauth"; session: ReauthenticationDesktopSession | ReadyDesktopSession | null }
  | {
      phase: "workspace";
      session: AuthenticatedDesktopSession;
      workspaces: WorkspaceSummaryV1[];
      notice?: string;
    }
  | {
      phase: "ready";
      runtime: RuntimeSnapshotV1;
      session: ReadyDesktopSession;
      /** An invite that failed to redeem during sign-in; the space menu reports it. */
      spaceNotice?: string;
    };

const initialView: GateView = {
  phase: "loading",
  title: "正在准备应用",
  detail: "请稍候，我们正在检查连接和登录状态。",
  stage: "正在启动本地组件",
};

/** Short, concrete labels for the spinner row of each start-up step. */
const GATE_STAGES = {
  refresh: "正在同步最新状态",
  reconnect: "正在重新连接学习服务",
  connect: "正在建立安全连接",
  trust: "正在验证本机服务身份",
  restoring: "正在校验已保存的登录凭据",
  checking: "正在向学习服务确认会话",
  resume: "正在恢复上次登录",
  switchWorkspace: "正在切换当前空间",
  loadWorkspaces: "正在读取可用的学习空间",
} as const;

/**
 * 一趟 bootstrap 的最长等待。超过它还没结论，spinner 就必须换成能点的重试：
 * 无限转圈看起来像"还在努力"，实际是把唯一的出路也藏了起来（F01 验收要求）。
 */
const BOOTSTRAP_DEADLINE_MS = 12_000;

function desktopApi(): AILearnDesktopApiM2 | null {
  const value = (window as unknown as { ailearn?: AILearnDesktopApiM2 }).ailearn;
  if (!value || typeof value !== "object") return null;
  if (
    typeof value.runtime?.getSnapshot !== "function"
    || typeof value.runtime?.retryApiConnection !== "function"
    || typeof value.auth?.getState !== "function"
    || typeof value.auth?.login !== "function"
    || typeof value.auth?.register !== "function"
    || typeof value.auth?.reauthenticate !== "function"
    || typeof value.workspace?.list !== "function"
    || typeof value.workspace?.switch !== "function"
    || typeof value.subscriptions?.subscribe !== "function"
    || typeof value.subscriptions?.onEvent !== "function"
    || typeof value.subscriptions?.unsubscribe !== "function"
  ) return null;
  return value;
}

function blockedFromError(error: unknown, title: string): BlockedView {
  const policy = gateErrorPolicy(error, title);
  const reconnect = error instanceof RendererGatewayError
    && (error.code === "api_unavailable" || error.code === "network_timeout");
  const retryAction = policy.retry === "safe_retry"
    ? reconnect ? "connect" : "bootstrap"
    : policy.retry === "resync_first"
      ? "bootstrap"
      : null;
  return {
    phase: "blocked",
    title: policy.title,
    detail: policy.detail,
    retryAction,
    ...(policy.retryAfter ? { retryAfter: policy.retryAfter } : {}),
  };
}

function isConfigurationBoundary(connection: RuntimeSnapshotV1["apiConnection"]): boolean {
  return connection.kind === "not_configured" || connection.kind === "configuration_error";
}

function retryTimeLabel(value?: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.valueOf())) return null;
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

/**
 * Hands one gate outcome to the room. A failed invite redemption happens during
 * bootstrap, before the room exists, but its surface — the learning-space menu —
 * lives in the room control pill. Rendering this beside the room children lets
 * the request fire once the pill is actually mounted.
 */
function SpaceMenuRequest({ notice }: { readonly notice: string }) {
  useEffect(() => {
    requestSpaceMenu(notice);
  }, [notice]);
  return null;
}

type LampTransitionDirection = `to-${AuthSceneTime}`;
type LampTransitionPhase = "idle" | "dimming" | "lamp-on" | "brightening" | "lamp-off" | "settling";
/** Room lighting the gate renders against; owned by the gate itself. */
type GateTheme = "day" | "night";
type GateBackdropUrls = Record<GateTheme, string | null> & { dusk: string | null };
type LampFrameCaptureController = {
  seek: (time: number) => void;
  finish: () => void;
  timing: () => { duration: number; labels: Record<string, number> };
};

const lampFrameCaptureStorageKey = "ailearn:auth-lamp-frame-capture";

function lampFrameCaptureWindow(): Window & { __ailearnAuthLampCapture?: LampFrameCaptureController } {
  return window as Window & { __ailearnAuthLampCapture?: LampFrameCaptureController };
}

function isLampFrameCaptureEnabled(): boolean {
  return window.localStorage.getItem(lampFrameCaptureStorageKey) === "paused";
}

function clearLampFrameCapture(controller?: LampFrameCaptureController | null): void {
  const captureWindow = lampFrameCaptureWindow();
  if (!controller || captureWindow.__ailearnAuthLampCapture === controller) {
    delete captureWindow.__ailearnAuthLampCapture;
  }
}

function SceneTimeIcon({ scene }: { scene: AuthSceneTime }) {
  if (scene === "day") return <Sun size={14} aria-hidden="true" />;
  if (scene === "dusk") return <Sunset size={14} aria-hidden="true" />;
  return <MoonStar size={14} aria-hidden="true" />;
}

function AuthLampControl({
  scene,
  targetScene,
  preference,
  systemScene,
  systemTimeLabel,
  motionMode,
  onSceneChange,
  onPreferenceChange,
  onLampCue,
}: {
  scene: AuthSceneTime;
  targetScene: AuthSceneTime;
  preference: AuthScenePreference;
  systemScene: AuthSceneTime;
  systemTimeLabel: string;
  motionMode: SceneMotionMode;
  onSceneChange: (scene: AuthSceneTime) => void;
  onPreferenceChange: (preference: AuthScenePreference) => void;
  onLampCue?: (direction: LampTransitionDirection) => void;
}) {
  const controlRef = useRef<HTMLDivElement>(null);
  const daySceneRef = useRef<HTMLSpanElement>(null);
  const duskSceneRef = useRef<HTMLSpanElement>(null);
  const nightSceneRef = useRef<HTMLSpanElement>(null);
  const dayScrimRef = useRef<HTMLSpanElement>(null);
  const nightScrimRef = useRef<HTMLSpanElement>(null);
  const pulseRef = useRef<HTMLSpanElement>(null);
  const pinRef = useRef<HTMLSpanElement>(null);
  const timeMenuRef = useRef<HTMLDivElement>(null);
  const timelineRef = useRef<gsap.core.Timeline | null>(null);
  const [transitionDirection, setTransitionDirection] = useState<LampTransitionDirection | null>(null);
  const [transitionPhase, setTransitionPhase] = useState<LampTransitionPhase>("idle");
  const [timeMenuOpen, setTimeMenuOpen] = useState(false);
  const { contextSafe } = useGSAP({ scope: controlRef });

  const clearTransition = useCallback(() => {
    const elements = [daySceneRef.current, duskSceneRef.current, nightSceneRef.current, dayScrimRef.current, nightScrimRef.current, pulseRef.current, pinRef.current]
      .filter((element): element is HTMLElement => element instanceof HTMLElement);
    if (elements.length) {
      gsap.set(elements, { clearProps: "opacity,visibility,transform,willChange,backgroundColor,boxShadow" });
    }
  }, []);

  useEffect(() => () => {
    timelineRef.current?.kill();
    clearLampFrameCapture();
  }, []);

  useEffect(() => {
    if (motionMode !== "off" || !timelineRef.current) return;
    timelineRef.current.kill();
    timelineRef.current = null;
    clearTransition();
    clearLampFrameCapture();
    setTransitionDirection(null);
    setTransitionPhase("idle");
  }, [clearTransition, motionMode]);

  useGSAP(() => {
    const menu = timeMenuRef.current;
    if (!timeMenuOpen || !menu) return undefined;
    return gsap.fromTo(
      menu,
      { autoAlpha: 0, y: 8, scale: 0.96, transformOrigin: "left center" },
      {
        autoAlpha: 1,
        y: 0,
        scale: 1,
        duration: sceneMotionDuration(motionMode, "surfaceEnter") > 0 ? 0.18 : 0,
        ease: "power3.out",
        clearProps: "transform,opacity,visibility",
      },
    );
  }, {
    scope: controlRef,
    dependencies: [motionMode, timeMenuOpen],
    revertOnUpdate: true,
  });

  useEffect(() => {
    if (!timeMenuOpen) return undefined;
    const closeWhenLeaving = (event: PointerEvent) => {
      if (event.target instanceof Node && !controlRef.current?.contains(event.target)) {
        setTimeMenuOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setTimeMenuOpen(false);
    };
    document.addEventListener("pointerdown", closeWhenLeaving, true);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeWhenLeaving, true);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [timeMenuOpen]);

  const runSceneTransition = contextSafe((nextScene: AuthSceneTime) => {
    const dayScene = daySceneRef.current;
    const duskScene = duskSceneRef.current;
    const nightScene = nightSceneRef.current;
    const dayScrim = dayScrimRef.current;
    const nightScrim = nightScrimRef.current;
    const pulse = pulseRef.current;
    const pin = pinRef.current;
    if (!dayScene || !duskScene || !nightScene || !dayScrim || !nightScrim || !pulse || !pin || timelineRef.current) return;

    if (sceneMotionDuration(motionMode, "camera") <= 0) {
      onSceneChange(nextScene);
      return;
    }

    const direction: LampTransitionDirection = `to-${nextScene}`;
    const fullMotion = motionMode === "full";
    const sourceIsAdjacentToTarget = Math.abs(
      ["day", "dusk", "night"].indexOf(scene) - ["day", "dusk", "night"].indexOf(nextScene),
    ) === 1;
    const transitionDuration = sourceIsAdjacentToTarget
      ? fullMotion ? 0.28 : 0.2
      : fullMotion ? 0.38 : 0.25;
    const initialSceneDuration = sourceIsAdjacentToTarget
      ? transitionDuration
      : fullMotion ? 0.17 : 0.11;
    const finalSceneDuration = transitionDuration - (sourceIsAdjacentToTarget ? 0 : initialSceneDuration);
    const handoffAt = sourceIsAdjacentToTarget ? transitionDuration * 0.52 : initialSceneDuration + finalSceneDuration * 0.18;
    const pressDuration = fullMotion ? 0.09 : 0.07;
    const releaseDuration = fullMotion ? 0.16 : 0.12;
    const frameCaptureEnabled = isLampFrameCaptureEnabled();
    onLampCue?.(direction);
    setTransitionDirection(direction);
    const sourceRank = ["day", "dusk", "night"].indexOf(scene);
    const targetRank = ["day", "dusk", "night"].indexOf(nextScene);
    const sceneIsDimming = targetRank > sourceRank;
    setTransitionPhase(sceneIsDimming ? "dimming" : "brightening");
    const supportsIntermediateScene = !sourceIsAdjacentToTarget;
    gsap.killTweensOf([dayScene, duskScene, nightScene, dayScrim, nightScrim, pulse, pin]);
    const sceneNodes: Record<AuthSceneTime, HTMLSpanElement> = {
      day: dayScene,
      dusk: duskScene,
      night: nightScene,
    };
    for (const [sceneName, node] of Object.entries(sceneNodes) as [AuthSceneTime, HTMLSpanElement][]) {
      gsap.set(node, { autoAlpha: sceneName === scene ? 1 : 0, willChange: "opacity" });
    }
    gsap.set([dayScrim, nightScrim], { autoAlpha: 0, willChange: "opacity" });
    gsap.set(pulse, { autoAlpha: 0, scale: 0.42, willChange: "transform,opacity" });
    gsap.set(pin, { willChange: "transform,background-color,box-shadow" });

    let captureController: LampFrameCaptureController | null = null;
    const timeline = gsap.timeline({
      paused: frameCaptureEnabled,
      onComplete: () => {
        timelineRef.current = null;
        setTransitionDirection(null);
        setTransitionPhase("idle");
        clearTransition();
        clearLampFrameCapture(captureController);
      },
    });
    timelineRef.current = timeline;

    const startPhase = sceneIsDimming ? "dimming" : "brightening";
    const focalPhase = sceneIsDimming ? "lamp-on" : "lamp-off";

    timeline.addLabel(startPhase, 0);
    if (supportsIntermediateScene) {
      const sourceScene = sceneNodes[scene];
      const targetSceneNode = sceneNodes[nextScene];
      // A long jump still passes through the purpose-made dusk exposure. It is
      // a scene handoff, never a blanket dimmer over the interface.
      timeline
        .to(sourceScene, { autoAlpha: 0, duration: initialSceneDuration, ease: "sine.inOut" }, startPhase)
        .to(duskScene, { autoAlpha: 1, duration: initialSceneDuration, ease: "sine.inOut" }, startPhase)
        .to(duskScene, { autoAlpha: 0, duration: finalSceneDuration, ease: "sine.inOut" }, `${startPhase}+=${initialSceneDuration}`)
        .to(targetSceneNode, { autoAlpha: 1, duration: finalSceneDuration, ease: "sine.inOut" }, `${startPhase}+=${initialSceneDuration}`);
    } else {
      const sourceScene = sceneNodes[scene];
      const targetSceneNode = sceneNodes[nextScene];
      timeline
        .to(sourceScene, { autoAlpha: 0, duration: transitionDuration, ease: "sine.inOut" }, startPhase)
        .to(targetSceneNode, { autoAlpha: 1, duration: transitionDuration, ease: "sine.inOut" }, startPhase);
    }

    timeline
      .to(pulse, { autoAlpha: 0.88, scale: 0.96, duration: 0.075, ease: "power3.out" }, startPhase)
      .to(pulse, { autoAlpha: 0, scale: 1.44, duration: 0.22, ease: "power2.out" }, `${startPhase}+=0.065`)
      .to(pin, {
        scale: 0.9,
        backgroundColor: "rgba(118, 55, 27, 0.94)",
        boxShadow: "0 4px 10px rgba(35, 21, 13, 0.25), 0 0 0 6px rgba(255, 211, 132, 0.22)",
        duration: pressDuration,
        ease: "power2.out",
      }, startPhase)
      .to(pin, {
        scale: 1.045,
        backgroundColor: "rgba(161, 82, 31, 0.92)",
        boxShadow: "0 8px 20px rgba(35, 21, 13, 0.28), 0 0 0 10px rgba(255, 201, 113, 0.28)",
        duration: 0.1,
        ease: "power3.out",
      }, `${startPhase}+=0.065`)
      .to(pin, { scale: 1, duration: releaseDuration, ease: "power2.out" }, `${startPhase}+=0.16`)
      .addLabel(focalPhase, handoffAt)
      .call(() => setTransitionPhase(focalPhase), [], focalPhase)
      .call(() => onSceneChange(nextScene), [], focalPhase)
      .addLabel("settling", transitionDuration)
      .call(() => setTransitionPhase("settling"), [], "settling");

    if (frameCaptureEnabled) {
      captureController = {
        seek: (time) => {
          timeline.pause();
          timeline.time(gsap.utils.clamp(0, timeline.duration(), time), false);
        },
        finish: () => timeline.play(),
        timing: () => ({ duration: timeline.duration(), labels: { ...timeline.labels } }),
      };
      lampFrameCaptureWindow().__ailearnAuthLampCapture = captureController;
    }
  });

  useEffect(() => {
    if (targetScene === scene || timelineRef.current) return;
    runSceneTransition(targetScene);
  }, [motionMode, scene, targetScene]);

  const handleLampPress = contextSafe(() => {
    if (timelineRef.current) return;
    const pulse = pulseRef.current;
    const pin = pinRef.current;
    if (sceneMotionDuration(motionMode, "camera") > 0 && pulse && pin) {
      gsap.killTweensOf([pulse, pin]);
      gsap.set(pulse, { autoAlpha: 0.58, scale: 0.5, willChange: "transform,opacity" });
      gsap.to(pulse, { autoAlpha: 0, scale: 1.14, duration: 0.24, ease: "power2.out", clearProps: "transform,opacity,willChange" });
      gsap.fromTo(pin, { scale: 0.94 }, { scale: 1, duration: 0.18, ease: "power3.out", clearProps: "transform" });
    }
    setTimeMenuOpen((open) => !open);
  });

  const handlePreferenceSelect = contextSafe((nextPreference: AuthScenePreference) => {
    if (timelineRef.current) return;
    setTimeMenuOpen(false);
    onPreferenceChange(nextPreference);
  });

  const isNight = scene === "night";
  const actionLabel = "调整场景时间";
  const systemDescription = `${systemTimeLabel} · ${authSceneLabel(systemScene)}`;

  return (
    <div
      ref={controlRef}
      className="desktop-access-gate__lamp-switch"
      data-transition-direction={transitionDirection ?? "idle"}
      data-transition-phase={transitionPhase}
    >
      <div className="desktop-access-gate__backdrop-stack" aria-hidden="true">
        <span ref={daySceneRef} className="desktop-access-gate__backdrop-layer desktop-access-gate__backdrop-layer--day" />
        <span ref={duskSceneRef} className="desktop-access-gate__backdrop-layer desktop-access-gate__backdrop-layer--dusk" />
        <span ref={nightSceneRef} className="desktop-access-gate__backdrop-layer desktop-access-gate__backdrop-layer--night" />
        <span ref={dayScrimRef} className="desktop-access-gate__backdrop-scrim desktop-access-gate__backdrop-scrim--day" />
        <span ref={nightScrimRef} className="desktop-access-gate__backdrop-scrim desktop-access-gate__backdrop-scrim--night" />
      </div>
      <button
        className="desktop-access-gate__lamp-control"
        type="button"
        disabled={transitionDirection !== null}
        data-lamp-lit={isNight}
        aria-label={actionLabel}
        aria-expanded={timeMenuOpen}
        aria-controls="desktop-gate-time-menu"
        title={actionLabel}
        onClick={handleLampPress}
      >
        <span ref={pulseRef} className="desktop-access-gate__lamp-control-pulse" aria-hidden="true" />
        <span ref={pinRef} className="desktop-access-gate__lamp-control-pin" aria-hidden="true">
          <LampDesk size={15} strokeWidth={1.8} />
        </span>
        <span className="desktop-access-gate__lamp-control-label" aria-hidden="true">时段</span>
      </button>
      {timeMenuOpen ? (
        <div ref={timeMenuRef} id="desktop-gate-time-menu" className="desktop-access-gate__time-menu" role="group" aria-label="选择场景时间">
          <button
            type="button"
            className="desktop-access-gate__time-option desktop-access-gate__time-option--system"
            data-scene-choice="system"
            data-selected={preference === "system"}
            aria-pressed={preference === "system"}
            onClick={() => handlePreferenceSelect("system")}
          >
            <Clock3 size={14} aria-hidden="true" />
            <span>跟随现在</span>
            <small>{systemDescription}</small>
          </button>
          <div className="desktop-access-gate__time-option-grid">
            {AUTH_SCENE_OPTIONS.map((option) => (
              <button
                key={option.scene}
                type="button"
                className="desktop-access-gate__time-option"
                data-scene-choice={option.scene}
                data-selected={preference === option.scene}
                aria-pressed={preference === option.scene}
                onClick={() => handlePreferenceSelect(option.scene)}
              >
                <SceneTimeIcon scene={option.scene} />
                <span>{option.label}</span>
                <small>{option.representativeTime}</small>
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function GateFrame({
  title,
  detail,
  tone = "default",
  variant = "default",
  motionMode = "off",
  requestedScene,
  scenePreference,
  systemScene,
  systemTimeLabel,
  onScenePreferenceChange,
  backdropUrls,
  children,
}: {
  title: string;
  detail: string;
  tone?: "default" | "danger";
  variant?: "default" | "register";
  motionMode?: SceneMotionMode;
  requestedScene: AuthSceneTime;
  scenePreference: AuthScenePreference;
  systemScene: AuthSceneTime;
  systemTimeLabel: string;
  onScenePreferenceChange: (preference: AuthScenePreference) => void;
  backdropUrls: GateBackdropUrls;
  children?: ReactNode;
}) {
  const frameRef = useRef<HTMLElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const lampCueIdRef = useRef(0);
  const [lampCue, setLampCue] = useState<AuthAmbientLampCue | null>(null);
  const [visibleScene, setVisibleScene] = useState<AuthSceneTime>(requestedScene);
  // The posters share one room composition, but dusk has its own mid-value
  // background.  Keeping it as a distinct visual theme lets form contrast,
  // focus treatment, and ambient particles adapt instead of borrowing the
  // brighter day palette.
  const visualTheme: AuthSceneTime = visibleScene;
  const style = {
    ...(backdropUrls.day ? { "--desktop-gate-backdrop-day": `url("${backdropUrls.day}")` } : {}),
    ...(backdropUrls.dusk ? { "--desktop-gate-backdrop-dusk": `url("${backdropUrls.dusk}")` } : {}),
    ...(backdropUrls.night ? { "--desktop-gate-backdrop-night": `url("${backdropUrls.night}")` } : {}),
  } as CSSProperties;

  const handleLampCue = useCallback((direction: LampTransitionDirection) => {
    lampCueIdRef.current += 1;
    setLampCue({ id: lampCueIdRef.current, direction });
  }, []);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => headingRef.current?.focus({ preventScroll: true }));
    return () => window.cancelAnimationFrame(frame);
  }, [title]);

  useGSAP(() => {
    const frame = frameRef.current;
    if (!frame) return undefined;
    const panel = frame.querySelector<HTMLElement>(".desktop-access-gate__panel");
    if (!panel) return undefined;

    const brand = panel.querySelector<HTMLElement>(".desktop-access-gate__brand");
    const heading = panel.querySelector<HTMLElement>(".desktop-access-gate__heading");
    const fields = [...frame.querySelectorAll<HTMLElement>(".desktop-access-gate__fields > label")];
    const form = panel.querySelector<HTMLElement>(".desktop-access-gate__form");
    const formSupport = form
      ? [...form.children].filter((element) => !element.matches(".desktop-access-gate__fields")) as HTMLElement[]
      : [];
    const directContent = [...panel.children]
      .filter((element) => !element.matches(".desktop-access-gate__brand, .desktop-access-gate__heading, .desktop-access-gate__form")) as HTMLElement[];
    const supportingNodes = [...formSupport, ...directContent];
    const animatedNodes = [brand, heading, ...fields, ...supportingNodes].filter(
      (element): element is HTMLElement => element instanceof HTMLElement,
    );
    const compact = window.matchMedia("(max-width: 760px), (max-height: 620px)").matches;
    const effectiveMode = compact && motionMode === "full" ? "lite" : motionMode;
    const duration = sceneMotionDuration(effectiveMode, "surfaceEnter");
    const direction = variant === "register" ? 1 : -1;
    frame.dataset.gateMotionState = duration > 0 ? "running" : "settled";

    if (duration <= 0) {
      gsap.set([panel, ...animatedNodes], { clearProps: "transform,opacity,visibility,willChange" });
      return undefined;
    }

    // The entrance animates `opacity`, never `autoAlpha`: `autoAlpha` would set
    // `visibility: hidden`, and for the length of the stagger the inputs and the
    // submit button would drop out of the tab order and out of the accessibility
    // tree. They stay focusable and announced while they fade in.
    gsap.set(panel, { willChange: "transform,opacity" });
    gsap.set(animatedNodes, { opacity: 0, y: 7, willChange: "transform,opacity" });
    const timeline = gsap.timeline({
      defaults: { ease: gateSurfaceEase },
      onComplete: () => {
        frame.dataset.gateMotionState = "settled";
      },
    });
    timeline.fromTo(
      panel,
      {
        opacity: 0,
        x: direction * (effectiveMode === "lite" ? 7 : 12),
        scale: effectiveMode === "lite" ? 0.998 : 0.994,
      },
      {
        opacity: 1,
        x: 0,
        scale: 1,
        duration,
        clearProps: "transform,opacity,visibility,willChange",
      },
      0,
    );
    const reveal = (targets: HTMLElement[], startAt: number, revealDuration: number, stagger = 0) => {
      if (targets.length === 0) return;
      timeline.to(targets, {
        opacity: 1,
        y: 0,
        duration: revealDuration,
        stagger,
        clearProps: "transform,opacity,visibility,willChange",
      }, startAt);
    };
    reveal(brand ? [brand] : [], Math.min(duration * 0.08, 0.04), Math.min(duration * 0.5, 0.23));
    reveal(heading ? [heading] : [], Math.min(duration * 0.14, 0.065), Math.min(duration * 0.52, 0.24));
    reveal(fields, Math.min(duration * 0.2, 0.09), Math.min(duration * 0.5, 0.23), Math.min(duration * 0.03, 0.014));
    reveal(supportingNodes, Math.min(duration * 0.3, 0.14), Math.min(duration * 0.46, 0.21), Math.min(duration * 0.025, 0.012));

    return () => {
      timeline.kill();
      frame.dataset.gateMotionState = "settled";
    };
  }, {
    scope: frameRef,
    dependencies: [motionMode, title, variant],
    revertOnUpdate: true,
  });

  return (
    <main
      ref={frameRef}
      id="main-content"
      className="desktop-access-gate"
      data-tone={tone}
      data-gate-variant={variant}
      data-gate-scene={visibleScene}
      data-gate-visual-theme={visualTheme}
      data-gate-time-mode={scenePreference}
      data-gate-motion-mode={motionMode}
      data-gate-asset-source={backdropUrls.day && backdropUrls.night ? "manifest" : "fallback"}
      style={style}
    >
      <div className="desktop-access-gate__drag-region" aria-hidden="true" />
      <Suspense fallback={null}>
        <AuthAmbientCanvas theme={visualTheme} variant={variant} motionMode={motionMode} lampCue={lampCue} />
      </Suspense>
      <AuthLampControl
        scene={visibleScene}
        targetScene={requestedScene}
        preference={scenePreference}
        systemScene={systemScene}
        systemTimeLabel={systemTimeLabel}
        motionMode={motionMode}
        onSceneChange={setVisibleScene}
        onPreferenceChange={onScenePreferenceChange}
        onLampCue={handleLampCue}
      />
      <section className="desktop-access-gate__panel" aria-labelledby="desktop-gate-title" aria-describedby="desktop-gate-detail">
        <div className="desktop-access-gate__brand" aria-label="理解引擎">
          <span className="desktop-access-gate__brand-seal" aria-hidden="true">理</span>
          <span className="desktop-access-gate__brand-name">理解引擎</span>
          <span className="desktop-access-gate__brand-dot" aria-hidden="true" />
        </div>
        <div className="desktop-access-gate__heading">
          <h1 ref={headingRef} id="desktop-gate-title" tabIndex={-1}>{title}</h1>
          <p id="desktop-gate-detail">{detail}</p>
        </div>
        {children}
      </section>
    </main>
  );
}

export function DesktopAccessGate({
  children,
  onWorkspaceBoundaryReset,
  motionMode = "full",
}: {
  children: ReactNode;
  onWorkspaceBoundaryReset?: () => void;
  motionMode?: SceneMotionMode;
}) {
  const [view, setView] = useState<GateView>(initialView);
  const [refreshRevision, setRefreshRevision] = useState(0);
  const [formBusy, setFormBusy] = useState(false);
  const [formFailure, setFormFailure] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [inviteToken, setInviteToken] = useState("");
  const [inviteEntryOpen, setInviteEntryOpen] = useState(false);
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [keepSignedIn, setKeepSignedIn] = useState(true);
  const [credentialPersistence, setCredentialPersistence] = useState<"safe_storage" | "memory">("memory");
  const [authSurfaceHelp, setAuthSurfaceHelp] = useState<string | null>(null);
  const [roomRevealed, setRoomRevealed] = useState(false);
  const [scenePreference, setScenePreference] = useState<AuthScenePreference>("system");
  const [systemNow, setSystemNow] = useState(() => new Date());
  const { manifest: roomManifest } = useLearningRoomManifest();
  const gateBackdropUrls: GateBackdropUrls = {
    day: roomManifest ? mediaAssetUrl(roomManifest, roomManifest.authPosters.day.path) : null,
    dusk: roomManifest ? mediaAssetUrl(roomManifest, roomManifest.authPosters.dusk.path) : null,
    night: roomManifest ? mediaAssetUrl(roomManifest, roomManifest.authPosters.night.path) : null,
  };
  const registerBackdropUrls: GateBackdropUrls = {
    day: roomManifest ? mediaAssetUrl(roomManifest, roomManifest.registerPosters.day.path) : null,
    dusk: roomManifest ? mediaAssetUrl(roomManifest, roomManifest.registerPosters.dusk.path) : null,
    night: roomManifest ? mediaAssetUrl(roomManifest, roomManifest.registerPosters.night.path) : null,
  };
  const generationRef = useRef(0);
  const forceConnectionRef = useRef(false);
  /** 这一趟 bootstrap 是不是"静默复核"：视图已经是 ready，复核期间不换视图。 */
  const silentReverifyRef = useRef(false);
  /** 是否有一趟 bootstrap 在飞：同一个账号+空间+epoch 的复核靠它合并成一趟。 */
  const bootstrapFlightRef = useRef(false);
  const connectionFlightRef = useRef<Promise<unknown> | null>(null);
  const readyBoundaryRef = useRef<string | null>(null);
  /** 上一次发布给顶栏胶囊的空间身份；只在真的变了时写 store，避免每次 ready 都刷一遍订阅者。 */
  const spaceIdentityBoundaryRef = useRef<string | null>(null);
  const lastTrustedSessionRef = useRef<ReadyDesktopSession | null>(null);
  // Set when an invite redemption fails right after login: the next bootstrap
  // resolves into the workspace phase so the failure has a surface to land on.
  const pendingWorkspaceNoticeRef = useRef<string | null>(null);
  const viewPhaseRef = useRef<GateView["phase"]>(initialView.phase);
  const systemScene = resolveAuthSceneFromDate(systemNow);
  const requestedScene = resolveAuthScene(scenePreference, systemNow);
  const systemTimeLabel = formatAuthSceneClock(systemNow);
  const gateSceneProps = {
    requestedScene,
    scenePreference,
    systemScene,
    systemTimeLabel,
    onScenePreferenceChange: setScenePreference,
  };
  viewPhaseRef.current = view.phase;

  useEffect(() => {
    if (scenePreference !== "system") return undefined;
    const syncSystemTime = () => setSystemNow(new Date());
    const untilNextMinute = 60_000 - (Date.now() % 60_000) + 24;
    let interval: number | undefined;
    const timeout = window.setTimeout(() => {
      syncSystemTime();
      interval = window.setInterval(syncSystemTime, 60_000);
    }, untilNextMinute);
    return () => {
      window.clearTimeout(timeout);
      if (interval !== undefined) window.clearInterval(interval);
    };
  }, [scenePreference]);

  useEffect(() => {
    if (view.phase !== "auth") return;
    const api = desktopApi();
    if (!api) return;
    let cancelled = false;
    void api.auth.getSurfaceManifest({ meta: createRequestMeta() }).then((response) => {
      if (cancelled || !response.ok || response.data.testMode) return;
      const targetId = `${view.mode}:static_help`;
      const entry = response.data.manifest.surfaces.find((surface) => surface.surfaceId === targetId);
      setAuthSurfaceHelp(entry?.textContent || null);
    }).catch(() => {
      if (!cancelled) setAuthSurfaceHelp(null);
    });
    return () => { cancelled = true; };
  }, [view.phase, view.phase === "auth" ? view.mode : null]);

  const beginRoomReveal = useCallback(() => {
    // The gate owns a distinct window-side alcove, so entering the Room is a
    // short CSS reveal rather than a threshold animation through an unrelated
    // environment.
    setRoomRevealed(true);
  }, []);

  useEffect(() => {
    if (view.phase !== "ready" && roomRevealed) {
      setRoomRevealed(false);
    }
  }, [roomRevealed, view.phase]);

  const requestBootstrap = useCallback((forceConnection = false, reverify = false) => {
    // 静默复核只对"已经在跑的房间"成立；视图不是 ready 时，该走的还是门禁视图那条路。
    const silent = reverify && viewPhaseRef.current === "ready";
    // 同代合并：同一个账号+空间+epoch 只允许一趟复核在飞。伴星投递、可见性恢复、
    // 空间事件可能在同一瞬间各来一条，不合并就是各起一趟 bootstrap——每趟一条
    // /auth/me，而它们对当前边界说的是同一句话。
    if (silent && bootstrapFlightRef.current) return;
    generationRef.current += 1;
    forceConnectionRef.current = forceConnectionRef.current || forceConnection;
    silentReverifyRef.current = silent;
    setFormFailure(null);
    if (!silent) {
      setView({
        phase: "loading",
        title: forceConnection ? "正在重新连接" : "正在刷新状态",
        detail: "连接恢复后会自动继续。",
        stage: forceConnection ? GATE_STAGES.reconnect : GATE_STAGES.refresh,
      });
    }
    setRefreshRevision((revision) => revision + 1);
  }, []);

  /**
   * 取走（并清空）待报告的邀请码失败提示。返回**值**而不是对象：两个消费方的字段名
   * 本来就不同（`workspace` 视图叫 `notice`、`ready` 视图叫 `spaceNotice`），此前
   * 这里返回 `{ notice }` 再被 spread 进 ready 视图，读的一直是 `view.spaceNotice`，
   * 于是登录页填的邀请码失败后没有任何地方能把话说出来。
   */
  const takeWorkspaceNotice = useCallback((): string | undefined => {
    const notice = pendingWorkspaceNoticeRef.current;
    pendingWorkspaceNoticeRef.current = null;
    return notice ?? undefined;
  }, []);

  const invalidateReadyGate = useCallback((code?: GateInvalidationCode) => {
    if (viewPhaseRef.current !== "ready") return;
    // 没有错误码的失效（runtime 的 snapshot_invalidated）先做一次静默复核：同一个
    // 账号+空间+epoch 复核通过时视图、房间视图状态与焦点都不动，真的换了边界才在
    // apply 里收口。以前这里无条件清空工作区并重建，于是任何一条运行时事件都能把
    // 用户正在看的页面推倒重来（F01）。
    if (code === undefined) {
      requestBootstrap(false, true);
      return;
    }
    onWorkspaceBoundaryReset?.();
    readyBoundaryRef.current = null;
    if (["auth_required", "api_untrusted", "configuration_error", "unsupported_contract"].includes(code)) {
      lastTrustedSessionRef.current = null;
    }
    requestBootstrap(false);
  }, [onWorkspaceBoundaryReset, requestBootstrap]);

  useEffect(() => subscribeGateInvalidation((code) => invalidateReadyGate(code)), [invalidateReadyGate]);

  const connectOnce = useCallback(async (api: AILearnDesktopApiM2) => {
    if (!connectionFlightRef.current) {
      const flight = api.runtime
        .retryApiConnection({ meta: createRequestMeta() })
        .then((response) => unwrapGatewayResult(response));
      connectionFlightRef.current = flight;
      void flight.finally(() => {
        if (connectionFlightRef.current === flight) connectionFlightRef.current = null;
      }).catch(() => undefined);
    }
    return connectionFlightRef.current;
  }, []);

  useEffect(() => {
    const generation = ++generationRef.current;
    let waitTimer: number | undefined;
    let runtimeSubscription: RequiredRuntimeSubscription | null = null;
    const silentReverify = silentReverifyRef.current;
    silentReverifyRef.current = false;
    bootstrapFlightRef.current = true;
    const isCurrent = () => generationRef.current === generation;
    const apply = (next: GateView) => {
      if (!isCurrent()) return;
      // 静默复核只报结论、不报过程：房间还在屏幕上，不该因为后台复核走到了哪一步
      // 就闪一次 spinner。
      if (silentReverify && next.phase === "loading" && viewPhaseRef.current === "ready") return;
      if (next.phase === "ready") {
        const nextBoundary = [
          next.session.user.userId,
          next.session.workspace.workspaceId,
          next.session.workspaceEpoch,
        ].join(":");
        const boundaryChanged = readyBoundaryRef.current !== null && readyBoundaryRef.current !== nextBoundary;
        if (boundaryChanged) {
          onWorkspaceBoundaryReset?.();
        }
        readyBoundaryRef.current = nextBoundary;
        lastTrustedSessionRef.current = next.session;
        // 边界一旦确定就同步给 createRequestMeta 的兜底，漏传 epoch 的调用点因此
        // 不可能把请求打到别的空间上；登出后视图不再是 ready，这里保持最后一次的
        // 值，而主进程届时已把 activeWorkspaceEpoch 归零 → 不匹配 → stale_workspace。
        setCurrentWorkspaceEpoch(next.session.workspaceEpoch);
        // 顶栏空间胶囊的身份随同一次已验证会话发布：胶囊不自己发请求，也就不会
        // 出现「菜单说 A、胶囊说 B」。登出后视图不再是 ready，这里保留最后一次的
        // 值——届时药丸本身也不在屏幕上。
        const identity = {
          name: next.session.workspace.name,
          role: next.session.workspace.role,
          isPersonal: next.session.workspace.isPersonal,
        };
        const identityBoundary = [identity.name, identity.role, String(identity.isPersonal)].join(":");
        if (spaceIdentityBoundaryRef.current !== identityBoundary) {
          spaceIdentityBoundaryRef.current = identityBoundary;
          useRoomStore.getState().setSpaceIdentity(identity);
        }
        // 账号身份与空间身份同一时机、同一来源发布：顶栏那个小框要回答「我是谁」，
        // 而它不该为这句话自己发请求——设置页已经有一份档案，两处各读各的就会打架。
        const account = {
          email: next.session.user.email,
          displayName: next.session.user.displayName ?? null,
        };
        const published = useRoomStore.getState().accountIdentity;
        if (published?.email !== account.email || published?.displayName !== account.displayName) {
          useRoomStore.getState().setAccountIdentity(account);
        }
        // 会话重新成立，上一次退出留下的那句话就用完了。不清的话它会在下一次
        // 完全不同的场合（比如会话到期）再冒出来。
        clearAccountSignOutNotice();
        // 静默复核落在同一个边界上：视图不落地。整棵房间因此不卸载，页面、滚动
        // 位置与焦点都留在原处；上面这些发布语句已经把这趟读到的会话对齐了。
        if (silentReverify && !boundaryChanged && viewPhaseRef.current === "ready") return;
      }
      setView(next);
    };

    const bootstrap = async () => {
      const api = desktopApi();
      if (!api) {
        apply({
          phase: "blocked",
          title: "应用组件加载失败",
          detail: "请重新载入应用；如果仍然失败，请退出后重新打开。",
          retryAction: "reload",
        });
        return;
      }
      const contractDecision = inspectDesktopContract(api.contract);
      if (contractDecision.kind === "blocked") {
        apply({
          phase: "blocked",
          title: "当前版本无法继续",
          detail: contractDecision.detail,
          retryAction: null,
        });
        return;
      }

      try {
        try {
          const subscription = await establishRequiredRuntimeSubscription(api, createRequestMeta(), (event) => {
            if (!isCurrent() || viewPhaseRef.current !== "ready") return;
            if (event.data.kind === "connection_changed") {
              // 连接恢复（ready）不是会话失效：房间已经在跑，再校验一次不会让任何
              // 东西变新，只会白拆一次页面。
              if (event.data.state.kind === "ready") return;
              const decision = decideRuntimeGate(event.data.state);
              if (decision.kind === "blocked") {
                onWorkspaceBoundaryReset?.();
                readyBoundaryRef.current = null;
                generationRef.current += 1;
                setFormFailure(null);
                setView(isConfigurationBoundary(decision.connection)
                  ? { phase: "auth", mode: "login", serviceNotice: decision.detail }
                  : {
                      phase: "blocked",
                      title: decision.title,
                      detail: decision.detail,
                      retryAction: decision.retry === "safe_retry" ? "connect" : null,
                      ...(decision.connection.kind === "api_unavailable" && decision.connection.retryAfter
                        ? { retryAfter: decision.connection.retryAfter }
                        : {}),
                    });
                return;
              }
              // 还在连接/核验：交给一次静默复核收口——成功就什么都不动，失败会落到
              // blocked。它不是"页面该重来"的理由。
              invalidateReadyGate();
              return;
            }
            // 伴星投递（companion_activity_changed）这类局部事件由伴星小屋与首页投影
            // 自己消费；门禁只对显式的 snapshot_invalidated 复核会话。
            if (event.data.kind !== "snapshot_invalidated") return;
            invalidateReadyGate();
          });
          if (!isCurrent()) {
            subscription.close();
            return;
          }
          runtimeSubscription = subscription;
        } catch (error) {
          if (!isCurrent()) return;
          const blocked = blockedFromError(error, "应用状态暂时无法更新");
          if (error instanceof RendererGatewayError && error.code === "configuration_error") {
            apply({ phase: "auth", mode: "login", serviceNotice: blocked.detail });
          } else {
            apply({ ...blocked, retryAction: blocked.retryAction ?? "bootstrap" });
          }
          return;
        }

        let runtime = unwrapGatewayResult(await api.runtime.getSnapshot({ meta: createRequestMeta() }));
        if (!isCurrent()) return;
        setCredentialPersistence(runtime.sessionCredential.persistence);
        let runtimeDecision = decideRuntimeGate(runtime.apiConnection);
        const forceConnection = forceConnectionRef.current;
        forceConnectionRef.current = false;

        if (runtimeDecision.kind === "connect" || forceConnection) {
          apply({
            phase: "loading",
            title: "正在连接学习服务",
            detail: "连接成功后会继续检查登录状态。",
            stage: GATE_STAGES.connect,
          });
          await connectOnce(api);
          if (!isCurrent()) return;
          runtime = unwrapGatewayResult(await api.runtime.getSnapshot({ meta: createRequestMeta() }));
          runtimeDecision = decideRuntimeGate(runtime.apiConnection);
          setCredentialPersistence(runtime.sessionCredential.persistence);
        }

        if (runtimeDecision.kind === "connect") {
          apply({
            phase: "loading",
            title: "正在建立安全连接",
            detail: "完成后会自动继续。",
            stage: GATE_STAGES.trust,
          });
          waitTimer = window.setTimeout(() => requestBootstrap(), 650);
          return;
        }

        if (runtimeDecision.kind === "blocked") {
          if (isConfigurationBoundary(runtimeDecision.connection)) {
            apply({ phase: "auth", mode: "login", serviceNotice: runtimeDecision.detail });
            return;
          }
          apply({
            phase: "blocked",
            title: runtimeDecision.title,
            detail: runtimeDecision.detail,
            retryAction: runtimeDecision.retry === "safe_retry" ? "connect" : null,
            ...(runtimeDecision.connection.kind === "api_unavailable" && runtimeDecision.connection.retryAfter
              ? { retryAfter: runtimeDecision.connection.retryAfter }
              : {}),
          });
          return;
        }

        // A credential left by a previous launch is the difference between
        // "resuming your session" and "asking whether you are signed in".
        const resumingStoredSession = runtime.sessionCredential.stored;
        apply({
          phase: "loading",
          title: resumingStoredSession ? "正在恢复上次登录" : "正在检查登录状态",
          detail: resumingStoredSession
            ? "已找到上次的登录状态，正在向学习服务确认。"
            : "请稍候，完成后会自动继续。",
          stage: resumingStoredSession ? GATE_STAGES.restoring : GATE_STAGES.checking,
        });
        const session = unwrapGatewayResult(await api.auth.getState({ meta: createRequestMeta() }));
        if (!isCurrent()) return;
        const sessionDecision = decideSessionGate(session);

        switch (sessionDecision.kind) {
          case "wait":
            apply({
              phase: "loading",
              title: sessionDecision.reason === "restoring" ? "正在恢复登录" : "正在切换学习空间",
              detail: "完成后会自动继续。",
              stage: sessionDecision.reason === "restoring" ? GATE_STAGES.resume : GATE_STAGES.switchWorkspace,
            });
            waitTimer = window.setTimeout(() => requestBootstrap(), 700);
            return;
          case "authenticate":
            apply({ phase: "auth", mode: "login", serviceNotice: peekAccountSignOutNotice() ?? undefined });
            return;
          case "reauthenticate":
            apply({ phase: "reauth", session: sessionDecision.session });
            return;
          case "blocked":
            apply({
              phase: "blocked",
              title: sessionDecision.reason === "api_untrusted" ? "无法安全登录" : "登录服务暂时不可用",
              detail: sessionDecision.detail,
              retryAction: sessionDecision.reason === "api_unavailable" ? "connect" : null,
            });
            return;
          case "resync":
            apply({
              phase: "blocked",
              title: "账号信息需要更新",
              detail: sessionDecision.detail,
              retryAction: "bootstrap",
            });
            return;
          case "workspace_required": {
            apply({
              phase: "loading",
              title: "正在加载学习空间",
              detail: "加载完成后，选择你要使用的空间。",
              stage: GATE_STAGES.loadWorkspaces,
            });
            const response = await api.workspace.list({ meta: createRequestMeta(sessionDecision.session.workspaceEpoch) });
            const workspaces = unwrapGatewayResult(response).workspaces;
            apply({ phase: "workspace", session: sessionDecision.session, workspaces, notice: takeWorkspaceNotice() });
            return;
          }
          case "ready": {
            // `/auth/me` always resolves an active workspace, so a ready session
            // already has a space to work in. More than one space no longer
            // gates the room — switching happens in the room control's
            // learning-space menu (mockup 04B), which lists `workspace.list` for
            // itself. The one outcome that still needs a surface is an invite
            // that failed to redeem during sign-in: the menu owns joining, so it
            // opens for that message instead of a gate panel.
            apply({
              phase: "ready",
              runtime,
              session: sessionDecision.session,
              spaceNotice: takeWorkspaceNotice(),
            });
            return;
          }
        }
      } catch (error) {
        if (!isCurrent()) return;
        const failureDecision = decideBootstrapGatewayFailure(error);
        switch (failureDecision.kind) {
          case "authenticate":
            apply({ phase: "auth", mode: "login", serviceNotice: peekAccountSignOutNotice() ?? undefined });
            return;
          case "reauthenticate":
            apply({ phase: "reauth", session: lastTrustedSessionRef.current });
            return;
          case "resync":
          case "blocked":
            if (error instanceof RendererGatewayError && error.code === "configuration_error") {
              apply({ phase: "auth", mode: "login", serviceNotice: gateErrorPolicy(error).detail });
              return;
            }
            apply(blockedFromError(error, "暂时无法打开学习空间"));
            return;
        }
      }
    };

    void bootstrap().finally(() => {
      // 一趟落地（成功、失败或被更新的一趟取代）就放掉在飞标记：下一个失效事件
      // 才有资格再起一趟。
      if (isCurrent()) bootstrapFlightRef.current = false;
    });
    // 有限等待：卡在 spinner 上超过时限就换成能点的重试。静默复核没有 spinner，
    // 它只放掉在飞标记，让后面的失效事件还能重来。
    const deadlineTimer = window.setTimeout(() => {
      if (!isCurrent()) return;
      bootstrapFlightRef.current = false;
      if (viewPhaseRef.current !== "loading") return;
      apply({
        phase: "blocked",
        title: "状态同步超时",
        detail: "学习服务一直没有回应。可以重试；已经读到的内容不会丢失。",
        retryAction: "bootstrap",
      });
      // 这一趟等不到结论了：把它的后续落地一并作废，免得迟到的"正在…"再把
      // spinner 放回屏幕上。
      generationRef.current += 1;
    }, BOOTSTRAP_DEADLINE_MS);
    return () => {
      if (waitTimer !== undefined) window.clearTimeout(waitTimer);
      window.clearTimeout(deadlineTimer);
      runtimeSubscription?.close();
    };
  }, [connectOnce, invalidateReadyGate, onWorkspaceBoundaryReset, refreshRevision, requestBootstrap, takeWorkspaceNotice]);

  useEffect(() => {
    if (view.phase !== "ready") return;
    const api = desktopApi();
    if (!api) return;
    let active = true;
    let subscriptionId: string | null = null;
    let stopEvents: (() => void) | undefined;

    const subscribe = async () => {
      try {
        const response = await api.subscriptions.subscribe({
          meta: createRequestMeta(view.session.workspaceEpoch),
          topic: { kind: "workspace" },
        });
        if (!active) return;
        subscriptionId = unwrapGatewayResult(response).subscriptionId;
        stopEvents = api.subscriptions.onEvent(subscriptionId, () => {
          // The learning-space menu owns `workspace.list`; a workspace event is
          // the one signal that the list may have changed under it. Refresh it
          // before the bootstrap re-verifies the session.
          requestSpaceMenuRefresh();
          requestBootstrap();
        });
      } catch (error) {
        if (!active) return;
        if (error instanceof RendererGatewayError && error.code === "configuration_error") {
          setView({ phase: "auth", mode: "login", serviceNotice: gateErrorPolicy(error).detail });
        } else {
          setView(blockedFromError(error, "学习空间暂时无法更新"));
        }
      }
    };

    void subscribe();
    return () => {
      active = false;
      stopEvents?.();
      if (subscriptionId) {
        void api.subscriptions.unsubscribe({
          meta: createRequestMeta(view.session.workspaceEpoch),
          subscriptionId,
        }).catch(() => undefined);
      }
    };
  }, [requestBootstrap, view]);

  useEffect(() => {
    if (view.phase !== "ready") return;
    const onVisibilityChange = () => {
      // 回到窗口只是复核一次：同一个账号+空间+epoch 复核通过时页面不该被推倒重来。
      if (document.visibilityState === "visible") requestBootstrap(false, true);
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, [requestBootstrap, view.phase]);

  const handleAuthSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const api = desktopApi();
    if (!api || view.phase !== "auth") return;
    const localFailure = validateAuthForm({ mode: view.mode, email, password, confirmPassword });
    if (localFailure) {
      setFormFailure(localFailure);
      return;
    }
    const registering = view.mode === "register";
    const pendingInvite = inviteToken.trim();
    // 开始下一次登录，上一次退出留下的结论就翻篇了：它描述的是刚离开的那个账号，
    // 继续挂在表单下面会把两件事混成一件。
    clearAccountSignOutNotice();
    setFormBusy(true);
    setFormFailure(null);
    try {
      const response = registering
        ? await api.auth.register({
            meta: createRequestMeta(),
            email,
            password,
            remember: keepSignedIn,
            ...(displayName.trim() ? { displayName: displayName.trim() } : {}),
            ...(pendingInvite ? { inviteToken: pendingInvite } : {}),
          })
        : await api.auth.login({ meta: createRequestMeta(), email, password, remember: keepSignedIn });
      unwrapGatewayResult(response);
      setPassword("");
      setConfirmPassword("");
      if (!registering && pendingInvite) {
        // The invite is redeemed only once the session exists. A failure here
        // must not strand the user: they stay signed in and the workspace phase
        // reports what happened to the code.
        try {
          unwrapGatewayResult(await api.auth.joinWorkspace({ meta: createRequestMeta(), inviteToken: pendingInvite }));
          setInviteToken("");
        } catch (error) {
          pendingWorkspaceNoticeRef.current = gateErrorPolicy(error, "登录成功，但邀请码没有生效").detail;
        }
      }
      beginRoomReveal();
      requestBootstrap();
    } catch (error) {
      const policy = gateErrorPolicy(error, registering ? "无法创建账号" : "无法登录");
      if (error instanceof RendererGatewayError && error.code === "configuration_error") {
        setFormFailure(policy.detail);
        setView({ phase: "auth", mode: view.mode, serviceNotice: policy.detail });
      } else if (error instanceof RendererGatewayError && ["api_unavailable", "network_timeout", "api_untrusted", "unsupported_contract"].includes(error.code)) {
        setView(blockedFromError(error, policy.title));
      } else {
        setFormFailure(policy.detail);
      }
    } finally {
      setFormBusy(false);
    }
  };

  const handleReauthenticate = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const api = desktopApi();
    if (!api || view.phase !== "reauth") return;
    if (!password) {
      setFormFailure("请输入当前密码。");
      return;
    }
    setFormBusy(true);
    setFormFailure(null);
    try {
      const response = await api.auth.reauthenticate({ meta: createRequestMeta(), password });
      unwrapGatewayResult(response);
      setPassword("");
      beginRoomReveal();
      requestBootstrap();
    } catch (error) {
      const policy = gateErrorPolicy(error, "无法重新验证身份");
      if (error instanceof RendererGatewayError && error.code === "configuration_error") {
        setFormFailure(policy.detail);
      } else if (error instanceof RendererGatewayError && ["api_unavailable", "network_timeout", "api_untrusted", "unsupported_contract"].includes(error.code)) {
        setView(blockedFromError(error, policy.title));
      } else {
        setFormFailure(policy.detail);
      }
    } finally {
      setFormBusy(false);
    }
  };

  if (view.phase === "ready") {
    return (
      <div className="desktop-access-gate__room-content" data-room-revealed={roomRevealed}>
        {view.spaceNotice ? <SpaceMenuRequest notice={view.spaceNotice} /> : null}
        {children}
      </div>
    );
  }

  if (view.phase === "loading") {
    return (
      <GateFrame title={view.title} detail={view.detail} motionMode={motionMode} backdropUrls={gateBackdropUrls} {...gateSceneProps}>
        <div className="desktop-access-gate__loading" role="status" aria-live="polite">
          <LoaderCircle size={24} aria-hidden="true" />
          <span>{view.stage ?? "正在与学习服务确认"}</span>
        </div>
      </GateFrame>
    );
  }

  if (view.phase === "blocked") {
    const retryAt = retryTimeLabel(view.retryAfter);
    return (
      <GateFrame title={view.title} detail={view.detail} tone="danger" motionMode={motionMode} backdropUrls={gateBackdropUrls} {...gateSceneProps}>
        <div className="desktop-access-gate__notice" role="alert">
          <span className="desktop-access-gate__notice-mark" aria-hidden="true">
            <ShieldAlert size={19} />
          </span>
          <p>{retryAt
            ? `请在 ${retryAt} 后再试。`
            : "为保护已有学习记录，应用尚未读取任何工作区内容。"}
          </p>
        </div>
        {view.retryAction ? (
          <button
            className="desktop-access-gate__primary"
            type="button"
            onClick={() => view.retryAction === "reload" ? window.location.reload() : requestBootstrap(view.retryAction === "connect")}
          >
            <RefreshCw size={17} aria-hidden="true" />
            {view.retryAction === "reload" ? "重新载入应用" : view.retryAction === "connect" ? "重新连接" : "再试一次"}
          </button>
        ) : null}
      </GateFrame>
    );
  }

  if (view.phase === "auth") {
    const registering = view.mode === "register";
    return (
      <GateFrame
        title={registering ? "创建账号" : "欢迎回来"}
        detail={registering ? "填写邮箱和密码即可；昵称和邀请码按需填写。" : "登录后继续上次的学习。"}
        variant={registering ? "register" : "default"}
        motionMode={motionMode}
        backdropUrls={registering ? registerBackdropUrls : gateBackdropUrls}
        {...gateSceneProps}
      >
        <form
          className={`desktop-access-gate__form${registering ? " desktop-access-gate__form--register" : ""}`}
          aria-busy={formBusy}
          noValidate
          onSubmit={handleAuthSubmit}
        >
          <div className={`desktop-access-gate__fields${registering ? " desktop-access-gate__fields--register" : ""}`}>
          <label className={registering ? "desktop-access-gate__field--wide" : undefined}>
            <span className="desktop-access-gate__field-label">邮箱</span>
            <span className="desktop-access-gate__field-control">
              <Mail size={18} aria-hidden="true" />
              <input type="email" autoComplete="email" maxLength={320} required value={email} placeholder="name@example.com" onChange={(event) => { setEmail(event.target.value); setFormFailure(null); }} />
            </span>
          </label>
          <label>
            <span className="desktop-access-gate__field-label">
              密码 {registering ? <small>至少 {MIN_PASSWORD_LENGTH} 位</small> : null}
            </span>
            <span className="desktop-access-gate__field-control desktop-access-gate__field-control--with-action">
              <LockKeyhole size={18} aria-hidden="true" />
              <input
                type={passwordVisible ? "text" : "password"}
                autoComplete={registering ? "new-password" : "current-password"}
                maxLength={200}
                required
                value={password}
                placeholder={registering ? `至少 ${MIN_PASSWORD_LENGTH} 位` : "输入密码"}
                onChange={(event) => { setPassword(event.target.value); setFormFailure(null); }}
              />
              <button
                className="desktop-access-gate__reveal"
                type="button"
                aria-label={passwordVisible ? "隐藏密码" : "显示密码"}
                aria-pressed={passwordVisible}
                onClick={() => setPasswordVisible((visible) => !visible)}
              >
                {passwordVisible ? <EyeOff size={16} aria-hidden="true" /> : <Eye size={16} aria-hidden="true" />}
              </button>
            </span>
          </label>
          {registering ? (
            <label>
              <span className="desktop-access-gate__field-label">确认密码</span>
              <span className="desktop-access-gate__field-control">
                <LockKeyhole size={18} aria-hidden="true" />
                <input
                  type={passwordVisible ? "text" : "password"}
                  autoComplete="new-password"
                  maxLength={200}
                  required
                  value={confirmPassword}
                  placeholder="再输入一次"
                  onChange={(event) => { setConfirmPassword(event.target.value); setFormFailure(null); }}
                />
              </span>
            </label>
          ) : null}
          {registering ? (
            <label>
              <span className="desktop-access-gate__field-label">昵称 <small>选填</small></span>
              <span className="desktop-access-gate__field-control">
                <UserRound size={18} aria-hidden="true" />
                <input autoComplete="name" maxLength={200} value={displayName} placeholder="怎么称呼你" onChange={(event) => setDisplayName(event.target.value)} />
              </span>
            </label>
          ) : null}
          {registering || inviteEntryOpen ? (
            <label>
              <span className="desktop-access-gate__field-label">
                邀请码 <small>{registering ? "选填 · 加入协作空间" : "选填 · 登录后自动加入"}</small>
              </span>
              <span className="desktop-access-gate__field-control">
                <Ticket size={18} aria-hidden="true" />
                <input
                  type="text"
                  autoComplete="off"
                  spellCheck={false}
                  maxLength={200}
                  value={inviteToken}
                  placeholder="粘贴邀请码"
                  onChange={(event) => { setInviteToken(event.target.value); setFormFailure(null); }}
                />
              </span>
            </label>
          ) : null}
          </div>
          {(formFailure ?? view.serviceNotice) ? <p className="desktop-access-gate__form-error" role="alert">{formFailure ?? view.serviceNotice}</p> : null}
          {credentialPersistence === "safe_storage" ? (
            <label className="desktop-access-gate__keep-signed-in">
              <input
                type="checkbox"
                checked={keepSignedIn}
                disabled={formBusy}
                onChange={(event) => setKeepSignedIn(event.target.checked)}
              />
              <span>保持登录，下次打开不用重新输入</span>
            </label>
          ) : null}
          <p className="desktop-access-gate__trust-note">
            <ShieldCheck size={16} aria-hidden="true" />
            <span>
              {authSurfaceHelp ?? (credentialPersistence === "safe_storage"
                ? "登录凭据由系统钥匙串加密保存，密码本身不会写入磁盘。"
                : "密码会安全提交；这台设备无法加密保存登录状态，关闭应用后需要重新登录。")}
            </span>
          </p>
          <button className="desktop-access-gate__primary" type="submit" disabled={formBusy}>
            {formBusy
              ? <LoaderCircle className="desktop-access-gate__button-spinner" size={17} aria-hidden="true" />
              : registering ? <UserPlus size={17} aria-hidden="true" /> : <LogIn size={17} aria-hidden="true" />}
            {formBusy ? registering ? "正在创建账号…" : "正在登录…" : registering ? "创建账号" : "登录"}
            {/* 登录态不排尾箭头：`→]` 与 `→` 都在说"进入"，而文字已经写了"登录"。
                尾箭头留着的是注册态——那里前面的图标是 `UserPlus`（讲"新建账号"，不是方向）。 */}
            {!formBusy && registering ? <ArrowRight className="desktop-access-gate__primary-arrow" size={16} aria-hidden="true" /> : null}
          </button>
          {!registering ? (
            <button
              className="desktop-access-gate__text-action desktop-access-gate__text-action--quiet"
              type="button"
              disabled={formBusy}
              aria-expanded={inviteEntryOpen}
              onClick={() => {
                setFormFailure(null);
                setInviteEntryOpen((open) => {
                  if (open) setInviteToken("");
                  return !open;
                });
              }}
            >
              <Ticket size={15} aria-hidden="true" />
              {inviteEntryOpen ? "取消填写邀请码" : "有邀请码？加入协作空间"}
            </button>
          ) : null}
          <button
            className="desktop-access-gate__text-action desktop-access-gate__text-action--mode"
            type="button"
            disabled={formBusy}
            onClick={() => {
              setFormFailure(null);
              setPassword("");
              setConfirmPassword("");
              setInviteToken("");
              setInviteEntryOpen(false);
              setView({ phase: "auth", mode: registering ? "login" : "register" });
            }}
          >
            {registering ? <ArrowLeft size={15} aria-hidden="true" /> : null}
            {registering ? "已有账号？登录" : "还没有账号？注册"}
          </button>
        </form>
      </GateFrame>
    );
  }

  if (view.phase === "reauth") {
    const accountLabel = view.session?.user?.displayName ?? view.session?.user?.email ?? "当前账号";
    return (
      <GateFrame title="请再次输入密码" detail={`为了保护 ${accountLabel} 的账号，请确认当前密码。`} motionMode={motionMode} backdropUrls={gateBackdropUrls} {...gateSceneProps}>
        <form className="desktop-access-gate__form" aria-busy={formBusy} onSubmit={handleReauthenticate}>
          <label>
            <span className="desktop-access-gate__field-label">当前密码</span>
            <span className="desktop-access-gate__field-control">
              <LockKeyhole size={18} aria-hidden="true" />
              <input type="password" autoComplete="current-password" maxLength={200} required value={password} placeholder="输入当前密码" onChange={(event) => setPassword(event.target.value)} />
            </span>
          </label>
          {formFailure ? <p className="desktop-access-gate__form-error" role="alert">{formFailure}</p> : null}
          <p className="desktop-access-gate__trust-note">
            <ShieldCheck size={16} aria-hidden="true" />
            <span>确认通过后，会继续打开你的学习空间。</span>
          </p>
          <button className="desktop-access-gate__primary" type="submit" data-busy={formBusy} disabled={formBusy}>
            {formBusy
              ? <LoaderCircle className="desktop-access-gate__button-spinner" size={17} aria-hidden="true" />
              : <KeyRound size={17} aria-hidden="true" />}
            {formBusy ? "正在确认…" : "确认并继续"}
          </button>
        </form>
      </GateFrame>
    );
  }

  // `workspace_required` is the one-time choice every other phase leaves alone:
  // the account is signed in but no space is bound, so the client still reads
  // nothing about any of them. The mockup folds that choice into the home page
  // (04A), which is what `HudFirstSpaceScene` restores.
  return (
    <HudFirstSpaceScene
      session={view.session}
      workspaces={view.workspaces}
      notice={view.notice}
      onCommitted={() => {
        beginRoomReveal();
        requestBootstrap();
      }}
    />
  );
}
