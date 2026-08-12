/**
 * 阶段 07（W6）任务 07-2：全路由 coverage registry 与 context/action manifest（§5.4.4/§5.4.6）。
 *
 * `CompanionPageCoverageRegistryV1`：public-auth / authenticated 全路由页面覆盖表。
 * 每个 `CompanionPageCoverageEntryV1` 声明：
 * - routePattern / pageKind / access（public-auth | authenticated）；
 * - surfaceMode（static_help | transitional | silent_anchor | panel，四种 surface mode，
 *   见 07-2 决策记录）与 sensitivity（normal | private | credential）；
 * - context/action manifest（manifestVersion + actionAllowlist + forbiddenActions +
 *   requiredCapabilities），manifestHash 为内容指纹；
 * - manualFallbackTestId（无自动化覆盖时的手动测试兜底）与 owner。
 *
 * 冻结规则（§5.4.4/§5.4.6，CI/启动 fail closed）：
 * - 未分类：真实路由没有匹配 entry → 抛错；
 * - 隐式继承：子路由与父 manifest（sensitivity + action allowlist + forbidden）完全
 *   相同却未显式声明 `inheritsManifestFrom` → 抛错；
 * - 显式继承条件：子只有与父完全相同时才可显式继承，否则抛错；
 * - manifest hash 失效：entry.manifestHash 不等于内容指纹 → 抛错；
 * - forbidden 与 allowlist 交集为空。
 *
 * 页面职责矩阵（§5.4.6）以数据形式落在每个 entry 的 actionAllowlist / forbiddenActions；
 * 本模块是纯逻辑（无 React / 无 DOM / 无网络），hash 使用跨平台纯 JS FNV-1a
 * （内容指纹，非密码学签名；凭据页静态签名由 02-5 auth-surface HMAC 体系负责）。
 */

import type { CompanionSensitivity } from "./page-companion-context.ts";

// ─── 1. 版本与枚举 ──────────────────────────────────────────────────────

export const COMPANION_COVERAGE_REGISTRY_VERSION = "CompanionPageCoverageRegistryV1";
/** manifest 版本（每个 entry 的 manifest 语义版本；内容变化应同步递增并重算 hash）。 */
export const PAGE_COVERAGE_MANIFEST_VERSION = 1;

/** 四种 surface mode（01-6「四种 surface mode」；语义见 07-2 决策记录）。 */
export const COMPANION_SURFACE_MODES = [
  "static_help",
  "transitional",
  "silent_anchor",
  "panel",
] as const;
export type CompanionSurfaceMode = (typeof COMPANION_SURFACE_MODES)[number];

/** 页面访问层：未登录认证层 / 已登录工作区。 */
export type CompanionPageAccess = "public-auth" | "authenticated";

/**
 * Companion 页面上下文动作 ID（bounded registry enum，never model-authored）。
 * allowlist = 该页面允许伴星执行的确定性上下文动作；
 * forbiddenActions = 页面职责矩阵（§5.4.6）明确禁止的动作（不得出现在 allowlist）。
 */
export const COMPANION_ACTION_IDS = [
  // ── 通用内容与学习动作 ──
  "explain_page",
  "read_selection",
  "locate_evidence",
  "show_published_card",
  "study_together",
  "let_me_try",
  "view_evidence",
  "go_to_star_map",
  "back_to_source",
  "stop",
  "read_operation",
  "switch_mode",
  "trusted_handoff",
  "focus",
  "switch_lens",
  "pave_route",
  "restore_viewport",
  "explain_recommendation",
  "shorten",
  "swap",
  "later",
  "free_browse",
  "explain_real_change",
  "optional_view_star_map",
  "user_confirm_continue",
  "narrow_legal_scope",
  "explain_no_result",
  "guide_add_or_select_existing",
  "explain_deterministic_job_status",
  "explain_option_impact",
  "locate_control",
  "preview_export_delete_scope",
  "replay_onboarding",
  "explain_signed_static_allowlist",
  "explain_saved_state",
  "explain_recoverable_steps",
  "start_or_resume_onboarding",
  "choose_sample",
  "explain_add_first_material",
  "resume_paused_task",
  "explain_public_capability",
  "a11y_help",
  "deterministic_auth_failure",
  "submit_login",
  "submit_register",
  "request_password_reset",
  "open_help",
  "toggle_hide_companion",
  // ── 明确禁止的动作（页面职责矩阵 forbid 项） ──
  "read_credentials",
  "observe_input",
  "build_profile",
  "request_microphone",
  "run_model",
  "voice",
  "observe_field_or_interaction_metadata",
  "read_member_or_secret_value",
  "authorize_for_user",
  "change_permissions",
  "force_upload",
  "auto_create",
  "onboarding_as_pending_task",
  "show_debt",
  "red_overdue",
  "silent_defer",
  "auto_start",
  "unbounded_qa_unbound_target",
  "publish_explanation_as_canonical_card",
  "read_unauthorized_material",
  "leak_answer_before_formal",
  "start_validation_for_user",
  "formal_content_hint",
  "do_for_user",
  "submit_for_user",
  "grade_for_user",
  "free_create_shared_relation",
  "publish_scene_edge_as_graph_truth",
  "exaggerate_mastery",
  "auto_continue_questions",
  "celebration_masks_assessment_boundary",
  "fabricate_result",
  "cross_permission_search",
  "fabricate_percentage",
  "promise_unfinished_artifact",
  "animation_masks_progress",
  "auto_change_preference",
  "confirm_for_user",
  "export_or_delete",
  "present_system_failure_as_user_failure",
  "block_original_page_fallback",
] as const;
export type CompanionActionId = (typeof COMPANION_ACTION_IDS)[number];

