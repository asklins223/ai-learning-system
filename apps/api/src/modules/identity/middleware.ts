import type { FastifyReply, FastifyRequest } from "fastify";
import { eq, and } from "drizzle-orm";
import { decodeToken } from "./service.ts";
import { withWorkspaceTransaction } from "../../db/client.ts";
import { workspaceMembers, workspaces } from "@ailearn/shared/db-schema/identity";
import { extractAuthCredential, hasValidCookieCsrf, type AuthCredential } from "./session-auth.ts";

declare module "fastify" {
  interface FastifyRequest {
    session: { userId: string; workspaceId: string; membershipRole?: string | null };
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
  membershipRole: string | null | undefined;
  workspaceOwnerId: string | null | undefined;
  userId: string;
}): boolean {
  return ctx.membershipRole === "owner" || ctx.workspaceOwnerId === ctx.userId;
}

export async function requireOwner(req: FastifyRequest, reply: FastifyReply) {
  const { userId, workspaceId } = req.session;
  // 2026-08-11（性能专项）：2 个并行查询合并为单条 LEFT JOIN（membership + workspace），
  // 事务内往返 3 次→2 次（BEGIN+set_config+查询+COMMIT）。JOIN 不命中 membership 时
  // membershipRole 为 null，等价于原"无成员记录 → 非 owner"。
  const { membershipRole, workspaceOwnerId } = await withWorkspaceTransaction(
    { workspaceId, userId },
    async (transaction) => {
      const row = await transaction
        .select({
          membershipRole: workspaceMembers.role,
          workspaceOwnerId: workspaces.ownerId,
        })
        .from(workspaces)
        .leftJoin(
          workspaceMembers,
          and(
            eq(workspaceMembers.workspaceId, workspaces.id),
            eq(workspaceMembers.userId, userId),
          ),
        )
        .where(eq(workspaces.id, workspaceId))
        .limit(1);
      return {
        membershipRole: row[0]?.membershipRole ?? null,
        workspaceOwnerId: row[0]?.workspaceOwnerId ?? null,
      };
    },
  );
  if (!isWorkspaceOwner({ membershipRole, workspaceOwnerId, userId })) {
    return reply.code(403).send({ error: "owner role required" });
  }
}
