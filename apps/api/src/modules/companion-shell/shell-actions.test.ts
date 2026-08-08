/**
 * 阶段 03（W2）任务 03-5：Global Shell 确定性动作服务单测。
 *
 * 验收覆盖：
 * - 9 个 §5.4 动作均可确定性执行（校验页面上下文/权限 → 记录 audit → 返回确定性结果）；
 * - 无 Session 创建、无 learning budget 消耗（字面量字段 + 守卫 + 静态解耦断言）；
 * - 未知 action 拒绝（模型不能自由拼装，spatial action 也不能冒充）；
 * - 权限不足拒绝（凭据页个性化动作 / authenticated-only 动作在 public 页）；
 * - 页面上下文缺失、context contract 版本失配、触发仲裁器拒绝。
 *
 * 纯逻辑测试：审计与仲裁全部走可注入 deps，不依赖 DB / learning-sessions / shared。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  canCreateSession,
  executeDismissSuggestion,
  executeGlobalShellAction,
  executeOpenPageHelp,
  executePreviewNavigation,
  executePreviewRegisteredPageAction,
  executeRequestPageActionConfirmation,
  executeResumeCheckpoint,
  executeResumeOnboarding,
  executeShowPermissionScope,
  executeSpotlightUiAnchor,
  GLOBAL_SHELL_ACTION_IDS,
  GLOBAL_SHELL_CONTEXT_ACTION_CONTRACT_VERSION,
  GLOBAL_SHELL_POLICY_VERSION,
  isGlobalShellAction,
  learningBudgetForShellAction,
  ShellActionError,
  ShellActionErrorCode,
  type GlobalShellActionResult,
  type GlobalShellActionName,
  type ShellActionAuditEntry,
  type ShellActionContext,
  type ShellActionDeps,
} from "./shell-actions.ts";

// ─── 测试依赖与上下文构造 ─────────────────────────────────────────────────

interface TestDeps extends ShellActionDeps {
  auditCalls: ShellActionAuditEntry[];
}

function makeDeps(overrides: Partial<ShellActionDeps> = {}): TestDeps {
  const auditCalls: ShellActionAuditEntry[] = [];
  return {
    audit: async (entry) => {
      auditCalls.push(entry);
    },
    ...overrides,
    auditCalls,
  };
}

function ctx(overrides: Partial<ShellActionContext> = {}): ShellActionContext {
  return {
    pageOpaqueId: "page:kp-detail",
    pageAccess: "authenticated",
    contextVersion: GLOBAL_SHELL_CONTEXT_ACTION_CONTRACT_VERSION,
    userId: "user-1",
    workspaceId: "ws-1",
    deviceSessionId: "device-1",
    ...overrides,
  };
}

/** 每个动作的合法上下文（满足其 requires 与 allowedAccess）。 */
function validCtxFor(action: GlobalShellActionName): ShellActionContext {
  const base = { pageOpaqueId: "page:kp-detail" };
  switch (action) {
    case "spotlight_ui_anchor":
      return ctx({ ...base, anchorId: "anchor:keypoint-map" });
    case "open_page_help":
      return ctx({ ...base, helpTopic: "learning-map" });
    case "preview_navigation":
      return ctx({ ...base, destinationPageId: "page:review-queue" });
    case "resume_onboarding":
      return ctx({ ...base, pageOpaqueId: undefined, onboardingVersion: "onboarding-v1" });
    case "resume_checkpoint":
      return ctx({ ...base, checkpointRef: "checkpoint:2026-08-08:kp-1" });
    case "show_permission_scope":
      return ctx({ ...base, permissionScopeId: "scope:companion" });
    case "dismiss_suggestion":
      return ctx({ ...base, suggestionId: "suggestion:abc123" });
    case "preview_registered_page_action":
      return ctx({ ...base, registeredActionId: "page-action:focus" });
    case "request_page_action_confirmation":
      return ctx({ ...base, registeredActionId: "page-action:focus" });
  }
}

/** 9 个动作 ID → 专用执行函数映射（验证专用函数与白名单一一对应）。 */
const EXECUTORS: Readonly<
  Record<
    GlobalShellActionName,
    (deps: ShellActionDeps, context: ShellActionContext) => Promise<GlobalShellActionResult>
  >
> = {
  spotlight_ui_anchor: executeSpotlightUiAnchor,
  open_page_help: executeOpenPageHelp,
  preview_navigation: executePreviewNavigation,
  resume_onboarding: executeResumeOnboarding,
  resume_checkpoint: executeResumeCheckpoint,
  show_permission_scope: executeShowPermissionScope,
  dismiss_suggestion: executeDismissSuggestion,
  preview_registered_page_action: executePreviewRegisteredPageAction,
  request_page_action_confirmation: executeRequestPageActionConfirmation,
};

