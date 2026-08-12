export type CompanionAction =
  | { id: "dismiss"; label: string }
  | { id: "start_card_journey"; label: string; cardId: string; keyPointId: string }
  | { id: "open_help"; label: string };

export type CompanionPanelModel = {
  kind: "page_help" | "route_offer" | "resume";
  title: string;
  body: string;
  actions: [CompanionAction, ...CompanionAction[]];
};

export type CompanionSurfaceState =
  | { kind: "hidden"; reason: "temporary_hidden" | "global_off" | "surface_forbidden" }
  | { kind: "anchor"; pageKind: string }
  | { kind: "panel"; model: CompanionPanelModel; returnFocusId?: string };

export type CompanionRuntimeAction =
  | { type: "hydrate"; hidden: boolean; pageKind: string }
  | { type: "summon"; model: CompanionPanelModel; returnFocusId?: string }
  | { type: "close_panel"; pageKind: string }
  | { type: "hide"; reason: "temporary_hidden" | "global_off" | "surface_forbidden" };

export function pageHelpModel(pageKind: string): CompanionPanelModel {
  const pageLabel = pageKind === "card-detail" ? "这张学习卡" : "当前页面";
  return {
    kind: "page_help",
    title: "要一起看一眼吗？",
    body: `${pageLabel}可以从这里开始一小段学习。你决定下一步，我只在需要时陪你走。`,
    actions: [
      { id: "dismiss", label: "知道了" },
    ],
  };
}

export function createInitialSurfaceState(pageKind: string): CompanionSurfaceState {
  return { kind: "anchor", pageKind };
}
