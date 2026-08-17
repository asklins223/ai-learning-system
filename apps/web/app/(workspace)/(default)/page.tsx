"use client";

import "@/app/styles/home.css";
import "@/app/styles/workspace-headers.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api, CardListItem, JobRow, SanitizedReviewItem, StatsOverview } from "@/lib/api";
import { useCurrentUser } from "@/lib/use-current-user";
import { useMainPageContext } from "@/features/companion-bridge/useMainPageContext";
import { resolveHomeOnboardingVisibility } from "@/lib/home-onboarding";
import { Skeleton } from "@/components/ui/Skeleton";
import { Icon } from "@/components/ui/icons";
import { ThemeToggle } from "@/components/ui/ThemeToggle";
import { statusMap } from "@/lib/status-map";
import { mergeLearningCardsV2 } from "@/lib/learning-card-library";
// Plan 23 FE-07：首页主内容切到 /v2/learning-dashboard（Objective Surface）。
import "@/app/styles/home-dashboard.css";
import { DashboardHome } from "@/features/learning-objective/DashboardHome";

type CaptureMessageType = "success" | "error";

/** 首页统一入口：到期复习也走 LearningRun（方案 16 三分钟微旅程）。 */
function homeLearningRunHref(review: SanitizedReviewItem) {
  const params = new URLSearchParams({
    origin: review.isV2 ? "review_v2" : "review",
    scheduleId: review.reviewId,
    cardId: review.cardId,
    returnTo: "/",
  });
  if (review.keyPointId) params.set("keyPointId", review.keyPointId);
  return `/learning-runs/new?${params.toString()}`;
}

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
  const [stats, setStats] = useState<StatsOverview | null>(null);
  const [statsError, setStatsError] = useState<string | null>(null);
  const [noteTotal, setNoteTotal] = useState<number | null>(null);
  const [notesError, setNotesError] = useState<string | null>(null);
  const [cards, setCards] = useState<CardListItem[] | null>(null);
  const [homeCardTotal, setHomeCardTotal] = useState<number | null>(null);
  const [cardsError, setCardsError] = useState<string | null>(null);
  const [reviews, setReviews] = useState<SanitizedReviewItem[] | null>(null);
  const [homeReviewTotal, setHomeReviewTotal] = useState<number | null>(null);
  const [reviewsError, setReviewsError] = useState<string | null>(null);
  const [jobs, setJobs] = useState<JobRow[] | null>(null);
  const [jobsError, setJobsError] = useState<string | null>(null);

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
    // F#7（🟠8）：先 await getMe（缓存命中/合并 in-flight），使 scope 解析为
    // 真实 ws 键，随后 5 个统计 GET 全部落在带缓存路径（首帧冷缓存收益），
    // 并让通用 in-flight 去重在并发重载时合并同 path GET。
    await api.getMe().catch(() => null);
    if (requestId !== homeRequestRef.current) return;
    const [statsResult, notesResult, cardsResult, v2CardsResult, reviewsResult, jobsResult] =
      await Promise.allSettled([
        api.getStatsOverview(),
        api.listNotes({ limit: 1 }),
        api.listCards({ limit: 50 }),
        api.listLearningCardsV2({ limit: 50 }),
        api.listSanitizedReviews({ status: "pending", limit: 3 }),
        api.listJobs({ limit: 50 }),
      ] as const);

    if (requestId !== homeRequestRef.current) return;

    if (statsResult.status === "fulfilled") {
      setStats(statsResult.value);
      setStatsError(null);
    } else {
      setStatsError("学习概览");
    }

    if (notesResult.status === "fulfilled") {
      setNoteTotal(notesResult.value.total);
      setNotesError(null);
    } else {
      setNotesError("笔记");
    }

    if (cardsResult.status === "fulfilled" || v2CardsResult.status === "fulfilled") {
      const legacyCards = cardsResult.status === "fulfilled" ? cardsResult.value.items : [];
      const v2Cards = v2CardsResult.status === "fulfilled" ? v2CardsResult.value.items : [];
      const mergedCards = mergeLearningCardsV2(legacyCards, v2Cards);
      setCards(mergedCards);
      // V2 列表接口没有 total；统计接口补上 V2 计数后 stats 会提供准确值。
      // 这里退化为「旧卡 total + 本页 V2 数量」，避免 stats 失败时首页仍显示 0。
      const legacyTotal = cardsResult.status === "fulfilled" ? cardsResult.value.total : 0;
      setHomeCardTotal(legacyTotal + v2Cards.length);
      setCardsError(null);
    } else {
      setCards(null);
      setCardsError("学习卡");
    }

    if (reviewsResult.status === "fulfilled") {
      setReviews(reviewsResult.value.items);
      setHomeReviewTotal(reviewsResult.value.total);
      setReviewsError(null);
    } else {
      setReviewsError("到期复习");
    }

    if (jobsResult.status === "fulfilled") {
      setJobs(jobsResult.value.items);
      setJobsError(null);
    } else {
      setJobsError("运行任务");
    }
    setHomeRefreshing(false);
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

      void Promise.allSettled([api.listJobs({ limit: 50 }), api.getStatsOverview()]).then(
        ([jobsResult, statsResult]) => {
          if (jobsResult.status === "fulfilled") {
            setJobs(jobsResult.value.items);
            setJobsError(null);
          } else {
            setJobsError("运行任务");
          }
          if (statsResult.status === "fulfilled") {
            setStats(statsResult.value);
            setStatsError(null);
          }
        },
      );
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
  }, [captureText, isOwner]);

  const pendingReviews = reviews ?? [];
  const pendingReviewCount = homeReviewTotal ?? pendingReviews.length;
  const activeJobs = jobs?.filter((job) => job.status === "pending" || job.status === "running") ?? [];
  // Plan 23 FE-07：概览计数/今日重点由 DashboardHome（/v2/learning-dashboard）提供，
  // 移除依赖 schemaJson.title/summary 的 legacy 派生（§2.2/§2.3）。
  const queueLoading =
    (reviews === null && !reviewsError) ||
    (jobs === null && !jobsError);

  const visibleReviews = pendingReviews.slice(0, 3);
  const visibleJobs = activeJobs.slice(0, Math.max(0, Math.min(3, 4 - visibleReviews.length)));
  const hiddenQueueCount = Math.max(
    0,
    pendingReviewCount + activeJobs.length - visibleReviews.length - visibleJobs.length,
  );
  const queueCount = pendingReviewCount + activeJobs.length;
  const errorList = [statsError, notesError, cardsError, reviewsError, jobsError].filter(Boolean);
  const resolvedNoteCount = stats?.noteCount ?? noteTotal;
  const resolvedCardCount = stats?.cardCount ?? homeCardTotal;
  const isEmptyWorkspace =
    resolvedNoteCount === 0 &&
    resolvedCardCount === 0 &&
    cards !== null &&
    reviews !== null &&
    jobs !== null &&
    !notesError &&
    !cardsError &&
    !reviewsError &&
    !jobsError &&
    pendingReviewCount === 0 &&
    jobs.length === 0;
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
        {!isFirstUse && (
        <DashboardHome
          isOwner={isOwner}
          onOpenCapture={openCapture}
        />
        )}

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
                ) : reviewsError && jobsError ? (
                  <div className="learning-home-queue-state" data-tone="error">
                    <Icon.Warn />
                    <div><strong>队列暂不可用</strong><span>稍后重新打开页面即可重试</span></div>
                  </div>
                ) : queueCount === 0 ? (
                  <div className="learning-home-queue-state">
                    <Icon.Check />
                    <div><strong>今天没有必须处理的事项</strong><span>可以专注推进左侧的学习卡</span></div>
                  </div>
                ) : (
                  <div className="learning-home-queue-list">
                    {visibleReviews.map((review) => {
                      const reason = statusMap.reviewReason(review.reviewReason);
                      return (
                        <Link
                          key={review.reviewId}
                          href={homeLearningRunHref(review)}
                          className="learning-home-queue-item"
                          data-kind="review"
                          aria-label={`开始三分钟验证：${reason.label}`}
                        >
                          <span className="learning-home-queue-item-icon" aria-hidden="true"><Icon.Review /></span>
                          <span className="learning-home-queue-item-copy">
                            <strong>三分钟内证明一个要点</strong>
                            <small>
                              {reason.label} · 间隔 {review.intervalDays} 天 · 可换方式
                            </small>
                          </span>
                          <Icon.ChevronRight className="learning-home-queue-chevron" />
                        </Link>
                      );
                    })}
                    {visibleJobs.map((job) => {
                      const status = statusMap.jobStatus(job.status);
                      return (
                        <div key={job.id} className="learning-home-queue-item" data-kind="job">
                          <span className="learning-home-queue-item-icon" aria-hidden="true"><Icon.Bolt /></span>
                          <span className="learning-home-queue-item-copy">
                            <strong>{jobLabel(job.type)}</strong>
                            <small>{status.label}</small>
                          </span>
                          <span className="learning-home-job-pulse" aria-hidden="true" />
                        </div>
                      );
                    })}
                    {hiddenQueueCount > 0 && (
                      <p className="learning-home-queue-more">还有 {hiddenQueueCount} 项未展示</p>
                    )}
                    {(reviewsError || jobsError) && (
                      <p className="learning-home-queue-more" data-tone="error">部分队列数据暂不可用</p>
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

function jobLabel(type: string): string {
  switch (type) {
    case "execute_card_agent_turn": return "生成学习卡";
    case "evaluate_validation": return "评估验证";
    case "align_evidence": return "证据对齐";
    case "parse_source": return "解析来源";
    default: return type;
  }
}
