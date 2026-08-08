/**
 * 阶段 08（W7）任务 08-2：安全与隐私审计纯逻辑（§13.1/§13.3）。
 *
 * 本文件是**纯逻辑审计器**（无 DB / 无网络 / 无副作用 / 无随机 / 无时钟依赖），
 * 把冻结记录 01-4 §13.1（答案泄漏边界）与 §13.3（RLS 与攻击面）翻译成确定性
 * 校验函数。每个函数输入一次审计快照，输出违规列表或 fail-closed 判定
 * （`FailClosedResult`）。所有攻击面**失败即关闭**（fail closed）：任何校验
 * 无法确认安全时按拒绝处理，绝不静默放行。
 *
 * 覆盖面（与任务 08-2 一一对应）：
 * - DOM Gold 双校验：前台 Companion DTO / RSC / hydration / prefetch / cache /
 *   DOM 零 private contract 字段（public allowlist + private denylist 同时校验，
 *   不做粗暴 substring 禁止；allowlist 与 denylist 交集在配置层即失败）；
 * - credential 页零采集复核：输入值及字段焦点/长度/粘贴/自动填充/时序元数据
 *   进入 DTO/RSC/cache/analytics/日志/模型请求六面 = 0；credential 页只提供
 *   公开只读帮助（static_help_only），错误码防枚举归一化；
 * - `PageCompanionContextV1` / 页面 manifest / action token 校验（schema、版本、
 *   签名/来源、workspace、permission snapshot、contextVersion、action allowlist），
 *   页面切换后 stale action fail closed；
 * - workspace/角色切换原子清空全局任务上下文；跨 workspace entity refs、
 *   onboarding resumeRef 与邀请 key 不得复用；
 * - 对抗集 fail closed：prompt injection、伪 evidence/node/token/option ID、
 *   跨版本引用、音频替换、replay 攻击；
 * - drag/order/scenario payload 校验 allowlisted IDs、数量、版本、hash；
 * - semantic relation candidate 不能通过回答接口变成 published；
 * - `temporary_hidden` / `global_off` 后零监听/零调用矩阵（observer/context DTO/
 *   角色/邀请/声音/预取/新增 Companion job；`global_off` 另含全部设备 lease
 *   失效、系统通知与跨设备调用为 0、可取消调用取消、迟到结果丢弃）。
 */

import { createHmac, timingSafeEqual } from "node:crypto";

// ─── 1. 公共类型 ─────────────────────────────────────────────────────────

/** 审计违规：人类可读的确定性描述（空数组 = 该维度通过）。 */
export type SecurityViolation = string;

/** fail-closed 判定：未能确认安全即拒绝。 */
export type FailClosedResult = { ok: true } | { ok: false; reason: string };

// ─── 2. DOM Gold 双校验（§13.1 答案泄漏边界）─────────────────────────────

/**
 * DOM Gold 表面：trusted 提交前任何可能到达前台/DOM 的载体。
 * dto/rsc/hydration/prefetch/cache 校验字段名集合；dom 校验文本中的 token。
 */
export type DomGoldSurfaceKind = "dto" | "rsc" | "hydration" | "prefetch" | "cache" | "dom";

export const DOM_GOLD_SURFACE_KINDS: readonly DomGoldSurfaceKind[] = [
  "dto",
  "rsc",
  "hydration",
  "prefetch",
  "cache",
  "dom",
];

/** 一个前台表面：字段名集合（结构化载体）或文本（DOM）。 */
export interface DomGoldSurface {
  kind: DomGoldSurfaceKind;
  /** 出现在该表面的字段名集合（DTO/RSC/hydration/prefetch/cache）。 */
  fieldNames?: readonly string[];
  /** DOM 文本（dom 表面；也可用于结构化表面做 token 文本兜底校验）。 */
  text?: string;
}

/**
 * DOM Gold 配置：public allowlist 与 private denylist **同时**生效。
 * 双校验规则：
 * 1. allowlist 校验——任何表面出现的字段名必须属于 `publicAllowlist`；
 * 2. denylist 校验——任何表面出现 `privateDenylist` 字段名即违规（即使在
 *    allowlist 中也违规）；
 * 3. 配置自检——`publicAllowlist ∩ privateDenylist` 必须为空（配置层即失败，
 *    防止 allowlist 被 private 字段污染）；
 * 4. DOM 文本——`privateTokens` 任一出现在任何表面文本即违规；`publicTokens`
 *    允许出现（scene-safety-v1 批准、属于 PublicSceneContract allowlist）。
 */
export interface DomGoldConfig {
  /** 允许出现在任何前台表面的字段名（public allowlist）。 */
  publicAllowlist: readonly string[];
  /** 绝对禁止出现在任何表面的字段名（private denylist）。 */
  privateDenylist: readonly string[];
  /** 允许出现在 DOM 文本中的 public token（§13.1 PublicSceneContract allowlist）。 */
  publicTokens?: readonly string[];
  /** 禁止出现在任何表面文本中的 private token（secret solution 等）。 */
  privateTokens?: readonly string[];
}

export interface DomGoldInput {
  surfaces: readonly DomGoldSurface[];
  config: DomGoldConfig;
}

/** 配置自检：allowlist 与 denylist 不得有交集（防 allowlist 污染）。 */
export function domGoldConfigIntersections(
  config: DomGoldConfig,
): readonly string[] {
  return config.publicAllowlist.filter((field) =>
    config.privateDenylist.includes(field),
  );
}

