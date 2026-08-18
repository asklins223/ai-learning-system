import type { AllowedMainRouteV1 } from "@ailearn/shared";

/**
 * Translate the typed Pet command into the parameter names consumed by the
 * current Main renderer routes. Keeping this pure makes route handoff drift
 * testable without booting Electron.
 */
export function currentMainRoute(route: AllowedMainRouteV1): string {
  switch (route.kind) {
    case "conversation":
      return route.conversationId
        ? `/companion/conversations?conversationId=${encodeURIComponent(route.conversationId)}`
        : "/companion/conversations";
    case "settings":
      return `/settings?section=${encodeURIComponent(route.section)}`;
    case "review":
      return "/review";
    case "card":
      // V2：旧 /cards/:id 详情页已退役，学习卡详情在 /learning-cards/:cardId。
      return `/learning-cards/${encodeURIComponent(route.cardId)}`;
    case "star_map":
      return route.keyPointId
        ? `/graph?targetNodeId=${encodeURIComponent(route.keyPointId)}`
        : "/graph";
    case "learning_session":
      // V1 卡片 companion session 已退役：回到 V2 学习卡页。
      return `/learning-cards/${encodeURIComponent(route.cardId)}`;
  }
}
