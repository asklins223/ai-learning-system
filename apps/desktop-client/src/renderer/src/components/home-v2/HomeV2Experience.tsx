import { CircleAlert, Volume2, VolumeX, X } from "lucide-react";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  COMPANION_DECOR_ALLOWED_SLOTS,
  COMPANION_EFFECT_IDS,
  type CompanionDecorIdV1,
  type CompanionEffectIdV1,
  type CompanionEquippedDecorBySlotV1,
  type CompanionRoomSlotV1,
} from "@ailearn/shared/companion-home-contracts";
import type { CompanionOnboardingStateV1 } from "@ailearn/shared/companion-shell-contracts";
import { createRequestMeta, unwrapGatewayResult } from "../../app/desktop-client";
import { useCompanionHomeProjection } from "../../app/companion-home-projection";
import { useHomeProjection } from "../../app/home-projection";
import { homePresentation } from "../../app/home-presentation";
import { useRoomStore } from "../../app/room-store";
import { resolveSceneMotionMode } from "../../scene/scene-motion";
import { HOME_V2_CAMERA_PRESETS, type HomeV2Zone } from "./home-v2";
import {
  HOME_FEATURE_GROUPS,
  getHomeFeature,
  homeFeaturesForGroup,
  isHomeFeatureId,
  type HomeFeatureDefinitionV1,
  type HomeFeatureId,
} from "./home-feature-registry";
import { HOME_FEATURE_ICONS } from "./home-feature-icons";
import "./home-v2.css";
import { HomeV2AudioController } from "./HomeV2AudioController";
import {
  homeSceneTimeForThemeMode,
  type HomeSceneTimeV1,
} from "./home-scene-profile";

gsap.registerPlugin(useGSAP);

export type HomeFeatureRuntimeV1 = Readonly<{
  definition: HomeFeatureDefinitionV1;
  title: string;
  detail: string;
  state: "ready" | "pending" | "loading" | "error";
  meta: string;
}>;

type HomeV2ContextValue = {
  readonly zone: HomeV2Zone;
  readonly sceneTime: HomeSceneTimeV1;
  readonly introVisible: boolean;
  readonly modalOpen: boolean;
  readonly focusRegion: (zone: Exclude<HomeV2Zone, "wide">) => void;
  readonly exitRegion: () => void;
  readonly setZone: (zone: HomeV2Zone) => void;
  readonly openCatalog: () => void;
  readonly replayIntro: () => void;
  readonly runFeature: (featureId: HomeFeatureId) => void;
  readonly featurePresentation: (featureId: HomeFeatureId) => HomeFeatureRuntimeV1;
};

const HOME_V2_INTRO_KEY = "ailearn.home-v2.intro-seen.v1";
const HOME_V2_ONBOARDING_VERSION = "home-v2-v1";
const HOME_V2_REGION_TRIGGER_IDS: Readonly<Record<Exclude<HomeV2Zone, "wide">, string>> = Object.freeze({
  desk: "home-v2-object-desk-book",
  shelf: "home-v2-object-magic-catalog",
  window: "home-v2-object-window-stars",
  rest: "home-v2-object-rest-cushion",
});
const HOME_PROJECTION_FEATURE_IDS = new Set<HomeFeatureId>([
  "continue",
  "today-review",
  "current-notebook",
  "current-target",
]);

const DEFAULT_CONTEXT: HomeV2ContextValue = {
  zone: "wide",
  sceneTime: "day",
  introVisible: false,
  modalOpen: false,
  focusRegion: () => {},
  exitRegion: () => {},
  setZone: () => {},
  openCatalog: () => {},
  replayIntro: () => {},
  runFeature: () => {},
  featurePresentation: (featureId) => {
    const definition = getHomeFeature(featureId);
    return {
      definition,
      title: definition.title,
      detail: definition.purpose,
      state: definition.availability === "native" ? "ready" : "pending",
      meta: definition.availability === "native" ? "小屋可用" : "新版页面尚未接入",
    };
  },
};

const HomeV2Context = createContext<HomeV2ContextValue>(DEFAULT_CONTEXT);

export const useHomeV2 = () => useContext(HomeV2Context);

