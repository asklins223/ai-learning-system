/**
 * 阶段 02（W1）任务 02-3：Companion shell 路由（§5.4.3 + §12.5）。
 *
 * 端点：
 * - GET  /public/auth-surface-manifest             公开（不鉴权）：随构建签名的 auth-surface manifest
 * - GET  /me/companion                           账号级聚合视图
 * - GET  /me/companion/answer-mode-preference     作答模态偏好（读）
 * - PATCH /me/companion/answer-mode-preference    作答模态偏好（写）
 * - PATCH /me/companion                          account state revision CAS
 * - POST  /me/companion/onboarding/:version/transition  onboarding CAS 状态机
 * - POST  /me/companion/runtime-fences           短 TTL device-session fence（server-side ephemeral）
 *
 * 错误映射：CompanionStateError → { statusCode, error: code, message }；
 * body 校验失败走 parseBody 统一 400。
 */

import type { FastifyInstance } from "fastify";
import { parseBody } from "../../lib/validate.ts";
import { requireSession } from "../identity/middleware.ts";
import {
  companionAccountPatchSchema,
  companionAnswerModePreferencePatchV1Schema,
  onboardingTransitionRequestSchema,
  runtimeFenceRequestSchema,
} from "@ailearn/shared";
import {
  CompanionStateError,
  createRuntimeFence,
  getAnswerModePreference,
  getCompanionOverview,
  setAnswerModePreference,
  transitionOnboarding,
  updateCompanionAccountState,
} from "./service.ts";
import { openCompanionAccountEventStream } from "./account-events.ts";
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

  // 任务 14：作答模态偏好（设置 → 伴星，跨设备一致；Owner 决策 4）。
  // GET /me/companion/answer-mode-preference — 读全局模态偏好。
  app.get("/me/companion/answer-mode-preference", { preHandler: [requireSession] }, async (req, reply) => {
    try {
      const result = await getAnswerModePreference(req.session.userId, req.session.workspaceId);
      return { version: 1, preference: result.preference, updatedAt: result.updatedAt };
    } catch (err) {
      if (err instanceof CompanionStateError) {
        return reply.code(err.statusCode).send({
          error: err.code,
          message: err.statusCode >= 500 ? "服务器内部错误" : err.message,
        });
      }
      throw err;
    }
  });

  // PATCH /me/companion/answer-mode-preference — 写全局模态偏好（"any" = 回跟随安排）。
  app.patch("/me/companion/answer-mode-preference", { preHandler: [requireSession] }, async (req, reply) => {
    const body = parseBody(app, companionAnswerModePreferencePatchV1Schema, req.body);
    try {
      const result = await setAnswerModePreference(req.session.userId, req.session.workspaceId, body.preference);
      return { version: 1, preference: result.preference, updatedAt: result.updatedAt };
    } catch (err) {
      if (err instanceof CompanionStateError) {
        return reply.code(err.statusCode).send({
          error: err.code,
          message: err.statusCode >= 500 ? "服务器内部错误" : err.message,
        });
      }
      throw err;
    }
  });

  // GET /me/companion/events — account-wide epoch revocation SSE.
  // It carries no page/content data; polling remains the reconnect fallback.
  app.get<{ Querystring: { after?: string } }>(
    "/me/companion/events",
    { preHandler: [requireSession] },
    async (req, reply) => {
      const afterRaw = typeof req.query?.after === "string" ? req.query.after : null;
      const lastEventId =
        typeof req.headers["last-event-id"] === "string" ? req.headers["last-event-id"] : null;
      const result = await openCompanionAccountEventStream({
        workspaceId: req.session.workspaceId,
        userId: req.session.userId,
        afterRaw,
        lastEventId,
        writer: {
          write: (chunk) => {
            if (!reply.raw.writableEnded) reply.raw.write(chunk);
          },
          onAbort: (cb) => req.raw.on("close", cb),
          close: () => {
            if (!reply.raw.writableEnded) reply.raw.end();
          },
        },
      });
      if (result.statusCode !== 200) {
        return reply.code(result.statusCode).send({
          version: 1,
          error: result.error.code,
          message: result.error.message,
          recoverable: true,
          requestId: req.id,
        });
      }
      reply.hijack();
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store, no-transform",
        "X-Accel-Buffering": "no",
        retry: "1500",
        Connection: "keep-alive",
      });
      result.stream.start();
      return reply;
    },
  );

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
        return reply.code(err.statusCode).send({ error: err.code, message: err.statusCode >= 500 ? "服务器内部错误" : err.message });
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
          return reply.code(err.statusCode).send({ error: err.code, message: err.statusCode >= 500 ? "服务器内部错误" : err.message });
        }
        throw err;
      }
    },
  );

  // POST /me/companion/runtime-fences — 创建/续期短 TTL device-session fence。
  // 只保存 content-free 的 user/device/epoch/TTL，既不写账号偏好，也不保存页面内容。
  app.post("/me/companion/runtime-fences", { preHandler: [requireSession] }, async (req) => {
    const body = parseBody(app, runtimeFenceRequestSchema, req.body);
    return createRuntimeFence(req.session.userId, req.session.workspaceId, body);
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
        return reply.code(err.statusCode).send({ error: err.code, message: err.statusCode >= 500 ? "服务器内部错误" : err.message });
      }
      throw err;
    }
  });
}
