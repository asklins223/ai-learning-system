import type { FastifyInstance } from "fastify";
import { requireSession } from "../identity/middleware.ts";
import { listJobs, getJob } from "./service.ts";
import { uuidParamSchema } from "../../lib/pagination.ts";

export async function jobRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireSession);

  app.get("/jobs", async (req) => {
    const items = await listJobs(req.session.workspaceId, req.session.userId);
    return { items };
  });

  app.get<{ Params: { id: string } }>("/jobs/:id", async (req, reply) => {
    const params = uuidParamSchema.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "invalid_id_format", message: "无效的 id 格式" });
    const job = await getJob(req.params.id, req.session.workspaceId, req.session.userId);
    if (!job) {
      return reply.code(404).send({ error: "not_found", message: "资源不存在" });
    }
    return job;
  });
}
