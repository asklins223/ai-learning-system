import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  getDefaultDevicePetPreferences,
  loadDevicePetPreferences,
  normalizeDevicePetPreferences,
  resolvePetPosition,
  saveDevicePetPreferences,
  updatePreferencesForPosition,
  type DisplayGeometryV1,
} from "./device-pet-preferences";

const display: DisplayGeometryV1 = {
  id: "main",
  scaleFactor: 2,
  workArea: { x: 0, y: 0, width: 1440, height: 900 },
  fingerprint: "a".repeat(64),
};

test("new preferences default to pet mode enabled (Owner 2026-08-12)", () => {
  const preferences = getDefaultDevicePetPreferences(display);
  assert.equal(preferences.petModeEnabled, true);
  assert.equal(preferences.alwaysOnTop, true);
  assert.equal(preferences.privacyMode, false);
  assert.equal(preferences.petScale, 1);
  const position = resolvePetPosition(preferences, display, { width: 560, height: 520 });
  assert.deepEqual(position, { x: 872, y: 372 });
});

test("corrupt or out-of-range preferences recover without throwing", () => {
  const normalized = normalizeDevicePetPreferences({
    version: 999,
    normalizedX: 8,
    normalizedY: -2,
    scaleFactor: Number.NaN,
    petScale: 4,
    displayFingerprint: "bad",
  }, display);
  assert.equal(normalized.normalizedX, 1);
  assert.equal(normalized.normalizedY, 0);
  assert.equal(normalized.scaleFactor, 2);
  assert.equal(normalized.petScale, 1);
  assert.equal(normalized.displayFingerprint, display.fingerprint);
});

test("position persistence is normalized, clamped, and atomic", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ailearn-pet-"));
  try {
    const base = getDefaultDevicePetPreferences(display);
    const moved = updatePreferencesForPosition(base, display, { x: 400, y: 200 }, { width: 560, height: 520 });
    await saveDevicePetPreferences(dir, moved);
    assert.deepEqual(loadDevicePetPreferences(dir), moved);
    writeFileSync(path.join(dir, "desktop-pet-preferences-v1.json"), "not-json", "utf8");
    assert.equal(loadDevicePetPreferences(dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
