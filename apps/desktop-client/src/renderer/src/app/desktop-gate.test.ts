import { describe, expect, it } from "vitest";
import type {
  DesktopContractSnapshotV1,
  GatewayErrorV1,
  SessionContextV1,
} from "@ailearn/shared/desktop-ipc-contracts";
import { RendererGatewayError } from "./desktop-client";
import {
  decideBootstrapGatewayFailure,
  decideRuntimeGate,
  decideSessionGate,
  gateErrorPolicy,
  inspectDesktopContract,
} from "./desktop-gate";

const contract: DesktopContractSnapshotV1 = {
  version: 1,
  contractVersion: "desktop-ipc-v1",
  domainSchemaRevision: "domain-v1",
  deploymentConfigRevision: "deployment-v1",
  namespaces: ["runtime", "auth", "workspace", "room", "subscriptions"],
  enabledRoutes: ["room.home"],
};

const authenticatedSession: SessionContextV1 = {
  version: 1,
  status: "authenticated",
  user: {
    userId: "11111111-1111-4111-8111-111111111111",
    email: "owner@example.com",
  },
  workspace: {
    version: 1,
    workspaceId: "22222222-2222-4222-8222-222222222222",
    name: "个人学习空间",
    role: "owner",
    workspaceType: "personal",
    isPersonal: true,
    workspaceEpoch: 7,
  },
  membership: { role: "owner" },
  capabilities: null,
  workspaceEpoch: 7,
  credentialPersistence: "memory",
};

function gatewayError(overrides: Partial<GatewayErrorV1> = {}): RendererGatewayError {
  return new RendererGatewayError({
    code: "api_unavailable",
    safeMessageKey: "error.api_unavailable",
    retry: "safe_retry",
    ...overrides,
  });
}

describe("desktop contract gate", () => {
  it("requires the bridge namespaces and room route used by the golden slice", () => {
    expect(inspectDesktopContract(contract)).toEqual({ kind: "supported" });
    expect(inspectDesktopContract({ ...contract, enabledRoutes: [] })).toMatchObject({ kind: "blocked", reason: "route" });
    expect(inspectDesktopContract({ ...contract, namespaces: contract.namespaces.filter((value) => value !== "auth") })).toMatchObject({
      kind: "blocked",
      reason: "namespace",
    });
  });
});

describe("runtime gate", () => {
  it("connects an authoritative checking state and opens only on ready", () => {
    expect(decideRuntimeGate({ version: 1, kind: "checking", originKind: "local_loopback" }).kind).toBe("connect");
    expect(decideRuntimeGate({ version: 1, kind: "ready", schemaRevision: "domain-v1" }).kind).toBe("ready");
  });

  it("allows safe retry only for an unavailable API", () => {
    expect(decideRuntimeGate({ version: 1, kind: "api_unavailable" })).toMatchObject({ kind: "blocked", retry: "safe_retry" });
    expect(decideRuntimeGate({ version: 1, kind: "configuration_error", reason: "pairing_secret_missing" })).toMatchObject({
      kind: "blocked",
      retry: "user_action",
    });
    expect(decideRuntimeGate({ version: 1, kind: "api_untrusted", reason: "bad_hmac" })).toMatchObject({
      kind: "blocked",
      retry: "user_action",
    });
  });
});

describe("session and workspace gate", () => {
  it("distinguishes anonymous, restoring, reauthentication and workspace selection", () => {
    expect(decideSessionGate({
      version: 1,
      status: "anonymous",
      user: null,
      workspace: null,
      membership: null,
      capabilities: null,
      workspaceEpoch: 0,
      credentialPersistence: "none",
    }).kind).toBe("authenticate");

    expect(decideSessionGate({
      version: 1,
      status: "restoring",
      user: null,
      workspace: null,
      membership: null,
      capabilities: null,
      workspaceEpoch: 0,
      credentialPersistence: "safe_storage",
    })).toEqual({ kind: "wait", reason: "restoring" });

    expect(decideSessionGate({ ...authenticatedSession, status: "reauth_required" }).kind).toBe("reauthenticate");
    expect(decideSessionGate({ ...authenticatedSession, workspace: null, membership: null }).kind).toBe("workspace_required");
  });

  it("requires matching workspace, membership and capability epochs", () => {
    expect(decideSessionGate(authenticatedSession).kind).toBe("ready");
    expect(decideSessionGate({
      ...authenticatedSession,
      workspace: { ...authenticatedSession.workspace!, workspaceEpoch: 8 },
    }).kind).toBe("resync");
    expect(decideSessionGate({ ...authenticatedSession, membership: { role: "member" } }).kind).toBe("resync");
  });

  it("never trusts workspace data carried by an unavailable or untrusted session", () => {
    expect(decideSessionGate({ ...authenticatedSession, status: "api_unavailable" })).toMatchObject({ kind: "blocked", reason: "api_unavailable" });
    expect(decideSessionGate({ ...authenticatedSession, status: "api_untrusted" })).toMatchObject({ kind: "blocked", reason: "api_untrusted" });
  });
});

describe("gateway retry policy", () => {
  it("routes bootstrap authentication boundaries without reopening old content", () => {
    expect(decideBootstrapGatewayFailure(gatewayError({
      code: "auth_required",
      safeMessageKey: "error.auth_required",
      retry: "user_action",
    }))).toEqual({ kind: "authenticate" });
    expect(decideBootstrapGatewayFailure(gatewayError({
      code: "reauth_required",
      safeMessageKey: "error.reauth_required",
      retry: "user_action",
    }))).toEqual({ kind: "reauthenticate" });
    expect(decideBootstrapGatewayFailure(gatewayError({
      code: "stale_workspace",
      safeMessageKey: "error.stale_workspace",
      retry: "resync_first",
    }))).toEqual({ kind: "resync" });
    expect(decideBootstrapGatewayFailure(gatewayError({
      code: "forbidden",
      safeMessageKey: "error.forbidden",
      retry: "never",
    }))).toEqual({ kind: "blocked" });
  });

  it("preserves the authoritative retry classification", () => {
    expect(gateErrorPolicy(gatewayError()).retry).toBe("safe_retry");
    expect(gateErrorPolicy(gatewayError({ code: "stale_workspace", safeMessageKey: "error.stale_workspace", retry: "resync_first" })).retry).toBe("resync_first");
    expect(gateErrorPolicy(gatewayError({ code: "api_untrusted", safeMessageKey: "error.api_untrusted", retry: "user_action" })).retry).toBe("user_action");
    expect(gateErrorPolicy(gatewayError({ code: "forbidden", safeMessageKey: "error.forbidden", retry: "never" })).retry).toBe("never");
  });

  it("does not invent a retry policy for unknown failures", () => {
    expect(gateErrorPolicy(new Error("opaque failure"))).toMatchObject({ retry: "never" });
  });
});
