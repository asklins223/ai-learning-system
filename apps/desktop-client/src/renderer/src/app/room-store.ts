import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  initialViewState,
  nextMotionMode,
  resolveRoomIntent,
  type MotionMode,
  type PresentationPhase,
  type RoomDestination,
  type RoomIntent,
  type RoomSurface,
  type RoomTheme,
  type ViewPresetId,
  type WindowState,
} from "./room-machine";
import { scenePhaseForIntent, type SceneMotionPhase } from "../scene/scene-motion";
import type { HudPageId } from "../components/hud/hud-pages";
import type { SourceStatusTab } from "../components/surfaces/source-index";

export type ThemeMode = "system" | "manual";
export type CompanionMoment = "idle" | "lamp" | "ambient" | "confirm";
export type CompanionPosition = { readonly x: number; readonly y: number };
export type CompanionNormalizedAnchor = { readonly x: number; readonly y: number };
export type CompanionPlacementOwner = "semantic" | "user";
/** 全局搜索的类型筛选，与 `ailearn.search.global` 的 type 参数同集合。 */
export type SearchTypeFilter = "all" | "note" | "source" | "objective";
/** Live2D 在渲染层的真实状态，与 WindowLive2D 的 onStatus 同集合。 */
export type Live2dStatus = "loading" | "ready" | "unavailable";
export type PendingHomeCompletion = { readonly id: string };
export type ActiveHomeCompletion = PendingHomeCompletion & { readonly started: boolean };
export type CompanionHomeZone = "desk" | "shelf" | "window" | "rest";
export const DEFAULT_COMPANION_POSITION: CompanionPosition = { x: 0, y: 0 };
export const DEFAULT_COMPANION_HOME_ZONE: CompanionHomeZone = "rest";
export const DEFAULT_COMPANION_SCALE = 1;
export const MIN_COMPANION_SCALE = 0.6;
export const MAX_COMPANION_SCALE = 1.4;

export type PersistedCompanionPlacement = Pick<RoomStore,
  "companionHomeZone" | "companionPlacementOwner" | "companionUserAnchor"
>;

/** Defensive hydration for older or manually edited local preference payloads. */
export function normalizePersistedCompanionPlacement(input: unknown): PersistedCompanionPlacement {
  const record = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const zone = record.companionHomeZone === "desk"
    || record.companionHomeZone === "shelf"
    || record.companionHomeZone === "window"
    || record.companionHomeZone === "rest"
    ? record.companionHomeZone
    : DEFAULT_COMPANION_HOME_ZONE;
  const rawAnchor = record.companionUserAnchor && typeof record.companionUserAnchor === "object"
    ? record.companionUserAnchor as Record<string, unknown>
    : null;
  const hasAnchor = rawAnchor
    && typeof rawAnchor.x === "number"
    && Number.isFinite(rawAnchor.x)
    && typeof rawAnchor.y === "number"
    && Number.isFinite(rawAnchor.y);
  if (record.companionPlacementOwner === "user" && hasAnchor) {
    return {
      companionHomeZone: zone,
      companionPlacementOwner: "user",
      companionUserAnchor: {
        x: Math.min(1, Math.max(0, rawAnchor.x as number)),
        y: Math.min(1, Math.max(0, rawAnchor.y as number)),
      },
    };
  }
  return {
    companionHomeZone: zone,
    companionPlacementOwner: "semantic",
    companionUserAnchor: null,
  };
}
/**
 * The note a surface is about to open. `mode` carries how the caller wants to
 * land on it — the library's shelf sends readers to the reading page and its
 * "继续写" button to the editor — and is only read when a note is first loaded.
 */
export type NoteTargetRef = {
  readonly noteId: string;
  /** 唯一消费方 notebook-surface 只按 noteId 读当前版本；缺版本就如实为 null。 */
  readonly noteVersionId: string | null;
  readonly mode?: "read" | "edit";
};
export type ReviewTargetRef = { readonly scheduleId: string; readonly objectiveId: string };

/**
 * Where the bottom-left pill goes while a page is open. A page that lives under
 * another page registers its parent here; nothing registered means the study
 * room, which is the parent of every directory-rail entry.
 */
