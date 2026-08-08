/**
 * 阶段 02（W1）任务 02-3：Companion shell 路由（§5.4.3 + §12.5）。
 *
 * 端点：
 * - GET  /public/auth-surface-manifest             公开（不鉴权）：随构建签名的 auth-surface manifest
 * - GET  /me/companion                           账号级聚合视图
 * - PATCH /me/companion                          account state revision CAS
 * - POST  /me/companion/onboarding/:version/transition  onboarding CAS 状态机
 * - POST  /me/companion/runtime-fences           短 TTL device-session fence（ephemeral）
 *
 * 错误映射：CompanionStateError → { statusCode, error: code, message }；
 * body 校验失败走 parseBody 统一 400。
 */

import type { FastifyInstance } from "fastify";
import { parseBody } from "../../lib/validate.ts";
import { requireSession } from "../identity/middleware.ts";
import {
  companionAccountPatchSchema,
  onboardingTransitionRequestSchema,
  runtimeFenceRequestSchema,
} from "@ailearn/shared";
import {
  CompanionStateError,
  createRuntimeFence,
  getCompanionOverview,
  transitionOnboarding,
  updateCompanionAccountState,
} from "./service.ts";
import { getAuthSurfaceManifestInfo } from "./auth-surface.ts";
import {
  CompanionAuditError,
  deleteCompanionUserData,
  exportCompanionUserData,
} from "./audit-service.ts";

export async function companionShellRoutes(app: FastifyInstance) {
  // GET /public/auth-surface-manifest — 阶段 02（W1）任务 02-5：随构建签名的
  // auth-surface manifest（§12.3 + §13.3）。公开端点（不 requireSession）：
  // 未登录的登录/注册页也能获取角色说明、公开帮助与通用错误帮助，不依赖 authenticated
  // API，不发起 LLM/ASR/TTS 或个性化预取；manifest 签名校验失败时客户端 fail closed。
  app.get("/public/auth-surface-manifest", async () => {
    return getAuthSurfaceManifestInfo();
  });

  // GET /me/companion — 账号级聚合视图（onboarding 各版本状态 + account state）。
  app.get("/me/companion", { preHandler: [requireSession] }, async (req) => {
    return getCompanionOverview(req.session.userId, req.session.workspaceId);
  });

  // PATCH /me/companion — account state revision CAS 更新。
  // 载荷字段与 CompanionAccountStateV1 对齐；revision 必填（乐观锁）。
  app.patch("/me/companion", { preHandler: [requireSession] }, async (req, reply) => {
    const body = parseBody(app, companionAccountPatchSchema, req.body);
    try {
      return await updateCompanionAccountState(
        req.session.userId,
        req.session.workspaceId,
        body,
      );
    } catch (err) {
      if (err instanceof CompanionStateError) {
        return reply.code(err.statusCode).send({ error: err.code, message: err.message });
      }
      throw err;
    }
  });

  // POST /me/companion/onboarding/:version/transition — onboarding CAS 状态机。
  // action 由服务端状态机判定；revision/runId/resumeTokenRef 按动作校验。
  app.post<{ Params: { version: string } }>(
    "/me/companion/onboarding/:version/transition",
    { preHandler: [requireSession] },
    async (req, reply) => {
      const body = parseBody(app, onboardingTransitionRequestSchema, req.body);
      try {
        return await transitionOnboarding({
          userId: req.session.userId,
          workspaceId: req.session.workspaceId,
          version: req.params.version,
          action: body.action,
          revision: body.revision,
          runId: body.runId,
          stepId: body.stepId,
          resumeTokenRef: body.resumeTokenRef,
        });
      } catch (err) {
        if (err instanceof CompanionStateError) {
          return reply.code(err.statusCode).send({ error: err.code, message: err.message });
        }
        throw err;
      }
    },
  );

  // POST /me/companion/runtime-fences — 创建/续期短 TTL device-session fence。
  // ephemeral：只存在于内存，不写账号偏好或持久表（§12.5）。
  app.post("/me/companion/runtime-fences", { preHandler: [requireSession] }, async (req) => {
    const body = parseBody(app, runtimeFenceRequestSchema, req.body);
    return createRuntimeFence(req.session.userId, body);
  });

  // GET /me/companion/audit/export — 用户导出自身 audit + invitation ledger。
  // 01-3 §3.1 冻结 API 清单无此端点；按 02-4「导出/删除」能力补充实现（见
  // docs/plans/learning-companion/02-4-audit-privacy-lifecycle.md）。导出内容只含
  // opaque IDs/hashes/版本/结果，不含页面内容/DOM/截图/凭据/未提交输入。
  app.get("/me/companion/audit/export", { preHandler: [requireSession] }, async (req) => {
    return exportCompanionUserData(req.session.userId, req.session.workspaceId);
  });

  // DELETE /me/companion/audit — 用户删除自身 audit + invitation ledger（级联）。
  // 删除后不触发重新邀请，不把拒绝行为重建为画像（02-4 §4）。
  app.delete("/me/companion/audit", { preHandler: [requireSession] }, async (req, reply) => {
    try {
      return await deleteCompanionUserData(req.session.userId, req.session.workspaceId);
    } catch (err) {
      if (err instanceof CompanionAuditError) {
        return reply.code(err.statusCode).send({ error: err.code, message: err.message });
      }
      throw err;
    }
  });
}
