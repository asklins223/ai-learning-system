/**
 * 任务 07-2：CompanionPageCoverageRegistryV1 单测（§5.4.4/§5.4.6）。
 *
 * 覆盖：
 * - 全路由 entry 完整性（字段齐全、pageKind 唯一、枚举合法、hash 自洽）；
 * - 页面职责矩阵（§5.4.6）allow/forbid 数据断言；
 * - 继承规则：显式继承条件、隐式继承失败、hash 失效失败；
 * - router 100% 对账：apps/web/app 下全部 page.tsx 路由被 registry 覆盖，
 *   registry 无手动兜底的具体页面都被真实路由匹配；
 * - 未分类路由失败、forbidden∩allowlist 冲突失败。
 */
import assert from "node:assert/strict";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import {
  COMPANION_ACTION_IDS,
  COMPANION_COVERAGE_REGISTRY_VERSION,
  COMPANION_PAGE_COVERAGE_REGISTRY,
  COMPANION_PAGE_KINDS,
  COMPANION_SURFACE_MODES,
  CoverageRegistryValidationError,
  assertAllRoutesCovered,
  assertExplicitInheritanceConditions,
  assertForbiddenDisjoint,
  assertManifestHashesValid,
  assertNoImplicitInheritance,
  assertNoUncoveredConcreteEntries,
  computeManifestHash,
  findEntryForPath,
  isCompanionActionId,
  matchesRoutePattern,
  validateCoverageRegistry,
  type CompanionPageCoverageEntryV1,
  type CompanionPageCoverageRegistryV1,
} from "./page-coverage-registry.ts";
import type { CompanionSensitivity } from "./page-companion-context.ts";

// ─── 路由收集（router 100% 对账）─────────────────────────────────────────

const APP_ROOT = fileURLToPath(new URL("../../app", import.meta.url));

function collectAppRoutes(root: string): string[] {
  const routes: string[] = [];
  const walk = (dir: string, segments: string[]) => {
    for (const entry of readdirSync(dir)) {
      if (entry.startsWith(".")) continue;
      const full = join(dir, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        // Next.js route group "(...)" 不贡献 URL 段
        walk(full, entry.startsWith("(") ? segments : [...segments, entry]);
      } else if (entry === "page.tsx") {
        const pattern = `/${segments
          .map((segment) =>
            segment.startsWith("[") && segment.endsWith("]")
              ? `:${segment.slice(1, -1)}`
              : segment,
          )
          .join("/")}`;
        routes.push(pattern === "/" ? "/" : pattern);
      }
    }
  };
  walk(root, []);
  return [...new Set(routes)].sort();
}

const ACTUAL_ROUTES = collectAppRoutes(APP_ROOT);

function byKind(registry: CompanionPageCoverageRegistryV1, pageKind: string) {
  const entry = registry.entries.find((e) => e.pageKind === pageKind);
  assert.ok(entry, `registry 缺少 pageKind=${pageKind}`);
  return entry!;
}

function requireAllowed(entry: CompanionPageCoverageEntryV1, actions: readonly string[]) {
  for (const action of actions) {
    assert.ok(
      (entry.actionAllowlist as readonly string[]).includes(action),
      `${entry.pageKind} 的 allowlist 必须包含 ${action}`,
    );
  }
}

function requireForbidden(entry: CompanionPageCoverageEntryV1, actions: readonly string[]) {
  for (const action of actions) {
    assert.ok(
      (entry.forbiddenActions as readonly string[]).includes(action),
      `${entry.pageKind} 的 forbiddenActions 必须包含 ${action}`,
    );
  }
}

function registryWith(entries: readonly CompanionPageCoverageEntryV1[]): CompanionPageCoverageRegistryV1 {
  return {
    version: COMPANION_COVERAGE_REGISTRY_VERSION,
    manifestVersion: 1,
    entries,
  };
}

// ─── 1. 全路由 entry 完整性 ──────────────────────────────────────────────