export function isCompanionActionId(value: string): value is CompanionActionId {
  return (COMPANION_ACTION_IDS as readonly string[]).includes(value);
}

// ─── 2. Entry / Registry 类型 ────────────────────────────────────────────

export interface CompanionPageCoverageEntryV1 {
  /** 路由模式："/login"、"/sources/:id"；:name 匹配单个路径段。 */
  routePattern: string;
  /** 页面类别（冻结清单见 COMPANION_PAGE_KINDS）。 */
  pageKind: string;
  /** 访问层：public-auth（未登录认证层）| authenticated。 */
  access: CompanionPageAccess;
  /** 伴星表面模式（决定稳定召唤入口形态）。 */
  surfaceMode: CompanionSurfaceMode;
  /** 敏感级（normal | private | credential）。 */
  sensitivity: CompanionSensitivity;
  /** manifest 版本（内容变化必须递增）。 */
  manifestVersion: number;
  /** manifest 内容指纹（computeManifestHash 结果；失效 → CI/启动失败）。 */
  manifestHash: string;
  /** 该页面允许的上下文动作 allowlist（§5.4.6 页面职责矩阵 allow 侧）。 */
  actionAllowlist: readonly CompanionActionId[];
  /** 页面职责矩阵 forbid 侧（不得出现在 allowlist）。 */
  forbiddenActions: readonly CompanionActionId[];
  /** 该页面所需能力旗标（manifest 内容，空数组 = 无额外要求）。 */
  requiredCapabilities?: readonly string[];
  /** 无自动化覆盖时的手动测试兜底 ID（E2E 用例锚点）。 */
  manualFallbackTestId?: string;
  /** 该 coverage entry 的维护 owner。 */
  owner: "web" | "backend" | "shared-contracts";
  /**
   * 显式继承父 manifest（父 pageKind）。只有 sensitivity 与 action allowlist
   * （及 forbidden）与父完全相同时才允许；未声明继承又与父完全相同 = 隐式继承 → 失败。
   */
  inheritsManifestFrom?: string;
}

export interface CompanionPageCoverageRegistryV1 {
  version: typeof COMPANION_COVERAGE_REGISTRY_VERSION;
  manifestVersion: number;
  entries: readonly CompanionPageCoverageEntryV1[];
}

/** 页面类别冻结清单（public-auth + authenticated 全路由，§5.4.6）。 */
export const COMPANION_PAGE_KINDS = [
  // public-auth
  "auth-login",
  "auth-register",
  "auth-forgot",
  "auth-invite",
  "auth-verify",
  "auth-mfa",
  "auth-sso-callback",
  // authenticated
  "home",
  "library",
  "source-detail",
  "note-list",
  "note-detail",
  "card-set-detail",
  "card-list",
  "card-detail",
  "key-point",
  "fullscreen-validate",
  "companion-stage",
  "review",
  "review-schedule",
  "now",
  "star-map",
  "workspace-results",
  "search",
  "import",
  "generate",
  "settings",
  "settings-privacy",
  "settings-history",
  "settings-account-security",
  "settings-members",
  "settings-keys",
  "co-study",
  "episode-results",
  "not-found",
  "offline",
  "internal",
  "admin",
] as const;
export type CompanionPageKind = (typeof COMPANION_PAGE_KINDS)[number];

// ─── 3. Manifest 指纹（跨平台纯 JS FNV-1a，内容指纹非签名）──────────────

export interface CompanionManifestFingerprintInput {
  access: CompanionPageAccess;
  pageKind: string;
  surfaceMode: CompanionSurfaceMode;
  sensitivity: CompanionSensitivity;
  manifestVersion: number;
  actionAllowlist: readonly string[];
  forbiddenActions: readonly string[];
  inheritsManifestFrom?: string;
  requiredCapabilities?: readonly string[];
}

