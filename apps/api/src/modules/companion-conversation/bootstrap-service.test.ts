import { test } from "node:test";
import assert from "node:assert/strict";
import { getCompanionBootstrapFeatures } from "./bootstrap-service.ts";
import { companionBootstrapResponseV1Schema } from "@ailearn/shared";

test("bootstrap features fail-closed：无阶段开关时能力关闭", () => {
  const saved = process.env.COMPANION_DIALOGUE_V1_ENABLED;
  const actionSaved = process.env.COMPANION_ACTION_BRIDGE_V1_ENABLED;
  const live2dSaved = process.env.COMPANION_LIVE2D_V1_ENABLED;
  const petSaved = process.env.COMPANION_PET_V1_ENABLED;
  delete process.env.COMPANION_DIALOGUE_V1_ENABLED;
  delete process.env.COMPANION_ACTION_BRIDGE_V1_ENABLED;
  delete process.env.COMPANION_LIVE2D_V1_ENABLED;
  delete process.env.COMPANION_PET_V1_ENABLED;
  const f = getCompanionBootstrapFeatures();
  // §13.1：companion_pet_v1 是服务端账号 capability，无开关时 fail-closed，
  // 不再硬编码恒 true。
  assert.equal(f.petSurface, false, "COMPANION_PET_V1_ENABLED 未开启时关闭");
  assert.equal(f.textConversation, false, "P2 开关默认 fail-closed");
  assert.equal(f.voiceDialogue, false);
  assert.equal(f.live2d, false);
  assert.equal(f.learningActions, false);
  assert.equal(f.streamingVoice, false);
  if (saved !== undefined) process.env.COMPANION_DIALOGUE_V1_ENABLED = saved;
  if (actionSaved !== undefined) process.env.COMPANION_ACTION_BRIDGE_V1_ENABLED = actionSaved;
  if (live2dSaved !== undefined) process.env.COMPANION_LIVE2D_V1_ENABLED = live2dSaved;
  if (petSaved !== undefined) process.env.COMPANION_PET_V1_ENABLED = petSaved;
  else delete process.env.COMPANION_PET_V1_ENABLED;
});

test("bootstrap features：显式开启 petSurface（COMPANION_PET_V1_ENABLED）", () => {
  const saved = process.env.COMPANION_PET_V1_ENABLED;
  process.env.COMPANION_PET_V1_ENABLED = "true";
  assert.equal(getCompanionBootstrapFeatures().petSurface, true);
  if (saved !== undefined) process.env.COMPANION_PET_V1_ENABLED = saved;
  else delete process.env.COMPANION_PET_V1_ENABLED;
});

test("bootstrap features：显式开启 P4 Live2D 能力", () => {
  const saved = process.env.COMPANION_LIVE2D_V1_ENABLED;
  process.env.COMPANION_LIVE2D_V1_ENABLED = "true";
  assert.equal(getCompanionBootstrapFeatures().live2d, true);
  if (saved !== undefined) process.env.COMPANION_LIVE2D_V1_ENABLED = saved;
  else delete process.env.COMPANION_LIVE2D_V1_ENABLED;
});

test("bootstrap features：显式开启 textConversation", () => {
  const saved = process.env.COMPANION_DIALOGUE_V1_ENABLED;
  const actionSaved = process.env.COMPANION_ACTION_BRIDGE_V1_ENABLED;
  process.env.COMPANION_DIALOGUE_V1_ENABLED = "true";
  process.env.COMPANION_ACTION_BRIDGE_V1_ENABLED = "false";
  assert.equal(getCompanionBootstrapFeatures().textConversation, true);
  assert.equal(getCompanionBootstrapFeatures().learningActions, false);
  process.env.COMPANION_ACTION_BRIDGE_V1_ENABLED = "true";
  assert.equal(getCompanionBootstrapFeatures().learningActions, true);
  if (saved !== undefined) process.env.COMPANION_DIALOGUE_V1_ENABLED = saved;
  else delete process.env.COMPANION_DIALOGUE_V1_ENABLED;
  if (actionSaved !== undefined) process.env.COMPANION_ACTION_BRIDGE_V1_ENABLED = actionSaved;
  else delete process.env.COMPANION_ACTION_BRIDGE_V1_ENABLED;
});

test("bootstrap response schema：全 false features 合法", () => {
  const result = companionBootstrapResponseV1Schema.safeParse({
    version: 1,
    userId: "123e4567-e89b-12d3-a456-426614174000",
    workspaceId: "123e4567-e89b-12d3-a456-426614174001",
    account: {
      revision: 0,
      epoch: 0,
      globalEnabled: true,
    },
    features: {
      petSurface: true,
      textConversation: false,
      voiceDialogue: false,
      live2d: false,
      learningActions: false,
      streamingVoice: false,
    },
    serverTime: "2026-08-10T00:00:00.000Z",
  });
  assert.equal(result.success, true);
});

test("bootstrap response schema：未知 feature 拒绝（strict）", () => {
  const result = companionBootstrapResponseV1Schema.safeParse({
    version: 1,
    userId: "123e4567-e89b-12d3-a456-426614174000",
    workspaceId: "123e4567-e89b-12d3-a456-426614174001",
    account: { revision: 0, epoch: 0, globalEnabled: false },
    features: { petSurface: true, textConversation: true, extra: true },
    serverTime: "2026-08-10T00:00:00.000Z",
  });
  assert.equal(result.success, false);
});
