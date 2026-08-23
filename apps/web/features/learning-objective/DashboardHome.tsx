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
import { ObjectiveStatusChip } from "./ObjectiveStatusChip";
import { objectiveChipStateFromSurface } from "./objective-state";
import { ObjectiveSourceLine } from "./ObjectiveSourceLine";
import { ObjectivePrimaryAction } from "./ObjectivePrimaryAction";
import { objectiveActionHref } from "./action-navigation";
import { ObjectiveSkeleton, ObjectiveError, ObjectiveEmpty } from "./ObjectiveStatePrimitives";
import {
  objectiveDisplayTitle,
  objectiveDistinctSummary,
  reasonCodeLabels,
} from "./labels";

function chipStateFor(dashboard: LearningDashboardV2, objectiveId: string): ReturnType<typeof objectiveChipStateFromSurface> {
  const surface = dashboard.queue.find((q) => q.objective.objectiveId === objectiveId)?.objective
    ?? dashboard.recentObjectives.find((o) => o.objectiveId === objectiveId);
  const primary = dashboard.primaryFocus?.objective;
  const target = primary?.objectiveId === objectiveId ? primary : surface;
  if (!target) return "ready";
  return objectiveChipStateFromSurface(target);
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

  // §9.3 empty_after_filter：所有 Objective 已归档或不可用。
  // 不是 first_use（有 Note 或历史 Objective），但当前无任何可行动目标。
  if (mode === "empty_after_filter") {
    return (
      <ObjectiveEmpty
        message="当前没有可继续的学习目标"
        hint="所有目标可能已归档或等待来源更新。可在学习目标库查看归档目标，或从笔记重新生成。"
      />
    );
  }

  const execute = (action: LearningObjectivePrimaryActionV3) => {
    if (action.kind === "refresh") {
      void load();
      return;
    }
    const href = objectiveActionHref(action, returnTo);
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
                  {objectiveDisplayTitle(primaryFocus.objective.content)}
                </Link>
              </h2>
              {/* conceptLabel 为空时标题即 publicSummary，同句不重复展示 */}
              {(() => {
                const summary = objectiveDistinctSummary(primaryFocus.objective.content);
                return summary ? <p>{summary}</p> : null;
              })()}
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
            <span className="dashboard-home-focus-reason">{reasonCodeLabels(primaryFocus.reasonCodes)}</span>
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
                    {objectiveDisplayTitle(entry.objective.content)}
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
            {recentObjectives.map((objective) => {
              const summary = objectiveDistinctSummary(objective.content, 80);
              return (
                <Link key={objective.objectiveId} href={objectiveDetailHref(objective)} className="dashboard-home-card">
                  <div className="dashboard-home-card-topline">
                    <ObjectiveStatusChip state={chipStateFor(dashboard, objective.objectiveId)} />
                  </div>
                  <h4>{objectiveDisplayTitle(objective.content)}</h4>
                  {summary && <p>{summary}</p>}
                  <ObjectiveSourceLine
                    noteTitle={objective.sources.primaryNote?.title ?? null}
                    freshness={objective.content.freshness}
                  />
                </Link>
              );
            })}
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
  objectiveId: string;
  content: { presentation: { cardId: string | null } };
}): string {
  // 优先使用 cardId（如果有 active Card），否则用 objectiveId（route resolution 同样可解析）。
  // 不再在 cardId 为 null 时 fallback 到 /cards（用户应能进入详情页查看 missing origin 等）。
  const id = objective.content.presentation.cardId ?? objective.objectiveId;
  return "/learning-cards/" + id;
}
