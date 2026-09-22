import type { FastifyReply, FastifyRequest } from "fastify";
import { decodeToken } from "./service.ts";
import { extractAuthCredential, hasValidCookieCsrf, type AuthCredential } from "./session-auth.ts";

declare module "fastify" {
  interface FastifyRequest {
    session: {
      userId: string;
      workspaceId: string;
      membershipRole?: string | null;
      workspaceOwnerId?: string | null;
      /** 空间边界令牌（0261）：由 decodeToken 读回 `workspaces.workspace_epoch`。 */
      workspaceEpoch: number;
    };
  }
}

export async function requireSession(req: FastifyRequest, reply: FastifyReply) {
  const credential = getRequestCredential(req);

  if (!credential) {
    reply.header("WWW-Authenticate", "Bearer");
    return reply.code(401).send({ error: "missing token" });
  }
  if (credential.source === "cookie" && !hasValidCookieCsrf(req.method, req.headers)) {
    return reply.code(403).send({ error: "csrf token required" });
  }
  const session = await decodeToken(credential.token);
  if (!session) {
    reply.header("WWW-Authenticate", "Bearer");
    return reply.code(401).send({ error: "invalid token" });
  }
  req.session = session;
}

/** Shared credential extraction for middleware and logout. */
export function getRequestCredential(req: FastifyRequest): AuthCredential | null {
  return extractAuthCredential(req.headers);
}

/**
 * Pure ownership decision extracted from requireOwner for testability.
 *
 * A user is considered an owner if EITHER:
 *   - their workspace_members.role equals "owner" (collaborative workspace), OR
 *   - the workspace.ownerId matches their userId (personal workspace, ADR-0009).
 *
 * This mirrors the OR semantics in requireOwner and /auth/me role derivation.
 */
export function isWorkspaceOwner(ctx: {
  userId: string;
  membershipRole?: string | null;
  workspaceOwnerId?: string | null;
}): boolean {
  return ctx.membershipRole === "owner" || ctx.workspaceOwnerId === ctx.userId;
}

/**
 * 判据只有一处：`req.session` 里的 `membershipRole` 与 `workspaceOwnerId` 都由
 * `decodeToken` 每次请求实时 JOIN 带回（成员失效时它直接吊销 session），所以这里
 * 不再自己查一遍。
 *
 * 此前它自己查、而 `/auth/capabilities/v1` 与笔记投影只看 `membershipRole`，同一个
 * 人于是可能"服务端允许写、UI 判它只读"。收敛成同一个谓词后这类分裂不再可能。
 */
export async function requireOwner(req: FastifyRequest, reply: FastifyReply) {
  if (!isWorkspaceOwner(req.session)) {
    return reply.code(403).send({ error: "owner role required" });
  }
}
