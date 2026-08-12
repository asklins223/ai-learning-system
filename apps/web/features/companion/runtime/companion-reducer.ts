import type { CompanionRuntimeAction, CompanionSurfaceState } from "./surface-model";
import { createInitialSurfaceState } from "./surface-model";

export function companionReducer(
  state: CompanionSurfaceState,
  action: CompanionRuntimeAction,
): CompanionSurfaceState {
  switch (action.type) {
    case "hydrate":
      return action.hidden
        ? { kind: "hidden", reason: "global_off" }
        : createInitialSurfaceState(action.pageKind);
    case "summon":
      if (state.kind === "hidden") return state;
      return { kind: "panel", model: action.model, returnFocusId: action.returnFocusId };
    case "close_panel":
      return state.kind === "hidden" ? state : createInitialSurfaceState(action.pageKind);
    case "hide":
      return { kind: "hidden", reason: action.reason };
    default:
      return state;
  }
}