function fnv1a32Hex(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** 稳定指纹：递归规范化（键序固定、数组排序），保证跨进程/跨构建可复现。 */
export function computeManifestHash(input: CompanionManifestFingerprintInput): string {
  const canonical = JSON.stringify({
    access: input.access,
    pageKind: input.pageKind,
    surfaceMode: input.surfaceMode,
    sensitivity: input.sensitivity,
    manifestVersion: input.manifestVersion,
    actionAllowlist: [...input.actionAllowlist].sort(),
    forbiddenActions: [...input.forbiddenActions].sort(),
    inheritsManifestFrom: input.inheritsManifestFrom ?? null,
    requiredCapabilities: [...(input.requiredCapabilities ?? [])].sort(),
  });
  return `fnv1a:${fnv1a32Hex(canonical)}`;
}

// ─── 4. 路由匹配与查询 ──────────────────────────────────────────────────

/** 是否命中路由模式（:name 匹配单个路径段；无通配符）。 */
export function matchesRoutePattern(pattern: string, pathname: string): boolean {
  if (pattern === pathname) return true;
  const patternSegments = pattern.split("/").filter(Boolean);
  const pathSegments = pathname.split("/").filter(Boolean);
  if (patternSegments.length !== pathSegments.length) return false;
  return patternSegments.every(
    (segment, index) => segment.startsWith(":") || segment === pathSegments[index],
  );
}

/** 按路径找到第一个匹配 entry（路由优先序由 registry 顺序决定）。 */
export function findEntryForPath(
  registry: CompanionPageCoverageRegistryV1,
  pathname: string,
): CompanionPageCoverageEntryV1 | undefined {
  return registry.entries.find((entry) => matchesRoutePattern(entry.routePattern, pathname));
}

/** 解析继承后的有效 action allowlist（未继承 → 自身 allowlist）。 */
export function effectiveActionAllowlist(
  registry: CompanionPageCoverageRegistryV1,
  entry: CompanionPageCoverageEntryV1,
): readonly CompanionActionId[] {
  if (!entry.inheritsManifestFrom) return entry.actionAllowlist;
  const parent = registry.entries.find((e) => e.pageKind === entry.inheritsManifestFrom);
  return parent ? parent.actionAllowlist : entry.actionAllowlist;
}

// ─── 5. 构建 helper（自动生成 hash，防手误）─────────────────────────────

type CoverageEntryInput = Omit<CompanionPageCoverageEntryV1, "manifestHash"> & {
  manifestHash?: string;
};

function coverageEntry(input: CoverageEntryInput): CompanionPageCoverageEntryV1 {
  return {
    ...input,
    manifestHash: input.manifestHash ?? computeManifestHash(input),
  };
}

// ─── 6. 页面职责矩阵（§5.4.6）数据 ───────────────────────────────────────

// allow 侧常用集合
const CONTENT_READ_ACTIONS = [
  "explain_page",
  "read_selection",
  "locate_evidence",
  "show_published_card",
] as const;
const CARD_STUDY_ACTIONS = [
  "explain_page",
  "study_together",
  "let_me_try",
  "view_evidence",
  "go_to_star_map",
] as const;
const REVIEW_NOW_ACTIONS = [
  "explain_recommendation",
  "shorten",
  "swap",
  "later",
  "free_browse",
  "explain_page",
] as const;
const AUTH_ACTIONS = [
  "explain_public_capability",
  "a11y_help",
  "deterministic_auth_failure",
  "submit_login",
  "submit_register",
  "request_password_reset",
  "open_help",
  "toggle_hide_companion",
] as const;
const SETTINGS_ACTIONS = [
  "explain_option_impact",
  "locate_control",
  "preview_export_delete_scope",
  "replay_onboarding",
  "open_help",
] as const;
const SENSITIVE_ACCOUNT_ACTIONS = [
  "explain_signed_static_allowlist",
  "locate_control",
  "open_help",
] as const;
const ERROR_RECOVERY_ACTIONS = [
  "explain_saved_state",
  "explain_recoverable_steps",
  "open_help",
] as const;
const HOME_ACTIONS = [
  "start_or_resume_onboarding",
  "choose_sample",
  "explain_add_first_material",
  "resume_paused_task",
  "replay_onboarding",
  "open_help",
] as const;
const JOB_STATUS_ACTIONS = ["explain_deterministic_job_status", "open_help"] as const;
const STAR_MAP_ACTIONS = [
  "explain_page",
  "focus",
  "switch_lens",
  "pave_route",
  "restore_viewport",
] as const;
const CO_STUDY_ACTIONS = [
  "read_operation",
  "switch_mode",
  "study_together",
  "trusted_handoff",
  "stop",
] as const;
const EPISODE_RESULT_ACTIONS = [
  "explain_real_change",
  "back_to_source",
  "optional_view_star_map",
  "user_confirm_continue",
] as const;

// forbid 侧常用集合
const CREDENTIAL_FORBIDDEN = [
  "read_credentials",
  "observe_input",
  "build_profile",
  "request_microphone",
  "run_model",
  "voice",
  "observe_field_or_interaction_metadata",
  "read_member_or_secret_value",
  "authorize_for_user",
  "change_permissions",
] as const;
const FORMAL_FORBIDDEN = [
  "leak_answer_before_formal",
  "start_validation_for_user",
  "formal_content_hint",
  "do_for_user",
  "submit_for_user",
  "grade_for_user",
  "auto_start",
] as const;
const LEARNING_INTEGRITY_FORBIDDEN = [
  "show_debt",
  "red_overdue",
  "silent_defer",
  "auto_start",
  "exaggerate_mastery",
  "auto_continue_questions",
  "celebration_masks_assessment_boundary",
] as const;
const CONTENT_FORBIDDEN = [
  "unbounded_qa_unbound_target",
  "publish_explanation_as_canonical_card",
  "read_unauthorized_material",
  "fabricate_result",
  "cross_permission_search",
] as const;
const SEARCH_FORBIDDEN = [
  "fabricate_result",
  "cross_permission_search",
  "read_unauthorized_material",
] as const;
const STAR_MAP_FORBIDDEN = [
  "free_create_shared_relation",
  "publish_scene_edge_as_graph_truth",
  "fabricate_result",
] as const;
const JOB_FORBIDDEN = [
  "fabricate_percentage",
  "promise_unfinished_artifact",
  "animation_masks_progress",
  "auto_create",
] as const;
const SETTINGS_FORBIDDEN = [
  "auto_change_preference",
  "confirm_for_user",
  "export_or_delete",
  "observe_input",
] as const;
const ERROR_FORBIDDEN = [
  "present_system_failure_as_user_failure",
  "block_original_page_fallback",
] as const;
const CO_STUDY_FORBIDDEN = [
  "formal_content_hint",
  "do_for_user",
  "submit_for_user",
  "grade_for_user",
  "auto_start",
  "run_model",
] as const;

// ─── 7. 全路由 Registry 数据（public-auth + authenticated）───────────────

export const COMPANION_PAGE_COVERAGE_REGISTRY: CompanionPageCoverageRegistryV1 = {
  version: COMPANION_COVERAGE_REGISTRY_VERSION,
  manifestVersion: PAGE_COVERAGE_MANIFEST_VERSION,
  entries: [
    // ── public-auth（sensitivity=credential；只允许确定性公开动作，零采集） ──
    coverageEntry({
      routePattern: "/login",
      pageKind: "auth-login",
      access: "public-auth",
      surfaceMode: "transitional",
      sensitivity: "credential",
      manifestVersion: PAGE_COVERAGE_MANIFEST_VERSION,
      actionAllowlist: AUTH_ACTIONS,
      forbiddenActions: CREDENTIAL_FORBIDDEN,
      owner: "web",
    }),
    coverageEntry({
      routePattern: "/register",
      pageKind: "auth-register",
      access: "public-auth",
      surfaceMode: "transitional",
      sensitivity: "credential",
      manifestVersion: PAGE_COVERAGE_MANIFEST_VERSION,
      actionAllowlist: AUTH_ACTIONS,
      forbiddenActions: CREDENTIAL_FORBIDDEN,
      owner: "web",
    }),
    coverageEntry({
      routePattern: "/forgot-password",
      pageKind: "auth-forgot",
      access: "public-auth",
      surfaceMode: "transitional",
      sensitivity: "credential",
      manifestVersion: PAGE_COVERAGE_MANIFEST_VERSION,
      actionAllowlist: AUTH_ACTIONS,
      forbiddenActions: CREDENTIAL_FORBIDDEN,
      owner: "web",
      manualFallbackTestId: "E2E-auth-forgot",
    }),
    coverageEntry({
      routePattern: "/invite",
      pageKind: "auth-invite",
      access: "public-auth",
      surfaceMode: "transitional",
      sensitivity: "credential",
      manifestVersion: PAGE_COVERAGE_MANIFEST_VERSION,
      actionAllowlist: AUTH_ACTIONS,
      forbiddenActions: CREDENTIAL_FORBIDDEN,
      owner: "web",
      manualFallbackTestId: "E2E-auth-invite",
    }),
    coverageEntry({
      routePattern: "/verify",
      pageKind: "auth-verify",
      access: "public-auth",
      surfaceMode: "transitional",
      sensitivity: "credential",
      manifestVersion: PAGE_COVERAGE_MANIFEST_VERSION,
      actionAllowlist: AUTH_ACTIONS,
      forbiddenActions: CREDENTIAL_FORBIDDEN,
      owner: "web",
      manualFallbackTestId: "E2E-auth-verify",
    }),
    coverageEntry({
      routePattern: "/mfa",
      pageKind: "auth-mfa",
      access: "public-auth",
      surfaceMode: "transitional",
      sensitivity: "credential",
      manifestVersion: PAGE_COVERAGE_MANIFEST_VERSION,
      actionAllowlist: AUTH_ACTIONS,
      forbiddenActions: CREDENTIAL_FORBIDDEN,
      owner: "web",
      manualFallbackTestId: "E2E-auth-mfa",
    }),
    coverageEntry({
      routePattern: "/auth/callback",
      pageKind: "auth-sso-callback",
      access: "public-auth",
      surfaceMode: "static_help",
      sensitivity: "credential",
      manifestVersion: PAGE_COVERAGE_MANIFEST_VERSION,
      actionAllowlist: AUTH_ACTIONS,
      forbiddenActions: CREDENTIAL_FORBIDDEN,
      owner: "web",
      manualFallbackTestId: "E2E-auth-sso-callback",
    }),

    // ── 首页 / 空 workspace（禁强迫上传/自动创建/把 onboarding 做成待清任务） ──
    coverageEntry({
      routePattern: "/",
      pageKind: "home",
      access: "authenticated",
      surfaceMode: "silent_anchor",
      sensitivity: "normal",
      manifestVersion: PAGE_COVERAGE_MANIFEST_VERSION,
      actionAllowlist: HOME_ACTIONS,
      forbiddenActions: [
        "force_upload",
        "auto_create",
        "onboarding_as_pending_task",
        "show_debt",
        "auto_start",
        "fabricate_result",
      ],
      owner: "web",
    }),

    // ── 内容库与 Source / Note（禁未绑定 target 无界问答、解释直接发布 canonical Card） ──
    coverageEntry({
      routePattern: "/sources",
      pageKind: "library",
      access: "authenticated",
      surfaceMode: "silent_anchor",
      sensitivity: "normal",
      manifestVersion: PAGE_COVERAGE_MANIFEST_VERSION,
      actionAllowlist: CONTENT_READ_ACTIONS,
      forbiddenActions: CONTENT_FORBIDDEN,
      owner: "web",
    }),
    coverageEntry({
      routePattern: "/sources/:id",
      pageKind: "source-detail",
      access: "authenticated",
      surfaceMode: "silent_anchor",
      sensitivity: "normal",
      manifestVersion: PAGE_COVERAGE_MANIFEST_VERSION,
      actionAllowlist: CONTENT_READ_ACTIONS,
      forbiddenActions: CONTENT_FORBIDDEN,
      owner: "web",
      inheritsManifestFrom: "library",
    }),
    coverageEntry({
      routePattern: "/notes",
      pageKind: "note-list",
      access: "authenticated",
      surfaceMode: "silent_anchor",
      sensitivity: "private",
      manifestVersion: PAGE_COVERAGE_MANIFEST_VERSION,
      actionAllowlist: CONTENT_READ_ACTIONS,
      forbiddenActions: [...CONTENT_FORBIDDEN, "observe_input"],
      owner: "web",
    }),
    coverageEntry({
      routePattern: "/notes/:id",
      pageKind: "note-detail",
      access: "authenticated",
      surfaceMode: "silent_anchor",
      sensitivity: "private",
      manifestVersion: PAGE_COVERAGE_MANIFEST_VERSION,
      actionAllowlist: CONTENT_READ_ACTIONS,
      forbiddenActions: [...CONTENT_FORBIDDEN, "observe_input"],
      owner: "web",
      inheritsManifestFrom: "note-list",
    }),

    // ── Card Set / Card / Key Point（禁 formal 前泄答案、替用户开始验证） ──
    coverageEntry({
      routePattern: "/card-sets/:id",
      pageKind: "card-set-detail",
      access: "authenticated",
      surfaceMode: "silent_anchor",
      sensitivity: "normal",
      manifestVersion: PAGE_COVERAGE_MANIFEST_VERSION,
      actionAllowlist: CARD_STUDY_ACTIONS,
      forbiddenActions: [
        "leak_answer_before_formal",
        "start_validation_for_user",
        "publish_explanation_as_canonical_card",
        "auto_start",
        "exaggerate_mastery",
      ],
      owner: "web",
    }),
    coverageEntry({
      routePattern: "/cards",
      pageKind: "card-list",
      access: "authenticated",
      surfaceMode: "silent_anchor",
      sensitivity: "normal",
      manifestVersion: PAGE_COVERAGE_MANIFEST_VERSION,
      actionAllowlist: CARD_STUDY_ACTIONS,
      forbiddenActions: [
        "leak_answer_before_formal",
        "start_validation_for_user",
        "publish_explanation_as_canonical_card",
        "auto_start",
        "exaggerate_mastery",
      ],
      owner: "web",
    }),
    coverageEntry({
      routePattern: "/cards/:id",
      pageKind: "card-detail",
      access: "authenticated",
      surfaceMode: "silent_anchor",
      sensitivity: "normal",
      manifestVersion: PAGE_COVERAGE_MANIFEST_VERSION,
      actionAllowlist: [...CARD_STUDY_ACTIONS, "read_selection"],
      forbiddenActions: [
        "leak_answer_before_formal",
        "start_validation_for_user",
        "publish_explanation_as_canonical_card",
        "auto_start",
      ],
      owner: "web",
    }),
    coverageEntry({
      routePattern: "/key-points/:id",
      pageKind: "key-point",
      access: "authenticated",
      surfaceMode: "silent_anchor",
      sensitivity: "normal",
      manifestVersion: PAGE_COVERAGE_MANIFEST_VERSION,
      actionAllowlist: [...CARD_STUDY_ACTIONS, "read_selection"],
      forbiddenActions: [
        "leak_answer_before_formal",
        "start_validation_for_user",
        "publish_explanation_as_canonical_card",
        "auto_start",
      ],
      owner: "web",
      manualFallbackTestId: "E2E-key-point",
    }),

    // ── 全屏验证（formal；禁泄答案/替用户开始/代做） ──
    coverageEntry({
      routePattern: "/cards/:id/validate",
      pageKind: "fullscreen-validate",
      access: "authenticated",
      surfaceMode: "panel",
      sensitivity: "normal",
      manifestVersion: PAGE_COVERAGE_MANIFEST_VERSION,
      actionAllowlist: [
        "explain_page",
        "read_operation",
        "switch_mode",
        "trusted_handoff",
        "stop",
      ],
      forbiddenActions: FORMAL_FORBIDDEN,
      owner: "web",
      requiredCapabilities: ["formal_assessment"],
    }),
    coverageEntry({
      routePattern: "/cards/:id/companion",
      pageKind: "companion-stage",
      access: "authenticated",
      surfaceMode: "panel",
      sensitivity: "normal",
      manifestVersion: PAGE_COVERAGE_MANIFEST_VERSION,
      actionAllowlist: ["read_operation", "trusted_handoff", "stop"],
      forbiddenActions: [
        ...FORMAL_FORBIDDEN,
        "exaggerate_mastery",
        "auto_continue_questions",
        "celebration_masks_assessment_boundary",
      ],
      owner: "web",
      requiredCapabilities: ["learning_session_v2_internal"],
    }),

    // ── Review / 此刻（禁债务/红色逾期/静默延期/自动开始） ──
    coverageEntry({
      routePattern: "/review",
      pageKind: "review",
      access: "authenticated",
      surfaceMode: "silent_anchor",
      sensitivity: "normal",
      manifestVersion: PAGE_COVERAGE_MANIFEST_VERSION,
      actionAllowlist: REVIEW_NOW_ACTIONS,
      forbiddenActions: LEARNING_INTEGRITY_FORBIDDEN,
      owner: "web",
    }),
    coverageEntry({
      routePattern: "/review/:scheduleId",
      pageKind: "review-schedule",
      access: "authenticated",
      surfaceMode: "silent_anchor",
      sensitivity: "normal",
      manifestVersion: PAGE_COVERAGE_MANIFEST_VERSION,
      actionAllowlist: REVIEW_NOW_ACTIONS,
      forbiddenActions: LEARNING_INTEGRITY_FORBIDDEN,
      owner: "web",
      inheritsManifestFrom: "review",
    }),
    coverageEntry({
      routePattern: "/today",
      pageKind: "now",
      access: "authenticated",
      surfaceMode: "silent_anchor",
      sensitivity: "normal",
      manifestVersion: PAGE_COVERAGE_MANIFEST_VERSION,
      actionAllowlist: REVIEW_NOW_ACTIONS,
      forbiddenActions: LEARNING_INTEGRITY_FORBIDDEN,
      owner: "web",
    }),

    // ── 理解星图（禁自由创建共享关系、把 Scene 连线发布为图真值） ──
    coverageEntry({
      routePattern: "/graph",
      pageKind: "star-map",
      access: "authenticated",
      surfaceMode: "silent_anchor",
      sensitivity: "normal",
      manifestVersion: PAGE_COVERAGE_MANIFEST_VERSION,
      actionAllowlist: STAR_MAP_ACTIONS,
      forbiddenActions: STAR_MAP_FORBIDDEN,
      owner: "web",
    }),

    // ── 工作台 / 结果（Episode 结果语义） ──
    coverageEntry({
      routePattern: "/results",
      pageKind: "workspace-results",
      access: "authenticated",
      surfaceMode: "panel",
      sensitivity: "normal",
      manifestVersion: PAGE_COVERAGE_MANIFEST_VERSION,
      actionAllowlist: [
        "explain_page",
        "read_operation",
        "switch_mode",
        "trusted_handoff",
        "stop",
        "explain_real_change",
        "user_confirm_continue",
      ],
      forbiddenActions: [
        "exaggerate_mastery",
        "auto_continue_questions",
        "celebration_masks_assessment_boundary",
        "do_for_user",
        "submit_for_user",
        "grade_for_user",
      ],
      owner: "web",
      manualFallbackTestId: "E2E-workspace-results",
    }),

    // ── 搜索 / 无结果（禁编造、跨权限检索） ──
    coverageEntry({
      routePattern: "/search",
      pageKind: "search",
      access: "authenticated",
      surfaceMode: "silent_anchor",
      sensitivity: "normal",
      manifestVersion: PAGE_COVERAGE_MANIFEST_VERSION,
      actionAllowlist: [
        "explain_page",
        "narrow_legal_scope",
        "explain_no_result",
        "guide_add_or_select_existing",
      ],
      forbiddenActions: SEARCH_FORBIDDEN,
      owner: "web",
    }),

    // ── 导入 / 生成（按确定性 job 状态解释；禁虚构百分比/动画伪装进度） ──
    coverageEntry({
      routePattern: "/import",
      pageKind: "import",
      access: "authenticated",
      surfaceMode: "silent_anchor",
      sensitivity: "normal",
      manifestVersion: PAGE_COVERAGE_MANIFEST_VERSION,
      actionAllowlist: JOB_STATUS_ACTIONS,
      forbiddenActions: JOB_FORBIDDEN,
      owner: "web",
      manualFallbackTestId: "E2E-import",
    }),
    coverageEntry({
      routePattern: "/generate",
      pageKind: "generate",
      access: "authenticated",
      surfaceMode: "silent_anchor",
      sensitivity: "normal",
      manifestVersion: PAGE_COVERAGE_MANIFEST_VERSION,
      actionAllowlist: JOB_STATUS_ACTIONS,
      forbiddenActions: JOB_FORBIDDEN,
      owner: "web",
      manualFallbackTestId: "E2E-generate",
    }),

    // ── 设置 / 隐私 / 历史（禁自动改偏好、代确认、导出或删除） ──
    coverageEntry({
      routePattern: "/settings",
      pageKind: "settings",
      access: "authenticated",
      surfaceMode: "silent_anchor",
      sensitivity: "normal",
      manifestVersion: PAGE_COVERAGE_MANIFEST_VERSION,
      actionAllowlist: SETTINGS_ACTIONS,
      forbiddenActions: SETTINGS_FORBIDDEN,
      owner: "web",
    }),
    coverageEntry({
      routePattern: "/settings#model",
      pageKind: "settings-privacy",
      access: "authenticated",
      surfaceMode: "silent_anchor",
      sensitivity: "private",
      manifestVersion: PAGE_COVERAGE_MANIFEST_VERSION,
      actionAllowlist: SETTINGS_ACTIONS,
      forbiddenActions: SETTINGS_FORBIDDEN,
      owner: "web",
      manualFallbackTestId: "E2E-settings-privacy",
    }),
    coverageEntry({
      routePattern: "/settings/history",
      pageKind: "settings-history",
      access: "authenticated",
      surfaceMode: "silent_anchor",
      sensitivity: "private",
      manifestVersion: PAGE_COVERAGE_MANIFEST_VERSION,
      actionAllowlist: SETTINGS_ACTIONS,
      forbiddenActions: SETTINGS_FORBIDDEN,
      owner: "web",
      manualFallbackTestId: "E2E-settings-history",
    }),

    // ── 账号 / 安全 / 成员 / 权限 / 密钥 / MFA（仅签名静态 allowlist 解释） ──
    coverageEntry({
      routePattern: "/settings/account-security",
      pageKind: "settings-account-security",
      access: "authenticated",
      surfaceMode: "static_help",
      sensitivity: "credential",
      manifestVersion: PAGE_COVERAGE_MANIFEST_VERSION,
      actionAllowlist: SENSITIVE_ACCOUNT_ACTIONS,
      forbiddenActions: CREDENTIAL_FORBIDDEN,
      owner: "web",
      manualFallbackTestId: "E2E-settings-account-security",
    }),
    coverageEntry({
      routePattern: "/settings/members",
      pageKind: "settings-members",
      access: "authenticated",
      surfaceMode: "static_help",
      sensitivity: "private",
      manifestVersion: PAGE_COVERAGE_MANIFEST_VERSION,
      actionAllowlist: SENSITIVE_ACCOUNT_ACTIONS,
      forbiddenActions: [
        "read_member_or_secret_value",
        "authorize_for_user",
        "change_permissions",
        "run_model",
        "voice",
        "observe_field_or_interaction_metadata",
        "observe_input",
      ],
      owner: "web",
      manualFallbackTestId: "E2E-settings-members",
    }),
    coverageEntry({
      routePattern: "/settings/keys",
      pageKind: "settings-keys",
      access: "authenticated",
      surfaceMode: "static_help",
      sensitivity: "credential",
      manifestVersion: PAGE_COVERAGE_MANIFEST_VERSION,
      actionAllowlist: SENSITIVE_ACCOUNT_ACTIONS,
      forbiddenActions: CREDENTIAL_FORBIDDEN,
      owner: "web",
      manualFallbackTestId: "E2E-settings-keys",
    }),

    // ── 共学工作台（禁 formal 中提示/代做/代提交/参与评分） ──
    coverageEntry({
      routePattern: "/co-study",
      pageKind: "co-study",
      access: "authenticated",
      surfaceMode: "panel",
      sensitivity: "normal",
      manifestVersion: PAGE_COVERAGE_MANIFEST_VERSION,
      actionAllowlist: CO_STUDY_ACTIONS,
      forbiddenActions: CO_STUDY_FORBIDDEN,
      owner: "web",
      manualFallbackTestId: "E2E-co-study",
    }),

    // ── Episode 结果（禁夸大掌握/自动续题/庆祝动画掩盖边界） ──
    coverageEntry({
      routePattern: "/episode-results",
      pageKind: "episode-results",
      access: "authenticated",
      surfaceMode: "silent_anchor",
      sensitivity: "normal",
      manifestVersion: PAGE_COVERAGE_MANIFEST_VERSION,
      actionAllowlist: EPISODE_RESULT_ACTIONS,
      forbiddenActions: [
        "exaggerate_mastery",
        "auto_continue_questions",
        "celebration_masks_assessment_boundary",
        "auto_start",
      ],
      owner: "web",
      manualFallbackTestId: "E2E-episode-results",
    }),

    // ── 404 / 离线 / 降级（禁把系统故障表现成用户失败、阻塞原页面 fallback） ──
    coverageEntry({
      routePattern: "/404",
      pageKind: "not-found",
      access: "authenticated",
      surfaceMode: "static_help",
      sensitivity: "normal",
      manifestVersion: PAGE_COVERAGE_MANIFEST_VERSION,
      actionAllowlist: ERROR_RECOVERY_ACTIONS,
      forbiddenActions: ERROR_FORBIDDEN,
      owner: "web",
      manualFallbackTestId: "E2E-not-found",
    }),
    coverageEntry({
      routePattern: "/offline",
      pageKind: "offline",
      access: "authenticated",
      surfaceMode: "static_help",
      sensitivity: "normal",
      manifestVersion: PAGE_COVERAGE_MANIFEST_VERSION,
      actionAllowlist: ERROR_RECOVERY_ACTIONS,
      forbiddenActions: ERROR_FORBIDDEN,
      owner: "web",
      manualFallbackTestId: "E2E-offline",
    }),

    // ── 桌宠 Pet Window（方案 13） ──
    // Pet Window 页面本身不承载页面内 Companion surface，也不写入 canonical
    // 学习事实；全量动作禁止，仅保留确定性降级动作。
    coverageEntry({
      routePattern: "/companion/pet",
      pageKind: "companion-pet-window",
      access: "authenticated",
      surfaceMode: "static_help",
      sensitivity: "normal",
      manifestVersion: PAGE_COVERAGE_MANIFEST_VERSION,
      actionAllowlist: ERROR_RECOVERY_ACTIONS,
      forbiddenActions: [
        ...LEARNING_INTEGRITY_FORBIDDEN,
        ...CONTENT_FORBIDDEN,
        "leak_answer_before_formal",
        "observe_input",
        "run_model",
        "export_or_delete",
        "auto_change_preference",
      ],
      owner: "web",
      manualFallbackTestId: "E2E-companion-pet-window",
    }),

    // ── 完整对话页（方案 13 §4.5；P1 占位，P2 接入真实历史） ──
    coverageEntry({
      routePattern: "/companion/conversations",
      pageKind: "companion-conversations",
      access: "authenticated",
      surfaceMode: "panel",
      sensitivity: "normal",
      manifestVersion: PAGE_COVERAGE_MANIFEST_VERSION,
      actionAllowlist: [],
      forbiddenActions: [
        ...LEARNING_INTEGRITY_FORBIDDEN,
        ...CONTENT_FORBIDDEN,
        "leak_answer_before_formal",
        "observe_input",
        "run_model",
        "export_or_delete",
        "auto_change_preference",
        "fabricate_result",
      ],
      owner: "web",
      manualFallbackTestId: "E2E-companion-conversations",
    }),

    // ── internal / admin ──
    coverageEntry({
      routePattern: "/benchmark",
      pageKind: "internal",
      access: "authenticated",
      surfaceMode: "static_help",
      sensitivity: "normal",
      manifestVersion: PAGE_COVERAGE_MANIFEST_VERSION,
      actionAllowlist: ["explain_page", "open_help"],
      forbiddenActions: [
        "run_model",
        "voice",
        "authorize_for_user",
        "change_permissions",
        "read_member_or_secret_value",
      ],
      owner: "web",
    }),
    coverageEntry({
      routePattern: "/admin",
      pageKind: "admin",
      access: "authenticated",
      surfaceMode: "static_help",
      sensitivity: "normal",
      manifestVersion: PAGE_COVERAGE_MANIFEST_VERSION,
      actionAllowlist: SENSITIVE_ACCOUNT_ACTIONS,
      forbiddenActions: [
        "run_model",
        "voice",
        "authorize_for_user",
        "change_permissions",
        "read_member_or_secret_value",
        "observe_field_or_interaction_metadata",
      ],
      owner: "web",
      manualFallbackTestId: "E2E-admin",
    }),
  ],
};

// ─── 8. 校验（CI / 启动 fail closed）─────────────────────────────────────

export class CoverageRegistryValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CoverageRegistryValidationError";
  }
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((value, index) => value === sortedB[index]);
}

