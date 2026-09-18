// @vitest-environment jsdom

import { act, cleanup, render, waitFor } from "@testing-library/react";
import type {
  AILearnDesktopApiM2,
  GatewayEventV1,
  GatewayResultV1,
  SessionContextV1,
} from "@ailearn/shared/desktop-ipc-contracts";
import type { RoomProjectionV1 } from "@ailearn/shared/room-projection-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRoomStore } from "./room-store";
import { HomeProjectionProvider, useHomeProjection } from "./home-projection";

type Deferred<T> = {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}

function ok<T>(data: T, workspaceEpoch?: number): GatewayResultV1<T> {
  return {
    version: 1,
    ok: true,
    data,
    requestId: "request-provider-test",
    correlationId: "correlation-provider-test",
    schemaRevision: "desktop-ipc-v1",
    ...(workspaceEpoch ? { workspaceEpoch } : {}),
  };
}

function failure(workspaceEpoch: number): GatewayResultV1<never> {
  return {
    version: 1,
    ok: false,
    requestId: "request-provider-failure",
    correlationId: "correlation-provider-failure",
    schemaRevision: "desktop-ipc-v1",
    workspaceEpoch,
    error: {
      code: "api_unavailable",
      safeMessageKey: "error.api_unavailable",
      retry: "safe_retry",
    },
  };
}

function session(workspaceId: string, workspaceEpoch: number): SessionContextV1 {
  return {
    version: 1,
    status: "authenticated",
    user: {
      userId: "11111111-1111-4111-8111-111111111111",
      email: "owner@example.com",
    },
    workspace: {
      version: 1,
      workspaceId,
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

function projection(workspaceEpoch: number, dashboardRevision: string): RoomProjectionV1 {
  return {
    version: 1,
    workspaceEpoch,
    snapshotAt: "2026-09-11T08:00:00.000Z",
    dashboardRevision,
    mode: "first_use",
    primaryFocus: { state: "empty" },
    queueSummary: { state: "empty" },
    sanitizedReviewSummary: { state: "empty" },
    activeRunSummary: { state: "empty" },
    activeGenerationSummary: { state: "empty" },
    recentObjectiveSummary: { state: "empty" },
    recentActivitySummary: { state: "empty" },
    captureCapability: { state: "disabled", reason: "capability_denied" },
    sectionStates: {
      primaryFocus: { state: "empty" },
      queueSummary: { state: "empty" },
      sanitizedReviewSummary: { state: "empty" },
      activeRunSummary: { state: "empty" },
      activeGenerationSummary: { state: "empty" },
      recentObjectiveSummary: { state: "empty" },
      recentActivitySummary: { state: "empty" },
    },
    degradation: null,
  };
}

type ProjectionSnapshot = ReturnType<typeof useHomeProjection>;
let latest: ProjectionSnapshot | null = null;

function Probe() {
  latest = useHomeProjection();
  return null;
}

function installApi(api: unknown) {
  Object.defineProperty(window, "ailearn", {
    configurable: true,
    value: api as AILearnDesktopApiM2,
  });
}

afterEach(() => {
  cleanup();
  latest = null;
  Reflect.deleteProperty(window, "ailearn");
  vi.restoreAllMocks();
});

beforeEach(() => {
  useRoomStore.setState({ surface: null });
});

describe("HomeProjectionProvider", () => {
  it("keeps the last verified same-workspace projection when refresh fails", async () => {
    const currentSession = session("22222222-2222-4222-8222-222222222222", 1);
    const trusted = projection(1, "home-initial");
    const getProjection = vi.fn()
      .mockResolvedValueOnce(ok(trusted, 1))
      .mockResolvedValueOnce(failure(1));
    installApi({
      auth: { getState: vi.fn().mockResolvedValue(ok(currentSession, 1)) },
      room: { getProjection },
      subscriptions: {
        subscribe: vi.fn().mockRejectedValue(new Error("stream intentionally absent")),
        onEvent: vi.fn(),
        unsubscribe: vi.fn().mockResolvedValue(ok({ closed: true })),
      },
    });

    render(<HomeProjectionProvider><Probe /></HomeProjectionProvider>);
    await waitFor(() => expect(latest?.projection?.dashboardRevision).toBe("home-initial"));

    act(() => latest?.reload());
    await waitFor(() => expect(latest?.loading).toBe(true));
    expect(latest?.projection).toBe(trusted);
    await waitFor(() => expect(latest?.loading).toBe(false));
    expect(latest?.projection).toBe(trusted);
    expect(latest?.failure).toContain("暂时不可用");
    expect(getProjection).toHaveBeenCalledTimes(2);
  });

  it("clears on a workspace event and discards the superseded response generation", async () => {
    const workspaceOne = session("22222222-2222-4222-8222-222222222222", 1);
    const workspaceTwo = session("33333333-3333-4333-8333-333333333333", 2);
    let activeSession = workspaceOne;
    const staleRefresh = deferred<GatewayResultV1<RoomProjectionV1>>();
    const nextWorkspace = deferred<GatewayResultV1<RoomProjectionV1>>();
    const callbacks = new Map<string, (event: GatewayEventV1) => void>();
    const getProjection = vi.fn()
      .mockResolvedValueOnce(ok(projection(1, "workspace-one"), 1))
      .mockImplementationOnce(() => staleRefresh.promise)
      .mockImplementationOnce(() => nextWorkspace.promise);
    installApi({
      auth: { getState: vi.fn().mockImplementation(() => Promise.resolve(ok(activeSession, activeSession.workspaceEpoch))) },
      room: { getProjection },
      subscriptions: {
        subscribe: vi.fn().mockImplementation(({ topic }: { topic: { kind: string } }) => (
          Promise.resolve(ok({ subscriptionId: `${topic.kind}-subscription` }, activeSession.workspaceEpoch))
        )),
        onEvent: vi.fn().mockImplementation((subscriptionId: string, callback: (event: GatewayEventV1) => void) => {
          callbacks.set(subscriptionId, callback);
          return () => callbacks.delete(subscriptionId);
        }),
        unsubscribe: vi.fn().mockResolvedValue(ok({ closed: true })),
      },
    });

    render(<HomeProjectionProvider><Probe /></HomeProjectionProvider>);
    await waitFor(() => expect(latest?.projection?.dashboardRevision).toBe("workspace-one"));
    await waitFor(() => expect(callbacks.size).toBe(2));

    act(() => latest?.reload());
    await waitFor(() => expect(getProjection).toHaveBeenCalledTimes(2));
    activeSession = workspaceTwo;
    act(() => callbacks.get("workspace-subscription")?.({
      version: 1,
      subscriptionId: "workspace-subscription",
      workspaceEpoch: 2,
      cursor: "cursor-workspace-2",
      eventRevision: 2,
      kind: "snapshot_invalidated",
      schemaRevision: "desktop-ipc-v1",
      data: { kind: "snapshot_invalidated", scope: "workspace" },
    }));

    await waitFor(() => {
      expect(latest?.projection).toBeNull();
      expect(latest?.loading).toBe(true);
      expect(getProjection).toHaveBeenCalledTimes(3);
    });

    staleRefresh.resolve(ok(projection(1, "stale-workspace-one"), 1));
    await act(async () => { await Promise.resolve(); });
    expect(latest?.projection).toBeNull();

    nextWorkspace.resolve(ok(projection(2, "workspace-two"), 2));
    await waitFor(() => expect(latest?.projection?.dashboardRevision).toBe("workspace-two"));
    expect(latest?.failure).toBeNull();
  });
});