/** DOM Gold 双校验：返回全部违规（空 = trusted 提交前无泄漏）。 */
export function checkDomGold(input: DomGoldInput): readonly SecurityViolation[] {
  const violations: SecurityViolation[] = [];

  // security_review LOW 修复：未提供任何 surface 快照 → 视为「未确认」（fail closed），
  // 空 surfaces 不得当作零违规通过（未采样快照 ≠ 无泄漏）。
  if (input.surfaces.length === 0) {
    violations.push("DOM Gold：无 surface 快照（未确认）→ fail closed");
  }

  // 配置层自检：allowlist ∩ denylist 必须为空。
  for (const field of domGoldConfigIntersections(input.config)) {
    violations.push(
      `DOM Gold 配置自检失败：字段 "${field}" 同时出现在 public allowlist 与 private denylist（配置层即失败）`,
    );
  }

  const privateTokens = input.config.privateTokens ?? [];
  const publicTokens = input.config.publicTokens ?? [];

  for (const surface of input.surfaces) {
    // allowlist 校验 + denylist 校验（字段名）。
    for (const field of surface.fieldNames ?? []) {
      if (!input.config.publicAllowlist.includes(field)) {
        violations.push(
          `[${surface.kind}] 字段 "${field}" 不在 public allowlist（trusted 提交前前台零非 allowlist 字段）`,
        );
      }
      if (input.config.privateDenylist.includes(field)) {
        violations.push(
          `[${surface.kind}] private denylist 字段 "${field}" 泄漏到前台=0 被违反`,
        );
      }
    }
    // DOM/文本 token 校验：private token 不得出现；public token 允许。
    const text = surface.text ?? "";
    for (const token of privateTokens) {
      if (text.length > 0 && text.includes(token)) {
        violations.push(
          `[${surface.kind}] private token "${token}" 出现在前台文本=0 被违反`,
        );
      }
    }
    // public token 若出现在文本中即视为已放行（allowlist 侧），无需违规；
    // 此处只做记录性确认：public token 必须属于 PublicSceneContract allowlist，
    // 这已由 config.publicTokens 声明保证（与 denylist 无交集时合法）。
    for (const token of publicTokens) {
      if (text.length > 0 && text.includes(token)) {
        // 放行——public token 由 scene-safety-v1 批准。
      }
    }
  }
  return violations;
}

// ─── 3. credential 页零采集 + 防枚举（§13.3）─────────────────────────────

/**
 * credential 页零采集六面（任务 08-2：DTO / RSC / cache / analytics / 日志 /
 * 模型请求）。输入值及字段焦点/长度/粘贴/自动填充/时序元数据进入任一面试
 * 0 容忍违规。截图与持久上下文作为模型请求/日志的相邻渠道由 08-5 D4 覆盖。
 */
/**
 * replay/时钟偏斜容忍：issuedAtMs 比 nowMs 超前超过该值（默认 30s）视为
 * 未来时间戳（时钟偏斜/伪造）→ replay 拒绝（security_review LOW 修复）。
 */
export const CLOCK_SKEW_TOLERANCE_MS = 30_000;

export const CREDENTIAL_INGRESS_SURFACES = [
  "companion_dto",
  "rsc",
  "cache",
  "analytics",
  "logs",
  "model_request",
] as const;
export type CredentialIngressSurface = (typeof CREDENTIAL_INGRESS_SURFACES)[number];

export const CREDENTIAL_INGRESS_KINDS = [
  "value",
  "focus",
  "length",
  "paste",
  "autofill",
  "timing",
] as const;
export type CredentialIngressKind = (typeof CREDENTIAL_INGRESS_KINDS)[number];

/** 一次 credential 页采集记录（0 容忍：任何一条进入六面都违规）。 */
export interface CredentialIngressRecord {
  surface: string;
  kind: string;
  detail?: string;
}

export interface CredentialZeroIngressInput {
  records: readonly CredentialIngressRecord[];
}

/** 类型守卫：字符串是否为已知六面之一（未知渠道也视为入侵尝试）。 */
export function isCredentialIngressSurface(value: string): value is CredentialIngressSurface {
  return (CREDENTIAL_INGRESS_SURFACES as readonly string[]).includes(value);
}

/**
 * credential 页零采集复核：任何输入值/字段交互元数据进入六面 = 0。
 * 未知渠道的记录同样违规（记录渠道是已知六面之外的枚举 → 防枚举失败）。
 */
export function checkCredentialZeroIngress(
  input: CredentialZeroIngressInput,
): readonly SecurityViolation[] {
  const violations: SecurityViolation[] = [];
  for (const record of input.records) {
    if (!isCredentialIngressSurface(record.surface)) {
      violations.push(
        `credential 页采集渠道 "${record.surface}" 未知（防枚举失败，六面清单之外一律拒绝）`,
      );
      continue;
    }
    violations.push(
      `credential 页 ${record.kind}（${record.detail ?? "无细节"}）进入 ${record.surface}=0 被违反（六面全 0）`,
    );
  }
  return violations;
}

/**
 * credential 页公开错误码白名单（防枚举）。credential 页/注册/找回只向客户端
 * 暴露这组归一化公开码，**不泄漏**具体校验细节、枚举值或内部错误结构。
 */
export const CREDENTIAL_PUBLIC_ERROR_CODES = [
  "GENERIC_AUTH_ERROR",
  "GENERIC_LOGIN_ERROR",
  "GENERIC_REGISTER_ERROR",
  "GENERIC_RESET_ERROR",
] as const;
export type CredentialPublicErrorCode = (typeof CREDENTIAL_PUBLIC_ERROR_CODES)[number];

/** 内部错误码 → 公开归一化错误码映射（防枚举：未知内部码 → 通用码）。 */
const CREDENTIAL_ERROR_NORMALIZATION: Readonly<Record<string, CredentialPublicErrorCode>> = {
  "invalid_credentials": "GENERIC_LOGIN_ERROR",
  "user_not_found": "GENERIC_LOGIN_ERROR",
  "account_locked_temporarily": "GENERIC_LOGIN_ERROR",
  "email_already_registered": "GENERIC_REGISTER_ERROR",
  "password_too_weak": "GENERIC_REGISTER_ERROR",
  "reset_token_invalid": "GENERIC_RESET_ERROR",
  "reset_request_unknown": "GENERIC_RESET_ERROR",
};

