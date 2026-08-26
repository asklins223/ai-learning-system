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
      detail: "桌面桥接合同版本与当前客户端不一致。",
    };
  }

  const missingNamespace = REQUIRED_GATE_NAMESPACES.find((namespace) => !contract.namespaces.includes(namespace));
  if (missingNamespace) {
    return {
      kind: "blocked",
      reason: "namespace",
      detail: `桌面合同缺少 ${missingNamespace} 命名空间，已停止进入工作区。`,
    };
  }

  if (!contract.enabledRoutes.includes("room.home")) {
    return {
      kind: "blocked",
      reason: "route",
      detail: "当前桌面合同没有开放理解书房入口。",
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
        detail: "桌面端无法确认真实身份与工作区；恢复连接前不会进入理解书房。",
        retry: "safe_retry",
      };
    case "not_configured":
      return {
        kind: "blocked",
        connection,
        title: "桌面服务尚未配置",
        detail: "请完成桌面服务地址与本机配对配置，然后重新启动客户端。",
        retry: "user_action",
      };
    case "configuration_error": {
      const reason = connection.reason === "pairing_secret_missing"
        ? "缺少本机配对密钥。"
        : connection.reason === "pairing_secret_invalid"
          ? "本机配对密钥无效。"
          : "桌面服务部署配置无效。";
      return {
        kind: "blocked",
        connection,
        title: "桌面服务配置不可用",
        detail: `${reason} 修复配置并重新启动后才能读取真实学习数据。`,
        retry: "user_action",
      };
    }
    case "api_untrusted": {
      const reason = connection.reason === "wrong_service"
        ? "目标地址不是受信任的 AI Learn 服务。"
        : connection.reason === "wrong_key" || connection.reason === "bad_hmac"
          ? "本机服务没有通过配对签名校验。"
          : "服务合同与当前桌面客户端不兼容。";
      return {
        kind: "blocked",
        connection,
        title: "无法信任当前学习服务",
        detail: `${reason} 为保护工作区数据，客户端已停止连接。`,
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
        detail: "身份服务暂时不可用，旧的登录信息不能作为进入工作区的依据。",
      };
    case "api_untrusted":
      return {
        kind: "blocked",
        reason: "api_untrusted",
        detail: "身份响应来自未受信任的服务，客户端已停止进入工作区。",
      };
    case "authenticated": {
      const authenticated = session as AuthenticatedDesktopSession;
      if (!authenticated.workspace) return { kind: "workspace_required", session: authenticated };
      if (!authenticated.membership) {
        return { kind: "resync", detail: "当前工作区缺少成员身份，必须重新同步会话。" };
      }
      if (authenticated.workspace.workspaceEpoch !== authenticated.workspaceEpoch) {
        return { kind: "resync", detail: "工作区版本已经变化，必须重新同步会话。" };
      }
      if (authenticated.membership.role !== authenticated.workspace.role) {
        return { kind: "resync", detail: "工作区角色与成员身份不一致，必须重新同步会话。" };
      }
      if (authenticated.capabilities && authenticated.capabilities.workspaceEpoch !== authenticated.workspaceEpoch) {
        return { kind: "resync", detail: "能力投影属于旧工作区，必须重新同步会话。" };
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

export function gateErrorPolicy(error: unknown, title = "无法确认桌面状态"): GateErrorPolicy {
  if (!(error instanceof RendererGatewayError)) {
    return {
      title,
      detail: "桌面端没有收到可验证的响应。为保护工作区数据，当前保持关闭状态。",
      retry: "never",
    };
  }

  const detail = error.code === "invalid_credentials"
    ? "邮箱或密码不正确，请检查后重新提交。"
    : error.code === "validation" || error.code === "invalid_request"
      ? "提交内容没有通过校验，请检查输入后重新提交。"
      : gatewayErrorMessage(error);

  return {
    title,
    detail,
    retry: error.retry,
    ...(error.retryAfter ? { retryAfter: error.retryAfter } : {}),
  };
}