export type ReturnTarget = { readonly label: string; readonly run: () => void };

type RoomStore = {
  destination: RoomDestination;
  viewPreset: ViewPresetId;
  surface: RoomSurface;
  scenePhase: SceneMotionPhase;
  theme: RoomTheme;
  themeMode: ThemeMode;
  motionMode: MotionMode;
  motionPreferenceExplicit: boolean;
  phase: PresentationPhase;
  mediaMessage: string | null;
  reducedMotion: boolean;
  windowState: WindowState;
  inputFocused: boolean;
  activeRunId: string | null;
  activeCardGenerationRunId: string | null;
  activeNoteRef: NoteTargetRef | null;
  /**
   * The last note the reader opened, kept across navigation. `activeNoteRef` is
   * the *current* target and is cleared whenever the reader leaves the note
   * pages, so the library had no way to know which note "继续写作" meant and
   * showed the most recently updated one instead.
   */
  recentNoteId: string | null;
  activeSourceId: string | null;
  activeObjectiveId: string | null;
  settingsSection: string;
  activeReviewTarget: ReviewTargetRef | null;
  /** 当前页面在 desktop-pages-v3 mockup 中的编号，由页面自身发布。 */
  hudPage: HudPageId;
  /**
   * page 04 的两种入口形态：`first` = 04A 首次进入，`returning` = 04B 老用户
   * 的空间菜单。只在 `hudPage === "space"` 时有意义，其余页面一律为 null。
   */
  hudSpaceEntry: "first" | "returning" | null;
  ambientRequested: boolean;
  masterMuted: boolean;
  onboardingSeen: boolean;
  onboardingOpen: boolean;
  companionOpen: boolean;
  companionMoment: CompanionMoment;
  pendingHomeCompletion: PendingHomeCompletion | null;
  activeHomeCompletion: ActiveHomeCompletion | null;
  consumedHomeCompletionIds: readonly string[];
  companionHomeZone: CompanionHomeZone;
  companionPosition: CompanionPosition;
  companionPlacementOwner: CompanionPlacementOwner;
  companionUserAnchor: CompanionNormalizedAnchor | null;
  companionScale: number;
  /**
   * 页面级存在感控制（2026-09-16 裁决 3）。三者都是**会话级**：不写入
   * partialize，重启回到默认；账号级设置由服务端保存。
   */
  mutedCompanionSceneKeys: readonly string[];
  companionFocusUntilTaskEnd: boolean;
  companionTemporarilyHidden: boolean;
  navigationGuard: ((intent: RoomIntent) => void) | null;
  returnTarget: ReturnTarget | null;
  /**
   * Which page sent the reader into the note, so the note's back pill names the
   * page it actually returns to. The library, the card-generation workbench and
   * the star map all open the same note page, and the pill used to say
   * "返回笔记库" even when the reader had come from the workbench.
   */
  noteReturnTo: "library" | "generation" | "graph";
  /** The 来源库 tab the reader left, so returning to the index resumes it. */
  sourceIndexTab: SourceStatusTab;
  /**
   * 全局搜索页的查询状态。页面本身会在切换 surface 时被整体重挂载
   * （TaskSurface 用 `key={renderedSurface}`），所以查询词、类型筛选和
   * 「证据不足」开关必须放在 store 里，否则每次离开都会丢。
   */
  searchQuery: string;
  searchTypeFilter: SearchTypeFilter;
  searchWeakOnly: boolean;
  /**
   * 复习队列的阅读位置，理由和上面的搜索状态完全一样：surface 会被整体重挂载。
   * 这里只存位置（选中卡 id + 序号），页数由页面按位置重新读到，所以恢复出来
   * 的永远是服务端当前的真实队列，而不是一份可能已经过期的缓存。
   * `workspaceEpoch` 用来辨认这个位置还属不属于当前工作区。
   */
  reviewQueueResume: {
    readonly workspaceEpoch: number | null;
    readonly selectedReviewId: string | null;
    readonly selectedIndex: number;
  } | null;
  /**
   * Live2D 在渲染层的**真实**加载结果。半身形象是伴星唯一形态，而模型能否
   * 加载只有渲染层知道，所以设置页读这里而不是读服务端的能力投影。
   */
  live2dStatus: Live2dStatus;
  resetWorkspaceScope: () => void;
  /**
   * `options.returnTo` is for pages a reader can reach from more than one
   * parent and that have no parent of their own to write the pill for. The
   * star map is the case that needed it: it opens objective-detail and
   * source-detail, neither of which registers a return target, so stepping out
   * of a star always landed on "返回书房" and the map itself became
   * unreachable. Passing the target through `invoke` keeps the reset and the
   * replacement in one place — a separate `setReturnTarget` call after the
   * navigation would only work if it happened to be written last.
   */
  invoke: (intent: RoomIntent, options?: { readonly returnTo?: ReturnTarget }) => void;
  closeSurface: () => void;
  toggleTheme: () => void;
  setTheme: (theme: RoomTheme) => void;
  applyTimeTheme: (theme: RoomTheme) => void;
  cycleMotionMode: () => void;
  setMotionMode: (mode: MotionMode) => void;
  setPhase: (phase: PresentationPhase, message?: string | null) => void;
  setReducedMotion: (reduced: boolean) => void;
  setWindowState: (windowState: WindowState) => void;
  setInputFocused: (inputFocused: boolean) => void;
  setScenePhase: (scenePhase: SceneMotionPhase) => void;
  setActiveRunId: (runId: string | null) => void;
  setActiveCardGenerationRunId: (runId: string | null) => void;
  setActiveNoteRef: (ref: NoteTargetRef | null) => void;
  setActiveSourceId: (sourceId: string | null) => void;
  setActiveObjectiveId: (objectiveId: string | null) => void;
  setSettingsSection: (section: string) => void;
  setActiveReviewTarget: (target: ReviewTargetRef | null) => void;
  setReviewQueueResume: (resume: {
    readonly workspaceEpoch: number | null;
    readonly selectedReviewId: string | null;
    readonly selectedIndex: number;
  } | null) => void;
  setHudPage: (page: HudPageId, spaceEntry?: "first" | "returning") => void;
  toggleAmbient: () => void;
  toggleMasterMuted: () => void;
  /** 显式设置总静音，供设置页的受控开关使用（不再靠双重否定反推）。 */
  setMasterMuted: (muted: boolean) => void;
  openOnboarding: () => void;
  finishOnboarding: () => void;
  toggleCompanion: () => void;
  closeCompanion: () => void;
  setCompanionMoment: (moment: CompanionMoment) => void;
  queueHomeCompletion: (id: string) => void;
  beginPendingHomeCompletion: (id: string) => void;
  markHomeCompletionStarted: (id: string) => boolean;
  consumeHomeCompletion: (id: string) => void;
  presentPendingHomeCompletion: (id: string) => void;
  setCompanionHomeZone: (zone: CompanionHomeZone) => void;
  setCompanionPosition: (position: CompanionPosition) => void;
  setCompanionHomePlacement: (zone: CompanionHomeZone, position?: CompanionPosition) => void;
  setCompanionUserPlacement: (anchor: CompanionNormalizedAnchor) => void;
  setCompanionScale: (scale: number) => void;
  setCompanionSceneMuted: (sceneKey: string, muted: boolean) => void;
  setCompanionFocusUntilTaskEnd: (value: boolean) => void;
  setCompanionTemporarilyHidden: (value: boolean) => void;
  resetCompanionPosition: () => void;
  setNavigationGuard: (guard: ((intent: RoomIntent) => void) | null) => void;
  setReturnTarget: (target: ReturnTarget | null) => void;
  setNoteReturnTo: (target: RoomStore["noteReturnTo"]) => void;
  setSourceIndexTab: (tab: SourceStatusTab) => void;
  setSearchQuery: (query: string) => void;
  setSearchTypeFilter: (filter: SearchTypeFilter) => void;
  setSearchWeakOnly: (weakOnly: boolean) => void;
  setLive2dStatus: (status: Live2dStatus) => void;
};

