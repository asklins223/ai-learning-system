/**
 * 阶段 03（W2）任务 03-5：Global Shell 确定性动作服务（原方案 §0.5/§5.4）。
 *
 * Global Companion Shell 是一层确定性分发与呈现壳，**不是第二条 Learning pipeline**：
 * 所有页面复用一个 versioned context/action contract、一个触发仲裁器和一套用户开关；
 * 不得为每个页面再建独立助手 Agent、消息历史或记忆库。
 *
 * 本服务只实现 §5.4 列出的 9 个 Global Shell 确定性产品动作：
 *   spotlight_ui_anchor / open_page_help / preview_navigation / resume_onboarding /
 *   resume_checkpoint / show_permission_scope / dismiss_suggestion /
 *   preview_registered_page_action / request_page_action_confirmation
 *
 * 边界（验收：普通浏览/引导路径零 Session 创建、零 learning budget 消耗）：
 * - **不 import learning-sessions 模块**（解耦证明，见 shell-actions.test.ts 静态断言）；
 * - 不创建 Episode、不创建 Learning Session、不直接修改领域数据、不调 Agent；
 * - 动作 ID 白名单校验：模型不能自由拼装，只接受预注册 action ID（其余一律拒绝）；
 * - 每个动作执行流程固定：触发仲裁器 → versioned context 校验 → 页面访问权限校验 →
 *   所需字段完整性校验 → 生成确定性 payload → 记录 audit → 返回结果；
 * - 结果类型在类型层面带字面量 `sessionCreated: false`、`learningBudgetSpent: 0`、
 *   `canonicalWrite: false`，配合 `canCreateSession()` 恒 false 守卫与
 *   `learningBudgetForShellAction()` 恒 0 守卫；
 * - 纯逻辑 + 可注入 repo：审计写入与触发仲裁规则由调用方注入（production 由路由层接
 *   audit-service / account-state 读取），本模块不直接依赖 DB 或共享包。
 */

import { createHash } from "node:crypto";
import { DomainError } from "@ailearn/shared";

// ─── 1. 版本化 context/action contract ────────────────────────────────────

/**
 * Global Shell 统一 context/action contract 版本。客户端提交的页面上下文
 * `contextVersion` 必须等于该版本，否则拒绝（防止模型/旧客户端拼装不同版本上下文）。
 */
export const GLOBAL_SHELL_CONTEXT_ACTION_CONTRACT_VERSION =
  "global-shell-context-action-v1" as const;

/** Global Shell 动作审计的 policy 版本（audit 记录用，与 §5.8 语义一致）。 */
export const GLOBAL_SHELL_POLICY_VERSION = "global-shell-action-v1" as const;

// ─── 2. 动作白名单（§5.4，9 个） ──────────────────────────────────────────

/**
 * 预注册的 Global Shell 动作 ID。**只接受本列表中的 action**；
 * 模型/客户端提交的任何其他字符串（包括 spatial actions 与任意拼装）一律拒绝。
 */
export const GLOBAL_SHELL_ACTION_IDS = [
  "spotlight_ui_anchor",
  "open_page_help",
  "preview_navigation",
  "resume_onboarding",
  "resume_checkpoint",
  "show_permission_scope",
  "dismiss_suggestion",
  "preview_registered_page_action",
  "request_page_action_confirmation",
] as const;
export type GlobalShellActionName = (typeof GLOBAL_SHELL_ACTION_IDS)[number];

/** 类型守卫：字符串是否为预注册的 Global Shell 动作 ID。 */
export function isGlobalShellAction(value: string): value is GlobalShellActionName {
  return (GLOBAL_SHELL_ACTION_IDS as readonly string[]).includes(value);
}

// ─── 3. 页面上下文与访问级别 ──────────────────────────────────────────────

/**
 * 页面访问级别（由净化页面上下文派生，服务端判定）：
 * - `credential`：登录/注册等凭据页——只允许静态帮助类动作，禁止任何个性化动作；
 * - `public`：未登录的普通页面；
 * - `authenticated`：已登录页面（有 userId/workspaceId）。
 */
