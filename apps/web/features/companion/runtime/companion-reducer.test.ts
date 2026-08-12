import { test } from "node:test";
import assert from "node:assert/strict";
import { companionReducer } from "./companion-reducer.ts";
import { pageHelpModel, type CompanionSurfaceState } from "./surface-model.ts";

test("companion surface is mutually exclusive: anchor → panel → anchor", () => {
  const anchor: CompanionSurfaceState = { kind: "anchor", pageKind: "card-detail" };
  const panel = companionReducer(anchor, {
    type: "summon",
    model: pageHelpModel("card-detail"),
    returnFocusId: "companion-v2-anchor",
  });
  assert.equal(panel.kind, "panel");
  assert.ok(panel.kind === "panel" && panel.model.actions.length > 0);

  const closed = companionReducer(panel, { type: "close_panel", pageKind: "card-detail" });
  assert.deepEqual(closed, anchor);
});

test("hidden surface cannot be summoned", () => {
  const hidden: CompanionSurfaceState = { kind: "hidden", reason: "global_off" };
  const next = companionReducer(hidden, {
    type: "summon",
    model: pageHelpModel("home"),
  });
  assert.deepEqual(next, hidden);
});
