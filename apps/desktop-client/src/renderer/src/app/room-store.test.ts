import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// node 测试环境没有 localStorage，zustand persist 会因此直接跳过中间件（api.persist 不挂载）。
// 这里在 import 之前注入内存 storage，使"哪些字段会写盘"成为可直接断言的真实行为。
const persistedStorage = vi.hoisted(() => {
  const entries = new Map<string, string>();
  const storage = {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => { entries.set(key, value); },
    removeItem: (key: string) => { entries.delete(key); },
    clear: () => { entries.clear(); },
    key: (index: number) => Array.from(entries.keys())[index] ?? null,
    get length() { return entries.size; },
  };
  const globals = globalThis as unknown as { localStorage?: unknown; window?: unknown };
  globals.localStorage = storage;
  // zustand v5 的 persist 默认取 window.localStorage；node 环境既没有 window 也没有
  // localStorage，中间件会因此整体跳过（api.persist 不挂载）。这里补最小的宿主对象。
  globals.window = globals;
  return { entries, storage };
});

import {
  MAX_COMPANION_SCALE,
  MIN_COMPANION_SCALE,
  normalizePersistedCompanionPlacement,
  useRoomStore,
} from "./room-store";

describe("room navigation guard", () => {
  beforeEach(() => {
    useRoomStore.setState({ activeRunId: null, navigationGuard: null });
  });

  it("routes every room intent through the active LearningRun exit guard", () => {
    const exit = vi.fn();
    useRoomStore.setState({ activeRunId: "run-1", navigationGuard: exit });

    useRoomStore.getState().invoke("home");
    useRoomStore.getState().invoke("review");
    useRoomStore.getState().invoke("search");

    expect(exit).toHaveBeenCalledTimes(3);
    expect(useRoomStore.getState().surface).not.toBe("review");
  });

  it("allows the resolved return intent after the active run is cleared", () => {
    useRoomStore.setState({ activeRunId: "run-1", navigationGuard: () => undefined });
    useRoomStore.getState().setActiveRunId(null);
    useRoomStore.getState().setNavigationGuard(null);

    useRoomStore.getState().invoke("review");

    expect(useRoomStore.getState().surface).toBe("review");
  });

  it("honors a surface-owned guard even when there is no active run", () => {
    const guard = vi.fn();
    useRoomStore.setState({
      destination: "review",
      viewPreset: "review",
      surface: "review",
      navigationGuard: guard,
    });

    useRoomStore.getState().invoke("home");

    expect(guard).toHaveBeenCalledWith("home");
    expect(useRoomStore.getState().surface).not.toBe(null);
  });
});

