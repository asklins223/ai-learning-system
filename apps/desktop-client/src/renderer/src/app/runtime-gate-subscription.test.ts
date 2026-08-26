import { describe, expect, it, vi } from "vitest";
import type { AILearnDesktopApiM2, RequestMetaV1 } from "@ailearn/shared/desktop-ipc-contracts";
import { establishRequiredRuntimeSubscription } from "./runtime-gate-subscription";

const meta: RequestMetaV1 = {
  version: 1,
  contractVersion: "desktop-ipc-v1",
  requestId: "request-runtime-subscription",
  correlationId: "correlation-runtime-subscription",
  clientStartedAt: "2026-08-24T00:00:00.000Z",
};

function subscriptionApi(options: { onEventThrows?: boolean } = {}) {
  const order: string[] = [];
  const stopEvents = vi.fn();
  const unsubscribe = vi.fn(async () => ({
    version: 1 as const,
    ok: true as const,
    data: { closed: true as const },
    requestId: meta.requestId,
    correlationId: meta.correlationId,
    schemaRevision: "desktop-ipc-v1",
  }));
  const api = {
    subscriptions: {
      subscribe: vi.fn(async () => {
        order.push("subscribe");
        return {
          version: 1 as const,
          ok: true as const,
          data: { subscriptionId: "runtime-subscription" },
          requestId: meta.requestId,
          correlationId: meta.correlationId,
          schemaRevision: "desktop-ipc-v1",
        };
      }),
      onEvent: vi.fn(() => {
        order.push("onEvent");
        if (options.onEventThrows) throw new Error("listener registration failed");
        return stopEvents;
      }),
      unsubscribe,
    },
  } as Pick<AILearnDesktopApiM2, "subscriptions">;
  return { api, order, stopEvents, unsubscribe };
}

describe("required runtime gate subscription", () => {
  it("returns only after the runtime listener is registered and closes once", async () => {
    const fixture = subscriptionApi();
    const subscription = await establishRequiredRuntimeSubscription(fixture.api, meta, vi.fn());

    expect(fixture.order).toEqual(["subscribe", "onEvent"]);
    subscription.close();
    subscription.close();
    expect(fixture.stopEvents).toHaveBeenCalledOnce();
    expect(fixture.unsubscribe).toHaveBeenCalledOnce();
  });

  it("rejects and cleans up if listener registration cannot be confirmed", async () => {
    const fixture = subscriptionApi({ onEventThrows: true });

    await expect(establishRequiredRuntimeSubscription(fixture.api, meta, vi.fn())).rejects.toThrow("listener registration failed");
    expect(fixture.unsubscribe).toHaveBeenCalledOnce();
  });
});