/** 子路由判定：parent 段是 child 段的前缀且更短（父 "/" 除外）。 */
export function isParentRoutePattern(parent: string, child: string): boolean {
  if (parent === "/" || parent === child) return false;
  const parentSegments = parent.split("/").filter(Boolean);
  const childSegments = child.split("/").filter(Boolean);
  if (parentSegments.length >= childSegments.length) return false;
  return parentSegments.every(
    (segment, index) => segment === childSegments[index] || segment.startsWith(":"),
  );
}

/** manifest hash 失效 → 抛错。 */
export function assertManifestHashesValid(
  registry: CompanionPageCoverageRegistryV1,
): void {
  for (const entry of registry.entries) {
    if (entry.manifestHash !== computeManifestHash(entry)) {
      throw new CoverageRegistryValidationError(
        `manifest hash 失效（pageKind=${entry.pageKind}, route=${entry.routePattern}）：内容与 manifestHash 不一致，需重算`,
      );
    }
  }
}

/** forbidden 与 allowlist 交集必须为空。 */
export function assertForbiddenDisjoint(registry: CompanionPageCoverageRegistryV1): void {
  for (const entry of registry.entries) {
    const overlap = entry.actionAllowlist.filter((action) =>
      (entry.forbiddenActions as readonly string[]).includes(action),
    );
    if (overlap.length > 0) {
      throw new CoverageRegistryValidationError(
        `页面职责冲突（pageKind=${entry.pageKind}）：forbidden 与 allowlist 重叠 ${overlap.join(",")}`,
      );
    }
  }
}