describe("workspace boundary reset", () => {
  /**
   * 边界只清"与某个工作区或某次会话绑定"的状态。本机偏好全部保留——这是
   * 2026-09-17 修正后的规则：之前连 `themeMode` / `ambientRequested` / 伴星摆放
   * 一起清，结果是读者显式选过的主题被 `applyTimeTheme` 在下一个 tick 覆盖回
   * 按时间自动、拖好的伴星位置跳回默认，而设置页对读者的承诺是"本机偏好保存在
   * 这台设备上"。这三项都跟工作区无关：房间是同一个房间，伴星是同一个伴星。
   */
  it("clears workspace-scoped activity without discarding desktop preferences", () => {
    const previousScopeRevision = useRoomStore.getState().workspaceScopeRevision;
    useRoomStore.setState({
      theme: "night",
      themeMode: "manual",
      motionMode: "lite",
      masterMuted: false,
      destination: "review",
      viewPreset: "review",
      surface: "review",
      phase: "media-ready",
      mediaMessage: "ready",
      inputFocused: true,
      activeRunId: "run-1",
      activeCardGenerationRunId: "generation-1",
      activeNoteRef: { noteId: "note-1", noteVersionId: "note-version-1" },
      activeReviewTarget: { scheduleId: "schedule-1", objectiveId: "objective-1" },
      ambientRequested: true,
      onboardingOpen: true,
      companionMoment: "confirm",
      pendingHomeCompletion: { id: "learning-result:run-1:snapshot-1:demonstrated" },
      consumedHomeCompletionIds: ["learning-result:older"],
      companionPlacementOwner: "user",
      companionUserAnchor: { x: 0.31, y: 0.42 },
      companionPosition: { x: 120, y: -40 },
      navigationGuard: () => undefined,
    });

    useRoomStore.getState().resetWorkspaceScope();

    expect(useRoomStore.getState()).toMatchObject({
      // 本机偏好：跨工作区、跨重启都保留。
      theme: "night",
      themeMode: "manual",
      motionMode: "lite",
      masterMuted: false,
      ambientRequested: true,
      companionPlacementOwner: "user",
      companionUserAnchor: { x: 0.31, y: 0.42 },
      // 工作区/会话状态：回到默认。
      destination: "room",
      viewPreset: "room",
      surface: null,
      phase: "booting",
      mediaMessage: null,
      inputFocused: false,
      activeRunId: null,
      activeCardGenerationRunId: null,
      activeNoteRef: null,
      activeReviewTarget: null,
      onboardingOpen: false,
      companionMoment: "idle",
      pendingHomeCompletion: null,
      activeHomeCompletion: null,
      consumedHomeCompletionIds: [],
      navigationGuard: null,
      workspaceScopeRevision: previousScopeRevision + 1,
    });

    // 保留 themeMode 的实际意义：时钟不能再改写读者选过的主题。
    useRoomStore.getState().applyTimeTheme("day");
    expect(useRoomStore.getState().theme).toBe("night");

    useRoomStore.setState({ ambientRequested: false, companionPlacementOwner: "semantic", companionUserAnchor: null, themeMode: "system", theme: "day" });
  });
});

describe("companion size preference", () => {
  it("keeps continuous resizing inside the safe visual range", () => {
    useRoomStore.getState().setCompanionScale(0.2);
    expect(useRoomStore.getState().companionScale).toBe(MIN_COMPANION_SCALE);

    useRoomStore.getState().setCompanionScale(1.17);
    expect(useRoomStore.getState().companionScale).toBe(1.17);

    useRoomStore.getState().setCompanionScale(2);
    expect(useRoomStore.getState().companionScale).toBe(MAX_COMPANION_SCALE);
  });
});

describe("companion home placement", () => {
  it("updates the semantic zone and visual offset in one store transaction", () => {
    useRoomStore.setState({ companionHomeZone: "rest", companionPosition: { x: 18, y: -7 } });
    let notifications = 0;
    const unsubscribe = useRoomStore.subscribe(() => { notifications += 1; });

    useRoomStore.getState().setCompanionHomePlacement("desk");
    unsubscribe();

    expect(notifications).toBe(1);
    expect(useRoomStore.getState()).toMatchObject({
      companionHomeZone: "desk",
      companionPosition: { x: 0, y: 0 },
      companionPlacementOwner: "semantic",
      companionUserAnchor: null,
    });
  });

  it("keeps a dragged normalized anchor until an explicit semantic move", () => {
    useRoomStore.getState().setCompanionUserPlacement({ x: 0.37, y: 0.72 });

    expect(useRoomStore.getState()).toMatchObject({
      companionPlacementOwner: "user",
      companionUserAnchor: { x: 0.37, y: 0.72 },
      companionPosition: { x: 0, y: 0 },
    });

    useRoomStore.getState().setCompanionHomePlacement("window");
    expect(useRoomStore.getState()).toMatchObject({
      companionHomeZone: "window",
      companionPlacementOwner: "semantic",
      companionUserAnchor: null,
    });
  });

  it("clamps a dragged normalized anchor to the scene", () => {
    useRoomStore.getState().setCompanionUserPlacement({ x: -2, y: 3 });
    expect(useRoomStore.getState().companionUserAnchor).toEqual({ x: 0, y: 1 });
  });

  it("hydrates a valid arbitrary world anchor and clamps unsafe stored values", () => {
    expect(normalizePersistedCompanionPlacement({
      companionHomeZone: "window",
      companionPlacementOwner: "user",
      companionUserAnchor: { x: 0.314_159, y: 0.812_5 },
    })).toEqual({
      companionHomeZone: "window",
      companionPlacementOwner: "user",
      companionUserAnchor: { x: 0.314_159, y: 0.812_5 },
    });
    expect(normalizePersistedCompanionPlacement({
      companionHomeZone: "unknown",
      companionPlacementOwner: "user",
      companionUserAnchor: { x: -4, y: 9 },
    })).toEqual({
      companionHomeZone: "rest",
      companionPlacementOwner: "user",
      companionUserAnchor: { x: 0, y: 1 },
    });
  });

  it("drops incomplete legacy user placement instead of hydrating a magnetic anchor", () => {
    expect(normalizePersistedCompanionPlacement({
      companionHomeZone: "desk",
      companionPlacementOwner: "user",
      companionUserAnchor: { x: Number.NaN, y: 0.6 },
    })).toEqual({
      companionHomeZone: "desk",
      companionPlacementOwner: "semantic",
      companionUserAnchor: null,
    });
  });
});

