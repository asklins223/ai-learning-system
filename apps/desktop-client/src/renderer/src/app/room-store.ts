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

export type CompanionForm = "orb" | "live2d";
export type CompanionMoment = "idle" | "lamp" | "ambient" | "confirm";
export type CompanionPosition = { readonly x: number; readonly y: number };
export const DEFAULT_COMPANION_POSITION: CompanionPosition = { x: 0, y: 0 };
export type NoteTargetRef = { readonly noteId: string; readonly noteVersionId: string };
export type ReviewTargetRef = { readonly scheduleId: string; readonly objectiveId: string };

type RoomStore = {
  destination: RoomDestination;
  viewPreset: ViewPresetId;
  surface: RoomSurface;
  theme: RoomTheme;
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
  activeReviewTarget: ReviewTargetRef | null;
  ambientRequested: boolean;
  masterMuted: boolean;
  onboardingSeen: boolean;
  onboardingOpen: boolean;
  companionOpen: boolean;
  companionForm: CompanionForm;
  companionMoment: CompanionMoment;
  companionPosition: CompanionPosition;
  navigationGuard: ((intent: RoomIntent) => void) | null;
  resetWorkspaceScope: () => void;
  invoke: (intent: RoomIntent) => void;
  closeSurface: () => void;
  toggleTheme: () => void;
  cycleMotionMode: () => void;
  setPhase: (phase: PresentationPhase, message?: string | null) => void;
  setReducedMotion: (reduced: boolean) => void;
  setWindowState: (windowState: WindowState) => void;
  setInputFocused: (inputFocused: boolean) => void;
  setActiveRunId: (runId: string | null) => void;
  setActiveCardGenerationRunId: (runId: string | null) => void;
  setActiveNoteRef: (ref: NoteTargetRef | null) => void;
  setActiveReviewTarget: (target: ReviewTargetRef | null) => void;
  toggleAmbient: () => void;
  toggleMasterMuted: () => void;
  openOnboarding: () => void;
  finishOnboarding: () => void;
  toggleCompanion: () => void;
  closeCompanion: () => void;
  setCompanionForm: (form: CompanionForm) => void;
  setCompanionMoment: (moment: CompanionMoment) => void;
  setCompanionPosition: (position: CompanionPosition) => void;
  resetCompanionPosition: () => void;
  setNavigationGuard: (guard: ((intent: RoomIntent) => void) | null) => void;
};

export const useRoomStore = create<RoomStore>()(
  persist(
    (set, get) => ({
      ...initialViewState,
      theme: "day",
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
      activeReviewTarget: null,
      ambientRequested: false,
      masterMuted: true,
      onboardingSeen: false,
      onboardingOpen: false,
      companionOpen: false,
      companionForm: "orb",
      companionMoment: "idle",
      companionPosition: { ...DEFAULT_COMPANION_POSITION },
      navigationGuard: null,
      resetWorkspaceScope: () => set({
        ...initialViewState,
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
        companionPosition: { ...DEFAULT_COMPANION_POSITION },
        navigationGuard: null,
      }),
      invoke: (intent) => {
        const state = get();
        if (state.activeRunId && state.navigationGuard) {
          state.navigationGuard(intent);
          return;
        }
        const next = resolveRoomIntent(intent);
        set({
          ...next,
          activeNoteRef: intent === "open-notebook" ? get().activeNoteRef : null,
          activeReviewTarget: intent === "review" ? get().activeReviewTarget : null,
          inputFocused: false,
          onboardingOpen: false,
          onboardingSeen: get().onboardingSeen || intent !== "home",
          companionOpen: false,
          companionMoment: "idle",
        });
      },
      closeSurface: () => set({ ...initialViewState, activeNoteRef: null, activeReviewTarget: null, inputFocused: false }),
      toggleTheme: () => set((state) => ({
        theme: state.theme === "day" ? "night" : "day",
        companionOpen: true,
        companionMoment: "lamp",
      })),
      cycleMotionMode: () =>
        set((state) => ({
          motionMode: nextMotionMode(state.motionMode),
          motionPreferenceExplicit: true,
          mediaMessage: null,
        })),
      setPhase: (phase, mediaMessage = null) => set({ phase, mediaMessage }),
      setReducedMotion: (reducedMotion) =>
        set((state) => ({
          reducedMotion,
          motionMode: state.motionPreferenceExplicit ? state.motionMode : reducedMotion ? "off" : "full",
        })),
      setWindowState: (windowState) => set({ windowState }),
      setInputFocused: (inputFocused) => set({ inputFocused }),
      setActiveRunId: (activeRunId) => set({ activeRunId }),
      setActiveCardGenerationRunId: (activeCardGenerationRunId) => set({ activeCardGenerationRunId }),
      setActiveNoteRef: (activeNoteRef) => set({ activeNoteRef }),
      setActiveReviewTarget: (activeReviewTarget) => set({ activeReviewTarget }),
      toggleAmbient: () =>
        set((state) => ({
          ambientRequested: !state.ambientRequested,
          masterMuted: state.ambientRequested ? state.masterMuted : false,
          companionOpen: true,
          companionMoment: "ambient",
        })),
      toggleMasterMuted: () => set((state) => ({ masterMuted: !state.masterMuted })),
      openOnboarding: () => set({ onboardingOpen: true }),
      finishOnboarding: () => set({ onboardingOpen: false, onboardingSeen: true }),
      toggleCompanion: () => set((state) => ({
        companionOpen: !state.companionOpen,
        companionMoment: state.companionOpen ? "idle" : state.companionMoment,
      })),
      closeCompanion: () => set({ companionOpen: false, companionMoment: "idle" }),
      setCompanionForm: (companionForm) => set({ companionForm }),
      setCompanionMoment: (companionMoment) => set({ companionMoment }),
      setCompanionPosition: (companionPosition) => set({
        companionPosition: { x: companionPosition.x, y: companionPosition.y },
      }),
      resetCompanionPosition: () => set({ companionPosition: { ...DEFAULT_COMPANION_POSITION } }),
      setNavigationGuard: (navigationGuard) => set({ navigationGuard }),
    }),
    {
      name: "ailearn.desktop-room.v2",
      partialize: (state) => ({
        theme: state.theme,
        motionMode: state.motionMode,
        motionPreferenceExplicit: state.motionPreferenceExplicit,
        masterMuted: state.masterMuted,
        onboardingSeen: state.onboardingSeen,
        companionForm: state.companionForm,
      }),
    },
  ),
);
