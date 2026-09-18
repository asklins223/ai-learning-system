/**
 * The room's learning-space menu is part of the room control pill, but one gate
 * outcome has to open it: an invite code that fails to redeem right after
 * signing in has no surface of its own, and the space menu is the surface that
 * owns joining. The gate asks for it by name instead of reaching into the pill's
 * state, the same way the rail and the home scene already talk to their peers.
 */
export const SPACE_MENU_OPEN_EVENT = "ailearn:space-menu-open";

type SpaceMenuRequest = { readonly notice?: string };

let pendingSpaceMenuRequest: SpaceMenuRequest | null = null;

/**
 * The request usually rides the same commit that mounts the pill itself (the
 * gate raises it while turning the room over), and a same-commit `dispatchEvent`
 * runs before the pill's own listener effect attaches — the event would be
 * lost. So the request is parked as well: a mounted pill takes the event, and a
 * pill that is still mounting picks the parked request up on mount.
 */
export function requestSpaceMenu(notice?: string): void {
  pendingSpaceMenuRequest = { notice };
  window.dispatchEvent(new CustomEvent(SPACE_MENU_OPEN_EVENT, { detail: { notice } }));
}

/** Consumes the parked request, if the pill never got the live event. */
export function takePendingSpaceMenuRequest(): SpaceMenuRequest | null {
  const request = pendingSpaceMenuRequest;
  pendingSpaceMenuRequest = null;
  return request;
}

/**
 * The open menu owns `workspace.list`, but it does not own the events that
 * change that list — the gate's workspace subscription does. When one arrives
 * while the menu is open, the gate asks the menu to re-read its data before it
 * re-verifies the session, so a non-invalidating update still lands as fresh
 * rows instead of a stale list.
 */
export const SPACE_MENU_REFRESH_EVENT = "ailearn:space-menu-refresh";

export function requestSpaceMenuRefresh(): void {
  window.dispatchEvent(new CustomEvent(SPACE_MENU_REFRESH_EVENT));
}