function expectShellError(
  fn: () => Promise<unknown>,
  code: ShellActionErrorCode,
  statusCode: number,
): Promise<void> {
  return assert.rejects(
    fn(),
    (err: unknown) =>
      err instanceof ShellActionError && err.code === code && err.statusCode === statusCode,
  );
}

// ─── 1. 9 个动作均可确定性执行 ────────────────────────────────────────────

describe("Global Shell：9 个动作均可确定性执行", () => {
  for (const action of GLOBAL_SHELL_ACTION_IDS) {
    it(`${action} 返回确定性结果并记录 audit`, async () => {
      const deps = makeDeps();
      const result = await executeGlobalShellAction(deps, {
        action,
        context: validCtxFor(action),
        opaqueActionId: "nonce:1",
      });

      assert.equal(result.action, action);
      assert.equal(result.outcome, "allowed");
      assert.equal(result.contract.version, GLOBAL_SHELL_CONTEXT_ACTION_CONTRACT_VERSION);
      assert.ok(result.payload, "每个动作必须有确定性 payload");
      assert.equal(typeof result.payload, "object");
      assert.equal(result.audit.policyVersion, GLOBAL_SHELL_POLICY_VERSION);

      // audit 被记录（校验页面上下文/权限后写入）。
      assert.equal(deps.auditCalls.length, 1);
      const entry = deps.auditCalls[0];
      assert.equal(entry.action, action);
      assert.equal(entry.result, "allowed");
      assert.equal(entry.pageActionType, "global_shell_action");
      assert.equal(entry.policyVersion, GLOBAL_SHELL_POLICY_VERSION);
      assert.equal(entry.contextVersion, GLOBAL_SHELL_CONTEXT_ACTION_CONTRACT_VERSION);
      assert.ok(entry.permissionSnapshotHash && entry.permissionSnapshotHash.length > 0);
      assert.equal(entry.actionOpaqueId, "nonce:1");
    });
  }

  it("专用执行函数与白名单一一对应（无遗漏、无多余）", async () => {
    const names = Object.keys(EXECUTORS).sort();
    assert.deepEqual(
      names,
      [...GLOBAL_SHELL_ACTION_IDS].sort(),
      "9 个专用执行函数必须正好覆盖白名单 9 个动作",
    );
    for (const action of GLOBAL_SHELL_ACTION_IDS) {
      const viaExecutor = await EXECUTORS[action](makeDeps(), validCtxFor(action));
      const viaEntry = await executeGlobalShellAction(makeDeps(), {
        action,
        context: validCtxFor(action),
      });
      // 两次独立执行的 audit.at（毫秒时间戳）必然不同；断言行为等价时剔除时间戳字段
      const stripAuditAt = (r: unknown) =>
        JSON.parse(
          JSON.stringify(r, (_key, value) =>
            typeof value === "object" && value !== null && "at" in value && typeof value.at === "string"
              ? { ...value, at: "<timestamp>" }
              : value,
          ),
        );
      assert.deepEqual(stripAuditAt(viaExecutor), stripAuditAt(viaEntry), `${action} 专用函数与统一入口结果一致`);
    }
  });
});

// ─── 2. 零 Session 创建 / 零 learning budget 消耗 ─────────────────────────

describe("Global Shell：零 Session 创建、零 learning budget 消耗", () => {
  it("canCreateSession() 恒 false、learningBudgetForShellAction() 恒 0", () => {
    assert.equal(canCreateSession(), false);
    assert.equal(learningBudgetForShellAction(), 0);
  });

  it("每个动作结果在类型与值上都声明 sessionCreated:false / learningBudgetSpent:0 / canonicalWrite:false", async () => {
    for (const action of GLOBAL_SHELL_ACTION_IDS) {
      const result = await executeGlobalShellAction(makeDeps(), {
        action,
        context: validCtxFor(action),
      });
      assert.equal(result.sessionCreated, false, `${action} 不得创建 Session`);
      assert.equal(result.learningBudgetSpent, 0, `${action} 不得消耗 learning budget`);
      assert.equal(result.canonicalWrite, false, `${action} 不得写 canonical/领域数据`);
    }
  });

  it("静态解耦：shell-actions.ts 不 import learning-sessions 模块", () => {
    const source = readFileSync(
      fileURLToPath(new URL("./shell-actions.ts", import.meta.url)),
      "utf8",
    );
    // 只匹配 import 语句（模块路径），不匹配注释/标识符。
    assert.ok(
      !/import\s+[^;]+from\s+["'][^"']*(learning-sessions|session-service|learning-budget|budget-envelope)["']/.test(
        source,
      ),
      "shell-actions.ts 不得 import learning-sessions 模块或 budget 模块",
    );
  });
});

