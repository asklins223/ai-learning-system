import {
  DESKTOP_IPC_CONTRACT_VERSION,
  type ApiConnectionStateV1,
  type DesktopContractSnapshotV1,
  type DesktopNamespaceV1,
  type SessionContextV1,
  type WorkspaceContextV1,
} from "@ailearn/shared/desktop-ipc-contracts";
import { gatewayErrorMessage, RendererGatewayError } from "./desktop-client";

const REQUIRED_GATE_NAMESPACES = ["runtime", "auth", "workspace", "room", "subscriptions"] as const satisfies readonly DesktopNamespaceV1[];

export type AuthenticatedDesktopSession = SessionContextV1 & { status: "authenticated" };
export type ReauthenticationDesktopSession = SessionContextV1 & { status: "reauth_required" };
export type ReadyDesktopSession = AuthenticatedDesktopSession & {
  workspace: WorkspaceContextV1;
  membership: { role: "owner" | "member" };
};

export type ContractGateDecision =
  | { kind: "supported" }
  | { kind: "blocked"; reason: "contract_version" | "namespace" | "route"; detail: string };

export type RuntimeGateDecision =
  | { kind: "ready"; connection: Extract<ApiConnectionStateV1, { kind: "ready" }> }
  | { kind: "connect"; connection: Extract<ApiConnectionStateV1, { kind: "checking" }> }
  | {
      kind: "blocked";
      connection: Exclude<ApiConnectionStateV1, { kind: "checking" | "ready" }>;
      title: string;
      detail: string;
      retry: "safe_retry" | "user_action";
    };

export type SessionGateDecision =
  | { kind: "wait"; reason: "restoring" | "switching_workspace" }
  | { kind: "authenticate" }
  | { kind: "reauthenticate"; session: ReauthenticationDesktopSession }
  | { kind: "workspace_required"; session: AuthenticatedDesktopSession }
  | { kind: "ready"; session: ReadyDesktopSession }
  | { kind: "resync"; detail: string }
  | { kind: "blocked"; reason: "api_unavailable" | "api_untrusted"; detail: string };

export type GateErrorPolicy = {
  title: string;
  detail: string;
  retry: "never" | "user_action" | "safe_retry" | "resync_first";
  retryAfter?: string;
};

export type BootstrapGatewayFailureDecision =
  | { kind: "authenticate" }
  | { kind: "reauthenticate" }
  | { kind: "resync" }
  | { kind: "blocked" };

export function inspectDesktopContract(contract: DesktopContractSnapshotV1): ContractGateDecision {
  if (contract.contractVersion !== DESKTOP_IPC_CONTRACT_VERSION) {
    return {
      kind: "blocked",
      reason: "contract_version",
      detail: "当前客户端版本与本机服务不兼容，请更新客户端或联系管理员。",
    };
  }

  const missingNamespace = REQUIRED_GATE_NAMESPACES.find((namespace) => !contract.namespaces.includes(namespace));
  if (missingNamespace) {
    return {
      kind: "blocked",
      reason: "namespace",
      detail: "当前客户端缺少必要功能，请重新安装或联系管理员。",
    };
  }

  if (!contract.enabledRoutes.includes("room.home")) {
    return {
      kind: "blocked",
      reason: "route",
      detail: "当前版本尚未开放学习空间入口，请更新客户端或联系管理员。",
    };
  }

  return { kind: "supported" };
}

