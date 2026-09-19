export type ViewPresetId =
  | "room"
  | "study"
  | "notebook"
  | "review"
  | "search"
  | "graph"
  | "validation"
  | "card-generation"
  | "source-library"
  | "source-detail"
  | "note-library"
  | "objective-library"
  | "objective-detail"
  | "companion-center"
  | "settings";

export type RoomDestination =
  | "room"
  | "study"
  | "notebook"
  | "review"
  | "search"
  | "graph"
  | "validation"
  | "card-generation"
  | "source-library"
  | "source-detail"
  | "note-library"
  | "objective-library"
  | "objective-detail"
  | "companion-center"
  | "settings";

export type RoomSurface = Exclude<RoomDestination, "room"> | null;
export type RoomTheme = "day" | "night";
export type MotionMode = "full" | "lite" | "off";
export type WindowState = "visible" | "hidden" | "minimized";
export type PresentationPhase =
  | "booting"
  | "poster-ready"
  | "media-loading"
  | "media-ready"
  | "media-fallback";

export type RoomIntent =
  | "home"
  | "continue"
  | "open-notebook"
  | "review"
  | "search"
  | "graph"
  | "validate"
  | "open-card-generation"
  | "open-sources"
  | "open-source"
  | "open-notes"
  | "open-objectives"
  | "open-objective"
  | "open-companion-center"
  | "open-settings";

export type RoomViewState = {
  destination: RoomDestination;
  viewPreset: ViewPresetId;
  surface: RoomSurface;
};

export const initialViewState: RoomViewState = {
  destination: "room",
  viewPreset: "room",
  surface: null,
};

export function resolveRoomIntent(intent: RoomIntent): RoomViewState {
  switch (intent) {
    case "continue":
      return { destination: "study", viewPreset: "study", surface: "study" };
    case "open-notebook":
      return { destination: "notebook", viewPreset: "notebook", surface: "notebook" };
    case "review":
      return { destination: "review", viewPreset: "review", surface: "review" };
    case "search":
      return { destination: "search", viewPreset: "search", surface: "search" };
    case "graph":
      return { destination: "graph", viewPreset: "graph", surface: "graph" };
    case "validate":
      return { destination: "validation", viewPreset: "validation", surface: "validation" };
    case "open-card-generation":
      return { destination: "card-generation", viewPreset: "card-generation", surface: "card-generation" };
    case "open-sources":
      return { destination: "source-library", viewPreset: "source-library", surface: "source-library" };
    case "open-source":
      return { destination: "source-detail", viewPreset: "source-detail", surface: "source-detail" };
    case "open-notes":
      return { destination: "note-library", viewPreset: "note-library", surface: "note-library" };
    case "open-objectives":
      return { destination: "objective-library", viewPreset: "objective-library", surface: "objective-library" };
    case "open-objective":
      return { destination: "objective-detail", viewPreset: "objective-detail", surface: "objective-detail" };
    case "open-companion-center":
      return { destination: "companion-center", viewPreset: "companion-center", surface: "companion-center" };
    case "open-settings":
      return { destination: "settings", viewPreset: "settings", surface: "settings" };
    case "home":
    default:
      return initialViewState;
  }
}

export function nextMotionMode(mode: MotionMode): MotionMode {
  if (mode === "full") return "lite";
  if (mode === "lite") return "off";
  return "full";
}
