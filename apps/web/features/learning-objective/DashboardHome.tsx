/**
 * Plan 23 FE-07..FE-11：首页 Dashboard V2 视图。
 *
 * 一次请求 /v2/learning-dashboard 驱动整个首页主内容：
 *  - 学习概览计数（笔记/学习目标/进行中 Run/到期复习/需修复）
 *  - primary focus（服务端 Primary Action；标题 → 详情，CTA 执行 typed action）
 *  - queue（不重复 primary；状态与来源均来自 Surface）
 *  - recent objectives（同源）
 *  - degraded / notes_without_objectives / first_use 显式状态
 *
 * 不做任何 V1/V2 union merge；action 由 typed action 决定，禁止 label 推断。
 */
"use client";

import { useCallback, useEffect, useRef, useState, type JSX } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type {
  LearningDashboardV2,
  LearningObjectivePrimaryActionV3,
} from "@ailearn/shared";
import { learningObjectiveApi } from "@/lib/learning-objective-api";
import { ObjectiveStatusChip, type ObjectiveChipState } from "./ObjectiveStatusChip";
import { ObjectiveSourceLine } from "./ObjectiveSourceLine";
import { ObjectivePrimaryAction } from "./ObjectivePrimaryAction";
import { ObjectiveSkeleton, ObjectiveError, ObjectiveEmpty } from "./ObjectiveStatePrimitives";

