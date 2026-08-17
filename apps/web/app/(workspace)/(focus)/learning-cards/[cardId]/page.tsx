/**
 * Plan 23 FE-19..FE-26：学习目标详情（Objective 档案页）。
 *
 * - controller：cardId → route resolution → objectiveId → Surface（FE-19）；
 * - 概览只读呈现 concept/summary/state，没有伪输入区（FE-20）；
 * - 来源与证据面板：多来源/missing/outdated 独立状态（FE-21）；
 * - 个人状态区来自 typed projection（FE-22）；历史时间线（FE-23）；
 * - Reveal exposure-first：答案只在成功后进入 DOM；409 清空并要求刷新（FE-24）；
 * - lifecycle 工具按权限裁剪（FE-25）；生产详情无答题 renderer（FE-26，
 *   不渲染 ActiveLearningCardV2 / 不承载输入）。
 */
"use client";

import "@/app/styles/card-detail.css";
import "@/app/styles/objective-system.css";
import "@/app/styles/objective-detail.css";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type JSX } from "react";
import { ThemeToggle } from "@/components/ui/ThemeToggle";
import type {
  LearningObjectiveSurfaceV3,
  LearningObjectivePrimaryActionV3,
} from "@ailearn/shared";
import { learningObjectiveApi, type ObjectiveHistoryPage } from "@/lib/learning-objective-api";
import { ObjectiveStatusChip, type ObjectiveChipState } from "@/features/learning-objective/ObjectiveStatusChip";
import { ObjectiveSourceLine } from "@/features/learning-objective/ObjectiveSourceLine";
import { ObjectivePrimaryAction } from "@/features/learning-objective/ObjectivePrimaryAction";
import { ObjectiveSkeleton, ObjectiveError } from "@/features/learning-objective/ObjectiveStatePrimitives";

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready" };

function chipStateOf(surface: LearningObjectiveSurfaceV3): ObjectiveChipState {
  if (surface.content.lifecycle === "archived") return "archived";
  if (surface.personal.activeRun) return "run";
  if (surface.personal.review?.status === "due") return "due";
  if (surface.personal.review?.status === "scheduled") return "scheduled";
  if (surface.content.freshness === "source_outdated") return "outdated";
  return "ready";
}

function actionHref(action: LearningObjectivePrimaryActionV3, returnTo: string): string | null {
  switch (action.kind) {
    case "create_run": {
      const params = new URLSearchParams({
        origin: "card_v2",
        cardId: action.cardId ?? action.objectiveId,
        objectiveId: action.objectiveId,
        goal: action.goal,
        returnTo,
      });
      return "/learning-runs/new?" + params.toString();
    }
    case "resume_run":
      return "/learning-runs/" + action.runId + "?returnTo=" + encodeURIComponent(returnTo);
    case "create_review_run": {
      const params = new URLSearchParams({
        origin: "review_v2",
        scheduleId: action.scheduleId,
        objectiveId: action.objectiveId,
        generation: String(action.generation),
        returnTo,
      });
      return "/learning-runs/new?" + params.toString();
    }
    case "practice_only":
      return "/learning-cards/" + (action.cardId ?? action.objectiveId) + "?practice=1";
    case "view_successor":
      return "/learning-cards/" + action.successorCardId;
    case "wait_for_initial_validation":
    case "refresh":
    case "none":
      return null;
  }
}

