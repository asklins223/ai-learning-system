import { describe, expect, it } from "vitest";
import { HUD_PAGES, type HudPageId } from "./hud-pages";

const EXPECTED_PAGES: readonly HudPageId[] = [
  "home",
  "login",
  "register",
  "space",
  "sources",
  "source-detail",
  "notes",
  "note-read",
  "note-edit",
  "goals",
  "goal-detail",
  "generating",
  "candidate",
  "today",
  "queue",
  "assessment",
  "result",
  "search",
  "graph",
  "companion",
  "settings",
] as const;

describe("HUD companion surface policies", () => {
  it("keeps one exhaustive policy for every HUD page", () => {
    expect(Object.keys(HUD_PAGES)).toEqual(EXPECTED_PAGES);
    for (const page of EXPECTED_PAGES) {
      const definition = HUD_PAGES[page];
      expect(definition.id).toBe(page);
      expect(definition.companion).toMatchObject({
        mode: expect.any(String),
        seat: expect.any(String),
        framing: expect.any(String),
        interaction: expect.any(String),
        proactive: expect.any(String),
        draggable: expect.any(Boolean),
      });
    }
  });

  it("hides authentication pages and never requests an interactive actor there", () => {
    for (const page of ["login", "register"] as const) {
      expect(HUD_PAGES[page].companion).toEqual({
        mode: "hidden",
        seat: "none",
        framing: "bust",
        interaction: "none",
        proactive: "silent",
        draggable: false,
      });
    }
  });

  it("keeps task pages quiet and on demand", () => {
    for (const page of EXPECTED_PAGES.filter((id) => !["home", "login", "register"].includes(id))) {
      const policy = HUD_PAGES[page].companion;
      expect(policy.proactive).toBe("silent");
      expect(policy.interaction).toBe("on-demand");
      expect(policy.draggable).toBe(false);
    }
  });

  it("uses compact fail-closed assessment policies", () => {
    for (const page of ["assessment", "result"] as const) {
      expect(HUD_PAGES[page].companion).toMatchObject({
        mode: "assessment",
        framing: "bust",
        interaction: "on-demand",
        proactive: "silent",
        draggable: false,
      });
    }
  });

  it("does not register the history drawer as a HUD page", () => {
    expect(Object.keys(HUD_PAGES)).not.toContain("drawer");
  });
});