export type ShellPageAccess = "public" | "authenticated" | "credential";

/**
 * Global Shell 页面上下文（versioned context contract v1）。
 * 全部字段为 opaque ID/版本/目标引用，不携带页面内容（§12.2：不读 DOM/截图/凭据）。
 */
export interface ShellActionContext {
  /** 页面 opaque id（不存内容；audit 关联与去重用）。 */
  readonly pageOpaqueId?: string;
  /** 页面访问级别（服务端判定并注入）。 */
  readonly pageAccess: ShellPageAccess;
  /** context contract 版本：必须等于 GLOBAL_SHELL_CONTEXT_ACTION_CONTRACT_VERSION。 */
  readonly contextVersion: string;
  /** 用户 id（authenticated 页面必填）。 */
  readonly userId?: string;
  /** workspace id（authenticated 页面必填）。 */
  readonly workspaceId?: string;
  /** 客户端设备 session（opaque；dismiss/仲裁用）。 */
  readonly deviceSessionId?: string;
  // ── 各动作所需目标字段 ──
  readonly anchorId?: string;
  readonly helpTopic?: string;
  readonly destinationPageId?: string;
  readonly onboardingVersion?: string;
  readonly checkpointRef?: string;
  readonly permissionScopeId?: string;
  readonly suggestionId?: string;
  readonly registeredActionId?: string;
}

// ─── 4. 可注入依赖（触发仲裁器 + 审计 + 时钟） ───────────────────────────

export interface ShellActionAuditEntry {
  /** 审计行分类：Global Shell 确定性动作。 */
  readonly pageActionType: "global_shell_action";
  /** 已校验通过的动作 ID。 */
  readonly action: GlobalShellActionName;
  readonly pageOpaqueId?: string;
  /** 客户端动作 nonce（opaque，幂等/关联用）。 */
  readonly actionOpaqueId?: string;
  /** 动作目标 id 的不可逆 hash（opaque entity refs，§12.2）。 */
  readonly entityOpaqueIds?: readonly string[];
  readonly contextVersion: string;
  /** 权限快照 hash：pageAccess + action + required fields 的稳定指纹。 */
  readonly permissionSnapshotHash?: string;
  readonly policyVersion: string;
  readonly result: "allowed";
}

/** 触发仲裁器：同一时刻/同一页面只能展示一个动作，一次只展示一个（§5.4.4）。 */
export interface ShellActionArbiter {
  canTrigger(
    action: GlobalShellActionName,
    ctx: ShellActionContext,
  ): { ok: true } | { ok: false; reason: string };
}

/** 执行依赖（production 由路由层注入 audit-service 与账号级开关读取）。 */
export interface ShellActionDeps {
  /** 审计写入（fire-and-forget 由调用方决定；本模块只负责调用）。 */
  readonly audit: (entry: ShellActionAuditEntry) => Promise<void>;
  /** 可选触发仲裁器；缺省 = 允许触发。 */
  readonly arbiter?: ShellActionArbiter;
  /** 可注入时钟（默认 new Date）。 */
  readonly now?: () => Date;
}

export interface ShellActionExecutionOptions {
  /** 客户端动作 nonce（opaque；写入 audit.actionOpaqueId）。 */
  readonly opaqueActionId?: string;
}

// ─── 5. 错误与错误码 ─────────────────────────────────────────────────────

export const ShellActionErrorCode = {
  /** 动作 ID 不在白名单（模型/客户端自由拼装被拒）。 */
  UNKNOWN_ACTION: "UNKNOWN_ACTION",
  /** 页面访问级别不允许该动作（如凭据页的个性化动作）。 */
  PERMISSION_DENIED: "PERMISSION_DENIED",
  /** 页面上下文缺少该动作所需字段。 */
  INCOMPLETE_PAGE_CONTEXT: "INCOMPLETE_PAGE_CONTEXT",
  /** contextVersion 与当前 contract 版本不匹配（旧/拼装上下文被拒）。 */
  STALE_CONTEXT_CONTRACT: "STALE_CONTEXT_CONTRACT",
  /** 触发仲裁器拒绝（冷却中 / 该页面一次只允许一个动作）。 */
  ARBITER_DENIED: "ARBITER_DENIED",
} as const;
export type ShellActionErrorCode =
  (typeof ShellActionErrorCode)[keyof typeof ShellActionErrorCode];

