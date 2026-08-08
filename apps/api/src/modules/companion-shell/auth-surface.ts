/**
 * 阶段 02（W1）任务 02-5：随构建签名的 auth-surface manifest（§12.3 + §13.3）。
 *
 * 登录/注册页的角色说明、公开帮助文案与错误帮助来自本模块构建并签名的 manifest：
 * - 内容全部是公开静态文案（不涉密），随构建签名一次并缓存，不依赖 authenticated API；
 * - 签名用 HMAC-SHA256，密钥来自环境变量 AUTH_SURFACE_MANIFEST_SECRET（代码中不硬编码）；
 *   密钥缺失时降级为测试模式：使用固定 test secret 签名并在响应中注明 testMode=true，
 *   生产部署必须设置该环境变量（未设置时控制台无法区分签名来源，由 testMode 显式披露）；
 * - manifest 经 packages/shared 的构建校验强制 credential 零采集
 *   （visibleEntityRefs 为空、无模型/ASR/TTS/observer 字段、动作仅限 allowlist）。
 *
 * 端点：GET /public/auth-surface-manifest（不鉴权，见 routes.ts）。
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import {
  AuthSurfaceAction,
  authSurfaceManifestV1Schema,
  buildAuthSurfaceManifestPayload,
  canonicalSerializeAuthSurfacePayload,
  type AuthSurfaceManifestEntryInput,
  type AuthSurfaceManifestPayload,
  type AuthSurfaceManifestV1,
} from "@ailearn/shared";

/** 签名载荷版本；与 authSurfaceManifestV1Schema.version 的 literal("1") 对应。 */
const SIGNING_VERSION = "1";

/**
 * 测试模式降级密钥：仅当 AUTH_SURFACE_MANIFEST_SECRET 缺失时使用。
 * 该密钥是公开常量，绝不用于生产签名；testMode=true 会在响应中显式披露。
 */
const TEST_MODE_SECRET =
  "auth-surface-manifest-test-mode-secret-do-not-use-in-production";

/**
 * 随构建签名的静态公开内容：登录/注册页的角色说明与公开帮助文案。
 * 均为公开静态文本，不涉密、不含账号/凭据相关信息；每条 visibleEntityRefs 为空。
 */
const STATIC_AUTH_SURFACES: readonly AuthSurfaceManifestEntryInput[] = [
  {
    surfaceId: "login:static_help",
    surfaceKind: "static_help",
    textContent:
      "登录页：伴星只提供公开帮助与提交动作。账号与密码输入不会被伴星读取、记录，也不会发送给任何模型。",
    allowedActions: [
      AuthSurfaceAction.OPEN_HELP,
      AuthSurfaceAction.SUBMIT_LOGIN,
      AuthSurfaceAction.TOGGLE_HIDE_COMPANION,
    ],
  },
  {
    surfaceId: "login:silent_anchor",
    surfaceKind: "silent_anchor",
    textContent: "",
    allowedActions: [AuthSurfaceAction.SUBMIT_LOGIN],
  },
  {
    surfaceId: "login:transitional",
    surfaceKind: "transitional",
    textContent: "正在校验登录信息…",
    allowedActions: [AuthSurfaceAction.SUBMIT_LOGIN],
  },
  {
    surfaceId: "register:static_help",
    surfaceKind: "static_help",
    textContent:
      "注册页：伴星只提供公开说明与注册动作。密码与验证码输入不会被伴星读取、记录，也不会发送给任何模型；" +
      "隐藏伴星只会在当前设备保存一个可清除的开关。",
    allowedActions: [
      AuthSurfaceAction.OPEN_HELP,
      AuthSurfaceAction.SUBMIT_REGISTER,
      AuthSurfaceAction.TOGGLE_HIDE_COMPANION,
    ],
  },
  {
    surfaceId: "register:silent_anchor",
    surfaceKind: "silent_anchor",
    textContent: "",
    allowedActions: [AuthSurfaceAction.SUBMIT_REGISTER],
  },
  {
    surfaceId: "register:transitional",
    surfaceKind: "transitional",
    textContent: "正在创建账号…",
    allowedActions: [AuthSurfaceAction.SUBMIT_REGISTER],
  },
];

export interface AuthSurfaceManifestInfo {
  manifest: AuthSurfaceManifestV1;
  /**
   * 是否因缺失 AUTH_SURFACE_MANIFEST_SECRET 而使用测试模式降级签名。
   * 生产响应必须为 false；true 时调用方应把签名视为不可信（fail closed）。
   */
  testMode: boolean;
}

/** 读取签名密钥；缺失/空时返回 null（触发测试模式降级）。 */
export function resolveAuthSurfaceManifestSecret(): string | null {
  const secret = process.env.AUTH_SURFACE_MANIFEST_SECRET?.trim();
  return secret && secret.length > 0 ? secret : null;
}

/** 对签名载荷（不含 signature）做 HMAC-SHA256，返回 hex 摘要。 */
function signPayload(payload: AuthSurfaceManifestPayload, secret: string): string {
  return createHmac("sha256", secret)
    .update(canonicalSerializeAuthSurfacePayload(payload))
    .digest("hex");
}

/** 校验 manifest 签名（constant-time 比对）；密钥不匹配时返回 false（fail closed）。 */
export function verifyAuthSurfaceManifest(
  manifest: AuthSurfaceManifestV1,
  secret: string,
): boolean {
  const payload = authSurfaceManifestV1Schema.omit({ signature: true }).parse(
    manifest,
  );
  const expected = signPayload(payload, secret);
  const actual = Buffer.from(manifest.signature, "utf8");
  const want = Buffer.from(expected, "utf8");
  return actual.length === want.length && timingSafeEqual(actual, want);
}

let cachedInfo: AuthSurfaceManifestInfo | null = null;

/**
 * 构建并签发 manifest，进程内缓存一次（「随构建签名」：signedAt 固定为首次构建时刻，
 * 不随请求变化）。构建即校验 credential 零采集，违规直接抛错（fail closed）。
 */
export function getAuthSurfaceManifestInfo(): AuthSurfaceManifestInfo {
  if (cachedInfo) return cachedInfo;

  const secret = resolveAuthSurfaceManifestSecret();
  const testMode = secret === null;
  const signingSecret = secret ?? TEST_MODE_SECRET;

  // buildAuthSurfaceManifestPayload 内部会执行 credential 零采集校验；
  // 再对完整 V1（含 signature）做一次 schema 校验，确保签名前后结构一致。
  const payload = buildAuthSurfaceManifestPayload({
    surfaces: STATIC_AUTH_SURFACES,
  });
  if (payload.version !== SIGNING_VERSION) {
    throw new Error(`auth-surface manifest version mismatch: ${payload.version}`);
  }
  const manifest = authSurfaceManifestV1Schema.parse({
    ...payload,
    signature: signPayload(payload, signingSecret),
  });

  cachedInfo = { manifest, testMode };
  return cachedInfo;
}