describe("room light interaction", () => {
  it("switches the room light without mutating companion interaction state", () => {
    useRoomStore.setState({ theme: "day", companionMoment: "idle" });

    useRoomStore.getState().toggleTheme();

    expect(useRoomStore.getState()).toMatchObject({
      theme: "night",
      companionMoment: "lamp",
    });
  });
});

describe("room theme ownership", () => {
  beforeEach(() => {
    useRoomStore.setState({ theme: "day", themeMode: "system" });
  });

  it("keeps an explicitly chosen theme when the clock sync runs again", () => {
    useRoomStore.getState().setTheme("night");

    expect(useRoomStore.getState()).toMatchObject({ theme: "night", themeMode: "manual" });

    // The home scene re-derives the theme from the local hour every minute; a
    // manual pick must survive that write instead of snapping back.
    useRoomStore.getState().applyTimeTheme("day");

    expect(useRoomStore.getState()).toMatchObject({ theme: "night", themeMode: "manual" });
  });

  it("lets the clock drive the theme only while the mode is still system", () => {
    useRoomStore.getState().applyTimeTheme("night");

    expect(useRoomStore.getState()).toMatchObject({ theme: "night", themeMode: "system" });
  });

  it("pins the motion level the same way an explicit choice does", () => {
    useRoomStore.setState({ motionMode: "full", motionPreferenceExplicit: false, reducedMotion: false });

    useRoomStore.getState().setMotionMode("lite");
    expect(useRoomStore.getState()).toMatchObject({ motionMode: "lite", motionPreferenceExplicit: true });

    // A later system preference change must not replace the chosen level.
    useRoomStore.getState().setReducedMotion(true);
    expect(useRoomStore.getState().motionMode).toBe("lite");
  });
});

describe("scene intent transaction", () => {
  beforeEach(() => {
    useRoomStore.setState({
      destination: "room",
      viewPreset: "room",
      surface: null,
      scenePhase: "idle",
      activeRunId: null,
      navigationGuard: null,
    });
  });

  it("treats a repeated same-target intent as a no-op", () => {
    useRoomStore.getState().invoke("continue");
    const focusingState = useRoomStore.getState();

    useRoomStore.getState().invoke("continue");

    expect(useRoomStore.getState()).toBe(focusingState);
    expect(useRoomStore.getState()).toMatchObject({ surface: "study", scenePhase: "focusing" });
  });

  it("does not restart an already settled surface from its own shortcut", () => {
    useRoomStore.setState({
      destination: "study",
      viewPreset: "study",
      surface: "study",
      scenePhase: "task",
    });

    const settledState = useRoomStore.getState();
    useRoomStore.getState().invoke("continue");

    expect(useRoomStore.getState()).toBe(settledState);
    expect(useRoomStore.getState().scenePhase).toBe("task");
  });
});

