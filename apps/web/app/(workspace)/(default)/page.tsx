"use client";

import "@/app/styles/home.css";
import "@/app/styles/workspace-headers.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { useCurrentUser } from "@/lib/use-current-user";
import { useMainPageContext } from "@/features/companion-bridge/useMainPageContext";
import { resolveHomeOnboardingVisibility } from "@/lib/home-onboarding";
import { Skeleton } from "@/components/ui/Skeleton";
import { Icon } from "@/components/ui/icons";
import { ThemeToggle } from "@/components/ui/ThemeToggle";
// Plan 23 FE-07：首页主内容切到 /v2/learning-dashboard（Objective Surface）。
// Bug 2 修复：移除 legacy card 拉取逻辑（listCards/mergeLearningCardsV2），
// isEmptyWorkspace 由 dashboard mode === 'first_use' 判定，不再依赖 card count。
// 方案 23 收口：右侧"今日队列"也由 getDashboard() 单一事实源驱动，移除
// legacy listSanitizedReviews/listJobs 并行调用（与 counts.reviewsDue 可能矛盾）。
import "@/app/styles/home-dashboard.css";
import { DashboardHome } from "@/features/learning-objective/DashboardHome";
import { learningObjectiveApi } from "@/lib/learning-objective-api";
import { objectiveActionHref } from "@/features/learning-objective/action-navigation";
import {
  objectiveDisplayTitle,
  reasonCodeLabels,
} from "@/features/learning-objective/labels";
import { objectiveChipStateFromSurface } from "@/features/learning-objective/objective-state";
import { objectiveChipStateLabel } from "@/features/learning-objective/ObjectiveStatusChip";
import { OBJECTIVE_ACTION_LABELS } from "@/features/learning-objective/ObjectivePrimaryAction";
import type { LearningDashboardV2 } from "@ailearn/shared";

type CaptureMessageType = "success" | "error";

/** Dashboard queue/primaryFocus 共享的条目形状（objective + reasonCodes + action）。 */
type DashboardQueueEntry = LearningDashboardV2["queue"][number];