// ─── 3. 未知 action 拒绝（白名单校验） ────────────────────────────────────

describe("Global Shell：未知 action 拒绝（模型不能自由拼装）", () => {
  it("任意拼装 action 被 400 拒绝", () => {
    return expectShellError(
      () =>
        executeGlobalShellAction(makeDeps(), {
          action: "arbitrary_made_up_action",
          context: validCtxFor("spotlight_ui_anchor"),
        }),
      ShellActionErrorCode.UNKNOWN_ACTION,
      400,
    );
  });

  it("spatial action（focus_nodes）不能冒充 Global Shell 动作", () => {
    return expectShellError(
      () =>
        executeGlobalShellAction(makeDeps(), {
          action: "focus_nodes",
          context: validCtxFor("spotlight_ui_anchor"),
        }),
      ShellActionErrorCode.UNKNOWN_ACTION,
      400,
    );
  });

  it("空字符串 / 非字符串输入均拒绝", async () => {
    await Promise.all([
      expectShellError(
        () => executeGlobalShellAction(makeDeps(), { action: "", context: validCtxFor("spotlight_ui_anchor") }),
        ShellActionErrorCode.UNKNOWN_ACTION,
        400,
      ),
      expectShellError(
        () => executeGlobalShellAction(makeDeps(), { action: "  open_page_help  ", context: validCtxFor("spotlight_ui_anchor") }),
        ShellActionErrorCode.UNKNOWN_ACTION,
        400,
      ),
    ]);
  });

  it("isGlobalShellAction 守卫行为正确", () => {
    assert.equal(isGlobalShellAction("open_page_help"), true);
    assert.equal(isGlobalShellAction("commit"), false);
    assert.equal(isGlobalShellAction("focus_nodes"), false);
  });
});

// ─── 4. 权限不足拒绝 ──────────────────────────────────────────────────────

describe("Global Shell：权限不足拒绝", () => {
  it("凭据页（credential）禁止个性化动作（resume_onboarding / resume_checkpoint / show_permission_scope / preview_registered_page_action / request_page_action_confirmation）", async () => {
    const credentialCtx = ctx({
      pageAccess: "credential",
      userId: undefined,
      workspaceId: undefined,
    });
    const blocked: GlobalShellActionName[] = [
      "resume_onboarding",
      "resume_checkpoint",
      "show_permission_scope",
      "preview_registered_page_action",
      "request_page_action_confirmation",
    ];
    await Promise.all(
      blocked.map((action) =>
        expectShellError(
          () =>
            executeGlobalShellAction(makeDeps(), {
              action,
              context: { ...credentialCtx, ...pickTarget(action) },
            }),
          ShellActionErrorCode.PERMISSION_DENIED,
          403,
        ),
      ),
    );
  });

  it("凭据页允许静态帮助/关闭建议/导航预览（open_page_help / dismiss_suggestion / preview_navigation / spotlight_ui_anchor 中允许项）", async () => {
    const credentialCtx = ctx({
      pageAccess: "credential",
      userId: undefined,
      workspaceId: undefined,
    });
    // open_page_help 在 credential 页放行；dismiss_suggestion 放行；preview_navigation 放行。
    const okOpen = await executeGlobalShellAction(makeDeps(), {
      action: "open_page_help",
      context: { ...credentialCtx, helpTopic: "login-help" },
    });
    assert.equal(okOpen.outcome, "allowed");
    const okDismiss = await executeGlobalShellAction(makeDeps(), {
      action: "dismiss_suggestion",
      context: { ...credentialCtx, suggestionId: "suggestion:login-tip" },
    });
    assert.equal(okDismiss.outcome, "allowed");
    const okPreview = await executeGlobalShellAction(makeDeps(), {
      action: "preview_navigation",
      context: { ...credentialCtx, destinationPageId: "page:login" },
    });
    assert.equal(okPreview.outcome, "allowed");
  });

  it("authenticated-only 动作（resume_checkpoint / show_permission_scope）在 public 页被拒", async () => {
    const publicCtx = ctx({
      pageAccess: "public",
      userId: undefined,
      workspaceId: undefined,
    });
    await Promise.all([
      expectShellError(
        () =>
          executeGlobalShellAction(makeDeps(), {
            action: "resume_checkpoint",
            context: { ...publicCtx, checkpointRef: "checkpoint:x" },
          }),
        ShellActionErrorCode.PERMISSION_DENIED,
        403,
      ),
      expectShellError(
        () =>
          executeGlobalShellAction(makeDeps(), {
            action: "show_permission_scope",
            context: { ...publicCtx, permissionScopeId: "scope:x" },
          }),
        ShellActionErrorCode.PERMISSION_DENIED,
        403,
      ),
    ]);
  });
});

