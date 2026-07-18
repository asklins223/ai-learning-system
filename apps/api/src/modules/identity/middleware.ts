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

export async function requireOwner(req: FastifyRequest, reply: FastifyReply) {
  const { userId, workspaceId } = req.session;
  const { isOwnerViaMember, isOwnerViaWorkspace } = await withWorkspaceTransaction(
    { workspaceId, userId },
    async (transaction) => {
      const membership = await transaction.query.workspaceMembers.findFirst({
        where: and(
          eq(workspaceMembers.workspaceId, workspaceId),
          eq(workspaceMembers.userId, userId),
        ),
      });
      const ws = await transaction.query.workspaces.findFirst({
        where: eq(workspaces.id, workspaceId),
      });
      return {
        isOwnerViaMember: membership?.role === "owner",
        isOwnerViaWorkspace: ws?.ownerId === userId,
      };
    },
  );
  if (!isOwnerViaMember && !isOwnerViaWorkspace) {
    return reply.code(403).send({ error: "owner role required" });
  }
}