/** 显式继承条件：父存在且 sensitivity / action allowlist / forbidden 完全一致。 */
export function assertExplicitInheritanceConditions(
  registry: CompanionPageCoverageRegistryV1,
): void {
  const byKind = new Map(registry.entries.map((entry) => [entry.pageKind, entry]));
  for (const entry of registry.entries) {
    if (!entry.inheritsManifestFrom) continue;
    const parent = byKind.get(entry.inheritsManifestFrom);
    if (!parent) {
      throw new CoverageRegistryValidationError(
        `继承父 manifest 不存在（pageKind=${entry.pageKind} -> ${entry.inheritsManifestFrom}）`,
      );
    }
    if (entry.sensitivity !== parent.sensitivity) {
      throw new CoverageRegistryValidationError(
        `显式继承条件不满足（pageKind=${entry.pageKind} -> ${parent.pageKind}）：sensitivity 不同`,
      );
    }
    if (!sameSet(entry.actionAllowlist, parent.actionAllowlist)) {
      throw new CoverageRegistryValidationError(
        `显式继承条件不满足（pageKind=${entry.pageKind} -> ${parent.pageKind}）：action allowlist 不同`,
      );
    }
    if (!sameSet(entry.forbiddenActions, parent.forbiddenActions)) {
      throw new CoverageRegistryValidationError(
        `显式继承条件不满足（pageKind=${entry.pageKind} -> ${parent.pageKind}）：forbidden 不同`,
      );
    }
  }
}