export function HomeV2Provider({ children }: { readonly children: ReactNode }) {
  const [zone, setZoneState] = useState<HomeV2Zone>("wide");
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [catalogNotice, setCatalogNotice] = useState<string | null>(null);
  const [selectedFeatureId, setSelectedFeatureId] = useState<HomeFeatureId | null>(null);
  const [introVisible, setIntroVisible] = useState(false);
  const [introReplayPending, setIntroReplayPending] = useState(false);
  const [sceneTime, setSceneTime] = useState<HomeSceneTimeV1>(() => homeSceneTimeForThemeMode({
    themeMode: useRoomStore.getState().themeMode,
    theme: useRoomStore.getState().theme,
    now: new Date(),
  }));
  const zoneRef = useRef<HomeV2Zone>("wide");
  const regionTriggerIdRef = useRef<string | null>(null);
  const catalogReturnZoneRef = useRef<HomeV2Zone>("wide");
  const catalogTriggerRef = useRef<HTMLElement | null>(null);
  const featureTriggerRef = useRef<HTMLElement | null>(null);
  const onboardingStateRef = useRef<CompanionOnboardingStateV1 | null>(null);
  const onboardingEpochRef = useRef<number | undefined>(undefined);
  const surface = useRoomStore((state) => state.surface);
  const applyTimeTheme = useRoomStore((state) => state.applyTimeTheme);
  const theme = useRoomStore((state) => state.theme);
  const themeMode = useRoomStore((state) => state.themeMode);
  const invoke = useRoomStore((state) => state.invoke);
  const onboardingOpen = useRoomStore((state) => state.onboardingOpen);
  const finishOnboarding = useRoomStore((state) => state.finishOnboarding);
  const setActiveNoteRef = useRoomStore((state) => state.setActiveNoteRef);
  const setActiveSourceId = useRoomStore((state) => state.setActiveSourceId);
  const setActiveObjectiveId = useRoomStore((state) => state.setActiveObjectiveId);
  const setActiveRunId = useRoomStore((state) => state.setActiveRunId);
  const { projection, loading, failure } = useHomeProjection();
  const companionHome = useCompanionHomeProjection();
  const home = homePresentation(projection, loading, failure);
  const modalOpen = catalogOpen || selectedFeatureId !== null;

  const setZone = useCallback((nextZone: HomeV2Zone) => {
    zoneRef.current = nextZone;
    const app = document.querySelector<HTMLElement>(".desktop-app");
    if (app) app.dataset.homeV2Zone = nextZone;
    setZoneState(nextZone);
  }, []);

  const focusRegion = useCallback((nextZone: Exclude<HomeV2Zone, "wide">) => {
    if (zoneRef.current === nextZone) return;
    regionTriggerIdRef.current = document.activeElement instanceof HTMLElement && document.activeElement.id
      ? document.activeElement.id
      : HOME_V2_REGION_TRIGGER_IDS[nextZone];
    setZone(nextZone);
    window.dispatchEvent(new CustomEvent("ailearn:home-v2-sound", { detail: { kind: "footstep" } }));
  }, [setZone]);

  const exitRegion = useCallback(() => {
    const triggerId = regionTriggerIdRef.current;
    regionTriggerIdRef.current = null;
    setZone("wide");
    if (!triggerId) return;
    window.requestAnimationFrame(() => document.getElementById(triggerId)?.focus({ preventScroll: true }));
  }, [setZone]);

  useEffect(() => {
    const syncWithLocalTime = () => {
      const next = homeSceneTimeForThemeMode({
        themeMode,
        theme: useRoomStore.getState().theme,
        now: new Date(),
      });
      setSceneTime(next);
      if (themeMode === "system") applyTimeTheme(next === "night" ? "night" : "day");
    };
    syncWithLocalTime();
    if (themeMode !== "system") return undefined;
    const timer = window.setInterval(syncWithLocalTime, 60_000);
    return () => window.clearInterval(timer);
  }, [applyTimeTheme, theme, themeMode]);

  useEffect(() => {
    const app = document.querySelector<HTMLElement>(".desktop-app");
    if (!app) return undefined;
    if (modalOpen) app.dataset.homeV2Modal = "true";
    else delete app.dataset.homeV2Modal;
    return () => { delete app.dataset.homeV2Modal; };
  }, [modalOpen]);

  const openCatalog = useCallback(() => {
    window.dispatchEvent(new CustomEvent("ailearn:home-v2-sound", { detail: { kind: "page" } }));
    setCatalogNotice(null);
    if (!catalogOpen) {
      catalogReturnZoneRef.current = zoneRef.current;
      catalogTriggerRef.current = document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    }
    setCatalogOpen(true);
    setZone("shelf");
  }, [catalogOpen, setZone]);

  const closeCatalog = useCallback((restoreFocus = true) => {
    window.dispatchEvent(new CustomEvent("ailearn:home-v2-sound", { detail: { kind: "page" } }));
    setCatalogOpen(false);
    setCatalogNotice(null);
    setZone(catalogReturnZoneRef.current);
    const trigger = catalogTriggerRef.current;
    catalogTriggerRef.current = null;
    if (!restoreFocus || surface || !trigger?.isConnected) return;
    window.requestAnimationFrame(() => trigger.focus({ preventScroll: true }));
  }, [setZone, surface]);

  const markIntroSeen = useCallback(() => {
    setIntroVisible(false);
    const app = document.querySelector<HTMLElement>(".desktop-app");
    if (app) delete app.dataset.homeV2Intro;
    try {
      window.localStorage.setItem(HOME_V2_INTRO_KEY, "seen");
    } catch {
      // First-entry guidance remains a progressive enhancement.
    }
    const state = onboardingStateRef.current;
    if (!state?.activeRun || !window.ailearn) return;
    void window.ailearn.companion.account.transitionOnboarding({
      meta: createRequestMeta(onboardingEpochRef.current),
      version: HOME_V2_ONBOARDING_VERSION,
      request: {
        action: "complete",
        revision: state.revision,
        runId: state.activeRun.runId,
      },
    }).then((result) => {
      onboardingStateRef.current = unwrapGatewayResult(result).state;
    }).catch(() => {
      // The intro is never allowed to trap the room. Account SSE will reconcile
      // a successful transition from another device, and replay remains explicit.
    });
  }, []);

  const replayIntro = useCallback(() => {
    setCatalogOpen(false);
    setSelectedFeatureId(null);
    setZone("wide");
    setIntroVisible(false);
    setIntroReplayPending(true);
    if (surface) invoke("home");
  }, [invoke, setZone, surface]);

  // The legacy onboarding flag has no V2 presentation. Clear it defensively so
  // stale state from an older build cannot hide the V2 HUD layers.
  useEffect(() => {
    if (onboardingOpen) finishOnboarding();
  }, [finishOnboarding, onboardingOpen]);

  useEffect(() => {
    if (surface) return;
    const replay = introReplayPending;
    if (replay) {
      // Consume the request so returning from a normal task surface does not
      // replay the guide again.
      setIntroReplayPending(false);
    }
    let cancelled = false;
    let introTimeline: gsap.core.Timeline | null = null;
    const prepare = async (): Promise<boolean> => {
      try {
        const session = unwrapGatewayResult(await window.ailearn.auth.getState({ meta: createRequestMeta() }));
        if (session.status !== "authenticated" || !session.workspace) return false;
        onboardingEpochRef.current = session.workspace.workspaceEpoch;
        const overview = unwrapGatewayResult(await window.ailearn.companion.account.getState({
          meta: createRequestMeta(session.workspace.workspaceEpoch),
        }));
        const current = overview.onboardingStates.find((item) => item.onboardingVersion === HOME_V2_ONBOARDING_VERSION) ?? null;
        onboardingStateRef.current = current;
        if (!replay && current?.offerStatus === "consumed") return false;
        if (!replay && current?.offerStatus === "offered") return false;
        const response = unwrapGatewayResult(await window.ailearn.companion.account.transitionOnboarding({
          meta: createRequestMeta(session.workspace.workspaceEpoch),
          version: HOME_V2_ONBOARDING_VERSION,
          request: {
            action: replay && current ? "replay" : "start",
            revision: current?.revision,
          },
        }));
        onboardingStateRef.current = response.state;
        return response.won !== false;
      } catch {
        if (replay) return true;
        try { return window.localStorage.getItem(HOME_V2_INTRO_KEY) !== "seen"; }
        catch { return true; }
      }
    };
    void prepare().then((shouldShow) => {
      if (cancelled || !shouldShow) return;
      introTimeline = gsap.timeline();
      introTimeline.call(() => {
        const app = document.querySelector<HTMLElement>(".desktop-app");
        if (app) app.dataset.homeV2Intro = "true";
        setIntroVisible(true);
      }, undefined, replay ? 0 : 1.1);
      introTimeline.call(markIntroSeen, undefined, replay ? 5.1 : 6.2);
    });
    return () => {
      cancelled = true;
      introTimeline?.kill();
    };
  }, [introReplayPending, markIntroSeen, surface]);

  const featurePresentation = useCallback((featureId: HomeFeatureId): HomeFeatureRuntimeV1 => {
    const definition = getHomeFeature(featureId);
    let detail = definition.purpose;
    let meta = definition.availability === "native" ? "小屋可用" : "新版页面尚未接入";
    let state: HomeFeatureRuntimeV1["state"] = definition.availability === "native" ? "ready" : "pending";

    switch (featureId) {
      case "continue":
        detail = home.title;
        meta = home.activeRunCount === null
          ? "状态 —"
          : home.activeRunCount > 0
            ? `${home.activeRunCount} 项可恢复`
            : home.primaryLabel;
        break;
      case "today-review":
        detail = home.reviewLabel;
        // 同一条（审计 F25）：读不到时不要用"数量 —"冒充加载态——它在同步和读失败之间
        // 长得一样。两种状态各说各的。
        meta = home.dueCount !== null
          ? `${home.dueCount} 项待复习`
          : home.reviewState === "syncing" ? "正在读取…" : "暂时读不到";
        break;
      case "current-notebook":
        detail = home.note?.title ?? "还没有存好的研究册";
        // 审计 F25：投影不含全量总数（`noteCount` 恒为 null），此前卡片附注写"数量 —"，
        // 读起来像"还没加载完"。这一格要说的是"点进去能做什么"，不是全库有多少。
        meta = home.note ? "继续阅读" : "从一份材料开始";
        break;
      case "current-target":
        detail = home.hasFocus ? "今天的主目标已经定下" : "还没定下今天的主目标";
        meta = home.hasFocus ? "查看这个目标" : "去学习卡里定一张";
        break;
      case "companion-center":
        detail = companionHome.projection?.profileSummary.name
          ? `打开 ${companionHome.projection.profileSummary.name} 的对话、日记、人格与记忆`
          : definition.purpose;
        meta = "小屋可用";
        break;
      default:
        break;
    }

    if (HOME_PROJECTION_FEATURE_IDS.has(featureId) && home.blockingLoading) {
      state = "loading";
      meta = "同步中";
    } else if (HOME_PROJECTION_FEATURE_IDS.has(featureId) && failure) {
      state = "error";
      meta = "状态待恢复";
    }

    return { definition, title: definition.title, detail, state, meta };
  }, [companionHome.projection, failure, home]);

  const openFeatureNotice = useCallback((featureId: HomeFeatureId) => {
    featureTriggerRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    setSelectedFeatureId(featureId);
    window.dispatchEvent(new CustomEvent("ailearn:home-v2-sound", { detail: { kind: "page" } }));
  }, []);

  const closeFeatureNotice = useCallback((restoreFocus = true) => {
    setSelectedFeatureId(null);
    const trigger = featureTriggerRef.current;
    featureTriggerRef.current = null;
    if (restoreFocus && trigger?.isConnected) {
      window.requestAnimationFrame(() => trigger.focus({ preventScroll: true }));
    }
  }, []);

  const runFeature = useCallback((featureId: HomeFeatureId) => {
    if (introVisible) markIntroSeen();
    const feature = getHomeFeature(featureId);
    if (feature.id === "catalog") {
      openCatalog();
      return;
    }
    if (feature.id === "companion-center") {
      invoke("open-companion-center");
      return;
    }
    if (feature.id === "today-review") {
      invoke("review");
      return;
    }
    if (feature.id === "continue") {
      // 审计 F24：这张卡的附注写着「N 项可恢复」，那点击就必须到那 N 项上——
      // 恰好一条时直达那条 run；两条以上时进「未完成的学习」清单；读不到时
      // 才退回原来的今日学习（那是历史日志，不是待办清单）。
      if (home.soleActiveRun) {
        setActiveRunId(home.soleActiveRun.runId);
        invoke("validate");
        return;
      }
      if ((home.activeRunCount ?? 0) > 1) {
        invoke("open-resumable");
        return;
      }
      invoke("continue");
      return;
    }
    if (feature.id === "current-notebook") {
      if (home.note) setActiveNoteRef({ noteId: home.note.noteId, noteVersionId: home.note.noteVersionId });
      invoke("open-notebook");
      return;
    }
    if (feature.id === "all-notes") {
      invoke("open-notes");
      return;
    }
    if (feature.id === "sources") {
      setActiveSourceId(null);
      invoke("open-sources");
      return;
    }
    if (feature.id === "global-search") {
      invoke("search");
      return;
    }
    if (feature.id === "current-target") {
      const objectiveId = projection?.primaryFocus.state === "data" ? projection.primaryFocus.data.objective.objectiveId : null;
      if (objectiveId) {
        setActiveObjectiveId(objectiveId);
        invoke("open-objective");
      } else {
        invoke("open-objectives");
      }
      return;
    }
    if (feature.id === "understanding-graph") {
      invoke("graph");
      return;
    }
    if (feature.id === "settings") {
      invoke("open-settings");
      return;
    }
    openFeatureNotice(feature.id);
  }, [home.note, home.soleActiveRun, introVisible, invoke, markIntroSeen, openCatalog, openFeatureNotice, projection, setActiveNoteRef, setActiveObjectiveId, setActiveRunId, setActiveSourceId]);

  const showAllFeatures = useCallback(() => {
    const alreadyOpen = catalogOpen;
    closeFeatureNotice(false);
    if (!alreadyOpen) openCatalog();
  }, [catalogOpen, closeFeatureNotice, openCatalog]);

  useEffect(() => {
    if (!surface) return;
    setCatalogOpen(false);
    setSelectedFeatureId(null);
    catalogTriggerRef.current = null;
    featureTriggerRef.current = null;
    // 离开书房去页面时，已聚焦的区域也要一起退：目录与功能说明都在这里收，
    // 唯独漏了区域，于是回到书房还挂着一条区域功能签条——既像残留，又压住
    // 左下角承载「今日下一步」的任务岛。
    exitRegion();
    markIntroSeen();
  }, [exitRegion, markIntroSeen, surface]);

  useEffect(() => {
    const runRequestedFeature = (event: Event) => {
      const featureId = (event as CustomEvent<{ featureId?: unknown }>).detail?.featureId;
      if (isHomeFeatureId(featureId)) runFeature(featureId);
    };
    const showUnavailable = (event: Event) => {
      const featureId = (event as CustomEvent<{ featureId?: unknown }>).detail?.featureId;
      if (isHomeFeatureId(featureId)) openFeatureNotice(featureId);
    };
    const focusZone = (event: Event) => {
      const requested = (event as CustomEvent<{ zone?: HomeV2Zone }>).detail?.zone;
      if (requested && requested in HOME_V2_CAMERA_PRESETS) setZone(requested);
    };
    window.addEventListener("ailearn:home-v2-run-feature", runRequestedFeature);
    window.addEventListener("ailearn:home-unavailable", showUnavailable);
    window.addEventListener("ailearn:home-v2-focus-zone", focusZone);
    return () => {
      window.removeEventListener("ailearn:home-v2-run-feature", runRequestedFeature);
      window.removeEventListener("ailearn:home-unavailable", showUnavailable);
      window.removeEventListener("ailearn:home-v2-focus-zone", focusZone);
    };
  }, [openFeatureNotice, runFeature, setZone]);

  useEffect(() => {
    const leaveFocusedRegion = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || catalogOpen || selectedFeatureId || zoneRef.current === "wide") return;
      event.preventDefault();
      exitRegion();
    };
    window.addEventListener("keydown", leaveFocusedRegion);
    return () => window.removeEventListener("keydown", leaveFocusedRegion);
  }, [catalogOpen, exitRegion, selectedFeatureId]);

  useEffect(() => {
    setZone(zoneRef.current);
  }, [setZone]);

  const value = useMemo(() => ({
    zone,
    sceneTime,
    introVisible,
    modalOpen,
    focusRegion,
    exitRegion,
    setZone,
    openCatalog,
    replayIntro,
    runFeature,
    featurePresentation,
  }), [exitRegion, featurePresentation, focusRegion, introVisible, modalOpen, openCatalog, replayIntro, runFeature, sceneTime, setZone, zone]);

  return (
    <HomeV2Context.Provider value={value}>
      {children}
      <HomeV2AudioController />
      <HomeV2Catalog open={catalogOpen} notice={catalogNotice} onNotice={setCatalogNotice} onClose={closeCatalog} />
      <HomeFeatureNoticeDialog featureId={selectedFeatureId} onClose={closeFeatureNotice} onShowAll={showAllFeatures} />
    </HomeV2Context.Provider>
  );
}

