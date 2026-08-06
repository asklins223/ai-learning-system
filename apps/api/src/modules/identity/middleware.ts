import type { FastifyReply, FastifyRequest } from "fastify";
import { eq, and } from "drizzle-orm";
import { decodeToken } from "./service.ts";
import { withWorkspaceTransaction } from "../../db/client.ts";
import { workspaceMembers, workspaces } from "../../db/schema/identity.ts";
import { extractAuthCredential, hasValidCookieCsrf, type AuthCredential } from "./session-auth.ts";

declare module "fastify" {
  interface FastifyRequest {
    session: { userId: string; workspaceId: string };
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
  const { membershipRole, workspaceOwnerId } = await withWorkspaceTransaction(
    { workspaceId, userId },
    async (transaction) => {
      // PERF-08 fix: These two queries are independent — run them in parallel.
      const [membership, ws] = await Promise.all([
        transaction.query.workspaceMembers.findFirst({
          where: and(
            eq(workspaceMembers.workspaceId, workspaceId),
            eq(workspaceMembers.userId, userId),
          ),
        }),
        transaction.query.workspaces.findFirst({
          where: eq(workspaces.id, workspaceId),
        }),
      ]);
      return {
        membershipRole: membership?.role,
        workspaceOwnerId: ws?.ownerId,
      };
    },
  );
  if (!isWorkspaceOwner({ membershipRole, workspaceOwnerId, userId })) {
    return reply.code(403).send({ error: "owner role required" });
  }
}