// 取每个动作的目标字段子集（供 permission 测试构造 credential 上下文用）。
function pickTarget(action: GlobalShellActionName): Partial<ShellActionContext> {
  switch (action) {
    case "resume_onboarding":
      return { onboardingVersion: "onboarding-v1" };
    case "resume_checkpoint":
      return { checkpointRef: "checkpoint:1" };
    case "show_permission_scope":
      return { permissionScopeId: "scope:x" };
    case "preview_registered_page_action":
    case "request_page_action_confirmation":
      return { registeredActionId: "page-action:x" };
    default:
      return {};
  }
}

// ─── 5. 页面上下文缺失 / context 版本失配 ────────────────────────────────

describe("Global Shell：页面上下文校验", () => {
  it("缺少所需字段（anchorId）→ INCOMPLETE_PAGE_CONTEXT 422", () => {
    return expectShellError(
      () =>
        executeGlobalShellAction(makeDeps(), {
          action: "spotlight_ui_anchor",
          context: ctx({ anchorId: undefined }),
        }),
      ShellActionErrorCode.INCOMPLETE_PAGE_CONTEXT,
      422,
    );
  });

  it("resume_checkpoint 缺少 checkpointRef / userId → 422", async () => {
    await Promise.all([
      expectShellError(
        () =>
          executeGlobalShellAction(makeDeps(), {
            action: "resume_checkpoint",
            context: ctx({ checkpointRef: undefined }),
          }),
        ShellActionErrorCode.INCOMPLETE_PAGE_CONTEXT,
        422,
      ),
      expectShellError(
        () =>
          executeGlobalShellAction(makeDeps(), {
            action: "resume_checkpoint",
            context: ctx({ userId: undefined }),
          }),
        ShellActionErrorCode.INCOMPLETE_PAGE_CONTEXT,
        422,
      ),
    ]);
  });

  it("context contract 版本失配 → STALE_CONTEXT_CONTRACT 409", () => {
    return expectShellError(
      () =>
        executeGlobalShellAction(makeDeps(), {
          action: "open_page_help",
          context: ctx({ contextVersion: "global-shell-context-action-v0" }),
        }),
      ShellActionErrorCode.STALE_CONTEXT_CONTRACT,
      409,
    );
  });
});

// ─── 6. 触发仲裁器拒绝 ────────────────────────────────────────────────────

describe("Global Shell：触发仲裁器拒绝", () => {
  it("arbiter 拒绝 → ARBITER_DENIED 409，且不写 audit", () => {
    const deps = makeDeps({
      arbiter: {
        canTrigger: () => ({ ok: false as const, reason: "cooldown active" }),
      },
    });
    return assert.rejects(
      executeGlobalShellAction(deps, {
        action: "spotlight_ui_anchor",
        context: validCtxFor("spotlight_ui_anchor"),
      }),
      (err: unknown) =>
        err instanceof ShellActionError
        && err.code === ShellActionErrorCode.ARBITER_DENIED
        && err.statusCode === 409,
    ).then(() => {
      assert.equal(deps.auditCalls.length, 0, "被仲裁器拒绝的动作不得写 audit");
    });
  });

  it("arbiter 放行 → 正常执行", async () => {
    const deps = makeDeps({
      arbiter: {
        canTrigger: () => ({ ok: true as const }),
      },
    });
    const result = await executeGlobalShellAction(deps, {
      action: "dismiss_suggestion",
      context: validCtxFor("dismiss_suggestion"),
    });
    assert.equal(result.outcome, "allowed");
  });
});

// ─── 7. 审计记录内容 ──────────────────────────────────────────────────────

describe("Global Shell：audit 记录", () => {
  it("审计行包含 action/result/policy/hash/opaque ids", async () => {
    const deps = makeDeps();
    await executeGlobalShellAction(deps, {
      action: "preview_registered_page_action",
      context: validCtxFor("preview_registered_page_action"),
      opaqueActionId: "nonce:audit-1",
    });
    assert.equal(deps.auditCalls.length, 1);
    const entry = deps.auditCalls[0];
    assert.equal(entry.action, "preview_registered_page_action");
    assert.equal(entry.result, "allowed");
    assert.equal(entry.policyVersion, GLOBAL_SHELL_POLICY_VERSION);
    assert.equal(entry.pageOpaqueId, "page:kp-detail");
    assert.equal(entry.actionOpaqueId, "nonce:audit-1");
    assert.equal(entry.contextVersion, GLOBAL_SHELL_CONTEXT_ACTION_CONTRACT_VERSION);
    assert.ok(entry.permissionSnapshotHash && /^[0-9a-f]{64}$/.test(entry.permissionSnapshotHash));
    assert.ok(entry.entityOpaqueIds && entry.entityOpaqueIds.length > 0);
  });
});
