import { useEffect } from "react";
import { useRoomStore } from "../../app/room-store";
import { HUD_PAGES, type HudPageId } from "./hud-pages";

/**
 * Publishes the current mockup page identity into the room store so the chrome
 * outside the task surface (directory rail, companion seat, control island)
 * can react to it, mirroring how `mockup.html` puts `page-NN`, `comp-left`,
 * `no-comp` and `space-*` on `.scene`.
 *
 * Publishing is separate from applying: many surfaces call `useHudPage`, but
 * the `.desktop-app` classes are applied from the store by
 * `useHudPageClasses`. That indirection is what lets the learning-space menu
 * (mockup 04B) republish `page-04 space-returning` on top of the running page
 * for as long as the menu is open — no surface remounts, and closing the menu
 * restores whatever page published itself before.
 */
export function useHudPage(page: HudPageId, options?: { readonly spaceFirstEntry?: boolean }) {
  const spaceFirstEntry = options?.spaceFirstEntry;
  const setHudPage = useRoomStore((state) => state.setHudPage);

  useEffect(() => {
    setHudPage(page, spaceFirstEntry ? "first" : "returning");
    return () => setHudPage("home");
  }, [page, setHudPage, spaceFirstEntry]);

  useHudPageClasses();
}

/**
 * Mirrors the published page identity onto `.desktop-app`. Store-driven and
 * safe to call from several mounted peers: every caller applies the same
 * classes from the same store state, so an override (the space menu) lands
 * everywhere at once without any page surface re-rendering.
 */
export function useHudPageClasses() {
  const hudPage = useRoomStore((state) => state.hudPage);
  const hudSpaceEntry = useRoomStore((state) => state.hudSpaceEntry);

  useEffect(() => {
    const app = document.querySelector<HTMLElement>(".desktop-app");
    if (!app) return undefined;
    const definition = HUD_PAGES[hudPage];
    // `mockup.html` writes both `page-NN` and the number's own chrome flags on
    // `.scene`; several mockup rules hang off the class rather than the page
    // number — including the collapsed rail geometry for 01/04 — so the class
    // has to be published alongside `data-hud-page`.
    const pageClass = `page-${definition.number}`;
    app.dataset.hudPage = definition.number;
    app.classList.add(pageClass);
    app.classList.toggle("comp-left", definition.companion.seat === "left");
    app.classList.toggle("no-comp", definition.companion.mode === "hidden");
    if (hudPage === "space") {
      app.dataset.hudSpace = hudSpaceEntry ?? "returning";
      app.classList.toggle("space-first", hudSpaceEntry === "first");
      app.classList.toggle("space-returning", hudSpaceEntry !== "first");
    }
    return () => {
      delete app.dataset.hudPage;
      delete app.dataset.hudSpace;
      app.classList.remove(pageClass, "comp-left", "no-comp", "space-first", "space-returning");
    };
  }, [hudPage, hudSpaceEntry]);
}