export class ShellActionError extends DomainError {
  readonly code: ShellActionErrorCode;
  readonly statusCode: number;

  constructor(code: ShellActionErrorCode, statusCode: number, message: string) {
    super({ name: "ShellActionError", code, message, statusCode });
    this.code = code;
    this.statusCode = statusCode;
  }
}

// ─── 6. 零 Session / 零 budget 守卫（解耦证明） ───────────────────────────

/**
 * Global Shell 永不创建 learning Session（解耦守卫，恒返回 false）。
 * 类型返回 `false`，配合每个结果的字面量 `sessionCreated: false`，
 * 编译期即阻止把 Global Shell 动作当作学习管道入口。
 */
export function canCreateSession(): false {
  return false;
}

/**
 * Global Shell 动作永不消耗 learning budget（恒返回 0）。
 * 配合每个结果的字面量 `learningBudgetSpent: 0`。
 */
export function learningBudgetForShellAction(): 0 {
  return 0;
}

// ─── 7. 动作规格表（权限矩阵 + 所需字段） ────────────────────────────────

interface GlobalShellActionSpec {
  readonly name: GlobalShellActionName;
  readonly description: string;
  /** 该动作允许的页面访问级别。 */
  readonly allowedAccess: readonly ShellPageAccess[];
  /** 该动作所需页面上下文字段（缺失即拒绝）。 */
  readonly requires: readonly (keyof ShellActionContext)[];
}

/**
 * 9 个动作的确定性规格。权限矩阵语义：
 * - `credential`（凭据页）只允许静态帮助/关闭建议/导航预览，禁止任何个性化动作；
 * - `authenticated` 专属：resume_checkpoint / show_permission_scope（需用户状态）。
 */
const GLOBAL_SHELL_ACTION_SPECS: Readonly<
  Record<GlobalShellActionName, GlobalShellActionSpec>
> = {
  spotlight_ui_anchor: {
    name: "spotlight_ui_anchor",
    description: "页面锚点亮显（仅 UI 呈现，不携带内容）。",
    allowedAccess: ["public", "authenticated"],
    requires: ["pageOpaqueId", "anchorId"],
  },
  open_page_help: {
    name: "open_page_help",
    description: "打开页面帮助（静态，所有页面可用）。",
    allowedAccess: ["public", "authenticated", "credential"],
    requires: ["pageOpaqueId", "helpTopic"],
  },
  preview_navigation: {
    name: "preview_navigation",
    description: "预览导航目标（静态，不实际导航）。",
    allowedAccess: ["public", "authenticated", "credential"],
    requires: ["pageOpaqueId", "destinationPageId"],
  },
  resume_onboarding: {
    name: "resume_onboarding",
    description: "恢复首次引导（确定性引导 step 呈现，非学习内容）。",
    allowedAccess: ["public", "authenticated"],
    requires: ["onboardingVersion"],
  },
  resume_checkpoint: {
    name: "resume_checkpoint",
    description: "恢复学习 checkpoint 入口（仅被动恢复入口，不创建 Session）。",
    allowedAccess: ["authenticated"],
    requires: ["checkpointRef", "userId", "workspaceId"],
  },
  show_permission_scope: {
    name: "show_permission_scope",
    description: "展示权限范围（静态说明卡）。",
    allowedAccess: ["authenticated"],
    requires: ["permissionScopeId", "userId"],
  },
  dismiss_suggestion: {
    name: "dismiss_suggestion",
    description: "关闭建议（只记录 dismiss 意图，不改变领域数据）。",
    allowedAccess: ["public", "authenticated", "credential"],
    requires: ["suggestionId", "deviceSessionId"],
  },
  preview_registered_page_action: {
    name: "preview_registered_page_action",
    description: "预览注册的页面动作（仅预览，确认前零副作用）。",
    allowedAccess: ["public", "authenticated"],
    requires: ["registeredActionId"],
  },
  request_page_action_confirmation: {
    name: "request_page_action_confirmation",
    description: "请求页面动作显式确认（确认 UI，动作本身未执行）。",
    allowedAccess: ["public", "authenticated"],
    requires: ["registeredActionId", "userId"],
  },
};