const HOME_V2_DECOR_COPY: Readonly<Record<CompanionDecorIdV1, { readonly title: string; readonly detail: string }>> = Object.freeze({
  "keepsake.first-note": { title: "第一张研究札记", detail: "来自第一篇存好的笔记" },
  "keepsake.first-goal": { title: "第一枚目标罗盘", detail: "来自第一张正式学习卡" },
  "keepsake.first-review": { title: "第一本复习历", detail: "来自第一次完成复习" },
  "keepsake.first-memory": { title: "第一幅记忆标本", detail: "来自第一条确认的伴星记忆" },
});

const HOME_V2_EFFECT_COPY: Readonly<Record<CompanionEffectIdV1, string>> = Object.freeze({
  "effect.page-ribbon": "书页绸带",
  "effect.ink-ripple": "墨色涟漪",
});

const HOME_V2_SLOT_COPY: Readonly<Record<CompanionRoomSlotV1, string>> = Object.freeze({ desk: "书桌", shelf: "书架", window: "窗边", rest: "休息角" });

function FeatureRow({ feature, onRun }: { readonly feature: HomeFeatureRuntimeV1; readonly onRun: (featureId: HomeFeatureId) => void }) {
  const Icon = HOME_FEATURE_ICONS[feature.definition.icon];
  return (
    <button type="button" className="home-v2-feature-row" data-feature={feature.definition.id} data-feature-state={feature.state} disabled={feature.state === "loading"} onClick={() => onRun(feature.definition.id)}>
      <Icon size={18} strokeWidth={1.7} aria-hidden="true" />
      <span><strong>{feature.title}</strong><small>{feature.detail}</small></span>
      <em>{feature.meta}</em>
    </button>
  );
}