describe("CompanionPageCoverageRegistryV1 数据完整性（§5.4.6）", () => {
  it("registry 版本与 manifest 版本冻结", () => {
    assert.equal(COMPANION_PAGE_COVERAGE_REGISTRY.version, "CompanionPageCoverageRegistryV1");
    assert.ok(COMPANION_PAGE_COVERAGE_REGISTRY.manifestVersion >= 1);
  });

  it("pageKind 覆盖冻结清单且唯一；routePattern 非空；每个 kind 有 entry", () => {
    const kinds = new Set<string>();
    for (const entry of COMPANION_PAGE_COVERAGE_REGISTRY.entries) {
      assert.ok(!kinds.has(entry.pageKind), `pageKind 重复：${entry.pageKind}`);
      kinds.add(entry.pageKind);
      assert.ok(entry.routePattern.length > 0);
      assert.ok(entry.owner.length > 0);
    }
    for (const pageKind of COMPANION_PAGE_KINDS) {
      assert.ok(kinds.has(pageKind), `冻结 pageKind 缺 entry：${pageKind}`);
    }
  });

  it("每个 entry 字段齐全：sensitivity/surfaceMode/access/manifestVersion/manifestHash", () => {
    for (const entry of COMPANION_PAGE_COVERAGE_REGISTRY.entries) {
      assert.ok(entry.sensitivity.length > 0);
      assert.ok((COMPANION_SURFACE_MODES as readonly string[]).includes(entry.surfaceMode));
      assert.ok(entry.access === "public-auth" || entry.access === "authenticated");
      assert.ok(entry.manifestVersion >= 1);
      assert.ok(entry.manifestHash.startsWith("fnv1a:"));
    }
  });

  it("manifest hash 自洽（构建时自动生成，任何内容变化都会使校验失败）", () => {
    assertManifestHashesValid(COMPANION_PAGE_COVERAGE_REGISTRY);
  });

  it("全部 action ID 是 bounded registry enum（无自由字符串）", () => {
    for (const entry of COMPANION_PAGE_COVERAGE_REGISTRY.entries) {
      for (const action of [...entry.actionAllowlist, ...entry.forbiddenActions]) {
        assert.ok(isCompanionActionId(action), `非法 action ID：${action}@${entry.pageKind}`);
      }
    }
    assert.ok(COMPANION_ACTION_IDS.length > 40, "bounded action enum 非空");
  });

  it("findEntryForPath 命中与未命中", () => {
    assert.equal(findEntryForPath(COMPANION_PAGE_COVERAGE_REGISTRY, "/graph")?.pageKind, "star-map");
    assert.equal(findEntryForPath(COMPANION_PAGE_COVERAGE_REGISTRY, "/sources/abc")?.pageKind, "source-detail");
    assert.equal(findEntryForPath(COMPANION_PAGE_COVERAGE_REGISTRY, "/no-such-route"), undefined);
  });
});

// ─── 2. 页面职责矩阵（§5.4.6）───────────────────────────────────────────