export function decideRuntimeGate(connection: ApiConnectionStateV1): RuntimeGateDecision {
  switch (connection.kind) {
    case "ready":
      return { kind: "ready", connection };
    case "checking":
      return { kind: "connect", connection };
    case "api_unavailable":
      return {
        kind: "blocked",
        connection,
        title: "学习服务暂时不可用",
        detail: "暂时连接不上学习服务，请检查网络后重试。",
        retry: "safe_retry",
      };
    case "not_configured":
      return {
        kind: "blocked",
        connection,
        title: "应用尚未完成连接设置",
        detail: "请联系管理员完成配置后，重新打开应用。",
        retry: "user_action",
      };
    case "configuration_error": {
      const reason = connection.reason === "pairing_secret_missing"
        ? "应用缺少连接凭据。"
        : connection.reason === "pairing_secret_invalid"
          ? "应用的连接凭据无效。"
          : "学习服务配置有误。";
      return {
        kind: "blocked",
        connection,
        title: "无法连接学习服务",
        detail: `${reason} 请联系管理员修复后重新打开应用。`,
        retry: "user_action",
      };
    }
    case "api_untrusted": {
      const reason = connection.reason === "wrong_service"
        ? "当前地址不是可用的学习服务。"
        : connection.reason === "wrong_key" || connection.reason === "bad_hmac"
          ? "应用无法验证学习服务的身份。"
          : "学习服务版本与当前客户端不兼容。";
      return {
        kind: "blocked",
        connection,
        title: "无法建立安全连接",
        detail: `${reason} 为保护你的数据，连接已停止。请联系管理员处理。`,
        retry: "user_action",
      };
    }
  }
}

export function decideSessionGate(session: SessionContextV1): SessionGateDecision {
  switch (session.status) {
    case "restoring":
      return { kind: "wait", reason: "restoring" };
    case "anonymous":
      return { kind: "authenticate" };
    case "switching_workspace":
      return { kind: "wait", reason: "switching_workspace" };
    case "reauth_required":
      return { kind: "reauthenticate", session: session as ReauthenticationDesktopSession };
    case "api_unavailable":
      return {
        kind: "blocked",
        reason: "api_unavailable",
        detail: "暂时无法确认登录状态，请检查网络后重试。",
      };
    case "api_untrusted":
      return {
        kind: "blocked",
        reason: "api_untrusted",
        detail: "无法安全确认登录状态。为保护你的数据，应用已停止连接。",
      };
    case "authenticated": {
      const authenticated = session as AuthenticatedDesktopSession;
      if (!authenticated.workspace) return { kind: "workspace_required", session: authenticated };
      if (!authenticated.membership) {
        return { kind: "resync", detail: "你的学习空间信息不完整，请重新同步。" };
      }
      if (authenticated.workspace.workspaceEpoch !== authenticated.workspaceEpoch) {
        return { kind: "resync", detail: "学习空间已更新，请同步最新状态。" };
      }
      if (authenticated.membership.role !== authenticated.workspace.role) {
        return { kind: "resync", detail: "账号权限已更新，请同步最新状态。" };
      }
      if (authenticated.capabilities && authenticated.capabilities.workspaceEpoch !== authenticated.workspaceEpoch) {
        return { kind: "resync", detail: "学习空间权限已更新，请同步最新状态。" };
      }
      return { kind: "ready", session: authenticated as ReadyDesktopSession };
    }
  }
}

export function decideBootstrapGatewayFailure(error: unknown): BootstrapGatewayFailureDecision {
  if (!(error instanceof RendererGatewayError)) return { kind: "blocked" };
  if (error.code === "auth_required") return { kind: "authenticate" };
  if (error.code === "reauth_required") return { kind: "reauthenticate" };
  if (error.code === "stale_workspace") return { kind: "resync" };
  return { kind: "blocked" };
}

export function gateErrorPolicy(error: unknown, title = "暂时无法继续"): GateErrorPolicy {
  if (!(error instanceof RendererGatewayError)) {
    return {
      title,
      detail: "暂时没有收到服务响应，请稍后重试。连接恢复前，我们不会打开你的学习数据。",
      retry: "never",
    };
  }

  const detail = error.code === "invalid_credentials"
    ? "邮箱或密码不正确，请检查后重新提交。"
    : error.code === "validation" || error.code === "invalid_request"
      ? "请检查填写内容后再试。"
      : gatewayErrorMessage(error);

  return {
    title,
    detail,
    retry: error.retry,
    ...(error.retryAfter ? { retryAfter: error.retryAfter } : {}),
  };
}