function HomeFeatureNoticeDialog({ featureId, onClose, onShowAll }: { readonly featureId: HomeFeatureId | null; readonly onClose: (restoreFocus?: boolean) => void; readonly onShowAll: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const { featurePresentation } = useHomeV2();
  const feature = featureId ? featurePresentation(featureId) : null;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (feature && !dialog.open) {
      dialog.showModal();
      window.requestAnimationFrame(() => closeRef.current?.focus({ preventScroll: true }));
    } else if (!feature && dialog.open) dialog.close();
  }, [feature]);

  return (
    <dialog ref={dialogRef} className="home-v2-feature-notice" aria-labelledby="home-v2-feature-notice-title" aria-describedby="home-v2-feature-notice-detail" onCancel={(event) => { event.preventDefault(); onClose(); }} onClose={() => { if (featureId) onClose(); }}>
      {feature ? (
        <div className="home-v2-feature-notice__sheet">
          <span className="home-v2-feature-notice__status"><CircleAlert size={15} aria-hidden="true" />新版页面尚未接入</span>
          <h2 id="home-v2-feature-notice-title">{feature.title}</h2>
          <p id="home-v2-feature-notice-detail">{feature.definition.pendingDetail ?? feature.detail}</p>
          <div className="home-v2-feature-notice__actions">
            <button ref={closeRef} type="button" className="home-v2-feature-notice__primary" onClick={() => onClose()}>知道了</button>
            <button type="button" onClick={onShowAll}>查看全部功能</button>
          </div>
        </div>
      ) : null}
    </dialog>
  );
}

