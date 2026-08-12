import assert from "node:assert/strict";
import test from "node:test";
import { CompanionBootstrapError, parseCompanionBootstrap } from "./bootstrap.ts";

const validBootstrap = {
  version: 1,
  userId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  account: {
    revision: 3,
    epoch: 1,
    globalEnabled: true,
    animationOff: false,
    voiceOff: false,
  },
  features: {
    petSurface: true,
    textConversation: false,
    voiceDialogue: false,
    live2d: true,
    learningActions: false,
    streamingVoice: false,
  },
  serverTime: "2026-08-11T12:00:00.000Z",
};

test("bootstrap parser preserves only the supported capability projection", () => {
  const parsed = parseCompanionBootstrap(validBootstrap);
  assert.equal(parsed.features.live2d, true);
  assert.equal(parsed.features.learningActions, false);
  assert.deepEqual(parsed.account, {
    globalEnabled: true,
    epoch: 1,
    animationOff: false,
    voiceOff: false,
  });
});

test("bootstrap parser fails closed on malformed capability values", () => {
  assert.throws(
    () => parseCompanionBootstrap({
      ...validBootstrap,
      features: { ...validBootstrap.features, voiceDialogue: "true" },
    }),
    CompanionBootstrapError,
  );
});

test("bootstrap parser rejects invalid scope and server timestamp", () => {
  assert.throws(
    () => parseCompanionBootstrap({ ...validBootstrap, userId: "user-1" }),
    CompanionBootstrapError,
  );
  assert.throws(
    () => parseCompanionBootstrap({ ...validBootstrap, serverTime: "not-a-date" }),
    CompanionBootstrapError,
  );
});
