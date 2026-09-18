import type { SessionContextV1 } from "@ailearn/shared/desktop-ipc-contracts";
import { createRequestMeta, RendererGatewayError, unwrapGatewayResult } from "./desktop-client";

/**
 * Every task surface reads the session before it reads workspace data, and each
 * one owns its own `workspaceEpoch` cursor so a stale response can be discarded.
 */
export async function readAuthenticatedSession(
  epochRef: React.MutableRefObject<number | undefined>,
): Promise<SessionContextV1> {
  if (!window.ailearn) throw new Error("桌面端 API 不可用，无法读取真实工作区数据。");
  const response = await window.ailearn.auth.getState({ meta: createRequestMeta(epochRef.current) });
  if (response.workspaceEpoch) epochRef.current = response.workspaceEpoch;
  const session = unwrapGatewayResult(response);
  if (session.status !== "authenticated" || !session.workspace) {
    throw new RendererGatewayError({ code: "auth_required", safeMessageKey: "error.auth_required", retry: "user_action" });
  }
  return session;
}