function HomeV2Catalog({ open, notice, onNotice, onClose }: { readonly open: boolean; readonly notice: string | null; readonly onNotice: (notice: string | null) => void; readonly onClose: (restoreFocus?: boolean) => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const { projection, loading, failure } = useHomeProjection();
  const companionHome = useCompanionHomeProjection();
  const home = homePresentation(projection, loading, failure);
  const { runFeature, featurePresentation } = useHomeV2();
  const masterMuted = useRoomStore((state) => state.masterMuted);
  const toggleMasterMuted = useRoomStore((state) => state.toggleMasterMuted);
  const motionPreference = useRoomStore((state) => state.motionMode);
  const reducedMotion = useRoomStore((state) => state.reducedMotion);
  const motionMode = resolveSceneMotionMode(motionPreference, reducedMotion);
  const roomProfile = companionHome.projection?.roomProfile ?? null;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      window.requestAnimationFrame(() => closeRef.current?.focus({ preventScroll: true }));
    } else if (!open && dialog.open) dialog.close();
  }, [open]);

  useGSAP(() => {
    const dialog = dialogRef.current;
    if (!open || !dialog) return;
    if (motionMode === "off") {
      gsap.set(dialog, { clearProps: "opacity,transform,filter" });
      return;
    }
    gsap.fromTo(dialog, { autoAlpha: 0, y: 18, filter: "blur(5px)" }, { autoAlpha: 1, y: 0, filter: "blur(0px)", duration: motionMode === "lite" ? 0.18 : 0.28, ease: "power3.out" });
  }, { scope: dialogRef, dependencies: [motionMode, open], revertOnUpdate: true });

  const runCatalogFeature = (featureId: HomeFeatureId) => {
    runFeature(featureId);
    // companion-center 会打开 surface，surface 变化的 effect 会替目录收起，
    // 这里不再需要按条目特判关闭。
  };

  const toggleDecor = async (decorId: CompanionDecorIdV1) => {
    if (!roomProfile || companionHome.profileSaving) return;
    const equipment = roomProfile.equippedDecorBySlot;
    const slots = Object.keys(equipment) as CompanionRoomSlotV1[];
    const currentSlot = slots.find((slot) => equipment[slot] === decorId);
    const equippedDecorBySlot: Partial<CompanionEquippedDecorBySlotV1> = {};
    if (currentSlot) equippedDecorBySlot[currentSlot] = null;
    else {
      const allowed = COMPANION_DECOR_ALLOWED_SLOTS[decorId];
      const targetSlot = allowed.find((slot) => equipment[slot] === null) ?? allowed[0];
      equippedDecorBySlot[targetSlot] = decorId;
    }
    const result = await companionHome.patchRoomProfile({ equippedDecorBySlot });
    if (!result.ok) onNotice(result.message);
    else window.dispatchEvent(new CustomEvent("ailearn:home-v2-sound", { detail: { kind: "page" } }));
  };

  const toggleEffect = async (effectId: CompanionEffectIdV1) => {
    if (!roomProfile || companionHome.profileSaving) return;
    const result = await companionHome.patchRoomProfile({ equippedEffectId: roomProfile.equippedEffectId === effectId ? null : effectId });
    if (!result.ok) onNotice(result.message);
    else window.dispatchEvent(new CustomEvent("ailearn:home-v2-sound", { detail: { kind: "magic" } }));
  };

  /**
   * 这个空间要不要让伴星主动开口（0266）。
   *
   * 审查 4.4：主动触达按 (ws,user) 各自产生，而开关只有账号级——一个人在两三个
   * 空间里就会同时收到几份"她想跟你说话"，只能把整个伴星关掉来止血，而那会把
   * "她记得我"一起关掉。这里给的是**按房间**的开关，与装饰共用同一把 revision 锁。
   */
  const toggleProactiveMuted = async () => {
    if (!roomProfile || companionHome.profileSaving) return;
    const result = await companionHome.patchRoomProfile({ proactiveMuted: !roomProfile.proactiveMuted });
    if (!result.ok) onNotice(result.message);
  };

  return (
    <dialog ref={dialogRef} className="home-v2-catalog" aria-labelledby="home-v2-catalog-title" onCancel={(event) => { event.preventDefault(); onClose(); }} onClose={() => { if (open) onClose(); }}>
      <header className="home-v2-catalog__header">
        <div>
          <h2 id="home-v2-catalog-title">魔法目录</h2>
          <p>{home.snapshotAt ? "学习空间状态已同步" : "等待学习空间同步"}{home.degraded ? " · 部分信息待恢复" : ""}</p>
        </div>
        <dl aria-label="真实学习概览">
          <div><dt>研究册</dt><dd>{home.noteCount ?? "—"}</dd></div>
          <div><dt>目标</dt><dd>{home.objectiveCount ?? "—"}</dd></div>
          <div><dt>待复习</dt><dd>{home.dueCount ?? "—"}</dd></div>
          <div><dt>进行中</dt><dd>{home.activeRunCount ?? "—"}</dd></div>
        </dl>
        <button type="button" onClick={toggleMasterMuted} aria-label={masterMuted ? "取消总静音" : "开启总静音"} title={masterMuted ? "取消总静音" : "总静音"}>
          {masterMuted ? <VolumeX size={18} aria-hidden="true" /> : <Volume2 size={18} aria-hidden="true" />}
        </button>
        <button ref={closeRef} type="button" onClick={() => onClose()} aria-label="关闭魔法目录"><X size={20} aria-hidden="true" /></button>
      </header>
      <div className="home-v2-catalog__scroll">
        {notice ? (
          <aside className="home-v2-catalog__notice" role="status" aria-live="polite">
            <CircleAlert size={19} aria-hidden="true" />
            <span><strong>小屋收藏没有保存</strong><small>{notice}</small></span>
            <button type="button" onClick={() => onNotice(null)} aria-label="收起保存提示"><X size={16} aria-hidden="true" /></button>
          </aside>
        ) : null}
        <div className="home-v2-catalog__pages">
          {HOME_FEATURE_GROUPS.map((group) => (
            <section key={group.id} className="home-v2-catalog__group" data-feature-group={group.id}>
              <h3>{group.title}</h3>
              {homeFeaturesForGroup(group.id).map((definition) => <FeatureRow key={definition.id} feature={featurePresentation(definition.id)} onRun={runCatalogFeature} />)}
            </section>
          ))}
        </div>
        <details className="home-v2-collection">
          <summary><span>小屋收藏</span><small>{roomProfile ? `${roomProfile.unlockedDecorIds.length} 件纪念物` : "等待伴星同步"}</small></summary>
          <div className="home-v2-collection__body">
            {companionHome.profileFailure ? <p role="status">{companionHome.profileFailure}</p> : null}
            {roomProfile?.unlockedDecorIds.length ? (
              <div className="home-v2-collection__grid" aria-label="已解锁的小屋纪念物">
                {roomProfile.unlockedDecorIds.map((decorId) => {
                  const slot = (Object.keys(roomProfile.equippedDecorBySlot) as CompanionRoomSlotV1[]).find((candidate) => roomProfile.equippedDecorBySlot[candidate] === decorId);
                  const copy = HOME_V2_DECOR_COPY[decorId];
                  return (
                    <button key={decorId} type="button" data-equipped={Boolean(slot)} disabled={companionHome.profileSaving} onClick={() => { void toggleDecor(decorId); }}>
                      <span><strong>{copy.title}</strong><small>{slot ? `摆在${HOME_V2_SLOT_COPY[slot]}` : copy.detail}</small></span><em>{slot ? "收起" : "摆入"}</em>
                    </button>
                  );
                })}
              </div>
            ) : <p>完成第一篇笔记、第一个目标、第一次复习或确认记忆之后，纪念物会自动解锁。</p>}
            {roomProfile?.unlockedEffectIds.length ? (
              <div className="home-v2-collection__effects" role="group" aria-label="完成学习时的魔法轨迹">
                <span>完成轨迹</span>
                {COMPANION_EFFECT_IDS.filter((effectId) => roomProfile.unlockedEffectIds.includes(effectId)).map((effectId) => (
                  <button key={effectId} type="button" aria-pressed={roomProfile.equippedEffectId === effectId} disabled={companionHome.profileSaving} onClick={() => { void toggleEffect(effectId); }}>{HOME_V2_EFFECT_COPY[effectId]}</button>
                ))}
              </div>
            ) : null}
            {roomProfile ? (
              <div className="home-v2-collection__effects" role="group" aria-label="这个学习空间的打扰设置">
                <span>这个空间</span>
                <button
                  type="button"
                  aria-pressed={roomProfile.proactiveMuted}
                  disabled={companionHome.profileSaving}
                  onClick={() => { void toggleProactiveMuted(); }}
                >
                  {roomProfile.proactiveMuted ? "已静音：她不在这里开口" : "可以主动找我"}
                </button>
              </div>
            ) : null}
          </div>
        </details>
      </div>
    </dialog>
  );
}
