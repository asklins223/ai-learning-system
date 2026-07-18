import type { FastifyInstance } from "fastify";
import { requireSession } from "../identity/middleware.ts";
import { listJobs, getJob } from "./service.ts";

export async function jobRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireSession);

  app.get("/jobs", async (req) => {
    const items = await listJobs(req.session.workspaceId);
    return { items };
  });

  app.get<{ Params: { id: string } }>("/jobs/:id", async (req, reply) => {
    const job = await getJob(req.params.id, req.session.workspaceId);
    if (!job) {
      return reply.code(404).send({ error: "not found" });
    }
    return job;
  });
}
