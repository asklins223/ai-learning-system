import {
  DESKTOP_IPC_CONTRACT_VERSION,
  type GatewayErrorV1,
  type GatewayResultV1,
  type RequestMetaV1,
} from "@ailearn/shared/desktop-ipc-contracts";
import { publishGateInvalidation } from "./gate-invalidation";

let requestSequence = 0;

function opaqueId(prefix: string): string {
  requestSequence += 1;
  return `${prefix}-${Date.now()}-${requestSequence}`;
}

/**
 * 渲染层当前所在工作区的 epoch，由 `DesktopAccessGate` 在边界判定时写入。
 *
 * 为什么要有一个模块级兜底：主进程的 `assertEpoch` 已改成 fail-closed（不带 epoch
 * 即视为过期），而"调用方漏传 epoch"是常态而非例外——`SourceIntake` 的批量采集、
 * 笔记图片上传、伴星念头气泡都不持有任何 epoch 游标。让 `createRequestMeta()`
 * 默认取当前边界，使漏传在结构上不可能发生；显式传参仍然优先，各 surface 自己的
 * 游标语义不变。
 */
let currentWorkspaceEpoch = 0;

export function setCurrentWorkspaceEpoch(epoch: number): void {
  currentWorkspaceEpoch = epoch > 0 ? epoch : 0;
}

export function getCurrentWorkspaceEpoch(): number {
  return currentWorkspaceEpoch;
}

export function createRequestMeta(workspaceEpoch?: number): RequestMetaV1 {
  const meta: RequestMetaV1 = {
    version: 1,
    contractVersion: DESKTOP_IPC_CONTRACT_VERSION,
    requestId: opaqueId("renderer-request"),
    correlationId: opaqueId("renderer-correlation"),
    clientStartedAt: new Date().toISOString(),
  };

  const boundary = workspaceEpoch && workspaceEpoch > 0 ? workspaceEpoch : currentWorkspaceEpoch;
  return boundary > 0 ? { ...meta, workspaceEpoch: boundary } : meta;
}

export function createCommandId(prefix: string): string {
  return opaqueId(`renderer-command-${prefix}`);
}

export class RendererGatewayError extends Error {
  readonly code: GatewayErrorV1["code"];
  readonly retry: GatewayErrorV1["retry"];
  readonly retryAfter?: string;

  constructor(error: GatewayErrorV1) {
    super(error.safeMessageKey);
    this.name = "RendererGatewayError";
    this.code = error.code;
    this.retry = error.retry;
    this.retryAfter = error.retryAfter;
  }
}

export function unwrapGatewayResult<T>(result: GatewayResultV1<T>): T {
  if (!result.ok) {
    publishGateInvalidation(result.error.code);
    throw new RendererGatewayError(result.error);
  }
  return result.data;
}

/**
 * 当前工作区纪元。写操作必须带上它：一旦切换过工作区，旧的在途请求就会落到
 * 新工作区上。会话发送与语音转写都从这里取。
 */
export async function requireWorkspaceEpoch(): Promise<number> {
  const session = await window.ailearn.auth.getState({ meta: createRequestMeta() });
  const context = unwrapGatewayResult(session);
  if (context.status !== "authenticated" || !context.workspace) {
    throw new Error("请先登录并进入工作区");
  }
  return context.workspace.workspaceEpoch;
}

export function gatewayErrorMessage(error: unknown): string {
  if (!(error instanceof RendererGatewayError)) return "服务暂时没有返回可确认的结果。";

  switch (error.code) {
    case "auth_required":
    case "reauth_required":
      return "请先登录或重新验证身份，再继续这条学习流程。";
    case "api_unavailable":
    case "network_timeout":
      return "学习服务暂时不可用；可以安全重试，不会重复创建学习旅程。";
    case "api_untrusted":
    case "configuration_error":
      return "桌面端尚未通过本机服务校验，当前不能读取真实学习数据。";
    case "unsupported_contract":
      return "服务返回的学习合同版本不受当前客户端支持，已安全停止。";
    case "forbidden":
      return "当前工作区或账号没有执行这个动作的权限。";
    case "stale_workspace":
      return "工作区已经变化，请重新加载当前学习队列。";
    case "conflict":
      return "这条学习状态已经发生变化，请先同步后再继续。";
    case "result_unknown":
      return "上一动作的结果尚未确认；请先同步当前学习状态，客户端不会重复提交。";
    case "rate_limited": {
      const retryAt = error.retryAfter ? new Date(error.retryAfter) : null;
      const retryTime = retryAt && Number.isFinite(retryAt.valueOf())
        ? new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(retryAt)
        : null;
      return retryTime ? `服务端暂时限流，请在 ${retryTime} 后再试。` : "服务端暂时限流，请稍后再试。";
    }
    case "not_found":
      return "这条学习内容已经不存在或不再对当前账号可见。";
    case "feature_disabled":
      return "这项学习能力当前未在本环境启用。";
    // 2026-09-19 补映射：这些码此前落到 default 兜底句，用户看不出发生了什么。
    case "invalid_request":
    case "validation":
      return "这次请求的内容没有通过校验，请检查后重试。";
    case "invalid_navigation":
    case "route_not_available":
      return "当前版本还不支持这个跳转目标。";
    case "cancelled":
      return "这一轮已经取消。";
    case "safe_internal_error":
      return "学习服务内部出了点问题，已记录；请稍后重试。";
    // Auth-form outcomes. These read as account and invitation problems, not as
    // learning-content problems, because that is the surface they appear on.
    case "email_exists":
      return "这个邮箱已经注册过，请直接登录；忘记密码请联系管理员。";
    case "invite_invalid":
      return "邀请码无效，请核对后重新输入，或向邀请你的人要一个新的。";
    case "invite_expired":
      return "邀请码已过期，请向邀请你的人要一个新的。";
    case "invite_consumed":
      return "这个邀请码已经被使用过了，请向邀请你的人要一个新的。";
    case "workspace_limit":
      return "你已经加入了可参与的工作区数量上限，无法再加入新的协作空间。";
    case "already_member":
      return "你的账号已经在这个协作空间里了，无需重复加入。";
    default:
      return "学习服务没有完成这次请求，请稍后重试。";
  }
}