// ─── 8. 确定性 payload 与审计辅助 ─────────────────────────────────────────

/** 每个动作返回结构化确定性 payload；全部是呈现/状态描述，不携带领域数据。 */
function buildPayload(
  name: GlobalShellActionName,
  ctx: ShellActionContext,
): Record<string, unknown> {
  switch (name) {
    case "spotlight_ui_anchor":
      return { anchorId: ctx.anchorId, presentation: "highlight_anchor", spotlightMode: "single" };
    case "open_page_help":
      return { helpTopic: ctx.helpTopic, static: true, presentation: "static_help_panel" };
    case "preview_navigation":
      return {
        destinationPageId: ctx.destinationPageId,
        presentation: "static_navigation_preview",
        commitOnConfirm: false,
      };
    case "resume_onboarding":
      return { onboardingVersion: ctx.onboardingVersion, entryMode: "resume", presentation: "onboarding_resume" };
    case "resume_checkpoint":
      return { checkpointRef: ctx.checkpointRef, presentation: "passive_resume" };
    case "show_permission_scope":
      return { permissionScopeId: ctx.permissionScopeId, presentation: "permission_scope_card" };
    case "dismiss_suggestion":
      return { suggestionId: ctx.suggestionId, dismissed: true };
    case "preview_registered_page_action":
      return { registeredActionId: ctx.registeredActionId, preview: "registered_action_preview", requiresConfirmation: true };
    case "request_page_action_confirmation":
      return { registeredActionId: ctx.registeredActionId, confirmationPending: true };
  }
}

/** 权限快照 hash：action + pageAccess + contract 版本的稳定指纹。 */
function computePermissionSnapshotHash(
  name: GlobalShellActionName,
  ctx: ShellActionContext,
): string {
  const spec = GLOBAL_SHELL_ACTION_SPECS[name];
  const canonical = [
    name,
    ctx.pageAccess,
    ctx.contextVersion,
    spec.requires.join(","),
  ].join("|");
  return createHash("sha256").update(canonical).digest("hex");
}

/** 动作目标 id 的不可逆 hash（opaque entity refs，audit 只存 hash，§12.2）。 */
function collectEntityOpaqueIds(
  name: GlobalShellActionName,
  ctx: ShellActionContext,
): string[] {
  const spec = GLOBAL_SHELL_ACTION_SPECS[name];
  const ids: string[] = [];
  for (const field of spec.requires) {
    const value = ctx[field];
    if (typeof value === "string" && value.length > 0) {
      ids.push(createHash("sha256").update(value).digest("hex"));
    }
  }
  return ids;
}

// ─── 9. 统一执行流程（触发仲裁 → 版本校验 → 权限 → 字段 → payload → audit）──

export interface GlobalShellActionResult {
  readonly action: GlobalShellActionName;
  readonly outcome: "allowed";
  /** versioned context/action contract 快照。 */
  readonly contract: {
    readonly version: typeof GLOBAL_SHELL_CONTEXT_ACTION_CONTRACT_VERSION;
    readonly pageOpaqueId?: string;
  };
  /** 确定性呈现 payload（无领域数据）。 */
  readonly payload: Record<string, unknown>;
  /** 字面量 false：本动作绝不创建 learning Session。 */
  readonly sessionCreated: false;
  /** 字面量 0：本动作不消耗任何 learning budget。 */
  readonly learningBudgetSpent: 0;
  /** 字面量 false：本动作绝不写 canonical/领域数据。 */
  readonly canonicalWrite: false;
  /** 审计摘要（完整审计行已通过 deps.audit 写入）。 */
  readonly audit: {
    readonly policyVersion: string;
    readonly actionOpaqueId?: string;
    readonly at: string;
  };
}

