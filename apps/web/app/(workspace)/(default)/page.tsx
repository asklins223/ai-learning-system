"use client";

import "@/app/styles/home.css";
import "@/app/styles/onboarding-guide.css";
import "@/app/styles/workspace-headers.css";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api, CardListItem, JobRow, ReviewWithCard, StatsOverview } from "@/lib/api";
import { useCurrentUser } from "@/lib/use-current-user";
import { relativeTime } from "@/lib/format";
import { Skeleton } from "@/components/ui/Skeleton";
import { Icon } from "@/components/ui/icons";
import { StatusChip } from "@/components/ui/StatusChip";
import { ThemeToggle } from "@/components/ui/ThemeToggle";
import { OnboardingGuide } from "@/components/study/OnboardingGuide";
import { statusMap } from "@/lib/status-map";
import { resolveHomeOnboardingVisibility } from "@/lib/home-onboarding";

type CaptureMessageType = "success" | "error";

export default function HomePage() {
  const { currentUser, loading: accountLoading } = useCurrentUser();
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
  const [reviews, setReviews] = useState<ReviewWithCard[] | null>(null);
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
    const [statsResult, notesResult, cardsResult, reviewsResult, jobsResult] =
      await Promise.allSettled([
        api.getStatsOverview(),
        api.listNotes({ limit: 1 }),
        api.listCards(),
        api.listReviews({ status: "pending" }),
        api.listJobs(),
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

    if (cardsResult.status === "fulfilled") {
      setCards(cardsResult.value.items);
      setHomeCardTotal(cardsResult.value.total);
      setCardsError(null);
    } else {
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
    if (!isOwner || !text) return;

    setCaptureBusy(true);
    setCaptureMsg(null);

    try {
      const isUrl = /^https?:\/\//.test(text);
      const isCode = /^(function|const|let|var|class|import|export|def |if __name__|#include|package |public class)/.test(text);
      const hasMarkdown = /^[#>*\-]/m.test(text);

      if (isUrl) {
        await api.createSource({ type: "url", title: text.slice(0, 60), url: text });
      } else {
        const type = isCode ? "code" : hasMarkdown ? "markdown" : "text";
        const title = text.split("\n")[0].slice(0, 60) || "快速捕获";
        await api.createSource({ type, title, content: text });
      }

      setCaptureMsg("材料已添加，正在解析…");
      setCaptureMsgType("success");
      setCaptureText("");

      void Promise.allSettled([api.listJobs(), api.getStatsOverview()]).then(
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
    } catch (caught: unknown) {
      setCaptureMsg(`创建失败：${caught instanceof Error ? caught.message : "未知错误"}`);
      setCaptureMsgType("error");
      window.requestAnimationFrame(() => {
        document.getElementById("home-capture-input")?.focus();
      });
    } finally {
      setCaptureBusy(false);
    }
  }, [captureText, isOwner]);

  const pendingReviews = reviews ?? [];
  const pendingReviewCount = homeReviewTotal ?? pendingReviews.length;
  const activeJobs = jobs?.filter((job) => job.status === "pending" || job.status === "running") ?? [];
  const recentCards = (cards ?? []).slice(0, 4);
  const primaryCard = (cards ?? []).find((card) => card.status === "active");

  const misunderstandingCount = stats?.misunderstandingCount ?? 0;
  const unclearCount = stats?.unclearCount ?? 0;
  const pendingEvidenceCount = stats?.pendingEvidenceCount ?? 0;
  const riskCount = stats
    ? misunderstandingCount + unclearCount + pendingEvidenceCount
    : null;

  const noteCountLabel = stats
    ? `${stats.noteCount}`
    : noteTotal !== null
      ? `${noteTotal}`
      : "—";
  const cardCountLabel = stats
    ? `${stats.cardCount}`
    : homeCardTotal !== null
      ? `${homeCardTotal}`
      : "—";
  const reviewCountLabel = homeReviewTotal !== null ? `${homeReviewTotal}` : "—";
  const noteCountAvailable = stats !== null || noteTotal !== null;
  const cardCountAvailable = stats !== null || homeCardTotal !== null;

  const focusLoading =
    (reviews === null && !reviewsError) ||
    (cards === null && !cardsError);
  const queueLoading =
    (reviews === null && !reviewsError) ||
    (jobs === null && !jobsError);

  const todayFocus = pendingReviewCount > 0
    ? {
        kind: "review" as const,
        eyebrow: "今日下一步 · 到期复习",
        title: pendingReviews[0]?.card.title ?? "完成一轮复习",
        summary: `今天有 ${pendingReviewCount} 条复习已经到期，先从最早的一条开始。`,
        meta: [
          { label: "到期复习", value: `${pendingReviewCount} 条` },
          { label: "优先级", value: "今天" },
        ],
        ctaLabel: "进入复习",
        ctaHref: "/review",
      }
    : primaryCard
      ? {
          kind: "continue" as const,
          eyebrow: "今日下一步 · 继续理解",
          title: primaryCard.schemaJson?.title ?? "未命名学习卡",
          summary: primaryCard.schemaJson?.summary ?? "回到这张学习卡，继续补充证据并验证理解。",
          meta: [
            ...((primaryCard.evidenceHardCount ?? 0) > 0
              ? [{ label: "硬证据", value: `${primaryCard.evidenceHardCount} 条` }]
              : []),
            ...((primaryCard.validationCount ?? 0) > 0
              ? [{ label: "验证", value: `${primaryCard.validationCount} 次` }]
              : []),
            { label: "创建", value: relativeTime(primaryCard.createdAt) },
          ],
          ctaLabel: "继续学习",
          ctaHref: `/cards/${primaryCard.id}`,
        }
      : null;

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
  const { isFirstUse, showOnboarding } = resolveHomeOnboardingVisibility({
    accountLoading,
    isPersonalWorkspace,
    isEmptyWorkspace,
  });

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
          <h1>{isFirstUse ? "建立你的第一条学习记录" : "今日学习"}</h1>
          <p className="learning-home-subtitle">
            {isFirstUse
              ? "先放入一份材料，笔记、学习卡与复习会从这里自然接上。"
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
        <section className="learning-home-overview" aria-labelledby="learning-home-overview-title">
          <div className="learning-home-overview-intro">
            <span className="learning-home-overview-kicker">今日概览</span>
            <h2 id="learning-home-overview-title">学习概览</h2>
            <p>今天的理解工作台</p>
          </div>

          <dl className="learning-home-facts">
            <div className="learning-home-fact">
              <span className="learning-home-fact-icon" aria-hidden="true"><Icon.Notepad /></span>
              <div>
                <dt>笔记</dt>
                <dd>{noteCountAvailable ? noteCountLabel : "—"}</dd>
                <span>{noteCountAvailable ? "已整理内容" : "暂不可用"}</span>
              </div>
            </div>
            <div className="learning-home-fact">
              <span className="learning-home-fact-icon" aria-hidden="true"><Icon.Card /></span>
              <div>
                <dt>学习卡</dt>
                <dd>{cardCountAvailable ? cardCountLabel : "—"}</dd>
                <span>{cardCountAvailable ? "可继续验证" : "暂不可用"}</span>
              </div>
            </div>
            <div className="learning-home-fact" data-tone={pendingReviewCount > 0 ? "warning" : "neutral"}>
              <span className="learning-home-fact-icon" aria-hidden="true"><Icon.Review /></span>
              <div>
                <dt>到期复习</dt>
                <dd>{reviewsError ? "—" : reviewCountLabel}</dd>
                <span>{reviewsError ? "暂不可用" : pendingReviewCount > 0 ? "需要优先处理" : "今天无到期"}</span>
              </div>
            </div>
            <div className="learning-home-fact" data-tone={riskCount && riskCount > 0 ? "danger" : "neutral"}>
              <span className="learning-home-fact-icon" aria-hidden="true"><Icon.Target /></span>
              <div>
                <dt>理解风险</dt>
                <dd>{statsError || riskCount === null ? "—" : riskCount}</dd>
                <span>{statsError ? "暂不可用" : riskCount ? "仍需补证或澄清" : "当前状态稳定"}</span>
              </div>
            </div>
          </dl>
        </section>
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
                  从这里开始
                </span>
                <h2 id="learning-home-starter-title">
                  从一份真正想弄懂的材料开始
                </h2>
                <p>
                  不用先整理格式。粘贴原文、Markdown、代码或网页链接，系统会先替你收好，再逐步整理成可验证的理解。
                </p>
                <div className="learning-home-starter-outcome">
                  <span aria-hidden="true"><Icon.Card /></span>
                  <div>
                    <strong>添加后会发生什么？</strong>
                    <p>材料进入解析队列，随后可在笔记中提炼重点并生成学习卡。</p>
                  </div>
                </div>
              </section>
            )}
            {showOnboarding && (
              <OnboardingGuide variant={isFirstUse ? "starter" : "default"} />
            )}
            {!isFirstUse && (focusLoading ? (
              <section className="learning-home-focus learning-home-focus--loading" aria-busy="true" aria-label="正在加载今日下一步">
                <div className="learning-home-focus-skeleton-label" />
                <div className="learning-home-focus-skeleton-title" />
                <Skeleton lines={3} />
                <div className="learning-home-focus-skeleton-button" />
              </section>
            ) : todayFocus ? (
              <section className="learning-home-focus" data-kind={todayFocus.kind} data-ui="primary-object">
                <span className="learning-home-focus-layer" aria-hidden="true" />
                <div className="learning-home-focus-topline">
                  <span className="learning-home-focus-tag">
                    {todayFocus.kind === "review" ? <Icon.Review /> : <Icon.Sparkle />}
                    {todayFocus.eyebrow}
                  </span>
                  <span className="learning-home-focus-index">今日重点</span>
                </div>

                <div className="learning-home-focus-body">
                  <div className="learning-home-focus-copy">
                    <p className="learning-home-focus-label">今天最值得推进的学习对象</p>
                    <h2>{todayFocus.title}</h2>
                    <p className="learning-home-focus-summary">{todayFocus.summary}</p>
                  </div>
                  <Link href={todayFocus.ctaHref} className="learning-home-focus-cta">
                    <span>{todayFocus.ctaLabel}</span>
                    <Icon.Arrow />
                  </Link>
                </div>

                <div className="learning-home-focus-footer">
                  <div className="learning-home-focus-meta">
                    {todayFocus.meta.slice(0, 3).map((item) => (
                      <span key={`${item.label}-${item.value}`}>
                        <small>{item.label}</small>
                        <strong>{item.value}</strong>
                      </span>
                    ))}
                  </div>
                  <div className="learning-home-route" aria-label="学习路径">
                    <span>材料</span><i aria-hidden="true" /><span>理解</span><i aria-hidden="true" /><span>验证</span>
                  </div>
                </div>
              </section>
            ) : (
              <section className="learning-home-focus learning-home-focus--empty" data-ui="primary-object">
                <div className="learning-home-focus-topline">
                  <span className="learning-home-focus-tag"><Icon.Sparkle />今天的学习桌面</span>
                  <span className="learning-home-focus-index">今日重点</span>
                </div>
                <div className="learning-home-focus-empty-copy">
                  <span className="learning-home-focus-empty-icon" aria-hidden="true"><Icon.Plus /></span>
                  <div>
                    <h2>桌面上还没有学习对象</h2>
                    <p>
                      {isOwner
                        ? "粘贴原文、Markdown、代码或链接，系统会把它整理成后续可验证的学习对象。"
                        : "你当前以成员身份浏览，可以先从工作区已有资料和学习记录开始。"}
                    </p>
                  </div>
                </div>
                {isOwner ? (
                  <button className="learning-home-focus-cta" type="button" onClick={openCapture}>
                    <span>打开快速捕获</span>
                    <Icon.Arrow />
                  </button>
                ) : (
                  <Link className="learning-home-focus-cta" href="/sources">
                    <span>浏览来源资料</span>
                    <Icon.Arrow />
                  </Link>
                )}
              </section>
            ))}
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
                          key={review.review.id}
                          href={`/review?review=${encodeURIComponent(review.review.id)}`}
                          className="learning-home-queue-item"
                          data-kind="review"
                          aria-label={`复习：${review.card.title}`}
                        >
                          <span className="learning-home-queue-item-icon" aria-hidden="true"><Icon.Review /></span>
                          <span className="learning-home-queue-item-copy">
                            <strong>{review.card.title}</strong>
                            <small>{reason.label}</small>
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

        {!isFirstUse && (
        <section className="learning-home-recent" aria-labelledby="learning-home-recent-title">
          <header className="learning-home-section-header">
            <div>
              <p>最近更新</p>
              <h2 id="learning-home-recent-title">最近学习卡</h2>
              <span>继续补充证据，或回到尚未说清楚的地方。</span>
            </div>
            <Link href="/cards" className="learning-home-section-link">
              查看全部
              <Icon.Arrow />
            </Link>
          </header>

          <div className="learning-home-recent-body">
            {cardsError ? (
              <div className="learning-home-recent-state" data-tone="error">
                <Icon.Warn />
                <span>学习卡加载失败</span>
                <button
                  type="button"
                  disabled={homeRefreshing}
                  aria-busy={homeRefreshing}
                  onClick={() => void loadHomeData()}
                >
                  {homeRefreshing ? "正在加载…" : "重新加载"}
                </button>
              </div>
            ) : cards === null ? (
              <div className="learning-home-card-grid" aria-busy="true">
                {[0, 1, 2, 3].map((item) => (
                  <div className="learning-home-card learning-home-card--loading" key={item}>
                    <Skeleton lines={4} />
                  </div>
                ))}
              </div>
            ) : recentCards.length === 0 ? (
              <div className="learning-home-recent-state">
                <Icon.Card />
                <span>还没有学习卡，先从笔记生成一张可验证的理解卡。</span>
                <Link href="/notes">去笔记</Link>
              </div>
            ) : (
              <div className="learning-home-card-grid">
                {recentCards.map((card, index) => {
                  const status = statusMap.cardStatus(card.status);
                  return (
                    <Link key={card.id} href={`/cards/${card.id}`} className="learning-home-card">
                      <span className="learning-home-card-layer" aria-hidden="true" />
                      <div className="learning-home-card-topline">
                        <span className="learning-home-card-index">{String(index + 1).padStart(2, "0")}</span>
                        <StatusChip tone={status.tone} size="sm">{status.label}</StatusChip>
                        <span className="learning-home-card-time">{relativeTime(card.createdAt)}</span>
                      </div>
                      <h3>{card.schemaJson?.title ?? "未命名学习卡"}</h3>
                      <p>{card.schemaJson?.summary ?? "这张学习卡还没有摘要，打开后继续整理核心理解。"}</p>
                      <div className="learning-home-card-footer">
                        <div className="learning-home-card-meta">
                          {(card.evidenceHardCount ?? 0) > 0 && <span>{card.evidenceHardCount} 条硬证据</span>}
                          {(card.validationCount ?? 0) > 0 && <span>{card.validationCount} 次验证</span>}
                          {card.reviewStatus === "pending" && <span data-tone="warning">已安排复习</span>}
                          {(card.evidenceHardCount ?? 0) === 0 && (card.validationCount ?? 0) === 0 && card.reviewStatus !== "pending" && <span>等待继续整理</span>}
                        </div>
                        <span className="learning-home-card-open" aria-hidden="true"><Icon.Arrow /></span>
                      </div>
                    </Link>
                  );
                })}
              </div>
            )}
          </div>
        </section>
        )}
      </div>
    </div>
  );
}

function jobLabel(type: string): string {
  switch (type) {
    case "generate_card": return "生成学习卡";
    case "evaluate_validation": return "评估验证";
    case "align_evidence": return "证据对齐";
    case "parse_source": return "解析来源";
    default: return type;
  }
}
