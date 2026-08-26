import type {
  AILearnDesktopApiM2,
  GatewayEventV1,
  RequestMetaV1,
} from "@ailearn/shared/desktop-ipc-contracts";
import { createRequestMeta, unwrapGatewayResult } from "./desktop-client";

type RuntimeSubscriptionApi = Pick<AILearnDesktopApiM2, "subscriptions">;

export type RequiredRuntimeSubscription = {
  readonly subscriptionId: string;
  close(): void;
};

function safelyUnsubscribe(
  api: RuntimeSubscriptionApi,
  subscriptionId: string,
): void {
  try {
    void api.subscriptions.unsubscribe({ meta: createRequestMeta(), subscriptionId }).catch(() => undefined);
  } catch {
    // The renderer is already fail-closed; cleanup failure must not reopen it.
  }
}

export async function establishRequiredRuntimeSubscription(
  api: RuntimeSubscriptionApi,
  meta: RequestMetaV1,
  listener: (event: GatewayEventV1) => void,
): Promise<RequiredRuntimeSubscription> {
  const response = await api.subscriptions.subscribe({ meta, topic: { kind: "runtime" } });
  const subscriptionId = unwrapGatewayResult(response).subscriptionId;
  let stopEvents: (() => void) | null = null;
  let closed = false;

  try {
    stopEvents = api.subscriptions.onEvent(subscriptionId, listener);
  } catch (error) {
    safelyUnsubscribe(api, subscriptionId);
    throw error;
  }

  return {
    subscriptionId,
    close() {
      if (closed) return;
      closed = true;
      stopEvents?.();
      safelyUnsubscribe(api, subscriptionId);
    },
  };
}
