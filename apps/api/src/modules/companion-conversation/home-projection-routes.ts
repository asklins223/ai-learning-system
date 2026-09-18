import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { companionRoomProfilePatchV1Schema } from "@ailearn/shared/companion-home-contracts";
import { withWorkspaceTransaction } from "../../db/client.ts";
import { requireSession } from "../identity/middleware.ts";
import {
  getCompanionHomeProjection,
  getCompanionRoomProfile,
  patchCompanionRoomProfile,
} from "./home-projection-service.ts";

const NO_STORE = "private, no-store";

async function setCompanionHomeNoStore(
  _request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  reply.header("Cache-Control", NO_STORE);
}

export async function companionHomeProjectionRoutes(app: FastifyInstance) {
  app.get(
    "/companion/home-projection",
    { onRequest: [setCompanionHomeNoStore], preHandler: [requireSession] },
    async (request, reply) => {
      const scope = {
        workspaceId: request.session.workspaceId,
        userId: request.session.userId,
      };
      const projection = await withWorkspaceTransaction(scope, (tx) => (
        getCompanionHomeProjection(tx, scope)
      ));
      return reply.send(projection);
    },
  );

  app.get(
    "/companion/room-profile",
    { onRequest: [setCompanionHomeNoStore], preHandler: [requireSession] },
    async (request, reply) => {
      const scope = {
        workspaceId: request.session.workspaceId,
        userId: request.session.userId,
      };
      const profile = await withWorkspaceTransaction(scope, (tx) => (
        getCompanionRoomProfile(tx, scope)
      ));
      return reply.send(profile);
    },
  );

  app.patch<{ Body: unknown }>(
    "/companion/room-profile",
    { onRequest: [setCompanionHomeNoStore], preHandler: [requireSession] },
    async (request, reply) => {
      const body = companionRoomProfilePatchV1Schema.safeParse(request.body ?? {});
      if (!body.success) {
        return reply.code(400).send({
          version: 1,
          error: "INVALID_REQUEST",
          message: "room profile body invalid",
          recoverable: false,
          requestId: request.id,
        });
      }
      const scope = {
        workspaceId: request.session.workspaceId,
        userId: request.session.userId,
      };
      const result = await withWorkspaceTransaction(scope, (tx) => (
        patchCompanionRoomProfile(tx, scope, body.data)
      ));
      if (!result.ok) {
        return reply.code(409).send({
          version: 1,
          error: result.reason === "revision_conflict"
            ? "ROOM_PROFILE_CAS_CONFLICT"
            : "ROOM_PROFILE_EQUIPMENT_REJECTED",
          message: result.reason,
          recoverable: result.reason === "revision_conflict",
          ...(result.reason === "revision_conflict"
            ? { currentRevision: result.currentRevision }
            : { resourceId: result.resourceId, ...(result.slot ? { slot: result.slot } : {}) }),
          requestId: request.id,
        });
      }
      return reply.send(result.profile);
    },
  );
}