export const useRoomStore = create<RoomStore>()(
  persist(
    (set, get) => ({
      ...initialViewState,
      scenePhase: "idle",
      theme: "day",
      themeMode: "system",
      motionMode: "full",
      motionPreferenceExplicit: false,
      phase: "booting",
      mediaMessage: null,
      reducedMotion: false,
      windowState: "visible",
      inputFocused: false,
      activeRunId: null,
      activeCardGenerationRunId: null,
      activeNoteRef: null,
      recentNoteId: null,
      activeSourceId: null,
      activeObjectiveId: null,
      settingsSection: "account",
      activeReviewTarget: null,
      hudPage: "home",
      hudSpaceEntry: null,
      ambientRequested: false,
      masterMuted: false,
      onboardingSeen: false,
      onboardingOpen: false,
      companionOpen: false,
      companionMoment: "idle",
      pendingHomeCompletion: null,
      activeHomeCompletion: null,
      consumedHomeCompletionIds: [],
      companionHomeZone: DEFAULT_COMPANION_HOME_ZONE,
      companionPosition: { ...DEFAULT_COMPANION_POSITION },
      companionPlacementOwner: "semantic",
      companionUserAnchor: null,
      companionScale: DEFAULT_COMPANION_SCALE,
      mutedCompanionSceneKeys: [],
      companionFocusUntilTaskEnd: false,
      companionTemporarilyHidden: false,
      navigationGuard: null,
      returnTarget: null,
      noteReturnTo: "library",
      sourceIndexTab: "all",
      searchQuery: "",
      searchTypeFilter: "all",
      searchWeakOnly: false,
      reviewQueueResume: null,
      live2dStatus: "loading",
      /**
       * 工作区/会话边界重置。
       *
       * 只清**与某个工作区或某次会话绑定**的状态：路由与页面身份、当前学习
       * 游标、运行中的任务、页面级存在感、搜索范围。**本机偏好不在这里清**：
       * 主题模式、环境音意图和伴星摆放都是"这台设备上的读者"的选择，跨工作区
       * 和跨重启都该保留——设置页对读者承诺的正是"本机偏好保存在这台设备上"。
       *
       * 之前这里把 `themeMode` 打回 `system`，等于悄悄取消了读者显式选过的主题：
       * `applyTimeTheme` 只在 `themeMode === "system"` 时写入，所以边界一过，
       * 时钟立刻把 `theme` 覆盖回按时间自动。伴星摆放同理——它本来就是持久化
       * 偏好，边界重置它等于"拖好的位置切个空间就跳回去"。
       *
       * `onboardingSeen` / `companionScale` / `theme` 一直不在重置列表里，这里是
       * 把同一规则补全，不是新规则。
       */
      resetWorkspaceScope: () => set({
        ...initialViewState,
        scenePhase: "idle",
        phase: "booting",
        mediaMessage: null,
        inputFocused: false,
        activeRunId: null,
        activeCardGenerationRunId: null,
        activeNoteRef: null,
        recentNoteId: null,
        activeSourceId: null,
        activeObjectiveId: null,
        settingsSection: "account",
        activeReviewTarget: null,
        hudPage: "home",
        hudSpaceEntry: null,
        onboardingOpen: false,
        companionOpen: false,
        companionMoment: "idle",
        pendingHomeCompletion: null,
        activeHomeCompletion: null,
        consumedHomeCompletionIds: [],
        // 页面级存在感属于"当前工作区会话"：切工作区必须回到默认，
        // 否则上一个工作区的"此页静音/专注/已隐藏"会静默延续到新工作区。
        mutedCompanionSceneKeys: [],
        companionFocusUntilTaskEnd: false,
        companionTemporarilyHidden: false,
        navigationGuard: null,
        returnTarget: null,
        noteReturnTo: "library",
        sourceIndexTab: "all",
        // 搜索范围与工作区绑定：换空间后上一空间的查询词不能再留在这里。
        searchQuery: "",
        searchTypeFilter: "all",
        searchWeakOnly: false,
        // 阅读位置属于当前工作区的队列：换空间后不能把上一空间的第 40 张
        // 当成这一空间的第 40 张。
        reviewQueueResume: null,
      }),
      invoke: (intent, options) => {
        const state = get();
        if (state.navigationGuard) {
          state.navigationGuard(intent);
          return;
        }
        const next = resolveRoomIntent(intent);
        const sameRoute = next.destination === state.destination
          && next.viewPreset === state.viewPreset
          && next.surface === state.surface;
        if (sameRoute) return;
        set({
          ...next,
          scenePhase: scenePhaseForIntent(intent, state.surface),
          // 学习卡生成工作台是笔记主线的一站：进入它不算离开这篇笔记，
          // 返回研究册时仍落回同一条 activeNoteRef。
          activeNoteRef: intent === "open-notebook" || intent === "open-card-generation"
            ? get().activeNoteRef
            : null,
          activeSourceId: intent === "open-source" ? get().activeSourceId : null,
          activeObjectiveId: intent === "open-objective" ? get().activeObjectiveId : null,
          activeReviewTarget: intent === "review" ? get().activeReviewTarget : null,
          inputFocused: false,
          // 目标页自身不登记返回目标，所以「从星图跳进来」这一跳由调用方随
          // 导航一起带上；其余情况一律清空，避免旧父级链接残留。
          returnTarget: options?.returnTo ?? null,
          onboardingOpen: false,
          onboardingSeen: get().onboardingSeen || intent !== "home",
          companionOpen: false,
          companionMoment: "idle",
        });
      },
      closeSurface: () => set((state) => ({
        ...initialViewState,
        scenePhase: state.surface ? "returning" : "idle",
        activeNoteRef: null,
        // Returning to the room is not a workspace change: the note the reader
        // was last in stays the note "继续写作" points at.
        recentNoteId: state.recentNoteId,
        activeSourceId: null,
        activeObjectiveId: null,
        activeReviewTarget: null,
        inputFocused: false,
      })),
      toggleTheme: () => set((state) => ({
        theme: state.theme === "day" ? "night" : "day",
        themeMode: "manual",
        companionMoment: "lamp",
      })),
      // An explicit choice always outranks the clock, exactly like `toggleTheme`.
      // Leaving the mode on "system" here let the home scene's minute timer
      // immediately write the time-derived theme back over the reader's pick.
      setTheme: (theme) => set({ theme, themeMode: "manual" }),
      // The clock's own write. It refuses once the reader has chosen a theme, so
      // a racing timer can never undo that choice.
      applyTimeTheme: (theme) => set((state) => (state.themeMode === "system" ? { theme } : {})),
      cycleMotionMode: () =>
        set((state) => ({
          motionMode: nextMotionMode(state.motionMode),
          motionPreferenceExplicit: true,
          mediaMessage: null,
        })),
      // Choosing a level directly is the same decision the cycler makes, so it
      // also pins the preference: the system reduced-motion default must stop
      // overriding a level the reader picked.
      setMotionMode: (motionMode) =>
        set({ motionMode, motionPreferenceExplicit: true, mediaMessage: null }),
      setPhase: (phase, mediaMessage = null) => set({ phase, mediaMessage }),
      setReducedMotion: (reducedMotion) =>
        set((state) => ({
          reducedMotion,
          motionMode: state.motionPreferenceExplicit ? state.motionMode : reducedMotion ? "off" : "full",
        })),
      setWindowState: (windowState) => set({ windowState }),
      setInputFocused: (inputFocused) => set({ inputFocused }),
      setScenePhase: (scenePhase) => set({ scenePhase }),
      setActiveRunId: (activeRunId) => set({ activeRunId }),
      setActiveCardGenerationRunId: (activeCardGenerationRunId) => set({ activeCardGenerationRunId }),
      setActiveNoteRef: (activeNoteRef) => set((state) => ({
        activeNoteRef,
        // Opening a note is what makes it the note to continue; leaving the note
        // pages clears the target but must not clear this.
        recentNoteId: activeNoteRef?.noteId ?? state.recentNoteId,
      })),
      setActiveSourceId: (activeSourceId) => set({ activeSourceId }),
      setActiveObjectiveId: (activeObjectiveId) => set({ activeObjectiveId }),
      setSettingsSection: (settingsSection) => set({ settingsSection }),
      setActiveReviewTarget: (activeReviewTarget) => set({ activeReviewTarget }),
      setReviewQueueResume: (reviewQueueResume) => set({ reviewQueueResume }),
      setHudPage: (hudPage, hudSpaceEntry) => set({
        hudPage,
        hudSpaceEntry: hudPage === "space" ? hudSpaceEntry ?? null : null,
      }),
      toggleAmbient: () =>
        set((state) => ({
          ambientRequested: !state.ambientRequested,
          masterMuted: state.ambientRequested ? state.masterMuted : false,
          companionOpen: true,
          companionMoment: "ambient",
        })),
      toggleMasterMuted: () => set((state) => ({ masterMuted: !state.masterMuted })),
      setMasterMuted: (masterMuted) => set({ masterMuted }),
      openOnboarding: () => set({ onboardingOpen: true }),
      finishOnboarding: () => set({ onboardingOpen: false, onboardingSeen: true }),
      toggleCompanion: () => set((state) => ({
        companionOpen: !state.companionOpen,
        companionMoment: state.companionOpen ? "idle" : state.companionMoment,
        // 任何"唤醒伴星"入口都同时解除临时隐藏——否则用户点了唤醒却看不到任何变化。
        companionTemporarilyHidden: false,
      })),
      closeCompanion: () => set({ companionOpen: false, companionMoment: "idle" }),
      setCompanionMoment: (companionMoment) => set({ companionMoment }),
      queueHomeCompletion: (id) => {
        const normalizedId = id.trim();
        if (!normalizedId) return;
        set((state) => state.pendingHomeCompletion?.id === normalizedId
          || state.activeHomeCompletion?.id === normalizedId
          || state.consumedHomeCompletionIds.includes(normalizedId)
          ? state
          : { pendingHomeCompletion: { id: normalizedId } });
      },
      beginPendingHomeCompletion: (id) => set((state) => {
        if (state.activeHomeCompletion?.id === id) {
          return state.companionMoment === "confirm"
            ? state
            : { companionMoment: "confirm" };
        }
        if (state.activeHomeCompletion || state.pendingHomeCompletion?.id !== id) return state;
        return {
          pendingHomeCompletion: null,
          activeHomeCompletion: { id, started: false },
          companionMoment: "confirm",
        };
      }),
      markHomeCompletionStarted: (id) => {
        const active = get().activeHomeCompletion;
        if (!active || active.id !== id || active.started) return false;
        set({ activeHomeCompletion: { ...active, started: true } });
        return true;
      },
      consumeHomeCompletion: (id) => set((state) => (
        state.activeHomeCompletion?.id === id
          ? {
              activeHomeCompletion: null,
              companionMoment: "idle",
              consumedHomeCompletionIds: state.consumedHomeCompletionIds.includes(id)
                ? state.consumedHomeCompletionIds
                : [...state.consumedHomeCompletionIds, id].slice(-32),
            }
          : state
      )),
      // V1 has no room-level completion trail. Keep its original immediate
      // acknowledgement path while V2 uses begin/consume around real playback.
      presentPendingHomeCompletion: (id) => set((state) => (
        state.pendingHomeCompletion?.id === id
          ? {
              pendingHomeCompletion: null,
              companionMoment: "confirm",
              consumedHomeCompletionIds: [...state.consumedHomeCompletionIds, id].slice(-32),
            }
          : state
      )),
      setCompanionHomeZone: (companionHomeZone) => set({
        companionHomeZone,
        companionPlacementOwner: "semantic",
        companionUserAnchor: null,
      }),
      setCompanionPosition: (companionPosition) => set({
        companionPosition: { x: companionPosition.x, y: companionPosition.y },
      }),
      setCompanionHomePlacement: (
        companionHomeZone,
        companionPosition = DEFAULT_COMPANION_POSITION,
      ) => set({
        companionHomeZone,
        companionPosition: { x: companionPosition.x, y: companionPosition.y },
        companionPlacementOwner: "semantic",
        companionUserAnchor: null,
      }),
      setCompanionUserPlacement: (anchor) => set((state) => {
        const normalized = {
          x: Math.min(1, Math.max(0, anchor.x)),
          y: Math.min(1, Math.max(0, anchor.y)),
        };
        if (state.companionPlacementOwner === "user"
          && state.companionUserAnchor
          && Math.abs(state.companionUserAnchor.x - normalized.x) < 0.000_001
          && Math.abs(state.companionUserAnchor.y - normalized.y) < 0.000_001
          && state.companionPosition.x === 0
          && state.companionPosition.y === 0) return state;
        return {
          companionPlacementOwner: "user",
          companionUserAnchor: normalized,
          companionPosition: { ...DEFAULT_COMPANION_POSITION },
        };
      }),
      setCompanionScale: (companionScale) => set({
        companionScale: Math.min(MAX_COMPANION_SCALE, Math.max(MIN_COMPANION_SCALE, companionScale)),
      }),
      setCompanionSceneMuted: (sceneKey, muted) => set((state) => ({
        mutedCompanionSceneKeys: muted
          ? (state.mutedCompanionSceneKeys.includes(sceneKey)
            ? state.mutedCompanionSceneKeys
            : [...state.mutedCompanionSceneKeys, sceneKey])
          : state.mutedCompanionSceneKeys.filter((key) => key !== sceneKey),
      })),
      setCompanionFocusUntilTaskEnd: (companionFocusUntilTaskEnd) => set({ companionFocusUntilTaskEnd }),
      setCompanionTemporarilyHidden: (companionTemporarilyHidden) => set({
        companionTemporarilyHidden,
        // 隐藏伴星时同时收起面板，避免留下一个"看不见的主人的面板"。
        ...(companionTemporarilyHidden ? { companionOpen: false, companionMoment: "idle" as const } : {}),
      }),
      resetCompanionPosition: () => set({
        companionHomeZone: DEFAULT_COMPANION_HOME_ZONE,
        companionPosition: { ...DEFAULT_COMPANION_POSITION },
        companionPlacementOwner: "semantic",
        companionUserAnchor: null,
      }),
      setNavigationGuard: (navigationGuard) => set({ navigationGuard }),
      setReturnTarget: (returnTarget) => set({ returnTarget }),
      setNoteReturnTo: (noteReturnTo) => set({ noteReturnTo }),
      setSourceIndexTab: (sourceIndexTab) => set({ sourceIndexTab }),
      setSearchQuery: (searchQuery) => set({ searchQuery }),
      setSearchTypeFilter: (searchTypeFilter) => set({ searchTypeFilter }),
      setSearchWeakOnly: (searchWeakOnly) => set({ searchWeakOnly }),
      setLive2dStatus: (live2dStatus) => set({ live2dStatus }),
    }),
    {
      name: "ailearn.desktop-room.v2",
      partialize: (state) => ({
        theme: state.theme,
        // `themeMode` has to travel with `theme`: `applyTimeTheme` only writes
        // while the mode is "system", so persisting the colour without the mode
        // meant a reader who picked 夜间书房 got the clock's theme back on the
        // next launch — the half-persisted pair silently undid the choice.
        themeMode: state.themeMode,
        motionMode: state.motionMode,
        motionPreferenceExplicit: state.motionPreferenceExplicit,
        masterMuted: state.masterMuted,
        onboardingSeen: state.onboardingSeen,
        companionScale: state.companionScale,
        companionHomeZone: state.companionHomeZone,
        companionPlacementOwner: state.companionPlacementOwner,
        companionUserAnchor: state.companionUserAnchor,
        // The settings directory reopens where the reader left it, like the
        // other local preferences on this card.
        settingsSection: state.settingsSection,
      }),
      version: 3,
      migrate: (persistedState) => {
        const persisted = persistedState && typeof persistedState === "object"
          ? persistedState as Record<string, unknown>
          : {};
        return { ...persisted, ...normalizePersistedCompanionPlacement(persisted) };
      },
      merge: (persistedState, currentState) => {
        const persisted = persistedState && typeof persistedState === "object"
          ? persistedState as Partial<RoomStore>
          : {};
        return {
          ...currentState,
          ...persisted,
          ...normalizePersistedCompanionPlacement(persisted),
          navigationGuard: null,
          returnTarget: null,
        };
      },
    },
  ),
);
