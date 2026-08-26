import { describe, expect, it, vi } from "vitest";
import type { GatewayResultV1 } from "@ailearn/shared/desktop-ipc-contracts";
import { unwrapGatewayResult } from "./desktop-client";
import {
  asGateInvalidationCode,
  publishGateInvalidation,
  subscribeGateInvalidation,
} from "./gate-invalidation";

function failure(code: "auth_required" | "reauth_required" | "stale_workspace" | "api_unavailable" | "api_untrusted" | "configuration_error" | "unsupported_contract" | "forbidden"): GatewayResultV1<never> {
  return {
    version: 1,
    ok: false,
    requestId: "request-test",
    correlationId: "correlation-test",
    schemaRevision: "desktop-ipc-v1",
    error: {
      code,
      safeMessageKey: `error.${code}`,
      retry: code === "stale_workspace"
        ? "resync_first"
        : code === "api_unavailable"
          ? "safe_retry"
          : code === "forbidden" || code === "unsupported_contract"
            ? "never"
            : "user_action",
    },
  };
}

describe("renderer gate invalidation channel", () => {
  it("recognizes identity, workspace, runtime-trust and contract failures", () => {
    expect(asGateInvalidationCode("auth_required")).toBe("auth_required");
    expect(asGateInvalidationCode("reauth_required")).toBe("reauth_required");
    expect(asGateInvalidationCode("stale_workspace")).toBe("stale_workspace");
    expect(asGateInvalidationCode("api_unavailable")).toBe("api_unavailable");
    expect(asGateInvalidationCode("api_untrusted")).toBe("api_untrusted");
    expect(asGateInvalidationCode("configuration_error")).toBe("configuration_error");
    expect(asGateInvalidationCode("unsupported_contract")).toBe("unsupported_contract");
    expect(asGateInvalidationCode("forbidden")).toBeNull();
    expect(asGateInvalidationCode("conflict")).toBeNull();
  });

  it("broadcasts authoritative child failures through the shared unwrap boundary", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeGateInvalidation(listener);

    for (const code of [
      "auth_required",
      "reauth_required",
      "stale_workspace",
      "api_unavailable",
      "api_untrusted",
      "configuration_error",
      "unsupported_contract",
    ] as const) {
      expect(() => unwrapGatewayResult(failure(code))).toThrowError(`error.${code}`);
    }
    expect(listener.mock.calls).toEqual([
      ["auth_required"],
      ["reauth_required"],
      ["stale_workspace"],
      ["api_unavailable"],
      ["api_untrusted"],
      ["configuration_error"],
      ["unsupported_contract"],
    ]);

    expect(() => unwrapGatewayResult(failure("forbidden"))).toThrowError("error.forbidden");
    expect(listener).toHaveBeenCalledTimes(7);
    unsubscribe();
  });

  it("isolates listeners and supports deterministic cleanup", () => {
    const survivor = vi.fn();
    const stopThrowing = subscribeGateInvalidation(() => {
      throw new Error("stale listener");
    });
    const stopSurvivor = subscribeGateInvalidation(survivor);

    expect(() => publishGateInvalidation("auth_required")).not.toThrow();
    expect(survivor).toHaveBeenCalledOnce();

    stopThrowing();
    stopSurvivor();
    publishGateInvalidation("auth_required");
    expect(survivor).toHaveBeenCalledOnce();
  });
});