describe("页面职责矩阵（§5.4.6）实现为 action allowlist 数据", () => {
  it("注册/登录/找回账号（public-auth）：解释公开能力/无障碍/确定性故障，禁读凭据/观察输入/建画像/麦克风", () => {
    const authKinds = [
      "auth-login",
      "auth-register",
      "auth-forgot",
      "auth-invite",
      "auth-verify",
      "auth-mfa",
      "auth-sso-callback",
    ];
    for (const kind of authKinds) {
      const entry = byKind(COMPANION_PAGE_COVERAGE_REGISTRY, kind);
      assert.equal(entry.sensitivity, "credential");
      requireAllowed(entry, [
        "explain_public_capability",
        "a11y_help",
        "deterministic_auth_failure",
        "open_help",
      ]);
      requireForbidden(entry, [
        "read_credentials",
        "observe_input",
        "build_profile",
        "request_microphone",
        "run_model",
      ]);
    }
  });

  it("首页/空 workspace：开始或恢复引导/选择示例/说明添加第一份材料/恢复暂停任务，禁强迫上传/自动创建/把 onboarding 做成待清任务", () => {
    const entry = byKind(COMPANION_PAGE_COVERAGE_REGISTRY, "home");
    requireAllowed(entry, [
      "start_or_resume_onboarding",
      "choose_sample",
      "explain_add_first_material",
      "resume_paused_task",
    ]);
    requireForbidden(entry, ["force_upload", "auto_create", "onboarding_as_pending_task"]);
  });

  it("Source/Note：说明页面/朗读选区/定位证据/展示已发布 Card，禁未绑定 target 无界问答/解释直接发布 canonical Card", () => {
    for (const kind of ["library", "source-detail", "note-list", "note-detail"]) {
      const entry = byKind(COMPANION_PAGE_COVERAGE_REGISTRY, kind);
      requireAllowed(entry, ["explain_page", "read_selection", "locate_evidence", "show_published_card"]);
      requireForbidden(entry, [
        "unbounded_qa_unbound_target",
        "publish_explanation_as_canonical_card",
        "read_unauthorized_material",
      ]);
    }
    assert.equal(byKind(COMPANION_PAGE_COVERAGE_REGISTRY, "note-list").sensitivity, "private");
    assert.equal(byKind(COMPANION_PAGE_COVERAGE_REGISTRY, "note-detail").sensitivity, "private");
  });

  it("Card/Key Point：一起学习/让我试试/查看证据/前往星图，禁 formal 前泄答案/替用户开始验证", () => {
    for (const kind of ["card-set-detail", "card-list", "card-detail", "key-point"]) {
      const entry = byKind(COMPANION_PAGE_COVERAGE_REGISTRY, kind);
      requireAllowed(entry, ["study_together", "let_me_try", "view_evidence", "go_to_star_map"]);
      requireForbidden(entry, ["leak_answer_before_formal", "start_validation_for_user"]);
    }
  });

  it("全屏验证（formal）：只留操作说明/切换模态/可信交接/停止，禁泄答案/替用户开始/formal 提示/代做", () => {
    const entry = byKind(COMPANION_PAGE_COVERAGE_REGISTRY, "fullscreen-validate");
    requireAllowed(entry, ["read_operation", "switch_mode", "trusted_handoff", "stop"]);
    requireForbidden(entry, [
      "leak_answer_before_formal",
      "start_validation_for_user",
      "formal_content_hint",
      "do_for_user",
      "submit_for_user",
      "grade_for_user",
    ]);
  });

  it("Review/此刻：解释推荐/缩短/换一条/稍后/自由漫游，禁债务/红色逾期/静默延期/自动开始", () => {
    for (const kind of ["review", "review-schedule", "now"]) {
      const entry = byKind(COMPANION_PAGE_COVERAGE_REGISTRY, kind);
      requireAllowed(entry, ["explain_recommendation", "shorten", "swap", "later", "free_browse"]);
      requireForbidden(entry, ["show_debt", "red_overdue", "silent_defer", "auto_start"]);
    }
  });

  it("理解星图：聚焦/切透镜/铺路/恢复视口，禁自由创建共享关系/把 Scene 连线发布为图真值", () => {
    const entry = byKind(COMPANION_PAGE_COVERAGE_REGISTRY, "star-map");
    requireAllowed(entry, ["focus", "switch_lens", "pave_route", "restore_viewport"]);
    requireForbidden(entry, ["free_create_shared_relation", "publish_scene_edge_as_graph_truth"]);
  });

  it("共学工作台：朗读操作/切换模态/一起学习/可信交接/停止，禁 formal 中提示/代做/代提交/参与评分", () => {
    const entry = byKind(COMPANION_PAGE_COVERAGE_REGISTRY, "co-study");
    requireAllowed(entry, ["read_operation", "switch_mode", "study_together", "trusted_handoff", "stop"]);
    requireForbidden(entry, ["formal_content_hint", "do_for_user", "submit_for_user", "grade_for_user"]);
  });

  it("Episode 结果：解释真实变化/返回来源/可选查看星图/用户确认继续，禁夸大掌握/自动续题/庆祝动画掩盖边界", () => {
    const entry = byKind(COMPANION_PAGE_COVERAGE_REGISTRY, "episode-results");
    requireAllowed(entry, [
      "explain_real_change",
      "back_to_source",
      "optional_view_star_map",
      "user_confirm_continue",
    ]);
    requireForbidden(entry, [
      "exaggerate_mastery",
      "auto_continue_questions",
      "celebration_masks_assessment_boundary",
    ]);
  });

  it("搜索/无结果：缩小合法范围/解释无结果/引导添加或选择已有内容，禁编造/跨权限检索", () => {
    const entry = byKind(COMPANION_PAGE_COVERAGE_REGISTRY, "search");
    requireAllowed(entry, ["narrow_legal_scope", "explain_no_result", "guide_add_or_select_existing"]);
    requireForbidden(entry, ["fabricate_result", "cross_permission_search"]);
  });

  it("导入/生成：按确定性 job 状态解释，禁虚构百分比/承诺未完成产物/动画伪装进度", () => {
    for (const kind of ["import", "generate"]) {
      const entry = byKind(COMPANION_PAGE_COVERAGE_REGISTRY, kind);
      requireAllowed(entry, ["explain_deterministic_job_status"]);
      requireForbidden(entry, [
        "fabricate_percentage",
        "promise_unfinished_artifact",
        "animation_masks_progress",
      ]);
    }
  });

  it("设置/隐私/历史：解释选项影响/定位控制项/预览导出删除范围/重播引导，禁自动改偏好/代确认/导出删除", () => {
    for (const kind of ["settings", "settings-privacy", "settings-history"]) {
      const entry = byKind(COMPANION_PAGE_COVERAGE_REGISTRY, kind);
      requireAllowed(entry, [
        "explain_option_impact",
        "locate_control",
        "preview_export_delete_scope",
        "replay_onboarding",
      ]);
      requireForbidden(entry, ["auto_change_preference", "confirm_for_user", "export_or_delete"]);
    }
  });

  it("账号/安全/成员/权限/密钥/MFA：仅签名静态 allowlist 解释，禁运行模型/语音/读成员密钥/代授权", () => {
    for (const kind of [
      "settings-account-security",
      "settings-members",
      "settings-keys",
      "admin",
    ]) {
      const entry = byKind(COMPANION_PAGE_COVERAGE_REGISTRY, kind);
      requireAllowed(entry, ["explain_signed_static_allowlist"]);
      requireForbidden(entry, [
        "run_model",
        "voice",
        "read_member_or_secret_value",
        "authorize_for_user",
        "change_permissions",
      ]);
    }
  });

  it("404/离线：解释已保存状态与可恢复步骤，禁把系统故障表现成用户失败/阻塞原页面 fallback", () => {
    for (const kind of ["not-found", "offline"]) {
      const entry = byKind(COMPANION_PAGE_COVERAGE_REGISTRY, kind);
      requireAllowed(entry, ["explain_saved_state", "explain_recoverable_steps"]);
      requireForbidden(entry, [
        "present_system_failure_as_user_failure",
        "block_original_page_fallback",
      ]);
    }
  });
});