function actionHref(action: LearningObjectivePrimaryActionV3, returnTo: string): string | null {
  switch (action.kind) {
    case "create_run": {
      const params = new URLSearchParams({
        origin: "card",
        cardId: action.cardId ?? action.objectiveId,
        keyPointId: action.objectiveId,
        goal: action.goal,
        returnTo,
      });
      return "/learning-runs/new?" + params.toString();
    }
    case "resume_run":
      return "/learning-runs/" + action.runId + "?returnTo=" + encodeURIComponent(returnTo);
    case "create_review_run": {
      const params = new URLSearchParams({
        origin: "review",
        scheduleId: action.scheduleId,
        keyPointId: action.objectiveId,
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

function chipStateFor(dashboard: LearningDashboardV2, objectiveId: string): ObjectiveChipState {
  const surface = dashboard.queue.find((q) => q.objective.objectiveId === objectiveId)?.objective
    ?? dashboard.recentObjectives.find((o) => o.objectiveId === objectiveId);
  const primary = dashboard.primaryFocus?.objective;
  const target = primary?.objectiveId === objectiveId ? primary : surface;
  if (!target) return "ready";
  if (target.personal.activeRun) return "run";
  if (target.personal.review?.status === "due") return "due";
  if (target.personal.review?.status === "scheduled") return "scheduled";
  if (target.content.freshness === "source_outdated") return "outdated";
  if (target.content.lifecycle === "archived") return "archived";
  return "ready";
}

export function DashboardHome(props: {
  isOwner: boolean;
  onOpenCapture: () => void;
  returnTo?: string;
}): JSX.Element {
  const router = useRouter();
  const returnTo = props.returnTo ?? "/";
  const [dashboard, setDashboard] = useState<LearningDashboardV2 | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const requestRef = useRef(0);

  const load = useCallback(async () => {
    const requestId = ++requestRef.current;
    setRefreshing(true);
    try {
      const data = await learningObjectiveApi.getDashboard();
      if (requestId !== requestRef.current) return;
      setDashboard(data);
      setError(null);
    } catch {
      if (requestId !== requestRef.current) return;
      setError("学习概览暂时不可用");
    } finally {
      if (requestId === requestRef.current) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load();
    return () => {
      requestRef.current += 1;
    };
  }, [load]);

  if (error && !dashboard) {
    return <ObjectiveError message={error} retryable onRetry={() => void load()} />;
  }
  if (!dashboard) {
    return <ObjectiveSkeleton rows={4} />;
  }

  const { counts, mode, primaryFocus, queue, recentObjectives, suggestedNote, degradation } = dashboard;

  if (mode === "first_use") {
    return (
      <ObjectiveEmpty
        message="从一份真正想弄懂的材料开始"
        hint={props.isOwner ? "先收起一份材料，系统会整理成后续可验证的学习对象。" : undefined}
      />
    );
  }

  const execute = (action: LearningObjectivePrimaryActionV3) => {
    if (action.kind === "refresh") {
      void load();
      return;
    }
    const href = actionHref(action, returnTo);
    if (href) router.push(href);
  };

  return (
    <div className="dashboard-home">
      {degradation && (
        <div className="dashboard-home-degraded" role="status">
          {degradation.unavailableSections.join("、") || "部分内容"}暂不可用
          {degradation.retryable ? "，可重试。" : "。"}
          <button type="button" onClick={() => void load()}>重试</button>
        </div>
      )}

      <section className="dashboard-home-overview" aria-labelledby="dashboard-home-overview-title">
        <div className="dashboard-home-overview-intro">
          <span className="dashboard-home-overview-kicker">今日概览</span>
          <h2 id="dashboard-home-overview-title">学习概览</h2>
          <p>今天的理解工作台</p>
        </div>
        <dl className="dashboard-home-facts">
          <div className="dashboard-home-fact">
            <dt>笔记</dt>
            <dd>{counts.notes}</dd>
            <span>已整理内容</span>
          </div>
          <div className="dashboard-home-fact">
            <dt>学习目标</dt>
            <dd>{counts.activeObjectives}</dd>
            <span>可继续验证</span>
          </div>
          <div className="dashboard-home-fact" data-tone={counts.activeRuns > 0 ? "run" : "neutral"}>
            <dt>进行中练习</dt>
            <dd>{counts.activeRuns}</dd>
            <span>{counts.activeRuns > 0 ? "需要继续" : "今天无进行中"}</span>
          </div>
          <div className="dashboard-home-fact" data-tone={counts.reviewsDue > 0 ? "warning" : "neutral"}>
            <dt>到期复习</dt>
            <dd>{counts.reviewsDue}</dd>
            <span>{counts.reviewsDue > 0 ? "需要优先处理" : "今天无到期"}</span>
          </div>
          <div className="dashboard-home-fact" data-tone={counts.needsRepair > 0 ? "danger" : "neutral"}>
            <dt>需修复来源</dt>
            <dd>{counts.needsRepair}</dd>
            <span>{counts.needsRepair > 0 ? "缺来源或待更新" : "来源完整"}</span>
          </div>
        </dl>
      </section>

      {mode === "notes_without_objectives" && suggestedNote && (
        <section className="dashboard-home-suggest" aria-label="从笔记开始">
          <div>
            <strong>还没有学习目标</strong>
            <span>「{suggestedNote.title}」可以生成第一张学习卡。</span>
          </div>
          <Link className="objective-primary-action" href={"/notes/" + suggestedNote.noteId}>
            去生成
          </Link>
        </section>
      )}

      {primaryFocus && (
        <section className="dashboard-home-focus" data-ui="primary-object" aria-labelledby="dashboard-home-focus-title">
          <div className="dashboard-home-focus-topline">
            <span className="dashboard-home-focus-tag">今日重点</span>
            <ObjectiveStatusChip state={chipStateFor(dashboard, primaryFocus.objective.objectiveId)} />
          </div>
          <div className="dashboard-home-focus-body">
            <div className="dashboard-home-focus-copy">
              <h2 id="dashboard-home-focus-title">
                <Link href={objectiveDetailHref(primaryFocus.objective)}>
                  {primaryFocus.objective.content.conceptLabel ?? primaryFocus.objective.content.publicSummary.slice(0, 40)}
                </Link>
              </h2>
              <p>{primaryFocus.objective.content.publicSummary}</p>
            </div>
            <ObjectivePrimaryAction
              action={primaryFocus.action}
              onExecute={execute}
              disabled={refreshing}
            />
          </div>
          <div className="dashboard-home-focus-footer">
            <ObjectiveSourceLine
              noteTitle={primaryFocus.objective.sources.primaryNote?.title ?? null}
              freshness={primaryFocus.objective.content.freshness}
              onClickNote={
                primaryFocus.objective.sources.primaryNote
                  ? () => router.push("/notes/" + primaryFocus.objective.sources.primaryNote!.noteId)
                  : undefined
              }
            />
            <span className="dashboard-home-focus-reason">{primaryFocus.reasonCodes.join(" · ")}</span>
          </div>
        </section>
      )}

      {queue.length > 0 && (
        <section className="dashboard-home-queue" aria-labelledby="dashboard-home-queue-title">
          <header>
            <h3 id="dashboard-home-queue-title">接下来</h3>
          </header>
          <ul>
            {queue.map((entry) => (
              <li key={entry.objective.objectiveId} className="dashboard-home-queue-item">
                <div>
                  <Link href={objectiveDetailHref(entry.objective)}>
                    {entry.objective.content.conceptLabel ?? entry.objective.content.publicSummary.slice(0, 40)}
                  </Link>
                  <ObjectiveSourceLine
                    noteTitle={entry.objective.sources.primaryNote?.title ?? null}
                    freshness={entry.objective.content.freshness}
                  />
                </div>
                <ObjectivePrimaryAction action={entry.action} onExecute={execute} />
              </li>
            ))}
          </ul>
        </section>
      )}

      {recentObjectives.length > 0 && (
        <section className="dashboard-home-recent" aria-labelledby="dashboard-home-recent-title">
          <header className="dashboard-home-section-header">
            <div>
              <h3 id="dashboard-home-recent-title">最近目标</h3>
              <span>继续补充证据，或回到尚未说清楚的地方。</span>
            </div>
            <Link href="/cards" className="dashboard-home-section-link">查看全部</Link>
          </header>
          <div className="dashboard-home-card-grid">
            {recentObjectives.map((objective) => (
              <Link key={objective.objectiveId} href={objectiveDetailHref(objective)} className="dashboard-home-card">
                <div className="dashboard-home-card-topline">
                  <ObjectiveStatusChip state={chipStateFor(dashboard, objective.objectiveId)} />
                </div>
                <h4>{objective.content.conceptLabel ?? objective.content.publicSummary.slice(0, 40)}</h4>
                <p>{objective.content.publicSummary.slice(0, 80)}</p>
                <ObjectiveSourceLine
                  noteTitle={objective.sources.primaryNote?.title ?? null}
                  freshness={objective.content.freshness}
                />
              </Link>
            ))}
          </div>
        </section>
      )}

      {!primaryFocus && queue.length === 0 && counts.activeObjectives === 0 && props.isOwner && (
        <div className="dashboard-home-empty-actions">
          <button type="button" className="objective-primary-action" onClick={props.onOpenCapture}>
            打开快速捕获
          </button>
        </div>
      )}
    </div>
  );
}

function objectiveDetailHref(objective: {
  content: { presentation: { cardId: string | null } };
}): string {
  return objective.content.presentation.cardId
    ? "/learning-cards/" + objective.content.presentation.cardId
    : "/cards";
}
