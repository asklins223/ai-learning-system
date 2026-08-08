/**
 * 阶段 02（W1）任务 02-5：auth-surface manifest 与 credential 零采集（§12.3 + §13.3）。
 *
 * 登录/注册页的角色说明、公开帮助文案与错误帮助来自「随构建签名的 auth-surface
 * manifest」：manifest 内容全部是公开静态文案（不涉密），由服务端用 HMAC 签名后经
 * 公开端点（不鉴权）下发，客户端在渲染前校验签名（fail closed）。
 *
 * credential 零采集约束（本文件内由 schema 与校验函数强制）：
 * - 每个 surface 的 visibleEntityRefs 必须为空（selectedEntityRefs 等价字段同样禁止）；
 * - 每个 surface 的动作只能来自有限 allowlist（AuthSurfaceAction）；
 * - manifest 不含任何模型 / ASR / TTS / 采集 observer / 截图 / 剪贴板相关字段
 *   （schema .strict() 拒绝未知键，collectCredentialZeroCollectionViolations 再显式扫一遍）；
 * - 错误码只给「通用、不暴露账号是否存在」的枚举。
 *
 * 签名实现（HMAC）放在 API 侧（apps/api/src/modules/companion-shell/auth-surface.ts），
 * 本文件不依赖 node:crypto，schema/构建/校验可同时用于服务端与浏览器端。
 * zod schema 风格与 packages/shared/src/companion-shell-contracts.ts 保持一致。
 */

import { z } from "zod";

// ─── surfaceKind：credential 页允许的三种伴星表面 ────────────────────────

export const AuthSurfaceKindSchema = z.enum([
  "static_help",
  "silent_anchor",
  "transitional",
]);
export type AuthSurfaceKind = z.infer<typeof AuthSurfaceKindSchema>;

/**
 * 有限动作 allowlist：credential 页伴星可执行的全部动作。
 * 任何未在此集合内的动作在构建 manifest 时都会被拒绝。
 */
export const AuthSurfaceAction = {
  /** 提交登录。 */
  SUBMIT_LOGIN: "submit_login",
  /** 提交注册。 */
  SUBMIT_REGISTER: "submit_register",
  /** 请求密码重置（只发通用邮件/结果，不暴露账号是否存在）。 */
  REQUEST_PASSWORD_RESET: "request_password_reset",
  /** 打开公开帮助文案。 */
  OPEN_HELP: "open_help",
  /** 切换「隐藏伴星」：只写一个设备本地布尔值。 */
  TOGGLE_HIDE_COMPANION: "toggle_hide_companion",
} as const;
export type AuthSurfaceAction =
  (typeof AuthSurfaceAction)[keyof typeof AuthSurfaceAction];

export const authSurfaceActionSchema = z.enum([
  AuthSurfaceAction.SUBMIT_LOGIN,
  AuthSurfaceAction.SUBMIT_REGISTER,
  AuthSurfaceAction.REQUEST_PASSWORD_RESET,
  AuthSurfaceAction.OPEN_HELP,
  AuthSurfaceAction.TOGGLE_HIDE_COMPANION,
]);

// ─── 错误码：通用，绝不暴露账号是否存在 ─────────────────────────────────

export const AuthSurfaceErrorCode = {
  /** 凭据校验失败。统一通用文案（「邮箱或密码不正确」），不区分账号不存在/密码错误。 */
  INVALID_CREDENTIALS: "INVALID_CREDENTIALS",
  /** 账号动作受限（如重复注册、锁定）。只给通用提示，不暴露账号是否存在。 */
  ACCOUNT_ACTION_BLOCKED: "ACCOUNT_ACTION_BLOCKED",
  /** 请求过频。限流响应，同样不区分是否命中某个真实账号。 */
  RATE_LIMITED: "RATE_LIMITED",
  /** 服务暂时不可用。 */
  SERVICE_UNAVAILABLE: "SERVICE_UNAVAILABLE",
  /** manifest 签名校验失败：客户端 fail closed 到通用帮助，不渲染任何页面级提示。 */
  MANIFEST_UNVERIFIED: "MANIFEST_UNVERIFIED",
} as const;
export type AuthSurfaceErrorCode =
  (typeof AuthSurfaceErrorCode)[keyof typeof AuthSurfaceErrorCode];

export const authSurfaceErrorCodeSchema = z.nativeEnum(AuthSurfaceErrorCode);

// ─── zod schema（.strict()：拒绝任何模型/ASR/TTS/采集相关未知键）─────────

export const authSurfaceManifestEntrySchema = z.object({
  /** 稳定 surface id，如 "login:static_help"；客户端按 id 定位渲染。 */
  surfaceId: z.string().min(1).max(100).regex(/^[A-Za-z0-9._:-]+$/),
  surfaceKind: AuthSurfaceKindSchema,
  /** 归一化公开文案（空白折叠后的纯文本）。空字符串 = 本 surface 不渲染文案。 */
  textContent: z.string().max(4000),
  /** credential 页必须为空：不携带任何实体引用（visibleEntityRefs 零采集）。 */
  visibleEntityRefs: z.array(z.string()).length(0),
  /** 有限动作 allowlist，只允许 AuthSurfaceAction 集合内动作。 */
  allowedActions: z.array(authSurfaceActionSchema).min(0).max(16),
}).strict();
export type AuthSurfaceManifestEntry = z.infer<
  typeof authSurfaceManifestEntrySchema
>;