export default function HomePage() {
  const { currentUser, loading: accountLoading } = useCurrentUser();
  // P5（文档 16 §14.2/§14.6）：Home 页发布 bounded context。
  // 第八轮 🟡B-1：useMemo 稳定引用。
  useMainPageContext(useMemo(() => ({
    routeRef: { kind: "home" },
    pageKind: "other",
    entityRefs: [],
    interactionState: "idle",
    capabilityHints: [],
    sensitivity: "normal",
  }), []));
  const isOwner = Boolean(
    currentUser && (currentUser.role === "owner" || currentUser.isPersonal),
  );
  const isPersonalWorkspace = Boolean(currentUser?.isPersonal);
  const router = useRouter();
  const [todayLabel, setTodayLabel] = useState("今天");
  // Bug 2 修复：移除 legacy stats/cards/notes state；方案 23 收口后整个页面
  // （mode 判定 + 今日队列）都由 /v2/learning-dashboard 单一响应驱动。
  const [dashboard, setDashboard] = useState<LearningDashboardV2 | null>(null);
  const [dashboardError, setDashboardError] = useState(false);

  const [captureText, setCaptureText] = useState("");
  const [captureBusy, setCaptureBusy] = useState(false);
  const [captureMsg, setCaptureMsg] = useState<string | null>(null);
  const [captureMsgType, setCaptureMsgType] = useState<CaptureMessageType>("success");
  const [captureExpanded, setCaptureExpanded] = useState(false);
  const [homeRefreshing, setHomeRefreshing] = useState(false);
  const homeRequestRef = useRef(0);
  const captureBusyRef = useRef(false);

  useEffect(() => {
    const formatter = new Intl.DateTimeFormat("zh-CN", {
      month: "long",
      day: "numeric",
      weekday: "long",
    });
    setTodayLabel(formatter.format(new Date()));
  }, []);

  const loadHomeData = useCallback(async () => {
    const requestId = ++homeRequestRef.current;
    setHomeRefreshing(true);
    // Bug 2 修复：移除 legacy stats/cards/notes API 调用；方案 23 收口：
    // 只拉 getDashboard()（mode + 今日队列同源），失败时保留旧数据并置错误态。
    await api.getMe().catch(() => null);
    if (requestId !== homeRequestRef.current) return;
    try {
      const data = await learningObjectiveApi.getDashboard();
      if (requestId !== homeRequestRef.current) return;
      setDashboard(data);
      setDashboardError(false);
    } catch {
      if (requestId !== homeRequestRef.current) return;
      setDashboardError(true);
    } finally {
      if (requestId === homeRequestRef.current) setHomeRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void loadHomeData();

    return () => {
      homeRequestRef.current += 1;
    };
  }, [loadHomeData]);

  useEffect(() => {
    const openSearch = (event: KeyboardEvent) => {
      if (
        !(event.metaKey || event.ctrlKey) ||
        event.altKey ||
        event.key.toLowerCase() !== "k"
      ) {
        return;
      }
      event.preventDefault();
      router.push("/search");
    };
    window.addEventListener("keydown", openSearch);
    return () => window.removeEventListener("keydown", openSearch);
  }, [router]);

  const openCapture = useCallback(() => {
    if (!isOwner) return;
    setCaptureExpanded(true);
    window.requestAnimationFrame(() => {
      document.getElementById("home-capture-input")?.focus();
    });
  }, [isOwner]);

  useEffect(() => {
    const openFromHash = () => {
      if (window.location.hash === "#quick-capture") openCapture();
    };
    const openFromShell = () => openCapture();
    openFromHash();
    window.addEventListener("hashchange", openFromHash);
    window.addEventListener("home:open-capture", openFromShell);
    return () => {
      window.removeEventListener("hashchange", openFromHash);
      window.removeEventListener("home:open-capture", openFromShell);
    };
  }, [openCapture]);

  const handleCapture = useCallback(async () => {
    const text = captureText.trim();
    if (!isOwner || !text || captureBusyRef.current) return;

    captureBusyRef.current = true;
    setCaptureBusy(true);
    setCaptureMsg(null);

    try {
      const isUrl = /^https?:\/\//.test(text);
      if (isUrl) {
        await api.createSource({ url: text });
      } else {
        await api.createSource({ content: text });
      }

      setCaptureMsg("材料已添加，正在解析…");
      setCaptureMsgType("success");
      setCaptureText("");

      // 方案 23 收口：捕获后只需刷新 Dashboard 单一事实源
      // （counts/mode/suggestedNote 均由它派生），不再单独拉 jobs。
      void loadHomeData();
    } catch {
      setCaptureMsg("材料暂时没有添加成功，输入内容已保留，请检查网络后重试。");
      setCaptureMsgType("error");
      window.requestAnimationFrame(() => {
        document.getElementById("home-capture-input")?.focus();
      });
    } finally {
      captureBusyRef.current = false;
      setCaptureBusy(false);
    }
  }, [captureText, isOwner, loadHomeData]);

  // Plan 23 FE-07：概览计数/今日重点由 DashboardHome（/v2/learning-dashboard）提供，
  // 移除依赖 schemaJson.title/summary 的 legacy 派生（§2.2/§2.3）。
  // 今日队列：primaryFocus 在前（服务端最优先项；旧列表的首条复习即它，
  // 不含它会出现"计数 > 0 但队列为空"的矛盾），queue 随后（不重复 primary）。
  const queueEntries = useMemo<DashboardQueueEntry[]>(() => {
    if (!dashboard) return [];
    return dashboard.primaryFocus
      ? [dashboard.primaryFocus, ...dashboard.queue]
      : [...dashboard.queue];
  }, [dashboard]);
  const visibleQueueEntries = queueEntries.slice(0, 4);
  // 队列总数用 Dashboard counts（reviewsDue + activeRuns）；jobs 数量无对应
  // 字段，不再单独展示。溢出提示取 counts 与实际条目数的较大者。
  const queueCount = dashboard ? dashboard.counts.reviewsDue + dashboard.counts.activeRuns : 0;
  const hiddenQueueCount = Math.max(
    0,
    Math.max(queueCount, queueEntries.length) - visibleQueueEntries.length,
  );
  const queueLoading = dashboard === null && !dashboardError;
  const queueUnavailable = dashboardError && dashboard === null;
  const errorList = dashboardError ? ["今日队列"] : [];
  // Bug 2 修复：isEmptyWorkspace 由 dashboard mode === 'first_use' 判定，
  // 不再依赖 legacy card count / stats / reviews+jobs 兜底推导。
  const isEmptyWorkspace = dashboard?.mode === "first_use";
  // 首页首次使用面（isFirstUse 由空个人工作区判定；onboarding 大卡已随
  // §21.3 删除，桌宠 + Journey 承担新用户引导）。
  const isFirstUse = resolveHomeOnboardingVisibility({
    accountLoading,
    isPersonalWorkspace,
    isEmptyWorkspace,
  }).isFirstUse;

  return (
    <div
      className="learning-home"
      data-ui="learning-home"
      data-home-state={isFirstUse ? "first-use" : "active"}
    >
      <header
        className="learning-home-header workspace-page-header"
        data-ui="page-header"
      >
        <div className="learning-home-heading">
          <p className="learning-home-eyebrow">
            <span className="learning-home-eyebrow-dot" aria-hidden="true" />
            {isFirstUse ? "第一次学习" : "个人理解工作台"}
            <span className="learning-home-eyebrow-separator" aria-hidden="true">·</span>
            <span className="learning-home-date">{todayLabel}</span>
          </p>
          <h1>{isFirstUse ? "走完第一条学习闭环" : "今日学习"}</h1>
          <p className="learning-home-subtitle">
            {isFirstUse
              ? "从一份材料出发，逐步整理成可以验证的理解。"
              : "把今天最值得推进的理解，放在桌面中央。"}
          </p>
        </div>

        <div className="learning-home-actions">
          <Link
            href="/search"
            className="learning-home-search"
            aria-label="搜索"
            aria-keyshortcuts="Meta+K Control+K"
          >
            <Icon.Search />
            <span>搜索</span>
            <kbd>⌘K</kbd>
          </Link>
          <ThemeToggle className="learning-home-theme-toggle" />
        </div>
      </header>

      <div className="learning-home-content">
        {errorList.length > 0 && (
          <div className="learning-home-alert" role="alert">
            <Icon.Warn />
            <span>{errorList.join("、")}暂时不可用，其余学习内容仍可继续使用。</span>
            <button
              type="button"
              disabled={homeRefreshing}
              aria-busy={homeRefreshing}
              onClick={() => void loadHomeData()}
            >
              {homeRefreshing ? "正在重试…" : "重试缺失内容"}
            </button>
          </div>
        )}

        <div className="learning-home-desk">
          <div className="learning-home-primary">
            {!isFirstUse && (
              <DashboardHome
                isOwner={isOwner}
                onOpenCapture={openCapture}
              />
            )}
            {isFirstUse && (
              <section
                className="learning-home-starter-intro"
                aria-labelledby="learning-home-starter-title"
              >
                  <span className="learning-home-starter-label">
                    <Icon.Sparkle aria-hidden="true" />
                  第一条学习闭环
                </span>
                <h2 id="learning-home-starter-title">
                  从一份真正想弄懂的材料开始
                </h2>
                <p>
                  不用先整理格式。先把材料收进来，后续只依据真实完成的动作推进。
                </p>
                <div className="learning-home-starter-outcome">
                  <span aria-hidden="true"><Icon.Card /></span>
                  <div>
                    <strong>这条路径会走到哪里？</strong>
                    <p>材料 → 笔记 → 学习卡 → 一次不必写长文的可信巩固。</p>
                  </div>
                </div>
              </section>
            )}
          </div>

          <aside className="learning-home-tools" aria-label="今日学习工具">
            {isOwner ? (
            <section
              id="quick-capture"
              className="learning-home-capture"
              data-expanded={captureExpanded ? "true" : "false"}
              data-ui="quick-capture"
            >
              <header className="learning-home-tool-header">
                <div className="learning-home-tool-heading">
                  <span className="learning-home-tool-icon" aria-hidden="true"><Icon.Plus /></span>
                  <div>
                    <p>{isFirstUse ? "从这里开始" : "添加学习材料"}</p>
                    <h2>{isFirstUse ? "添加第一份材料" : "快速捕获"}</h2>
                  </div>
                </div>
                <button
                  className="learning-home-capture-collapse"
                  type="button"
                  onClick={() => setCaptureExpanded(false)}
                  aria-label="收起快速捕获"
                >
                  <Icon.Chevron />
                </button>
              </header>

              <button className="learning-home-capture-trigger" type="button" onClick={openCapture}>
                <span>粘贴一段内容或链接…</span>
                <Icon.Plus />
              </button>

              <div className="learning-home-capture-form">
                <label className="learning-home-sr-only" htmlFor="home-capture-input">捕获内容</label>
                <textarea
                  id="home-capture-input"
                  className="learning-home-capture-input"
                  placeholder={isFirstUse
                    ? "粘贴一段真正想弄懂的内容，或输入网页链接…"
                    : "粘贴原文、Markdown、代码，或输入 URL…"}
                  value={captureText}
                  onChange={(event) => {
                    setCaptureText(event.target.value);
                    if (captureMsg) setCaptureMsg(null);
                  }}
                  onKeyDown={(event) => {
                    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                      event.preventDefault();
                      handleCapture();
                    }
                  }}
                  rows={4}
                  disabled={captureBusy}
                />
                <div className="learning-home-capture-footer">
                  <span className="learning-home-capture-hint">支持文本、Markdown、代码与 URL · ⌘+Enter</span>
                  <button
                    className="learning-home-capture-submit"
                    type="button"
                    onClick={handleCapture}
                    disabled={captureBusy || !captureText.trim()}
                    aria-busy={captureBusy}
                  >
                    {captureBusy && <span className="learning-home-spinner" aria-hidden="true" />}
                    <span>
                      {captureBusy
                        ? isFirstUse ? "正在添加…" : "创建中…"
                        : isFirstUse ? "添加材料" : "创建来源"}
                    </span>
                  </button>
                </div>
                {captureMsg && (
                  <div
                    className="learning-home-capture-message"
                    data-tone={captureMsgType}
                    role={captureMsgType === "error" ? "alert" : "status"}
                    aria-live={captureMsgType === "error" ? "assertive" : "polite"}
                  >
                    {captureMsgType === "success" ? <Icon.Check /> : <Icon.Warn />}
                    <span>{captureMsg}</span>
                  </div>
                )}
              </div>
            </section>
            ) : (
              <div className="learning-home-readonly-notice">
                <span className="learning-home-readonly-icon" aria-hidden="true">
                  <Icon.Eye />
                </span>
                <div>
                  <strong>成员模式</strong>
                  <span>你可以查看、验证和复习，创建和编辑由工作区所有者操作。</span>
                </div>
              </div>
            )}

            {!isFirstUse && (
            <section className="learning-home-queue" data-ui="today-queue">
              <header className="learning-home-tool-header learning-home-queue-header">
                <div className="learning-home-tool-heading">
                  <span className="learning-home-tool-icon" aria-hidden="true"><Icon.Review /></span>
                  <div>
                    <p>今日待办</p>
                    <h2>今日队列</h2>
                  </div>
                </div>
                <span className="learning-home-queue-count">{queueLoading ? "—" : queueCount}</span>
              </header>

              <div className="learning-home-queue-body">
                {queueLoading ? (
                  <Skeleton lines={3} />
                ) : queueUnavailable ? (
                  <div className="learning-home-queue-state" data-tone="error">
                    <Icon.Warn />
                    <div><strong>队列暂不可用</strong><span>稍后重新打开页面即可重试</span></div>
                  </div>
                ) : visibleQueueEntries.length === 0 ? (
                  <div className="learning-home-queue-state">
                    <Icon.Check />
                    <div><strong>今天没有必须处理的事项</strong><span>可以专注推进左侧的学习卡</span></div>
                  </div>
                ) : (
                  <div className="learning-home-queue-list">
                    {visibleQueueEntries.map((entry) => {
                      // typed action → 路由（单一实现 objectiveActionHref）；
                      // 禁止由 label 文本推断跳转（§7.5/§29.1）。
                      const href = objectiveActionHref(entry.action, "/");
                      const actionLabel = OBJECTIVE_ACTION_LABELS[entry.action.kind];
                      const title = objectiveDisplayTitle(entry.objective.content);
                      const stateLabel = objectiveChipStateLabel(
                        objectiveChipStateFromSurface(entry.objective),
                      );
                      const isReviewKind = entry.action.kind === "create_review_run";
                      const itemBody = (
                        <>
                          <span className="learning-home-queue-item-icon" aria-hidden="true">
                            {isReviewKind ? <Icon.Review /> : <Icon.Bolt />}
                          </span>
                          <span className="learning-home-queue-item-copy">
                            <strong>{actionLabel || stateLabel}</strong>
                            <small>
                              {reasonCodeLabels(entry.reasonCodes)} · {stateLabel}
                            </small>
                          </span>
                          {href ? (
                            <Icon.ChevronRight className="learning-home-queue-chevron" />
                          ) : (
                            <span className="learning-home-job-pulse" aria-hidden="true" />
                          )}
                        </>
                      );
                      return href ? (
                        <Link
                          key={entry.objective.objectiveId}
                          href={href}
                          className="learning-home-queue-item"
                          data-kind={isReviewKind ? "review" : "job"}
                          aria-label={`${actionLabel}：${title}`}
                        >
                          {itemBody}
                        </Link>
                      ) : (
                        <div
                          key={entry.objective.objectiveId}
                          className="learning-home-queue-item"
                          data-kind={isReviewKind ? "review" : "job"}
                          aria-label={`${actionLabel || stateLabel}：${title}`}
                        >
                          {itemBody}
                        </div>
                      );
                    })}
                    {hiddenQueueCount > 0 && (
                      <p className="learning-home-queue-more">还有 {hiddenQueueCount} 项未展示</p>
                    )}
                  </div>
                )}
              </div>
            </section>
            )}
          </aside>
        </div>

      </div>
    </div>
  );
}