export default function LearningObjectiveDetailPage(): JSX.Element {
  const params = useParams<{ cardId: string }>();
  const router = useRouter();
  const cardId = params.cardId;
  const [load, setLoad] = useState<LoadState>({ status: "loading" });
  const [surface, setSurface] = useState<LearningObjectiveSurfaceV3 | null>(null);
  const [history, setHistory] = useState<ObjectiveHistoryPage | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [noticeTone, setNoticeTone] = useState<"info" | "error">("info");
  const [busy, setBusy] = useState(false);
  const [revealOpen, setRevealOpen] = useState(false);
  const [revealContent, setRevealContent] = useState<{
    explanation: string;
    boundary?: string;
    misconception?: string;
  } | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewPrompt, setPreviewPrompt] = useState<string | null>(null);
  const [revealParams, setRevealParams] = useState<{
    publicationRevision: number;
    publicPayloadHash: string;
  } | null>(null);
  const cancelledRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    cancelledRef.current = false;
    async function boot() {
      try {
        // FE-19：cardId → objectiveId（V2 card 与 legacy 均可确定性解析）
        const resolution = await learningObjectiveApi.resolveLegacyRoute("card", cardId);
        if (resolution.status !== "mapped" || !resolution.objectiveId) {
          if (cancelled) return;
          setLoad({
            status: "error",
            message:
              resolution.status === "forbidden"
                ? "这是一个隐藏的兼容引用，请从学习目标库进入。"
                : resolution.status === "ambiguous"
                  ? "这张旧卡包含多个学习目标，请从学习目标库选择。"
                  : "目标不存在或已迁移，请从学习目标库重新进入。",
          });
          return;
        }
        const [surfaceData, historyData] = await Promise.all([
          learningObjectiveApi.getObjective(resolution.objectiveId),
          learningObjectiveApi.getObjectiveHistory(resolution.objectiveId, { limit: 20 }),
        ]);
        // 公开呈现（供 Reveal 参数与折叠练习预览；不承载作答）
        const mod = await import("@/features/card-generation-v2/api-client");
        const client = mod.createV2Client();
        let revealParamsNext: { publicationRevision: number; publicPayloadHash: string } | null = null;
        let previewPromptNext: string | null = null;
        if (surfaceData.content.presentation.cardId) {
          try {
            const pub = await client.readPublicCard(surfaceData.content.presentation.cardId);
            revealParamsNext = {
              publicationRevision: pub.publicationRevision,
              publicPayloadHash: pub.publicPayloadHash,
            };
            previewPromptNext = pub.front.prompt ?? null;
          } catch {
            // 呈现读取失败不阻塞档案页
          }
        }
        if (cancelled) return;
        setSurface(surfaceData);
        setHistory(historyData);
        setRevealParams(revealParamsNext);
        setPreviewPrompt(previewPromptNext);
        setLoad({ status: "ready" });
      } catch (error) {
        if (cancelled) return;
        setLoad({
          status: "error",
          message: error instanceof Error ? error.message : "学习目标加载失败。",
        });
      }
    }
    void boot();
    return () => {
      cancelled = true;
      cancelledRef.current = true;
    };
  }, [cardId]);

  const onReveal = useCallback(async () => {
    if (!surface || !revealParams) return;
    const mod = await import("@/features/card-generation-v2/api-client");
    const client = mod.createV2Client();
    setBusy(true);
    setNotice(null);
    try {
      const cardId = surface.content.presentation.cardId ?? surface.objectiveId;
      const reveal = await client.revealCardV2(
        {
          cardId,
          expectedPublicationRevision: revealParams.publicationRevision,
          expectedPublicPayloadHash: revealParams.publicPayloadHash,
        },
        "reveal-" + cardId + "-" + Date.now(),
      );
      // FE-24：答案只在成功后才进入 DOM
      setRevealContent({
        explanation: reveal.reveal.explanation,
        boundary: reveal.reveal.boundary,
        misconception: reveal.reveal.misconception,
      });
      setRevealOpen(true);
      setNoticeTone("info");
      setNotice("已记录查看参考内容；正式练习会根据当前状态选择题型。");
    } catch (error) {
      // 409 / revision mismatch：迟到响应拒绝，清空旧 payload 并要求刷新
      setRevealContent(null);
      setRevealOpen(false);
      setNoticeTone("error");
      setNotice(error instanceof Error ? error.message : "参考内容暂时无法打开，请刷新后重试。");
    } finally {
      setBusy(false);
    }
  }, [surface, revealParams]);

  const onArchive = useCallback(async () => {
    if (!surface || !revealParams) return;
    const mod = await import("@/features/card-generation-v2/api-client");
    const client = mod.createV2Client();
    setBusy(true);
    setNotice(null);
    try {
      const cardId = surface.content.presentation.cardId;
      if (!cardId) {
        setNoticeTone("error");
        setNotice("没有可归档的公开呈现。");
        return;
      }
      await client.archiveCardV2(
        {
          cardId,
          expectedPublicationRevision: revealParams.publicationRevision,
          expectedPublicPayloadHash: revealParams.publicPayloadHash,
          expectedObjectiveLifecycleEpoch: 1,
        },
        "archive-" + cardId + "-" + Date.now(),
      );
      setNoticeTone("info");
      setNotice("已归档。");
      window.location.reload();
    } catch (error) {
      setNoticeTone("error");
      setNotice(error instanceof Error ? error.message : "归档失败。");
    } finally {
      setBusy(false);
    }
  }, [surface, revealParams]);

  const execute = (action: LearningObjectivePrimaryActionV3) => {
    if (action.kind === "refresh") {
      window.location.reload();
      return;
    }
    const href = actionHref(action, "/learning-cards/" + cardId);
    if (href) router.push(href);
  };

  if (load.status === "loading") {
    return (
      <div className="objective-detail-page">
        <ObjectiveSkeleton rows={6} />
      </div>
    );
  }
  if (load.status === "error" || !surface) {
    return (
      <div className="objective-detail-page">
        <ObjectiveError message={load.status === "error" ? load.message : "加载失败"} retryable onRetry={() => window.location.reload()} />
      </div>
    );
  }

  const primaryNote = surface.sources.primaryNote;

  return (
    <div className="objective-detail-page">
      <div className="objective-detail-topbar">
        <Link href="/cards" className="objective-detail-back">← 返回学习目标库</Link>
        <ThemeToggle className="objective-detail-theme" />
      </div>

      <header className="objective-detail-header objective-surface">
        <div className="objective-detail-header-topline">
          <ObjectiveStatusChip state={chipStateOf(surface)} />
          <span className="objective-detail-form">{surface.content.knowledgeForm}</span>
          <span className="objective-detail-freshness">
            {surface.content.freshness === "source_outdated"
              ? "来源待更新"
              : surface.content.freshness === "legacy_unreviewed"
                ? "来源未核验"
                : "来源已核验"}
          </span>
        </div>
        <h1>{surface.content.conceptLabel ?? surface.content.publicSummary.slice(0, 40)}</h1>
        <p className="objective-detail-summary">{surface.content.publicSummary}</p>
        <div className="objective-detail-action">
          <ObjectivePrimaryAction action={surface.primaryAction} onExecute={execute} disabled={busy} />
        </div>
      </header>

      {notice && (
        <div className="objective-detail-notice" data-tone={noticeTone} role="status" aria-live="polite">
          {notice}
        </div>
      )}

      <div className="objective-detail-columns">
        <section className="objective-detail-panel objective-surface" aria-labelledby="objective-source-title">
          <h2 id="objective-source-title">来源与证据</h2>
          {surface.sources.origins.length === 0 ? (
            <div className="objective-detail-panel-empty">
              暂无来源记录
              {surface.sources.missingOrigin && <span>（该目标缺少可证明的笔记来源）</span>}
            </div>
          ) : (
            <ul className="objective-detail-origins">
              {surface.sources.origins.map((origin) => (
                <li key={origin.originId}>
                  <span className="objective-detail-origin-kind">{origin.kind}</span>
                  <span>{origin.integrity === "legacy_unreviewed" ? "来源未核验" : "已核验"}</span>
                  {origin.kind === "note" && origin.noteId && (
                    <Link href={"/notes/" + origin.noteId}>打开笔记</Link>
                  )}
                </li>
              ))}
            </ul>
          )}
          <ObjectiveSourceLine
            noteTitle={primaryNote?.title ?? null}
            freshness={surface.content.freshness}
            onClickNote={primaryNote ? () => router.push("/notes/" + primaryNote.noteId) : undefined}
          />
          {surface.content.freshness === "source_outdated" && (
            <p className="objective-detail-outdated-hint">
              来源笔记已发布新版本；原血缘仍保留，可查看差异后重新生成。
            </p>
          )}
        </section>

        <section className="objective-detail-panel objective-surface" aria-labelledby="objective-state-title">
          <h2 id="objective-state-title">个人学习状态</h2>
          <dl className="objective-detail-state">
            <div>
              <dt>首次验证</dt>
              <dd>
                {surface.personal.initialValidation
                  ? surface.personal.initialValidation.status === "ready"
                    ? "可以开始"
                    : surface.personal.initialValidation.status === "deferred"
                      ? "已安排（稍后）"
                      : "已完成"
                  : "未安排"}
              </dd>
            </div>
            <div>
              <dt>进行中练习</dt>
              <dd>
                {surface.personal.activeRun
                  ? "进行中（" + surface.personal.activeRun.phase + "）"
                  : "无"}
              </dd>
            </div>
            <div>
              <dt>复习</dt>
              <dd>
                {surface.personal.review
                  ? surface.personal.review.status === "due"
                    ? "已到期"
                    : "已安排"
                  : "无"}
              </dd>
            </div>
            <div>
              <dt>练习轨迹</dt>
              <dd>{surface.personal.practiceTrailCount} 次</dd>
            </div>
          </dl>
        </section>
      </div>

      <section className="objective-detail-panel objective-surface" aria-labelledby="objective-history-title">
        <h2 id="objective-history-title">目标历史</h2>
        {!history || history.items.length === 0 ? (
          <div className="objective-detail-panel-empty">暂无历史记录</div>
        ) : (
          <ol className="objective-detail-history">
            {history.items.map((item) => (
              <li key={item.objectiveRevisionId}>
                <span className="objective-detail-history-rev">v{item.revision}</span>
                <span>{item.revisionClass}</span>
                <span className="objective-detail-history-summary">{item.publicSummary.slice(0, 60)}</span>
              </li>
            ))}
          </ol>
        )}
      </section>

      <section className="objective-detail-panel objective-surface" aria-labelledby="objective-preview-title">
        <h2 id="objective-preview-title">练习预览</h2>
        <p className="objective-detail-preview-note">
          建议练习方式：开放回忆 / 情境应用 · 预计用时 1–3 分钟。
          正式练习会根据当前状态选择题型，实际任务可能不同。
        </p>
        {previewPrompt && (
          <button
            type="button"
            className="objective-secondary-action"
            aria-expanded={previewOpen}
            onClick={() => setPreviewOpen(!previewOpen)}
          >
            {previewOpen ? "收起练习预览" : "展开练习预览"}
          </button>
        )}
        {previewOpen && previewPrompt && (
          <blockquote className="objective-detail-preview">{previewPrompt}</blockquote>
        )}
      </section>

      <section className="objective-detail-panel objective-surface" aria-labelledby="objective-reveal-title">
        <h2 id="objective-reveal-title">参考内容</h2>
        <p className="objective-detail-reveal-note">
          查看参考内容会先记录一次阅读行为，不会替代正式练习。
        </p>
        <button
          type="button"
          className="objective-secondary-action"
          onClick={() => void onReveal()}
          disabled={busy || !revealParams}
        >
          {busy ? "正在记录…" : "查看参考内容"}
        </button>
        {revealOpen && revealContent && (
          <div className="objective-detail-reveal" aria-live="polite">
            <p>{revealContent.explanation}</p>
            {revealContent.boundary && <p><strong>适用边界：</strong>{revealContent.boundary}</p>}
            {revealContent.misconception && <p><strong>常见误区：</strong>{revealContent.misconception}</p>}
          </div>
        )}
      </section>

      <section className="objective-detail-panel objective-surface" aria-labelledby="objective-tools-title">
        <h2 id="objective-tools-title">管理</h2>
        <div className="objective-detail-tools">
          <button type="button" className="objective-secondary-action" disabled>
            编辑公开呈现
          </button>
          <button
            type="button"
            className="objective-secondary-action"
            onClick={() => void onArchive()}
            disabled={busy || surface.content.lifecycle !== "active" || !surface.content.presentation.cardId}
          >
            归档
          </button>
          {surface.content.lifecycle === "superseded" && surface.lifecycle.successorObjectiveId && (
            <Link
              className="objective-primary-action"
              href={actionHref(surface.primaryAction, "/cards") ?? "/cards"}
            >
              查看新版目标
            </Link>
          )}
        </div>
      </section>
    </div>
  );
}