/** 签名载荷（不含 signature）：HMAC 作用在这个规范化 JSON 上。 */
export const authSurfaceManifestPayloadSchema = z.object({
  version: z.literal("1"),
  /** 构建/签发时刻（ISO-8601）；随构建固定，不随请求变化。 */
  signedAt: z.string().datetime(),
  surfaces: z.array(authSurfaceManifestEntrySchema).min(1).max(16),
}).strict();
export type AuthSurfaceManifestPayload = z.infer<
  typeof authSurfaceManifestPayloadSchema
>;

export const authSurfaceManifestV1Schema = authSurfaceManifestPayloadSchema.extend({
  /** hex HMAC-SHA256，密钥来自 AUTH_SURFACE_MANIFEST_SECRET（代码中不硬编码）。 */
  signature: z.string().min(1).max(1024),
}).strict();
export type AuthSurfaceManifestV1 = z.infer<typeof authSurfaceManifestV1Schema>;

// ─── 文案归一化 ──────────────────────────────────────────────────────────

/**
 * textContent 归一化：折叠连续空白/制表符、压缩连续空行、去掉首尾空白。
 * manifest 内只允许这种归一化纯文本（非 HTML/富文本，不携带任何凭据值）。
 */
export function normalizeAuthSurfaceText(input: string): string {
  return input
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ─── 零采集校验（manifest 构建时强制 + 可独立调用）──────────────────────

/**
 * 显式扫描 forbidden key：即使 schema 未来被放宽，也保证 credential 页
 * manifest 不含模型 / ASR / TTS / 采集 observer / 截图 / 剪贴板 / 交互时序
 * 相关字段。返回违规描述数组（空 = 通过）。
 */
export function collectCredentialZeroCollectionViolations(
  manifest: { surfaces: readonly AuthSurfaceManifestEntry[] },
): string[] {
  const violations: string[] = [];
  const forbiddenKeys = [
    "model",
    "modelId",
    "llm",
    "provider",
    "prompt",
    "asr",
    "tts",
    "speech",
    "voice",
    "stt",
    "screenshot",
    "clipboard",
    "domObserver",
    "selectionObserver",
    "observer",
    "focus",
    "focusTiming",
    "keystroke",
    "inputRhythm",
    "autofill",
    "paste",
    "validationTiming",
    "fieldLength",
    "selectedEntityRefs",
    "personalizationContext",
    "pageContext",
  ];

  for (const surface of manifest.surfaces) {
    if (surface.visibleEntityRefs.length !== 0) {
      violations.push(
        `${surface.surfaceId}: visibleEntityRefs must be empty (got ${surface.visibleEntityRefs.length})`,
      );
    }
    for (const key of Object.keys(surface)) {
      if (forbiddenKeys.includes(key)) {
        violations.push(`${surface.surfaceId}: forbidden key "${key}"`);
      }
    }
  }
  return violations;
}

/** 校验 manifest 满足 credential 零采集；违规时抛错（fail closed）。 */
export function assertCredentialZeroCollection(
  manifest: { surfaces: readonly AuthSurfaceManifestEntry[] },
): void {
  const violations = collectCredentialZeroCollectionViolations(manifest);
  if (violations.length > 0) {
    throw new Error(
      `auth-surface manifest violates credential zero-collection: ${violations.join("; ")}`,
    );
  }
}

// ─── 构建（不含签名；签名由 API 侧 HMAC 完成）───────────────────────────

export interface AuthSurfaceManifestEntryInput {
  surfaceId: string;
  surfaceKind: AuthSurfaceKind;
  textContent: string;
  allowedActions: readonly AuthSurfaceAction[];
  /** 默认空数组；传非空会被 schema/校验拒绝。 */
  visibleEntityRefs?: readonly string[];
}

export interface BuildAuthSurfaceManifestInput {
  surfaces: readonly AuthSurfaceManifestEntryInput[];
  /** 缺省为当前时刻；随构建固定。 */
  signedAt?: string;
}

/**
 * 构建 manifest 签名载荷：归一化文案、去重 allowedActions、强制 visibleEntityRefs
 * 为空并拒绝任何模型/采集相关字段。任何违规立即抛错（fail closed）。
 */
export function buildAuthSurfaceManifestPayload(
  input: BuildAuthSurfaceManifestInput,
): AuthSurfaceManifestPayload {
  const signedAt = input.signedAt ?? new Date().toISOString();
  const surfaces = input.surfaces.map((surface) => {
    const entry = authSurfaceManifestEntrySchema.parse({
      surfaceId: surface.surfaceId,
      surfaceKind: surface.surfaceKind,
      textContent: normalizeAuthSurfaceText(surface.textContent),
      visibleEntityRefs: [...(surface.visibleEntityRefs ?? [])],
      allowedActions: [...new Set(surface.allowedActions)],
    });
    assertCredentialZeroCollection({ surfaces: [entry] });
    return entry;
  });

  const payload = authSurfaceManifestPayloadSchema.parse({
    version: "1",
    signedAt,
    surfaces,
  });
  assertCredentialZeroCollection(payload);
  return payload;
}

// ─── 签名载荷的规范化序列化（供 HMAC 使用；键排序保证确定输出）──────────

function canonicalSerializeValue(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalSerializeValue).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(
        ([key, val]) =>
          `${JSON.stringify(key)}:${canonicalSerializeValue(val)}`,
      );
    return `{${entries.join(",")}}`;
  }
  // 不支持的原始类型（undefined/function/symbol）按字符串兜底，避免序列化分叉。
  return JSON.stringify(String(value));
}

/**
 * 对签名载荷做规范化 JSON 序列化（递归键排序、数组保序）。
 * 构建与校验使用同一函数，保证 HMAC 跨进程可复现。
 */
export function canonicalSerializeAuthSurfacePayload(
  payload: AuthSurfaceManifestPayload,
): string {
  return canonicalSerializeValue(payload);
}