describe("pending home completion", () => {
  beforeEach(() => {
    useRoomStore.setState({
      companionMoment: "idle",
      pendingHomeCompletion: null,
      activeHomeCompletion: null,
      consumedHomeCompletionIds: [],
      destination: "room",
      viewPreset: "room",
      surface: null,
      scenePhase: "idle",
      navigationGuard: null,
    });
  });

  it("retains a trusted result while navigation returns to the room", () => {
    const id = "learning-result:run-1:snapshot-1:demonstrated";
    useRoomStore.getState().queueHomeCompletion(id);
    useRoomStore.setState({
      destination: "validation",
      viewPreset: "validation",
      surface: "validation",
      scenePhase: "task",
    });

    useRoomStore.getState().invoke("home");

    expect(useRoomStore.getState()).toMatchObject({
      scenePhase: "returning",
      companionMoment: "idle",
      pendingHomeCompletion: { id },
    });
  });

  it("presents and consumes only the matching event id", () => {
    const id = "learning-result:run-1:snapshot-1:demonstrated";
    useRoomStore.getState().queueHomeCompletion(id);

    useRoomStore.getState().presentPendingHomeCompletion("stale-result");
    expect(useRoomStore.getState()).toMatchObject({
      companionMoment: "idle",
      pendingHomeCompletion: { id },
    });

    useRoomStore.getState().presentPendingHomeCompletion(id);
    expect(useRoomStore.getState()).toMatchObject({
      companionMoment: "confirm",
      pendingHomeCompletion: null,
      consumedHomeCompletionIds: [id],
    });
  });

  it("keeps a V2 event active until its room trail actually completes", () => {
    const id = "learning-result:run-2:snapshot-4:demonstrated";
    useRoomStore.getState().queueHomeCompletion(id);

    useRoomStore.getState().beginPendingHomeCompletion(id);

    expect(useRoomStore.getState()).toMatchObject({
      companionMoment: "confirm",
      pendingHomeCompletion: null,
      activeHomeCompletion: { id, started: false },
      consumedHomeCompletionIds: [],
    });
    expect(useRoomStore.getState().markHomeCompletionStarted(id)).toBe(true);
    expect(useRoomStore.getState().markHomeCompletionStarted(id)).toBe(false);
    expect(useRoomStore.getState().activeHomeCompletion).toEqual({ id, started: true });

    useRoomStore.getState().consumeHomeCompletion(id);

    expect(useRoomStore.getState()).toMatchObject({
      companionMoment: "idle",
      activeHomeCompletion: null,
      consumedHomeCompletionIds: [id],
    });
  });

  it("resumes an interrupted active event without consuming or restarting it", () => {
    const id = "learning-result:run-3:snapshot-2:demonstrated";
    useRoomStore.getState().queueHomeCompletion(id);
    useRoomStore.getState().beginPendingHomeCompletion(id);
    useRoomStore.getState().markHomeCompletionStarted(id);
    useRoomStore.getState().invoke("continue");

    expect(useRoomStore.getState()).toMatchObject({
      scenePhase: "focusing",
      companionMoment: "idle",
      activeHomeCompletion: { id, started: true },
      consumedHomeCompletionIds: [],
    });

    useRoomStore.setState({ destination: "room", viewPreset: "room", surface: null, scenePhase: "idle" });
    useRoomStore.getState().beginPendingHomeCompletion(id);

    expect(useRoomStore.getState()).toMatchObject({
      companionMoment: "confirm",
      activeHomeCompletion: { id, started: true },
      consumedHomeCompletionIds: [],
    });
  });

  it("does not queue a consumed completion event again", () => {
    const id = "learning-result:run-1:snapshot-1:demonstrated";
    useRoomStore.getState().queueHomeCompletion(id);
    useRoomStore.getState().presentPendingHomeCompletion(id);
    useRoomStore.getState().setCompanionMoment("idle");

    useRoomStore.getState().queueHomeCompletion(id);

    expect(useRoomStore.getState()).toMatchObject({
      companionMoment: "idle",
      pendingHomeCompletion: null,
      consumedHomeCompletionIds: [id],
    });
  });
});