// ─── 3. 继承规则与 hash 失效（fail closed）──────────────────────────────

describe("继承规则与 manifest hash（§5.4.4/§5.4.6）", () => {
  it("正常 registry 通过完整校验（含显式继承、hash、未分类、forbidden 不重叠）", () => {
    assert.doesNotThrow(() => validateCoverageRegistry(COMPANION_PAGE_COVERAGE_REGISTRY, ACTUAL_ROUTES));
  });

  it("显式继承的父子 sensitivity/allowlist 完全相同（source-detail←library、note-detail←note-list、review-schedule←review）", () => {
    for (const [child, parent] of [
      ["source-detail", "library"],
      ["note-detail", "note-list"],
      ["review-schedule", "review"],
    ] as const) {
      const c = byKind(COMPANION_PAGE_COVERAGE_REGISTRY, child);
      const p = byKind(COMPANION_PAGE_COVERAGE_REGISTRY, parent);
      assert.equal(c.inheritsManifestFrom, parent);
      assert.equal(c.sensitivity, p.sensitivity);
      assert.deepEqual([...c.actionAllowlist].sort(), [...p.actionAllowlist].sort());
    }
  });

  it("隐式继承（子与父 manifest 完全相同但未声明继承）→ 抛错", () => {
    const sourceDetail = byKind(COMPANION_PAGE_COVERAGE_REGISTRY, "source-detail");
    const broken = {
      ...sourceDetail,
      inheritsManifestFrom: undefined,
      actionAllowlist: [...sourceDetail.actionAllowlist],
      forbiddenActions: [...sourceDetail.forbiddenActions],
    };
    assert.throws(
      () => assertNoImplicitInheritance(registryWith([...COMPANION_PAGE_COVERAGE_REGISTRY.entries.filter((e) => e.pageKind !== "source-detail"), broken])),
      CoverageRegistryValidationError,
    );
  });

  it("显式继承但 sensitivity 与父不同 → 抛错", () => {
    const reviewSchedule = byKind(COMPANION_PAGE_COVERAGE_REGISTRY, "review-schedule");
    const broken: CompanionPageCoverageEntryV1 = {
      ...reviewSchedule,
      sensitivity: "private" as CompanionSensitivity,
      actionAllowlist: [...reviewSchedule.actionAllowlist],
      forbiddenActions: [...reviewSchedule.forbiddenActions],
    };
    assert.throws(
      () =>
        assertExplicitInheritanceConditions(
          registryWith([...COMPANION_PAGE_COVERAGE_REGISTRY.entries.filter((e) => e.pageKind !== "review-schedule"), broken]),
        ),
      CoverageRegistryValidationError,
    );
  });

  it("显式继承但 action allowlist 与父不同 → 抛错", () => {
    const noteDetail = byKind(COMPANION_PAGE_COVERAGE_REGISTRY, "note-detail");
    const broken: CompanionPageCoverageEntryV1 = {
      ...noteDetail,
      actionAllowlist: [...noteDetail.actionAllowlist, "study_together"],
      forbiddenActions: [...noteDetail.forbiddenActions],
    };
    assert.throws(
      () =>
        assertExplicitInheritanceConditions(
          registryWith([...COMPANION_PAGE_COVERAGE_REGISTRY.entries.filter((e) => e.pageKind !== "note-detail"), broken]),
        ),
      CoverageRegistryValidationError,
    );
  });

  it("manifest hash 失效（内容与 hash 不一致）→ 抛错；重算后通过", () => {
    const home = byKind(COMPANION_PAGE_COVERAGE_REGISTRY, "home");
    const tampered: CompanionPageCoverageEntryV1 = {
      ...home,
      manifestHash: "fnv1a:00000000",
      actionAllowlist: [...home.actionAllowlist],
      forbiddenActions: [...home.forbiddenActions],
    };
    assert.throws(
      () => assertManifestHashesValid(registryWith([tampered])),
      CoverageRegistryValidationError,
    );
    const fixed: CompanionPageCoverageEntryV1 = { ...tampered, manifestHash: computeManifestHash(tampered) };
    assert.doesNotThrow(() => assertManifestHashesValid(registryWith([fixed])));
  });

  it("篡改 allowlist 但未更新 hash → 校验失败（CI 拦截）", () => {
    const home = byKind(COMPANION_PAGE_COVERAGE_REGISTRY, "home");
    const tampered: CompanionPageCoverageEntryV1 = {
      ...home,
      actionAllowlist: [...home.actionAllowlist, "fabricate_result"],
      forbiddenActions: [...home.forbiddenActions],
    };
    assert.throws(
      () => assertManifestHashesValid(registryWith([tampered])),
      CoverageRegistryValidationError,
    );
  });

  it("forbidden 与 allowlist 重叠 → 抛错", () => {
    const search = byKind(COMPANION_PAGE_COVERAGE_REGISTRY, "search");
    const broken: CompanionPageCoverageEntryV1 = {
      ...search,
      actionAllowlist: [...search.actionAllowlist, "fabricate_result"],
      forbiddenActions: [...search.forbiddenActions],
    };
    assert.throws(
      () => assertForbiddenDisjoint(registryWith([broken])),
      CoverageRegistryValidationError,
    );
  });
});

