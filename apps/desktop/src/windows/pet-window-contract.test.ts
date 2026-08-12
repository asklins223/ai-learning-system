import test from "node:test";
import assert from "node:assert/strict";
import {
  createPetWindowOptions,
  extraWidthForPetScale,
  isPetRouteUrl,
  petContentSizeForScale,
  petRouteUrl,
} from "./pet-window-contract";

test("Pet Window uses the frozen transparent 560x520 contract", () => {
  const options = createPetWindowOptions("/tmp/pet-preload.cjs", true);
  assert.equal(options.width, 560);
  assert.equal(options.height, 520);
  assert.equal(options.transparent, true);
  assert.equal(options.frame, false);
  assert.equal(options.skipTaskbar, true);
  assert.equal(options.alwaysOnTop, true);
  assert.equal(options.webPreferences?.contextIsolation, true);
  assert.equal(options.webPreferences?.nodeIntegration, false);
  assert.equal(options.webPreferences?.sandbox, true);
});

test("pet scale changes only the effective content width", () => {
  assert.equal(extraWidthForPetScale(0.85), 0);
  assert.deepEqual(petContentSizeForScale(1.25), { width: 621, height: 520 });
  assert.deepEqual(petContentSizeForScale(1.15), { width: 597, height: 520 });
});

test("Pet route is exact-origin and path constrained", () => {
  const base = "http://127.0.0.1:3011";
  const route = petRouteUrl(base);
  assert.equal(isPetRouteUrl(route, base), true);
  assert.equal(isPetRouteUrl(`${base}/companion/pet/other`, base), false);
  assert.equal(isPetRouteUrl("http://localhost:3011/companion/pet", base), false);
  assert.equal(isPetRouteUrl("https://127.0.0.1:3011/companion/pet", base), false);
});