describe("页面级存在感控制（2026-09-16 裁决 3）", () => {
  beforeEach(() => {
    useRoomStore.setState({
      mutedCompanionSceneKeys: [],
      companionFocusUntilTaskEnd: false,
      companionTemporarilyHidden: false,
      companionMoment: "idle",
    });
  });

  it("按页静音是幂等的集合操作，可分别静音多个页面", () => {
    const store = useRoomStore.getState();
    store.setCompanionSceneMuted("room", true);
    store.setCompanionSceneMuted("room", true);
    store.setCompanionSceneMuted("review", true);
    expect(useRoomStore.getState().mutedCompanionSceneKeys).toEqual(["room", "review"]);

    useRoomStore.getState().setCompanionSceneMuted("room", false);
    expect(useRoomStore.getState().mutedCompanionSceneKeys).toEqual(["review"]);
  });

  it("暂时隐藏会结束一次性表现，恢复时保留统一 HUD 自己的开合状态", () => {
    useRoomStore.setState({ companionMoment: "confirm" });
    useRoomStore.getState().setCompanionTemporarilyHidden(true);
    expect(useRoomStore.getState().companionTemporarilyHidden).toBe(true);
    expect(useRoomStore.getState().companionMoment).toBe("idle");

    useRoomStore.getState().setCompanionTemporarilyHidden(false);
    expect(useRoomStore.getState().companionTemporarilyHidden).toBe(false);
  });

  it("切工作区时页面级状态回到默认（不会把上一个工作区的静音带过去）", () => {
    useRoomStore.getState().setCompanionSceneMuted("room", true);
    useRoomStore.getState().setCompanionFocusUntilTaskEnd(true);
    useRoomStore.getState().setCompanionTemporarilyHidden(true);

    useRoomStore.getState().resetWorkspaceScope();

    const state = useRoomStore.getState();
    expect(state.mutedCompanionSceneKeys).toEqual([]);
    expect(state.companionFocusUntilTaskEnd).toBe(false);
    expect(state.companionTemporarilyHidden).toBe(false);
  });

  it("切工作区不会清掉本机偏好（主题模式 / 环境音 / 伴星摆放）", () => {
    // 读者的显式主题选择：themeMode 一旦被打回 system，applyTimeTheme 就会在
    // 下一个时钟 tick 把 theme 覆盖回按时间自动，等于悄悄取消这次选择。
    useRoomStore.getState().setTheme("night");
    useRoomStore.getState().toggleAmbient();
    useRoomStore.getState().setCompanionUserPlacement({ x: 0.42, y: 0.61 });
    useRoomStore.getState().setCompanionScale(1.2);

    useRoomStore.getState().resetWorkspaceScope();

    const state = useRoomStore.getState();
    expect(state.theme).toBe("night");
    expect(state.themeMode).toBe("manual");
    expect(state.ambientRequested).toBe(true);
    expect(state.companionScale).toBe(1.2);
    expect(state.companionPlacementOwner).toBe("user");
    expect(state.companionUserAnchor).toEqual({ x: 0.42, y: 0.61 });
    // …and the clock can no longer overwrite the reader's pick.
    useRoomStore.getState().applyTimeTheme("day");
    expect(useRoomStore.getState().theme).toBe("night");
  });

  it("主题颜色与主题模式一起写盘，重启后不会被时钟改写", () => {
    useRoomStore.getState().setTheme("night");

    const raw = persistedStorage.entries.get("ailearn.desktop-room.v2");
    const payload = JSON.parse(raw as string) as { state: Record<string, unknown> };
    expect(payload.state).toMatchObject({ theme: "night", themeMode: "manual" });

    useRoomStore.getState().setTheme("day");
  });

  it("页面级状态刻意不进入持久化白名单（会话级）", () => {
    useRoomStore.getState().setCompanionScale(1.15);
    useRoomStore.getState().setCompanionTemporarilyHidden(true);
    useRoomStore.getState().setCompanionSceneMuted("notebook", true);

    const raw = persistedStorage.entries.get("ailearn.desktop-room.v2");
    expect(raw).toBeTruthy();
    const payload = JSON.parse(raw as string) as { state: Record<string, unknown> };
    // 跨会话仍然成立的偏好继续写盘。
    expect(payload.state).toMatchObject({
      theme: expect.any(String),
      motionMode: expect.any(String),
      companionScale: 1.15,
      companionHomeZone: expect.any(String),
    });
    // 三项页面级存在感控制是会话级：重启后回到默认，不写盘。
    expect(payload.state).not.toHaveProperty("mutedCompanionSceneKeys");
    expect(payload.state).not.toHaveProperty("companionFocusUntilTaskEnd");
    expect(payload.state).not.toHaveProperty("companionTemporarilyHidden");

    useRoomStore.getState().setCompanionTemporarilyHidden(false);
    useRoomStore.getState().setCompanionSceneMuted("notebook", true);
  });
});