/**
 * 防枚举归一化：内部错误码 → 公开只读错误码。任何未映射的内部码收敛为
 * `GENERIC_AUTH_ERROR`，且**公开码自身不可逆推内部细节**（所有公开码都在
 * 白名单内，无内幕语义）。
 */
export function normalizeCredentialErrorCode(internalCode: string): CredentialPublicErrorCode {
  return CREDENTIAL_ERROR_NORMALIZATION[internalCode] ?? "GENERIC_AUTH_ERROR";
}

/** credential 页唯一允许的伴星表面：公开只读静态帮助（无角色/无个性化动作）。 */
export type CredentialPageRole = "static_help_only";

export const CREDENTIAL_PAGE_ALLOWED_ROLE = "static_help_only" as const;

/**
 * 解析 credential 页伴星角色：`sensitivity === "credential"` 的页面只能提供
 * 公开只读静态帮助（fail closed）；其余表面一律拒绝（不提供模型生成帮助，
 * 不读取表单，不观察字段/交互元数据）。
 */
export function resolveCredentialPageRole(
  sensitivity: string,
): { ok: true; role: CredentialPageRole } | { ok: false; reason: string } {
  if (sensitivity !== "credential") {
    return { ok: false, reason: `页面敏感级 "${sensitivity}" 不是 credential 页，不适用公开帮助解析` };
  }
  return { ok: true, role: CREDENTIAL_PAGE_ALLOWED_ROLE };
}

// ─── 4. 页面 manifest 与 action token 校验（§13.3）────────────────────────

/** PageCompanionContextV1 的 schema 名（与 05-5 冻结类型一致）。 */
export const PAGE_COMPANION_CONTEXT_SCHEMA = "PageCompanionContextV1";
/** 页面 manifest schema 名。 */
export const PAGE_MANIFEST_SCHEMA = "CompanionPageManifestV1";
/** action token schema 名。 */
export const ACTION_TOKEN_SCHEMA = "CompanionActionTokenV1";

/**
 * 页面 manifest（服务端签发、HMAC 签名）。全部字段为 opaque 引用/版本/hash，
 * 不携带页面内容或凭据（§12.2）。
 */
export interface PageManifestV1 {
  schema: string;
  version: number;
  source: string;
  pageKind: string;
  routePattern: string;
  sensitivity: string;
  workspaceId?: string;
  permissionSnapshotHash: string;
  contextVersion: number;
  actionAllowlist: readonly string[];
  signature: string;
}

/** manifest 校验期望（服务端持有）。 */
export interface PageManifestExpectations {
  expectedSchema: string;
  expectedVersion: number;
  /** 合法签发来源（构建时签名等）。 */
  allowedSources: readonly string[];
  expectedWorkspaceId?: string;
  expectedPermissionSnapshotHash: string;
  expectedContextVersion: number;
  /** 合法 action ID 注册表（页面职责矩阵 allow 侧，07-2）。 */
  allowedActionRegistry: readonly string[];
  /** HMAC 签名密钥。 */
  signatureSecret: string;
}

/** 构造 manifest 签名字符串（确定性字段顺序，签名对象固定）。 */
export function canonicalManifestPayload(
  manifest: Pick<
    PageManifestV1,
    | "schema"
    | "version"
    | "source"
    | "pageKind"
    | "routePattern"
    | "sensitivity"
    | "workspaceId"
    | "permissionSnapshotHash"
    | "contextVersion"
    | "actionAllowlist"
  >,
): string {
  return JSON.stringify({
    schema: manifest.schema,
    version: manifest.version,
    source: manifest.source,
    pageKind: manifest.pageKind,
    routePattern: manifest.routePattern,
    sensitivity: manifest.sensitivity,
    workspaceId: manifest.workspaceId ?? null,
    permissionSnapshotHash: manifest.permissionSnapshotHash,
    contextVersion: manifest.contextVersion,
    actionAllowlist: [...manifest.actionAllowlist].sort(),
  });
}