// ─── 4. router 100% 对账 ────────────────────────────────────────────────

describe("router 与 CompanionPageCoverageRegistryV1 对账（验收）", () => {
  it("真实路由集合非空且包含关键路由", () => {
    for (const route of ["/", "/cards", "/graph", "/notes/:id", "/login", "/register", "/benchmark"]) {
      assert.ok(ACTUAL_ROUTES.includes(route), `实际路由缺失：${route}`);
    }
  });

  it("100% 对账：所有真实路由都被 registry 覆盖（未分类为 0）", () => {
    assertAllRoutesCovered(COMPANION_PAGE_COVERAGE_REGISTRY, ACTUAL_ROUTES);
  });

  it("registry 无手动兜底的具体页面都命中真实路由；有兜底的不强制存在", () => {
    assertNoUncoveredConcreteEntries(COMPANION_PAGE_COVERAGE_REGISTRY, ACTUAL_ROUTES);
    const fallback = COMPANION_PAGE_COVERAGE_REGISTRY.entries.filter((e) => e.manualFallbackTestId);
    assert.ok(fallback.length > 10, "手动兜底页面应覆盖尚未实现的路由类别");
    for (const entry of fallback) {
      assert.ok(entry.manualFallbackTestId!.startsWith("E2E-"), `${entry.pageKind} 兜底 ID 格式`);
    }
  });

  it("新增未分类路由 → 抛错（CI fail closed）", () => {
    assert.throws(
      () => assertAllRoutesCovered(COMPANION_PAGE_COVERAGE_REGISTRY, [...ACTUAL_ROUTES, "/brand-new-page"]),
      CoverageRegistryValidationError,
    );
  });
});

// ─── 5. 路由匹配单元 ────────────────────────────────────────────────────

describe("matchesRoutePattern", () => {
  it("精确、动态段、段数不符、非动态差异", () => {
    assert.equal(matchesRoutePattern("/graph", "/graph"), true);
    assert.equal(matchesRoutePattern("/cards/:id", "/cards/abc-123"), true);
    assert.equal(matchesRoutePattern("/cards/:id", "/cards/abc/extra"), false);
    assert.equal(matchesRoutePattern("/cards/:id", "/notes/abc"), false);
    assert.equal(matchesRoutePattern("/cards/:id/validate", "/cards/abc/validate"), true);
    assert.equal(matchesRoutePattern("/", "/"), true);
  });
});
