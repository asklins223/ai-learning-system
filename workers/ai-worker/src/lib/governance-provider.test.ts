import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AIConsentRequiredError,
  AIDataPolicyDeniedError,
  createGovernedProvider,
  type WorkspaceAIPolicy,
} from "./governance.ts";
import type { AIProvider } from "./ai-provider.ts";

const workspaceId = "00000000-0000-0000-0000-000000000001";

function makeProvider() {
  let seenMessages: unknown[] | undefined;
  const provider = {
    id: "openai_compatible",
    modelId: "test-model",
    visionModelId: "test-vision-model",
    promptVersion: "test-v1",
    async chatCompletion(messages: unknown[]) {
      seenMessages = messages;
      return { content: "ok", usage: {} };
    },
    getCapabilities(this: { id: string }) {
      return { providerId: this.id };
    },
  } as unknown as AIProvider;
  return { provider, getSeenMessages: () => seenMessages };
}

function policy(overrides: Partial<WorkspaceAIPolicy> = {}): WorkspaceAIPolicy {
  return {
    sendToExternal: true,
    sendImageContent: true,
    piiDetection: true,
    auditLogging: true,
    ...overrides,
  };
}

test("governed provider rejects external calls when consent is missing", async () => {
  const { provider } = makeProvider();
  const governed = createGovernedProvider(
    provider,
    { consentOk: false, policy: policy() },
    workspaceId,
  );

  await assert.rejects(
    () => governed.chatCompletion([{ role: "user", content: "hello" }], {}),
    AIConsentRequiredError,
  );
});

test("governed provider enforces sendToExternal and sanitizes PII", async () => {
  const denied = makeProvider();
  const deniedProvider = createGovernedProvider(
    denied.provider,
    { consentOk: true, policy: policy({ sendToExternal: false }) },
    workspaceId,
  );
  await assert.rejects(
    () => deniedProvider.chatCompletion([{ role: "user", content: "hello" }], {}),
    AIDataPolicyDeniedError,
  );

  const allowed = makeProvider();
  const allowedProvider = createGovernedProvider(
    allowed.provider,
    { consentOk: true, policy: policy() },
    workspaceId,
  );
  await allowedProvider.chatCompletion([
    { role: "user", content: "联系 test@example.com" },
  ], {});
  const sent = allowed.getSeenMessages() as Array<{ content: string }>;
  assert.ok(sent[0]!.content.includes("***") || !sent[0]!.content.includes("test@example.com"));
  assert.equal(allowedProvider.getCapabilities?.().providerId, "openai_compatible");
});

test("governed provider enforces sendImageContent for multimodal messages", async () => {
  const { provider } = makeProvider();
  const governed = createGovernedProvider(
    provider,
    { consentOk: true, policy: policy({ sendImageContent: false }) },
    workspaceId,
  );

  await assert.rejects(
    () => governed.chatCompletion([{
      role: "user",
      content: [
        { type: "text", text: "inspect" },
        { type: "image_url", image_url: { url: "https://example.com/image.png" } },
      ],
    } as never], {}),
    AIDataPolicyDeniedError,
  );
});
