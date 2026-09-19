// @vitest-environment jsdom

import { act, cleanup, render, waitFor } from "@testing-library/react";
import type { GatewayResultV1, SessionContextV1 } from "@ailearn/shared/desktop-ipc-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSurfaceProjection, formatRelative, formatSourceStamp, type SurfaceProjectionOptions } from "./surface-data";

function session(workspaceEpoch: number): SessionContextV1 {
  return {
    version: 1,
    status: "authenticated",
    user: { userId: "11111111-1111-4111-8111-111111111111", email: "owner@example.com" },
    workspace: {
      version: 1,
      workspaceId: "22222222-2222-4222-8222-222222222222",
      name: `Workspace ${workspaceEpoch}`,
      role: "owner",
      workspaceType: "personal",
      isPersonal: true,
      workspaceEpoch,
    },
    membership: { role: "owner" },
    capabilities: null,
    workspaceEpoch,
    credentialPersistence: "memory",
  };
}

function ok<T>(data: T): GatewayResultV1<T> {
  return {
    version: 1,
    ok: true,
    data,
    requestId: "surface-data-test",
    correlationId: "surface-data-test",
    schemaRevision: "desktop-ipc-v1",
  };
}

function installApi() {
  Object.defineProperty(window, "ailearn", {
    configurable: true,
    value: { auth: { getState: vi.fn().mockResolvedValue(ok(session(7))) } },
  });
}

type Snapshot = ReturnType<typeof useSurfaceProjection<string>>;
let latest: Snapshot | null = null;

function Probe({ read, options }: { readonly read: () => Promise<string>; readonly options?: SurfaceProjectionOptions }) {
  latest = useSurfaceProjection(read, [], options);
  return null;
}

/** Let the swallowed rejection of a silent re-read settle before asserting. */
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

function defineVisibility(value: DocumentVisibilityState) {
  Object.defineProperty(document, "visibilityState", { configurable: true, value });
}

afterEach(() => {
  cleanup();
  latest = null;
  Reflect.deleteProperty(window, "ailearn");
  Reflect.deleteProperty(document, "visibilityState");
  vi.restoreAllMocks();
});

describe("the index row's two time columns", () => {
  it("never print the same string, at any age", () => {
    const now = Date.now();
    const ages = [0, 30_000, 45 * 60_000, 5 * 3_600_000, 26 * 3_600_000, 50 * 3_600_000, 40 * 86_400_000];
    for (const age of ages) {
      const stamp = new Date(now - age).toISOString();
      expect(formatSourceStamp(stamp)).not.toBe(formatRelative(stamp));
    }
  });

  it("keeps the clock on every row, which is what the relative line omits", () => {
    expect(formatSourceStamp(new Date().toISOString())).toMatch(/^今天 \d{2}:\d{2}$/);
    expect(formatSourceStamp(new Date(Date.now() - 26 * 3_600_000).toISOString())).toMatch(/^昨天 \d{2}:\d{2}$/);
    expect(formatSourceStamp(new Date(Date.now() - 40 * 86_400_000).toISOString())).toMatch(/日 \d{2}:\d{2}$/);
  });
});

describe("useSurfaceProjection refreshOnFocus", () => {
  it("does not re-read on focus unless the page asks for it", async () => {
    installApi();
    const read = vi.fn().mockResolvedValue("only");
    render(<Probe read={read} />);
    await waitFor(() => expect(latest?.data).toBe("only"));

    await act(async () => { window.dispatchEvent(new Event("focus")); await Promise.resolve(); });
    await settle();

    expect(read).toHaveBeenCalledTimes(1);
  });

  it("re-reads on focus when asked, and swaps in the fresher records", async () => {
    installApi();
    const read = vi.fn().mockResolvedValueOnce("first").mockResolvedValueOnce("second");
    render(<Probe read={read} options={{ refreshOnFocus: true }} />);
    await waitFor(() => expect(latest?.data).toBe("first"));

    await act(async () => { window.dispatchEvent(new Event("focus")); await Promise.resolve(); });

    await waitFor(() => expect(latest?.data).toBe("second"));
    expect(read).toHaveBeenCalledTimes(2);
    // A background re-read owns neither the loading paper nor an error card.
    expect(latest?.loading).toBe(false);
    expect(latest?.failure).toBeNull();
    expect(latest?.refreshing).toBe(false);
    expect(latest?.refreshFailure).toBeNull();
  });

  it("keeps the records already on the paper when a focus re-read fails", async () => {
    installApi();
    const read = vi.fn().mockResolvedValueOnce("first").mockRejectedValueOnce(new Error("network down"));
    render(<Probe read={read} options={{ refreshOnFocus: true }} />);
    await waitFor(() => expect(latest?.data).toBe("first"));

    await act(async () => { window.dispatchEvent(new Event("focus")); await Promise.resolve(); });
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    await settle();

    expect(latest?.data).toBe("first");
    expect(latest?.failure).toBeNull();
    expect(latest?.refreshing).toBe(false);
    expect(latest?.refreshFailure).toBe("服务暂时没有返回可确认的结果。");
  });

  it("exposes non-blocking refresh progress without blanking the paper", async () => {
    installApi();
    let resolveRefresh: ((value: string) => void) | undefined;
    const refresh = new Promise<string>((resolve) => { resolveRefresh = resolve; });
    const read = vi.fn().mockResolvedValueOnce("first").mockReturnValueOnce(refresh);
    render(<Probe read={read} options={{ refreshOnFocus: true }} />);
    await waitFor(() => expect(latest?.data).toBe("first"));

    await act(async () => { window.dispatchEvent(new Event("focus")); await Promise.resolve(); });
    await waitFor(() => expect(latest?.refreshing).toBe(true));
    expect(latest?.data).toBe("first");
    expect(latest?.loading).toBe(false);

    await act(async () => { resolveRefresh?.("second"); await refresh; });
    await waitFor(() => expect(latest?.refreshing).toBe(false));
    expect(latest?.data).toBe("second");
  });

  it("ignores an older refresh that resolves after a newer one", async () => {
    installApi();
    let resolveOlder: ((value: string) => void) | undefined;
    let resolveNewer: ((value: string) => void) | undefined;
    const older = new Promise<string>((resolve) => { resolveOlder = resolve; });
    const newer = new Promise<string>((resolve) => { resolveNewer = resolve; });
    const read = vi.fn()
      .mockResolvedValueOnce("first")
      .mockReturnValueOnce(older)
      .mockReturnValueOnce(newer);
    render(<Probe read={read} options={{ refreshOnFocus: true }} />);
    await waitFor(() => expect(latest?.data).toBe("first"));

    await act(async () => { window.dispatchEvent(new Event("focus")); await Promise.resolve(); });
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    await act(async () => { window.dispatchEvent(new Event("focus")); await Promise.resolve(); });
    await waitFor(() => expect(read).toHaveBeenCalledTimes(3));

    await act(async () => { resolveNewer?.("newer"); await newer; });
    await waitFor(() => expect(latest?.data).toBe("newer"));
    await act(async () => { resolveOlder?.("older"); await older; });
    expect(latest?.data).toBe("newer");
  });

  it("re-reads when the app becomes visible again, but not when it is hidden", async () => {
    installApi();
    const read = vi.fn().mockResolvedValue("first");
    render(<Probe read={read} options={{ refreshOnFocus: true }} />);
    await waitFor(() => expect(latest?.data).toBe("first"));

    defineVisibility("hidden");
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); await Promise.resolve(); });
    await settle();
    expect(read).toHaveBeenCalledTimes(1);

    defineVisibility("visible");
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); await Promise.resolve(); });

    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  });
});