/** 计算 HMAC-SHA256 签名（确定性）。 */
export function computeSignature(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

/** 常数时间签名校验（长度不一致直接拒绝）。 */
export function verifySignature(payload: string, signature: string, secret: string): boolean {
  const expected = Buffer.from(computeSignature(payload, secret), "hex");
  const actual = Buffer.from(signature, "hex");
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

/**
 * 页面 manifest 校验：schema → 版本 → 来源 → workspace → permission snapshot →
 * contextVersion → action allowlist ⊆ 注册表 → 签名。任一失败 fail closed。
 */
export function validatePageManifestV1(
  manifest: PageManifestV1,
  expectations: PageManifestExpectations,
): FailClosedResult {
  if (manifest.schema !== expectations.expectedSchema) {
    return { ok: false, reason: `manifest schema 不匹配（${manifest.schema}，应为 ${expectations.expectedSchema}）` };
  }
  if (manifest.version !== expectations.expectedVersion) {
    return { ok: false, reason: `manifest 版本不匹配（${manifest.version}，应为 ${expectations.expectedVersion}）` };
  }
  if (!expectations.allowedSources.includes(manifest.source)) {
    return { ok: false, reason: `manifest 来源 "${manifest.source}" 不在合法来源 allowlist` };
  }
  if (
    expectations.expectedWorkspaceId !== undefined
    && manifest.workspaceId !== expectations.expectedWorkspaceId
  ) {
    return { ok: false, reason: `manifest workspace 不匹配（${manifest.workspaceId ?? "无"}，应为 ${expectations.expectedWorkspaceId}）` };
  }
  if (manifest.permissionSnapshotHash !== expectations.expectedPermissionSnapshotHash) {
    return { ok: false, reason: "manifest permission snapshot hash 不匹配（fail closed）" };
  }
  if (manifest.contextVersion !== expectations.expectedContextVersion) {
    return { ok: false, reason: `manifest contextVersion 不匹配（${manifest.contextVersion}，应为 ${expectations.expectedContextVersion}）` };
  }
  for (const actionId of manifest.actionAllowlist) {
    if (!expectations.allowedActionRegistry.includes(actionId)) {
      return { ok: false, reason: `manifest allowlist 含未注册 action "${actionId}"（不在页面职责矩阵 allow 侧）` };
    }
  }
  const payload = canonicalManifestPayload(manifest);
  if (!verifySignature(payload, manifest.signature, expectations.signatureSecret)) {
    return { ok: false, reason: "manifest 签名无效（fail closed）" };
  }
  return { ok: true };
}

/** action token（服务端签发、一次性、短 TTL、HMAC 签名）。 */
export interface ActionTokenV1 {
  schema: string;
  version: number;
  source: string;
  actionId: string;
  pageInstanceId: string;
  workspaceId: string;
  permissionSnapshotHash: string;
  contextVersion: number;
  issuedAtMs: number;
  nonce: string;
  signature: string;
}

export interface ActionTokenExpectations {
  expectedSchema: string;
  expectedVersion: number;
  allowedSources: readonly string[];
  expectedWorkspaceId: string;
  expectedPermissionSnapshotHash: string;
  expectedContextVersion: number;
  /** 当前页面允许的 action（当前 context 重验后的 allowlist）。 */
  allowlistedActionIds: readonly string[];
  signatureSecret: string;
  /** token 最大年龄（ms）；超过即视为 stale/过期。 */
  maxTokenAgeMs: number;
}

export function canonicalActionTokenPayload(
  token: Pick<
    ActionTokenV1,
    | "schema"
    | "version"
    | "source"
    | "actionId"
    | "pageInstanceId"
    | "workspaceId"
    | "permissionSnapshotHash"
    | "contextVersion"
    | "issuedAtMs"
    | "nonce"
  >,
): string {
  return JSON.stringify({
    schema: token.schema,
    version: token.version,
    source: token.source,
    actionId: token.actionId,
    pageInstanceId: token.pageInstanceId,
    workspaceId: token.workspaceId,
    permissionSnapshotHash: token.permissionSnapshotHash,
    contextVersion: token.contextVersion,
    issuedAtMs: token.issuedAtMs,
    nonce: token.nonce,
  });
}

/**
 * action token 校验：schema/版本/来源/workspace/permission/contextVersion/
 * actionId allowlist/签名/TTL。任一失败 fail closed。
 */
export function validateActionTokenV1(
  token: ActionTokenV1,
  expectations: ActionTokenExpectations,
  nowMs: number,
): FailClosedResult {
  if (token.schema !== expectations.expectedSchema) {
    return { ok: false, reason: `action token schema 不匹配（${token.schema}，应为 ${expectations.expectedSchema}）` };
  }
  if (token.version !== expectations.expectedVersion) {
    return { ok: false, reason: `action token 版本不匹配（${token.version}，应为 ${expectations.expectedVersion}）` };
  }
  if (!expectations.allowedSources.includes(token.source)) {
    return { ok: false, reason: `action token 来源 "${token.source}" 不在合法来源 allowlist` };
  }
  if (token.workspaceId !== expectations.expectedWorkspaceId) {
    return { ok: false, reason: `action token workspace 不匹配（${token.workspaceId}，应为 ${expectations.expectedWorkspaceId}）` };
  }
  if (token.permissionSnapshotHash !== expectations.expectedPermissionSnapshotHash) {
    return { ok: false, reason: "action token permission snapshot hash 不匹配（fail closed）" };
  }
  if (token.contextVersion !== expectations.expectedContextVersion) {
    return { ok: false, reason: `action token contextVersion 不匹配（${token.contextVersion}，应为 ${expectations.expectedContextVersion}）` };
  }
  if (!expectations.allowlistedActionIds.includes(token.actionId)) {
    return { ok: false, reason: `action "${token.actionId}" 不在当前页面 allowlist（fail closed）` };
  }
  if (nowMs - token.issuedAtMs > expectations.maxTokenAgeMs) {
    return { ok: false, reason: `action token 过期（age=${nowMs - token.issuedAtMs}ms > ${expectations.maxTokenAgeMs}ms）` };
  }
  const payload = canonicalActionTokenPayload(token);
  if (!verifySignature(payload, token.signature, expectations.signatureSecret)) {
    return { ok: false, reason: "action token 签名无效（fail closed）" };
  }
  return { ok: true };
}

// ─── 5. 页面切换后 stale action fail closed（§13.3）───────────────────────

/** 页面切换后的当前页面状态（服务端当前重验）。 */
export interface CurrentPageState {
  pageInstanceId: string;
  workspaceId: string;
  permissionSnapshotHash: string;
  contextVersion: number;
}

export interface StaleActionCheckInput {
  token: ActionTokenV1;
  current: CurrentPageState;
  /** 当前页面允许的 action（当前 manifest 的 allowlist 重验）。 */
  allowlistedActionIds: readonly string[];
  nowMs: number;
}

/**
 * stale action fail closed：页面切换后，token 与当前页面任何维度不一致即拒绝
 * 动作——不得绕过未保存内容、workspace 或权限状态（§17.2 故障矩阵：
 * "page context/action token stale → 拒绝动作，刷新净化上下文"）。
 */
export function evaluateStaleAction(input: StaleActionCheckInput): FailClosedResult {
  if (input.token.pageInstanceId !== input.current.pageInstanceId) {
    return {
      ok: false,
      reason: `stale action fail closed：页面实例已切换（token=${input.token.pageInstanceId}，当前=${input.current.pageInstanceId}）`,
    };
  }
  if (input.token.workspaceId !== input.current.workspaceId) {
    return { ok: false, reason: "stale action fail closed：workspace 已切换，旧 token 拒绝" };
  }
  if (input.token.permissionSnapshotHash !== input.current.permissionSnapshotHash) {
    return { ok: false, reason: "stale action fail closed：permission snapshot 已变化，旧 token 拒绝" };
  }
  if (input.token.contextVersion !== input.current.contextVersion) {
    return { ok: false, reason: "stale action fail closed：contextVersion 已变化，旧 token 拒绝" };
  }
  if (!input.allowlistedActionIds.includes(input.token.actionId)) {
    return { ok: false, reason: `stale action fail closed：action "${input.token.actionId}" 不在当前页面 allowlist` };
  }
  return { ok: true };
}

// ─── 6. workspace/角色切换原子清空 + 跨 workspace ref 不复用（§13.3）──────

export type GlobalTaskContextKind =
  | "entity_ref"
  | "onboarding_resume"
  | "invitation_key"
  | "task_state";

/** 全局任务上下文条目（只携带 opaque ref/键，不携带内容）。 */
export interface GlobalTaskContextEntry {
  workspaceId: string;
  contextKey: string;
  kind: GlobalTaskContextKind;
}

export interface WorkspaceSwitchInput {
  previousWorkspaceId: string;
  nextWorkspaceId: string;
  /** 是否同时发生角色切换。 */
  roleChanged: boolean;
  /** 切换后仍存活的全局任务上下文（应原子清空旧 workspace 残留）。 */
  retainedContexts: readonly GlobalTaskContextEntry[];
}

/**
 * workspace/角色切换原子清空：切换后任何仍保留的、属于**旧 workspace** 的
 * 全局任务上下文（entity refs / onboarding resume / invitation key / task state）
 * = 违规。角色切换与 workspace 切换同等要求原子清空。
 */
export function checkWorkspaceSwitchAtomicClear(
  input: WorkspaceSwitchInput,
): readonly SecurityViolation[] {
  const violations: SecurityViolation[] = [];
  if (input.previousWorkspaceId === input.nextWorkspaceId && !input.roleChanged) {
    return violations; // 无切换，无需清空。
  }
  for (const entry of input.retainedContexts) {
    if (entry.workspaceId === input.previousWorkspaceId) {
      violations.push(
        `workspace/角色切换后旧 workspace 全局任务上下文 ${entry.kind}("${entry.contextKey}") 仍保留=0 被违反（须原子清空）`,
      );
    }
  }
  return violations;
}

export interface CrossWorkspaceRefCheckInput {
  /** 当前存活的跨 workspace ref 快照。 */
  activeRefs: readonly GlobalTaskContextEntry[];
  /** 此前已签发给他 workspace 的 ref 键（key + 所在 workspace）。 */
  previouslyIssuedRefKeys: readonly { key: string; workspaceId: string }[];
}

/**
 * 跨 workspace ref 不得复用：entity refs、onboarding resumeRef 与邀请 key
 * 若被复用到不同 workspace（无论是与历史签发冲突，还是在同一快照内跨
 * workspace 重复）即违规。
 */
export function checkCrossWorkspaceRefReuse(
  input: CrossWorkspaceRefCheckInput,
): readonly SecurityViolation[] {
  const violations: SecurityViolation[] = [];
  const seen: Map<string, string> = new Map();
  for (const entry of input.activeRefs) {
    const priorWorkspace = seen.get(entry.contextKey);
    if (priorWorkspace !== undefined && priorWorkspace !== entry.workspaceId) {
      violations.push(
        `跨 workspace ${entry.kind} ref "${entry.contextKey}" 复用于 workspace ${priorWorkspace} 与 ${entry.workspaceId}=0 被违反`,
      );
    }
    seen.set(entry.contextKey, entry.workspaceId);

    for (const issued of input.previouslyIssuedRefKeys) {
      if (issued.key === entry.contextKey && issued.workspaceId !== entry.workspaceId) {
        violations.push(
          `跨 workspace ${entry.kind} ref "${entry.contextKey}" 复用了此前签发到 workspace ${issued.workspaceId} 的键（现用于 ${entry.workspaceId}）=0 被违反`,
        );
      }
    }
  }
  return violations;
}

// ─── 7. 对抗集 fail closed（§13.3）────────────────────────────────────────

/**
 * prompt injection 检测样本（确定性模式集，大小写不敏感）。
 * 规则：命中任一模式即拒绝——不依赖模型"自觉不泄题"（§13.1）。
 */
export const PROMPT_INJECTION_PATTERNS = [
  "ignore previous instructions",
  "ignore all previous instructions",
  "forget everything you know",
  "you are now",
  "act as system",
  "system prompt",
  "repeat all instructions",
  "输出系统提示",
  "忽略之前的指令",
  "忽略以上所有指令",
  "你是系统",
  "重复所有指令",
] as const;

/** 检测 prompt injection（fail closed：命中任一模式 = true）。 */
export function detectPromptInjection(text: string): boolean {
  const lower = text.toLowerCase();
  return PROMPT_INJECTION_PATTERNS.some((pattern) => lower.includes(pattern.toLowerCase()));
}

/** 伪 ID 类别（§13.3 伪 evidence/node/token/option ID）。 */
export type ForgedIdKind = "evidence" | "node" | "token" | "option";

export interface ForgedIdSample {
  id: string;
  /** 服务端签发、当前 context 允许的合法 ID 注册表。 */
  issuedIdRegistry: readonly string[];
  idKind: ForgedIdKind;
}

/** 伪 ID 判定：不在服务端签发注册表 = 伪 ID（fail closed）。 */
export function checkForgedId(sample: ForgedIdSample): boolean {
  return !sample.issuedIdRegistry.includes(sample.id);
}

export interface CrossVersionReferenceSample {
  ref: string;
  /** ref 中声明的版本。 */
  declaredVersion: number;
  /** 当前 context 期望版本。 */
  expectedVersion: number;
}

/** 跨版本引用判定：声明的版本与当前 context 版本不一致 = 拒绝。 */
export function checkCrossVersionReference(sample: CrossVersionReferenceSample): boolean {
  return sample.declaredVersion !== sample.expectedVersion;
}

export interface AudioReplacementSample {
  /** artifact 声明的 transcript/audio 绑定 hash。 */
  declaredBindingHash: string;
  /** 服务端记录的 canonical 绑定 hash。 */
  expectedBindingHash: string;
  /** 仅当用户显式确认替换（合法重录）才豁免。 */
  userConfirmedReplacement?: boolean;
}

/** 音频替换判定：绑定 hash 不一致且未经用户显式确认 = 替换攻击（拒绝）。 */
export function checkAudioReplacement(sample: AudioReplacementSample): boolean {
  if (sample.declaredBindingHash === sample.expectedBindingHash) return false;
  return sample.userConfirmedReplacement !== true;
}

export interface ReplaySample {
  nonce: string;
  /** 已消费 nonce 集合（服务端维护）。 */
  usedNonces: readonly string[];
  issuedAtMs: number;
  nowMs: number;
  maxAgeMs: number;
}

/** replay 判定：nonce 已用、超出有效期或未来时间（时钟偏斜）= replay（拒绝）。 */
export function checkReplay(sample: ReplaySample): boolean {
  if (sample.usedNonces.includes(sample.nonce)) return true;
  // security_review LOW 修复：issuedAtMs 在未来（时钟偏斜/伪造）→ 视为 replay，
  // 不能因「age 为负」而永不判过期。
  if (sample.issuedAtMs > sample.nowMs + CLOCK_SKEW_TOLERANCE_MS) return true;
  return sample.nowMs - sample.issuedAtMs > sample.maxAgeMs;
}

/** 对抗面枚举（§13.3：prompt injection、伪 ID、跨版本引用、音频替换、replay）。 */
export const ADVERSARIAL_ATTACK_IDS = [
  "prompt_injection",
  "forged_evidence_id",
  "forged_node_id",
  "forged_token_id",
  "forged_option_id",
  "cross_version_reference",
  "audio_replacement",
  "replay_attack",
] as const;
export type AdversarialAttackId = (typeof ADVERSARIAL_ATTACK_IDS)[number];

/** 一次对抗样本：attackId + 对应检测输入。 */
export type AdversarialSample =
  | { attackId: "prompt_injection"; text: string }
  | { attackId: "forged_evidence_id" | "forged_node_id" | "forged_token_id" | "forged_option_id"; sample: ForgedIdSample }
  | { attackId: "cross_version_reference"; sample: CrossVersionReferenceSample }
  | { attackId: "audio_replacement"; sample: AudioReplacementSample }
  | { attackId: "replay_attack"; sample: ReplaySample };

/**
 * 统一对抗面判定（fail closed）：检测到攻击 → `{ rejected: true }`。
 * 攻击样本必须被拒绝；正常样本被放行（供测试双断言）。
 */
export function evaluateAdversarialSample(sample: AdversarialSample): {
  rejected: boolean;
  reason?: string;
} {
  switch (sample.attackId) {
    case "prompt_injection":
      return detectPromptInjection(sample.text)
        ? { rejected: true, reason: "检测到 prompt injection（命中注入模式）" }
        : { rejected: false };
    case "forged_evidence_id":
    case "forged_node_id":
    case "forged_token_id":
    case "forged_option_id": {
      const forged = checkForgedId(sample.sample);
      return forged
        ? { rejected: true, reason: `伪 ${sample.attackId}：ID 不在服务端签发注册表（fail closed）` }
        : { rejected: false };
    }
    case "cross_version_reference":
      return checkCrossVersionReference(sample.sample)
        ? { rejected: true, reason: `跨版本引用：声明版本 ${sample.sample.declaredVersion} ≠ 当前 ${sample.sample.expectedVersion}（fail closed）` }
        : { rejected: false };
    case "audio_replacement":
      return checkAudioReplacement(sample.sample)
        ? { rejected: true, reason: "音频替换：绑定 hash 不一致且无用户确认（fail closed）" }
        : { rejected: false };
    case "replay_attack":
      return checkReplay(sample.sample)
        ? { rejected: true, reason: "replay 攻击：nonce 已消费或过期（fail closed）" }
        : { rejected: false };
  }
}

// ─── 8. drag/order/scenario payload 校验（§13.3）──────────────────────────

export type CompanionPayloadKind = "drag" | "order" | "scenario";

export interface CompanionPayloadV1 {
  kind: CompanionPayloadKind;
  version: number;
  /** payload 引用的 ID（node/order/scenario item ids）。 */
  ids: readonly string[];
  /** payload 内容指纹（确定性）。 */
  hash: string;
}

export interface PayloadExpectations {
  kind: CompanionPayloadKind;
  /** 服务端当前 context 允许的 ID 集合。 */
  allowlistedIds: readonly string[];
  maxCount: number;
  expectedVersion: number;
  expectedHash: string;
}

/**
 * payload 校验：kind 匹配、每个 ID ∈ allowlist、数量 ≤ maxCount、版本匹配、
 * hash 匹配。任一失败 fail closed（§13.3 drag/order/scenario）。
 */
export function checkCompanionPayload(
  payload: CompanionPayloadV1,
  expectations: PayloadExpectations,
): FailClosedResult {
  if (payload.kind !== expectations.kind) {
    return { ok: false, reason: `payload kind 不匹配（${payload.kind}，应为 ${expectations.kind}）` };
  }
  if (payload.ids.length > expectations.maxCount) {
    return { ok: false, reason: `payload ID 数量 ${payload.ids.length} 超过上限 ${expectations.maxCount}` };
  }
  for (const id of payload.ids) {
    if (!expectations.allowlistedIds.includes(id)) {
      return { ok: false, reason: `payload 含非 allowlisted ID "${id}"（fail closed）` };
    }
  }
  if (payload.version !== expectations.expectedVersion) {
    return { ok: false, reason: `payload 版本不匹配（${payload.version}，应为 ${expectations.expectedVersion}）` };
  }
  if (payload.hash !== expectations.expectedHash) {
    return { ok: false, reason: "payload hash 不匹配（fail closed）" };
  }
  return { ok: true };
}

// ─── 9. semantic relation candidate 不可经回答接口 published（§13.3）──────

export interface RelationCandidatePublishAttempt {
  /** 提交渠道：回答接口或 relation review（Should）。 */
  via: "answer_response" | "relation_review";
  candidateRef: string;
  becamePublished: boolean;
  /** relation_review 渠道是否经有审核权限的 actor 走发布流程。 */
  reviewedByAuthorizedActor?: boolean;
}

/**
 * semantic relation candidate 只能经 relation review + 有审核权限的 actor
 * 发布；**不得**通过回答接口变成 published。违反即违规。
 */
export function checkRelationCandidatePublish(
  attempts: readonly RelationCandidatePublishAttempt[],
): readonly SecurityViolation[] {
  const violations: SecurityViolation[] = [];
  for (const attempt of attempts) {
    if (attempt.becamePublished && attempt.via === "answer_response") {
      violations.push(
        `semantic relation candidate "${attempt.candidateRef}" 经回答接口变成 published=0 被违反（只能经 relation review 发布）`,
      );
    }
    if (
      attempt.becamePublished
      && attempt.via === "relation_review"
      && attempt.reviewedByAuthorizedActor !== true
    ) {
      violations.push(
        `semantic relation candidate "${attempt.candidateRef}" 未经审核权限 actor 发布=0 被违反`,
      );
    }
  }
  return violations;
}

// ─── 10. temporary_hidden / global_off 零监听零调用矩阵（§13.3）────────────

/** hidden/off 确认后必须清零的监听/调用面（§13.3：observer/context DTO/角色/邀请/声音/预取/新增 Companion job）。 */
export const SUPPRESSED_AFTER_HIDDEN_ACTIVITIES = [
  "observer",
  "context_dto",
  "character",
  "invite",
  "voice",
  "prefetch",
  "companion_job",
] as const;
export type SuppressedActivityKind = (typeof SUPPRESSED_AFTER_HIDDEN_ACTIVITIES)[number];

export interface SuppressedActivityRecord {
  kind: string;
  deviceSessionId?: string;
  /** 活动时刻（ms）；缺省 = 视为 hidden 确认后（保守判定）。 */
  atMs?: number;
}

export interface HiddenOffZeroListenersInput {
  /** temporary_hidden 是否已本地生效/runtime-fence 确认。 */
  temporaryHidden: boolean;
  /** global_off 是否已 account CAS 应用。 */
  globalOff: boolean;
  /** 当前 device session（temporary_hidden 只约束当前设备）。 */
  currentDeviceSessionId?: string;
  /** temporary_hidden 确认时刻（ms）；缺省 = 全部活动视为确认后。 */
  hiddenConfirmedAtMs?: number;
  activities: readonly SuppressedActivityRecord[];
}

/** 活动是否落在 hidden 确认之后（无时刻 → 保守视为之后）。 */
function occursAfterHiddenConfirm(
  activity: SuppressedActivityRecord,
  confirmedAtMs: number | undefined,
): boolean {
  if (confirmedAtMs === undefined) return true;
  if (activity.atMs === undefined) return true;
  return activity.atMs >= confirmedAtMs;
}

/**
 * hidden/off 零监听零调用矩阵：
 * - temporary_hidden 确认后：当前 device session 的 observer/context DTO/角色/
 *   邀请/声音/预取/新增 Companion job = 0；
 * - global_off CAS 后：所有设备上述活动 = 0。
 */
export function checkHiddenOffZeroListenersCalls(
  input: HiddenOffZeroListenersInput,
): readonly SecurityViolation[] {
  const violations: SecurityViolation[] = [];
  for (const activity of input.activities) {
    const suppressed = (SUPPRESSED_AFTER_HIDDEN_ACTIVITIES as readonly string[]).includes(
      activity.kind,
    );
    if (!suppressed) continue;
    const isThisDevice =
      activity.deviceSessionId === undefined
      || activity.deviceSessionId === input.currentDeviceSessionId;

    if (input.temporaryHidden && isThisDevice && occursAfterHiddenConfirm(activity, input.hiddenConfirmedAtMs)) {
      violations.push(
        `temporary_hidden 确认后当前设备 ${activity.kind} 活动=0 被违反（零监听/零调用）`,
      );
    }
    if (input.globalOff) {
      violations.push(
        `global_off CAS 后 ${activity.kind} 活动=0 被违反（所有设备要求 0）`,
      );
    }
  }
  return violations;
}

export interface GlobalOffAdditionalCheckInput {
  globalOffCasApplied: boolean;
  /** 是否全部设备 lease 已失效（global_off 要求）。 */
  allDeviceLeasesInvalidated: boolean;
  /** Companion 系统通知计数（必须 0）。 */
  systemNotifications: number;
  /** 跨设备调用计数（必须 0）。 */
  crossDeviceCalls: number;
  /** 可取消调用记录：已请求取消的必须真正被取消。 */
  cancellableCalls: readonly { cancelRequested: boolean; cancelled: boolean }[];
  /** 迟到结果被采用计数（必须 0；须丢弃不渲染不写状态不触发后续 job）。 */
  lateResultsAdopted: number;
}

/**
 * global_off 附加复核：全部设备 lease 失效、Companion 系统通知与跨设备调用
 * 为 0、可取消调用取消、迟到结果丢弃（§13.3 / §17.2 故障矩阵）。
 */
export function checkGlobalOffAdditional(
  input: GlobalOffAdditionalCheckInput,
): readonly SecurityViolation[] {
  const violations: SecurityViolation[] = [];
  if (!input.globalOffCasApplied) return violations;
  if (!input.allDeviceLeasesInvalidated) {
    violations.push("global_off CAS 后全部设备 lease 未失效=0 被违反");
  }
  if (input.systemNotifications > 0) {
    violations.push(`global_off CAS 后 Companion 系统通知 ${input.systemNotifications} 次=0 被违反`);
  }
  if (input.crossDeviceCalls > 0) {
    violations.push(`global_off CAS 后跨设备调用 ${input.crossDeviceCalls} 次=0 被违反`);
  }
  for (const call of input.cancellableCalls) {
    if (call.cancelRequested && !call.cancelled) {
      violations.push("已请求取消的 Companion 调用未被取消=0 被违反（可取消调用必须取消）");
    }
  }
  if (input.lateResultsAdopted > 0) {
    violations.push(`迟到 Companion 结果被采用 ${input.lateResultsAdopted} 次=0 被违反（须丢弃不渲染不写状态）`);
  }
  return violations;
}

// ─── 11. 聚合套件 ─────────────────────────────────────────────────────────

export const SECURITY_AUDIT_DIMENSION_IDS = [
  "dom_gold",
  "credential_zero_ingress",
  "workspace_switch_clear",
  "cross_workspace_ref_reuse",
  "relation_publish",
  "hidden_off_zero",
  "global_off_additional",
] as const;
export type SecurityAuditDimensionId = (typeof SECURITY_AUDIT_DIMENSION_IDS)[number];

/** 一次安全/隐私审计套件（确定性校验维度；manifest/token/对抗/payload 为独立判定函数）。 */
export interface SecurityAuditSuiteInput {
  domGold: DomGoldInput;
  credentialZeroIngress: CredentialZeroIngressInput;
  workspaceSwitch: WorkspaceSwitchInput;
  crossWorkspaceRefs: CrossWorkspaceRefCheckInput;
  relationPublish: readonly RelationCandidatePublishAttempt[];
  hiddenOff: HiddenOffZeroListenersInput;
  globalOffAdditional: GlobalOffAdditionalCheckInput;
}

export interface SecurityAuditReport {
  ok: boolean;
  violations: readonly SecurityViolation[];
  dimensions: Record<SecurityAuditDimensionId, readonly SecurityViolation[]>;
}

/** 运行一次安全/隐私审计套件，返回确定性报告（空违规 = 通过）。 */
export function runSecurityAudit(input: SecurityAuditSuiteInput): SecurityAuditReport {
  const dimensions: Record<SecurityAuditDimensionId, readonly SecurityViolation[]> = {
    dom_gold: checkDomGold(input.domGold),
    credential_zero_ingress: checkCredentialZeroIngress(input.credentialZeroIngress),
    workspace_switch_clear: checkWorkspaceSwitchAtomicClear(input.workspaceSwitch),
    cross_workspace_ref_reuse: checkCrossWorkspaceRefReuse(input.crossWorkspaceRefs),
    relation_publish: checkRelationCandidatePublish(input.relationPublish),
    hidden_off_zero: checkHiddenOffZeroListenersCalls(input.hiddenOff),
    global_off_additional: checkGlobalOffAdditional(input.globalOffAdditional),
  };
  const violations: SecurityViolation[] = [];
  for (const key of SECURITY_AUDIT_DIMENSION_IDS) {
    violations.push(...dimensions[key]);
  }
  return { ok: violations.length === 0, violations, dimensions };
}

export class SecurityAuditFailure extends Error {
  readonly violations: readonly SecurityViolation[];
  constructor(violations: readonly SecurityViolation[]) {
    super(`安全/隐私审计失败（${violations.length} 项违规）：\n- ${violations.join("\n- ")}`);
    this.name = "SecurityAuditFailure";
    this.violations = violations;
  }
}

/** 确定性断言入口：任一维度违规即抛 `SecurityAuditFailure`（0 容忍 fail closed）。 */
export function assertSecurityAudit(input: SecurityAuditSuiteInput): SecurityAuditReport {
  const report = runSecurityAudit(input);
  if (!report.ok) {
    throw new SecurityAuditFailure(report.violations);
  }
  return report;
}

/** 维度 → 任务 08-2 要求说明（供报告/决策记录引用）。 */
export const SECURITY_AUDIT_DIMENSION_DESCRIPTIONS: Record<
  SecurityAuditDimensionId,
  string
> = {
  dom_gold:
    "trusted 提交前前台 Companion DTO、RSC/hydration、prefetch、cache 与 DOM 零 private contract 字段/完整 claim 结论/secret solution/正确映射/distractor 身份/hidden rubric/expected target/private evidence/历史正确答案/内部 gap verdict/Tutor 提示；DOM Gold 同时校验 public allowlist 与 private denylist",
  credential_zero_ingress:
    "credential 页输入值及字段焦点/长度/粘贴/自动填充/时序元数据进入 Companion DTO、RSC/hydration/cache、analytics、日志、模型请求六面=0；公开帮助只读页面类型；防枚举归一化错误码",
  workspace_switch_clear:
    "workspace/角色切换原子清空全局任务上下文；跨 workspace entity refs、onboarding resumeRef 和邀请 key 不得复用",
  cross_workspace_ref_reuse:
    "跨 workspace entity refs、onboarding resumeRef 和邀请 key 不得复用（fail closed）",
  relation_publish:
    "semantic relation candidate 不能通过回答接口变成 published；relation review 须经有审核权限的 actor",
  hidden_off_zero:
    "temporary_hidden/global_off 后 observer/context DTO/角色/邀请/声音/预取/新增 Companion job 零监听零调用",
  global_off_additional:
    "global_off 还要求全部设备 lease 失效、系统通知和跨设备调用为 0；可取消调用取消、迟到结果丢弃",
};
