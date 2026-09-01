import { beforeEach, describe, expect, it, vi } from "vitest";
import { useRoomStore } from "./room-store";

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
  it("clears workspace-scoped activity without discarding desktop preferences", () => {
    useRoomStore.setState({
      theme: "night",
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
      companionOpen: true,
      companionMoment: "confirm",
      companionPosition: { x: 120, y: -40 },
      navigationGuard: () => undefined,
    });

    useRoomStore.getState().resetWorkspaceScope();

    expect(useRoomStore.getState()).toMatchObject({
      theme: "night",
      motionMode: "lite",
      masterMuted: false,
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
      ambientRequested: false,
      onboardingOpen: false,
      companionOpen: false,
      companionMoment: "idle",
      companionPosition: { x: 0, y: 0 },
      navigationGuard: null,
    });
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
