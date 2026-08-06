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
    if (!params.success) return reply.code(400).send({ error: "invalid id format" });
    const job = await getJob(req.params.id, req.session.workspaceId, req.session.userId);
    if (!job) {
      return reply.code(404).send({ error: "not found" });
    }
    return job;
  });
}
