/**
 * 桌宠人格档案路由（22-real-desktop-pet-memory-context-prd-tdd.md §3.3）。
 *
 * GET   /companion/pet-profile       — 读取当前人格（无自定义时返回系统默认预设）
 * PATCH /companion/pet-profile       — 保存自定义人格（revision CAS 由前端携带）
 * POST  /companion/pet-profile/reset — 重置为系统默认
 *
 * capability 门控：COMPANION_PET_PROFILE_V1=true 或 COMPANION_JOURNEY_V2=true。
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireSession } from "../identity/middleware.ts";
import { withWorkspaceTransaction } from "../../db/client.ts";
import { companionPetProfileChangedTotal } from "../../lib/metrics.ts";
import {
  getPetProfile,
  getPresetById,
  PET_PERSONA_PRESETS,
  resetPetProfile,
  upsertPetProfile,
  type PetPersonaPreset,
} from "./pet-profile-service.ts";

function isPetProfileEnabled(): boolean {
  return process.env.COMPANION_PET_PROFILE_V1 === "true"
    || process.env.COMPANION_JOURNEY_V2 === "true";
}

const petProfileBodySchema = z.object({
  // §12.1.3：revision 用于 CAS 乐观锁，防止并发覆盖。
  revision: z.number().int().positive().optional(),
  presetId: z.string().min(1).max(80).nullable().optional(),
  name: z.string().min(1).max(60),
  personalityTags: z.array(z.string().min(1).max(20)).min(1).max(10),
  speakingStyle: z.string().min(1).max(1000),
  examples: z.array(z.object({ text: z.string().min(1).max(200) })).max(5).default([]),
  activeness: z.enum(["quiet", "moderate", "active"]),
  boundaries: z.object({
    allowPlayful: z.boolean().optional(),
    allowNudgeLearning: z.boolean().optional(),
    allowVoiceTags: z.boolean().optional(),
    catchphrase: z.string().max(80).nullable().optional(),
  }).default({}),
}).strict();

export async function petProfileRoutes(app: FastifyInstance) {
  app.addHook("onRequest", async (req, reply) => {
    if (!isPetProfileEnabled()) {
      void req;
      return reply.code(404).send({
        error: "companion_pet_profile_disabled",
        message: "桌宠人格档案当前未开放",
      });
    }
  });

  app.get(
    "/companion/pet-profile",
    { preHandler: [requireSession] },
    async (req, reply) => {
      const scope = { workspaceId: req.session.workspaceId, userId: req.session.userId };
      const profile = await withWorkspaceTransaction(scope, (tx) => getPetProfile(tx, scope));
      const preset: PetPersonaPreset | null = profile?.presetId
        ? getPresetById(profile.presetId)
        : null;
      return reply.header("Cache-Control", "no-store").send({
        version: 1,
        profile,
        presets: PET_PERSONA_PRESETS,
        activePreset: preset,
      });
    },
  );

  app.patch<{ Body: unknown }>(
    "/companion/pet-profile",
    { preHandler: [requireSession] },
    async (req, reply) => {
      const body = petProfileBodySchema.safeParse(req.body ?? {});
      if (!body.success) throw app.httpErrors.badRequest("pet profile body 非法");
      const scope = { workspaceId: req.session.workspaceId, userId: req.session.userId };
      // §12.1.3：CAS 乐观锁——检查与写入必须在同一事务内，防止 TOCTOU 竞态。
      // 之前用两个独立事务（先 getPetProfile 校验，再 upsertPetProfile 写入），
      // 两个事务之间的窗口期允许并发请求绕过 CAS 检查导致覆盖。
      let casConflict = false;
      let conflictRevision = 0;
      let profile: Awaited<ReturnType<typeof upsertPetProfile>> | null = null;
      try {
        profile = await withWorkspaceTransaction(scope, async (tx) => {
          const existing = await getPetProfile(tx, scope);
          if (existing && body.data.revision !== undefined && body.data.revision !== existing.revision) {
            casConflict = true;
            conflictRevision = existing.revision;
            return null;
          }
          return upsertPetProfile(tx, scope, body.data);
        });
      } catch {
        throw app.httpErrors.internalServerError("pet profile upsert failed");
      }
      if (casConflict) {
        return reply.code(409).send({
          error: "PROFILE_CAS_CONFLICT",
          message: "人格档案已被修改，请刷新后重试",
          currentRevision: conflictRevision,
        });
      }
      // §9.9：记录人格变更指标
      try {
        companionPetProfileChangedTotal.inc();
      } catch {
        // metrics 记录失败不阻断请求
      }
      return reply.header("Cache-Control", "no-store").send({ version: 1, profile });
    },
  );

  app.post(
    "/companion/pet-profile/reset",
    { preHandler: [requireSession] },
    async (req, reply) => {
      const scope = { workspaceId: req.session.workspaceId, userId: req.session.userId };
      await withWorkspaceTransaction(scope, (tx) => resetPetProfile(tx, scope));
      // §9.9：记录人格变更指标（重置也是一次变更）
      try {
        companionPetProfileChangedTotal.inc();
      } catch {
        // metrics 记录失败不阻断请求
      }
      return reply.header("Cache-Control", "no-store").send({ version: 1, ok: true });
    },
  );
}
