import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireSession } from "../identity/middleware.ts";
import { getCardEvidence, overrideEvidence, removeEvidenceOverride } from "./service.ts";
import { parseBody } from "../../lib/validate.ts";
import { uuidParamSchema, cardIdParamSchema } from "../../lib/pagination.ts";

export async function evidenceRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireSession);

  app.get<{ Params: { cardId: string } }>("/cards/:cardId/evidence", async (req, reply) => {
    // R-022: UUID 路径参数校验
    const params = cardIdParamSchema.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "invalid cardId format" });
    // N-005: 传递 userId 以获取用户级 override
    const data = await getCardEvidence(req.params.cardId, req.session.workspaceId, req.session.userId);
    if (!data) return reply.code(404).send({ error: "not found" });
    return data;
  });

  const overrideSchema = z.object({
    override: z.enum(["confirmed", "downgraded", "rejected"]),
  });

  app.post<{ Params: { id: string } }>("/evidences/:id/override", async (req, reply) => {
    // R-022: UUID 路径参数校验
    const params = uuidParamSchema.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "invalid id format" });
    const body = parseBody(app, overrideSchema, req.body);
    const result = await overrideEvidence(req.params.id, req.session.workspaceId, req.session.userId, body.override);
    if (!result) return reply.code(404).send({ error: "not found" });
    return result;
  });

  /**
   * N-005: 删除用户级证据覆盖（恢复原始 alignment）。
   */
  app.delete<{ Params: { id: string } }>("/evidences/:id/override", async (req, reply) => {
    const params = uuidParamSchema.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "invalid id format" });
    const result = await removeEvidenceOverride(req.params.id, req.session.workspaceId, req.session.userId);
    if (!result) return reply.code(404).send({ error: "not found" });
    return result;
  });
}