/**
 * 执行单个已注册的 Global Shell 动作（内部统一流程）。
 * 每一步 fail closed：仲裁拒绝 → 409；context 版本失配 → 409；权限不足 → 403；
 * 字段缺失 → 422；白名单外动作在入口处 → 400。
 */
async function runSpecifiedAction(
  deps: ShellActionDeps,
  name: GlobalShellActionName,
  ctx: ShellActionContext,
  opts: ShellActionExecutionOptions | undefined,
): Promise<GlobalShellActionResult> {
  // 1. 触发仲裁器：同一页面一次只展示一个动作（§5.4.4）。
  const verdict = deps.arbiter?.canTrigger(name, ctx);
  if (verdict && !verdict.ok) {
    throw new ShellActionError(
      ShellActionErrorCode.ARBITER_DENIED,
      409,
      `trigger arbiter denied ${name}: ${verdict.reason}`,
    );
  }

  // 2. versioned context contract：客户端必须提交当前版本（防旧/拼装上下文）。
  if (ctx.contextVersion !== GLOBAL_SHELL_CONTEXT_ACTION_CONTRACT_VERSION) {
    throw new ShellActionError(
      ShellActionErrorCode.STALE_CONTEXT_CONTRACT,
      409,
      `context contract version mismatch: got ${ctx.contextVersion}, expected ${GLOBAL_SHELL_CONTEXT_ACTION_CONTRACT_VERSION}`,
    );
  }

  // 3. 页面访问权限校验（凭据页只放行静态帮助类动作）。
  const spec = GLOBAL_SHELL_ACTION_SPECS[name];
  if (!spec.allowedAccess.includes(ctx.pageAccess)) {
    throw new ShellActionError(
      ShellActionErrorCode.PERMISSION_DENIED,
      403,
      `action ${name} is not allowed on page access ${ctx.pageAccess}`,
    );
  }

  // 4. 所需字段完整性校验（模型不能拼装缺少目标的动作）。
  for (const field of spec.requires) {
    const value = ctx[field];
    if (value === undefined || value === null || value === "") {
      throw new ShellActionError(
        ShellActionErrorCode.INCOMPLETE_PAGE_CONTEXT,
        422,
        `action ${name} requires ${field} in page context`,
      );
    }
  }

  // 5. 解耦守卫：本函数不可达的运行时护栏（编译期由字面量类型保证）。
  //    合并判定同时引用两个守卫，杜绝「只判 Session、漏判 budget」的半吊子护栏。
  if (canCreateSession() || learningBudgetForShellAction() !== 0) {
    throw new Error(
      "invariant: global shell action must never create a learning session or spend learning budget",
    );
  }

  // 6. 生成确定性 payload + 记录审计。
  const now = (deps.now ?? (() => new Date()))();
  const permissionSnapshotHash = computePermissionSnapshotHash(name, ctx);
  const entry: ShellActionAuditEntry = {
    pageActionType: "global_shell_action",
    action: name,
    pageOpaqueId: ctx.pageOpaqueId,
    actionOpaqueId: opts?.opaqueActionId,
    entityOpaqueIds: collectEntityOpaqueIds(name, ctx),
    contextVersion: ctx.contextVersion,
    permissionSnapshotHash,
    policyVersion: GLOBAL_SHELL_POLICY_VERSION,
    result: "allowed",
  };
  await deps.audit(entry);

  return {
    action: name,
    outcome: "allowed",
    contract: {
      version: GLOBAL_SHELL_CONTEXT_ACTION_CONTRACT_VERSION,
      pageOpaqueId: ctx.pageOpaqueId,
    },
    payload: buildPayload(name, ctx),
    sessionCreated: false,
    learningBudgetSpent: 0,
    canonicalWrite: false,
    audit: {
      policyVersion: GLOBAL_SHELL_POLICY_VERSION,
      actionOpaqueId: opts?.opaqueActionId,
      at: now.toISOString(),
    },
  };
}