/** 隐式继承：子路由与父 manifest 完全相同却未显式声明继承 → 抛错。 */
export function assertNoImplicitInheritance(
  registry: CompanionPageCoverageRegistryV1,
): void {
  for (const child of registry.entries) {
    if (child.inheritsManifestFrom) continue;
    for (const parent of registry.entries) {
      if (!isParentRoutePattern(parent.routePattern, child.routePattern)) continue;
      if (
        child.sensitivity === parent.sensitivity
        && sameSet(child.actionAllowlist, parent.actionAllowlist)
        && sameSet(child.forbiddenActions, parent.forbiddenActions)
      ) {
        throw new CoverageRegistryValidationError(
          `隐式继承（${child.pageKind}(${child.routePattern}) 与父 ${parent.pageKind}(${parent.routePattern}) 的 sensitivity 与 action manifest 完全相同）：必须显式声明 inheritsManifestFrom`,
        );
      }
    }
  }
}

/** 未分类：真实路由必须被至少一个 entry 覆盖。 */
export function assertAllRoutesCovered(
  registry: CompanionPageCoverageRegistryV1,
  actualRoutePatterns: readonly string[],
): void {
  for (const route of actualRoutePatterns) {
    if (!registry.entries.some((entry) => matchesRoutePattern(entry.routePattern, route))) {
      throw new CoverageRegistryValidationError(
        `未分类路由（${route}）：未被 CompanionPageCoverageRegistryV1 覆盖`,
      );
    }
  }
}

/** registry 声明的具体页面（无手动兜底）必须能匹配至少一个真实路由。 */
export function assertNoUncoveredConcreteEntries(
  registry: CompanionPageCoverageRegistryV1,
  actualRoutePatterns: readonly string[],
): void {
  for (const entry of registry.entries) {
    if (entry.manualFallbackTestId) continue;
    const covered = actualRoutePatterns.some((route) =>
      matchesRoutePattern(entry.routePattern, route),
    );
    if (!covered) {
      throw new CoverageRegistryValidationError(
        `registry 声明了无手动兜底的具体页面但路由不存在（${entry.pageKind}@${entry.routePattern}）`,
      );
    }
  }
}

/** 完整校验（CI / 启动入口）：任一规则失败即抛错。 */
export function validateCoverageRegistry(
  registry: CompanionPageCoverageRegistryV1,
  actualRoutePatterns: readonly string[],
): void {
  assertManifestHashesValid(registry);
  assertForbiddenDisjoint(registry);
  assertExplicitInheritanceConditions(registry);
  assertNoImplicitInheritance(registry);
  assertAllRoutesCovered(registry, actualRoutePatterns);
  assertNoUncoveredConcreteEntries(registry, actualRoutePatterns);
}
