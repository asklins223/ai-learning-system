import test from "node:test";
import assert from "node:assert/strict";
import {
  desktopPetCapabilitiesV1Schema,
  desktopPetWindowStateV1Schema,
  petBootstrapResultV1Schema,
  petHitGeometryV1Schema,
} from "@ailearn/shared";
import { PET_IPC_CHANNELS } from "./contract";

test("IPC surface has stable, bounded channel names and strict shared payloads", () => {
  assert.equal(PET_IPC_CHANNELS.getCapabilities, "pet:get-capabilities");
  assert.equal(PET_IPC_CHANNELS.openMainRoute, "pet:open-main-route");
  assert.equal(petBootstrapResultV1Schema.safeParse({ version: 1, kind: "ready", extra: true }).success, false);
  assert.equal(desktopPetCapabilitiesV1Schema.safeParse({
    version: 1,
    platform: "darwin",
    transparentWindow: true,
    forwardedClickThrough: true,
    showInactive: true,
    contentProtection: false,
  }).success, true);
});

test("window and hit geometry contracts reject out-of-range values", () => {
  assert.equal(desktopPetWindowStateV1Schema.safeParse({
    version: 1,
    revision: 1,
    visible: true,
    displayId: "main",
    boundsDip: { x: 0, y: 0, width: 560, height: 520 },
    contentSizeCssPx: { width: 622, height: 520 },
    scaleFactor: 2,
    petModeEnabled: true,
    petScale: 1,
    locked: false,
    alwaysOnTop: true,
    privacyMode: false,
    interactionMode: "passive",
  }).success, false);
  assert.equal(petHitGeometryV1Schema.safeParse({
    version: 1,
    revision: 1,
    contentWidth: 560,
    contentHeight: 520,
    petScale: 1,
    regions: [{ id: "character", kind: "rect", rect: { x: 0, y: 0, width: 100, height: 100 } }],
  }).success, true);
});