export interface ExecuteShellActionInput {
  /** 动作 ID（字符串，服务端白名单校验；未知 ID 拒绝，模型不能自由拼装）。 */
  readonly action: string;
  readonly context: ShellActionContext;
  readonly opaqueActionId?: string;
}

/**
 * 统一入口：白名单校验后执行。这是 Global Shell 的唯一触发点——
 * 页面导航、首次引导与静态帮助都汇聚到这里，不创建第二条 Learning pipeline。
 */
export async function executeGlobalShellAction(
  deps: ShellActionDeps,
  input: ExecuteShellActionInput,
): Promise<GlobalShellActionResult> {
  if (!isGlobalShellAction(input.action)) {
    throw new ShellActionError(
      ShellActionErrorCode.UNKNOWN_ACTION,
      400,
      `unknown global shell action: ${input.action}`,
    );
  }
  return runSpecifiedAction(deps, input.action, input.context, {
    opaqueActionId: input.opaqueActionId,
  });
}

// ─── 10. 九个动作的专用执行函数（§5.4 清单逐一对应） ────────────────────

/** 页面锚点亮显。 */
export function executeSpotlightUiAnchor(
  deps: ShellActionDeps,
  context: ShellActionContext,
  opts?: ShellActionExecutionOptions,
): Promise<GlobalShellActionResult> {
  return runSpecifiedAction(deps, "spotlight_ui_anchor", context, opts);
}

/** 打开页面帮助（静态）。 */
export function executeOpenPageHelp(
  deps: ShellActionDeps,
  context: ShellActionContext,
  opts?: ShellActionExecutionOptions,
): Promise<GlobalShellActionResult> {
  return runSpecifiedAction(deps, "open_page_help", context, opts);
}

/** 预览导航目标。 */
export function executePreviewNavigation(
  deps: ShellActionDeps,
  context: ShellActionContext,
  opts?: ShellActionExecutionOptions,
): Promise<GlobalShellActionResult> {
  return runSpecifiedAction(deps, "preview_navigation", context, opts);
}

/** 恢复首次引导。 */
export function executeResumeOnboarding(
  deps: ShellActionDeps,
  context: ShellActionContext,
  opts?: ShellActionExecutionOptions,
): Promise<GlobalShellActionResult> {
  return runSpecifiedAction(deps, "resume_onboarding", context, opts);
}

/** 恢复学习 checkpoint 入口（仅被动恢复入口，不创建 Session）。 */
export function executeResumeCheckpoint(
  deps: ShellActionDeps,
  context: ShellActionContext,
  opts?: ShellActionExecutionOptions,
): Promise<GlobalShellActionResult> {
  return runSpecifiedAction(deps, "resume_checkpoint", context, opts);
}

/** 展示权限范围（静态说明卡）。 */
export function executeShowPermissionScope(
  deps: ShellActionDeps,
  context: ShellActionContext,
  opts?: ShellActionExecutionOptions,
): Promise<GlobalShellActionResult> {
  return runSpecifiedAction(deps, "show_permission_scope", context, opts);
}

/** 关闭建议（只记录 dismiss 意图）。 */
export function executeDismissSuggestion(
  deps: ShellActionDeps,
  context: ShellActionContext,
  opts?: ShellActionExecutionOptions,
): Promise<GlobalShellActionResult> {
  return runSpecifiedAction(deps, "dismiss_suggestion", context, opts);
}

/** 预览注册的页面动作（仅预览，确认前零副作用）。 */
export function executePreviewRegisteredPageAction(
  deps: ShellActionDeps,
  context: ShellActionContext,
  opts?: ShellActionExecutionOptions,
): Promise<GlobalShellActionResult> {
  return runSpecifiedAction(deps, "preview_registered_page_action", context, opts);
}

/** 请求页面动作显式确认（确认 UI，动作本身未执行）。 */
export function executeRequestPageActionConfirmation(
  deps: ShellActionDeps,
  context: ShellActionContext,
  opts?: ShellActionExecutionOptions,
): Promise<GlobalShellActionResult> {
  return runSpecifiedAction(deps, "request_page_action_confirmation", context, opts);
}