describe("设置页与搜索页的会话级状态", () => {
  // The store is a module singleton shared by every test file in a worker, so
  // anything these tests touch goes back to its baseline afterwards.
  afterEach(() => {
    useRoomStore.setState({
      masterMuted: false,
      searchQuery: "",
      searchTypeFilter: "all",
      searchWeakOnly: false,
      live2dStatus: "loading",
    });
  });

  it("总静音有显式 setter，设置页的受控开关不靠双重否定", () => {
    useRoomStore.getState().setMasterMuted(true);
    expect(useRoomStore.getState().masterMuted).toBe(true);
    useRoomStore.getState().setMasterMuted(false);
    expect(useRoomStore.getState().masterMuted).toBe(false);
  });

  it("搜索查询状态在 surface 重挂载之间保留，但不写盘", () => {
    useRoomStore.getState().setSearchQuery("Needle");
    useRoomStore.getState().setSearchTypeFilter("objective");
    useRoomStore.getState().setSearchWeakOnly(true);

    const state = useRoomStore.getState();
    expect(state.searchQuery).toBe("Needle");
    expect(state.searchTypeFilter).toBe("objective");
    expect(state.searchWeakOnly).toBe(true);

    const raw = persistedStorage.entries.get("ailearn.desktop-room.v2");
    const payload = JSON.parse(raw as string) as { state: Record<string, unknown> };
    expect(payload.state).not.toHaveProperty("searchQuery");
    expect(payload.state).not.toHaveProperty("searchTypeFilter");
    expect(payload.state).not.toHaveProperty("searchWeakOnly");
  });

  it("换工作区会清掉上一空间的查询与筛选", () => {
    useRoomStore.getState().setSearchQuery("Needle");
    useRoomStore.getState().setSearchWeakOnly(true);

    useRoomStore.getState().resetWorkspaceScope();

    const state = useRoomStore.getState();
    expect(state.searchQuery).toBe("");
    expect(state.searchTypeFilter).toBe("all");
    expect(state.searchWeakOnly).toBe(false);
  });

  it("Live2D 状态由渲染层上报，且不进入持久化白名单", () => {
    useRoomStore.getState().setLive2dStatus("ready");
    expect(useRoomStore.getState().live2dStatus).toBe("ready");

    const raw = persistedStorage.entries.get("ailearn.desktop-room.v2");
    const payload = JSON.parse(raw as string) as { state: Record<string, unknown> };
    expect(payload.state).not.toHaveProperty("live2dStatus");
    expect(payload.state).not.toHaveProperty("workspaceScopeRevision");
  });
});
