"use client";

/**
 * Agent 执行记录时间线（设计稿"暖纸编辑主题"）。
 *
 * 按 Supervisor 轮次流式分组（子代理事件归入委派它的那一轮并缩进），
 * 每组展示阶段标签 + 事件卡片（状态图标 + 角色 tag + 动作文案 + 时间）。
 * 行文案来自 agentEventRowText 映射（§3.1 红线，不渲染模型原文）。
 *
 * 自动跟踪最新进度：
 * - 新事件到达时自动滚动到底部（仅当用户在底部 / 处于跟踪态）。
 * - 用户向上滚动 → 取消跟踪，不再被拉回底部。
 * - 用户停留 10 秒未操作 → 恢复跟踪并回到最新。
 *
 * 可访问性：容器 `role="log"` + `aria-live="polite"`。
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentEventView } from "@/lib/api";
import { agentEventRowText } from "./agent-event-text";
import type { AgentEventRowStatus } from "./agent-event-text";
import { AGENT_EVENT_MAX_BUFFER } from "./useGenerationActivity";

/** 距底 < 此值视为"已到底部"。 */
const NEAR_BOTTOM_PX = 28;
/** 用户滚离底部后，无操作多久恢复自动跟踪（毫秒）。 */
const RESUME_TRACKING_MS = 10_000;

function formatEventTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/** 轮次标签 */
function turnLabel(turn: number | null): string {
  if (turn == null) return "执行流水";
  if (turn === 0) return "准备阶段";
  return `第 ${turn} 轮`;
}

/**
 * 按 Supervisor 轮次流式分组。
 * 子代理（agentRole ≠ generation_supervisor）也有自己的 turnNo，
 * 若按 turnNo 分组会与 Supervisor 轮次冲突。以 Supervisor 的
 * 动作事件驱动轮次边界：
 * - 新轮次：Supervisor 的 tool_request/tool_result 且 turnNo 变化，
 *   或上一轮已以 turn_completed 收尾。
 * - 委派出的子代理事件（turn_completed 之后）归入委派它的那一轮
 *   （缩进展示，is-child），直到下一个 Supervisor 动作开启新轮。
 * 这样每组轮次唯一，不会产生重复 turn 分组（避免 React 重复 key）。
 */
function groupBySupervisorTurn(events: AgentEventView[]): Array<{ turn: number | null; events: AgentEventView[] }> {
  const groups: Array<{ turn: number | null; events: AgentEventView[] }> = [];
  let current: { turn: number | null; events: AgentEventView[]; turnClosed: boolean } | null = null;

  const isSupervisor = (event: AgentEventView): boolean =>
    event.agentRole === "generation_supervisor"
    || (event.agentRole == null && event.turnNo === 0);

  for (const event of events) {
    if (isSupervisor(event) && event.eventType !== "turn_completed") {
      // Supervisor 的动作事件：轮次推进或上一轮已收尾 → 开新组。
      if (current && current.turn === event.turnNo && !current.turnClosed) {
        current.events.push(event);
      } else {
        current = { turn: event.turnNo ?? null, events: [event], turnClosed: false };
        groups.push(current);
      }
      continue;
    }

    // turn_completed（prepare / supervisor）与子代理事件归入当前组；
    // supervisor turn_completed 之后委派的子代理事件留在本组（缩进），
    // 直到下一个 Supervisor 动作开启新轮。
    if (!current) {
      current = { turn: event.turnNo ?? 0, events: [], turnClosed: false };
      groups.push(current);
    }
    current.events.push(event);
    if (event.eventType === "turn_completed") {
      current.turnClosed = true;
    }
  }

  return groups;
}

/** 圆形状态徽标：实色圆 + 白色图形（不只靠色，§6.4）。 */
function StatusGlyph({ status }: { status: string }) {
  const stroke = {
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round",
    strokeLinejoin: "round",
  } as const;

  switch (status) {
    case "success":
      return (
        <span className="gen-status-badge is-success" aria-hidden="true">
          <svg viewBox="0 0 16 16" width="11" height="11" {...stroke}>
            <path d="M4 8.5l3 3L12 4.5" />
          </svg>
        </span>
      );
    case "failed":
      return (
        <span className="gen-status-badge is-failed" aria-hidden="true">
          <svg viewBox="0 0 16 16" width="10" height="10" {...stroke}>
            <path d="M5.5 5.5l5 5M10.5 5.5l-5 5" />
          </svg>
        </span>
      );
    case "warning":
      return (
        <span className="gen-status-badge is-warning" aria-hidden="true">
          <svg viewBox="0 0 16 16" width="10" height="10" {...stroke}>
            <path d="M8 4v5.4" />
            <circle cx="8" cy="12" r=".9" fill="currentColor" stroke="none" />
          </svg>
        </span>
      );
    case "running":
      return (
        <span className="gen-status-badge is-running" aria-hidden="true">
          <svg viewBox="0 0 16 16" width="12" height="12" {...stroke}>
            <circle cx="8" cy="8" r="5.5" opacity=".3" />
            <path d="M13.5 8A5.5 5.5 0 0 0 8 2.5" />
          </svg>
        </span>
      );
    default:
      // muted：软灰圆 + 小圆点
      return (
        <span className="gen-status-badge is-muted" aria-hidden="true">
          <span className="gen-status-badge-dot" />
        </span>
      );
  }
}

/**
 * 行状态展示：
 * - 最新一行始终代表"当前正在进行的任务"，显示为转圈（running）；
 *   失败/警告保留原状，不掩盖问题。
 * - 非最新的 running 事件视为已完成（打勾 success）。
 */
export function rowDisplayStatus(status: AgentEventRowStatus, isLatest: boolean): AgentEventRowStatus {
  if (isLatest) {
    return (status === "failed" || status === "warning") ? status : "running";
  }
  return status === "running" ? "success" : status;
}

export function AgentStreamRow({ event, isLatest = false }: { event: AgentEventView; isLatest?: boolean }) {
  const view = agentEventRowText(event);
  const isChild = !!event.agentRole && event.agentRole !== "generation_supervisor";
  const displayStatus = rowDisplayStatus(view.status, isLatest);

  return (
    <li
      className={`gen-timeline-event is-${displayStatus}${isChild ? " is-child" : ""}`}
      data-status={displayStatus}
      data-role={event.agentRole ?? undefined}
    >
      <span className="gen-timeline-event-icon">
        <StatusGlyph status={displayStatus} />
      </span>
      <div className="gen-timeline-event-main">
        <div className="gen-timeline-event-line">
          {view.roleLabel && (
            <span className="gen-timeline-agent-tag">{view.roleLabel}</span>
          )}
          <span className="gen-timeline-event-text">{view.text}</span>
        </div>
        {isChild && (
          <p className="gen-timeline-event-detail">子代理执行</p>
        )}
      </div>
      <time className="gen-timeline-event-time" dateTime={event.createdAt}>
        {formatEventTime(event.createdAt)}
      </time>
    </li>
  );
}

export interface AgentStreamListProps {
  events: AgentEventView[];
  loading: boolean;
  error: string | null;
  /** 初始是否展开。弹窗内默认展开（true）。 */
  initiallyExpanded?: boolean;
}

export const AgentStreamList = memo(function AgentStreamList({ events, loading, error, initiallyExpanded = false }: AgentStreamListProps) {
  const [expanded, setExpanded] = useState(initiallyExpanded);
  // 滚动容器 ref（三种渲染分支共用一个 ref，换元素时自动重新绑定监听）。
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const scrollHandlerRef = useRef<((event: Event) => void) | null>(null);
  // 是否自动跟踪最新（用户滚离底部后置 false）
  const [tracking, setTracking] = useState(true);
  const trackingRef = useRef(true);
  trackingRef.current = tracking;
  const resumeTimerRef = useRef<number | null>(null);
  const lastEventCountRef = useRef(events.length);

  const scrollToBottom = useCallback(() => {
    const el = wrapRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  const clearResumeTimer = useCallback(() => {
    if (resumeTimerRef.current != null) {
      window.clearTimeout(resumeTimerRef.current);
      resumeTimerRef.current = null;
    }
  }, []);

  // 用 callback ref 绑定滚动容器：元素挂载/切换/卸载时都重新挂/解绑监听。
  const setWrapRef = useCallback((el: HTMLDivElement | null) => {
    if (wrapRef.current && scrollHandlerRef.current) {
      wrapRef.current.removeEventListener("scroll", scrollHandlerRef.current);
    }
    wrapRef.current = el;
    if (!el) {
      scrollHandlerRef.current = null;
      clearResumeTimer();
      return;
    }
    const onScroll = () => {
      const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
      if (nearBottom) {
        // 用户回到底部 → 立即恢复跟踪。
        clearResumeTimer();
        if (!trackingRef.current) {
          trackingRef.current = true;
          setTracking(true);
        }
        return;
      }
      // 用户滚离底部：取消跟踪；10 秒无操作后恢复跟踪并回到最新。
      if (trackingRef.current) {
        trackingRef.current = false;
        setTracking(false);
      }
      clearResumeTimer();
      resumeTimerRef.current = window.setTimeout(() => {
        trackingRef.current = true;
        setTracking(true);
        scrollToBottom();
      }, RESUME_TRACKING_MS);
    };
    scrollHandlerRef.current = onScroll;
    el.addEventListener("scroll", onScroll, { passive: true });
  }, [clearResumeTimer, scrollToBottom]);

  // 展开时先落到底部（初始/重新展开都适用）。
  useEffect(() => {
    if (expanded) scrollToBottom();
  }, [expanded, scrollToBottom]);

  // 新事件到达：仅当处于跟踪态才滚到底部。
  useEffect(() => {
    if (!expanded || !tracking) return;
    if (events.length === lastEventCountRef.current) return;
    lastEventCountRef.current = events.length;
    scrollToBottom();
  }, [events.length, expanded, tracking, scrollToBottom]);

  const groups = useMemo(() => groupBySupervisorTurn(events), [events]);
  const latest = events.at(-1);
  const truncated = events.length >= AGENT_EVENT_MAX_BUFFER;

  if (events.length === 0) {
    return (
      <div className="gen-timeline-wrap" ref={setWrapRef}>
        <p className="gen-timeline-empty" role="status">
          {loading
            ? "正在连接代理执行流…"
            : error ?? "等待代理执行…（生成开始后会实时出现执行路径）"}
        </p>
      </div>
    );
  }

  if (!expanded) {
    const latestView = latest ? agentEventRowText(latest) : null;
    return (
      <div className="gen-timeline-wrap" ref={setWrapRef}>
        <button
          type="button"
          className="gen-timeline-summary"
          aria-expanded="false"
          aria-controls="gen-timeline-log"
          onClick={() => setExpanded(true)}
        >
          {latestView && (
            <span className="gen-timeline-summary-row">
              {latestView.roleLabel && (
                <span className="gen-timeline-agent-tag">{latestView.roleLabel}</span>
              )}
              <span className="gen-timeline-event-text">{latestView.text}</span>
            </span>
          )}
          <span className="gen-timeline-summary-action">展开执行记录</span>
        </button>
      </div>
    );
  }

  return (
    <div className="gen-timeline-wrap" ref={setWrapRef}>
      {error && (
        <p className="gen-timeline-error" role="status">{error}</p>
      )}
      {truncated && (
        <p className="gen-timeline-limit">当前只展示最近 {AGENT_EVENT_MAX_BUFFER} 条代理活动。</p>
      )}
      <ol id="gen-timeline-log" className="gen-timeline" role="log" aria-live="polite">
        {groups.map((group) => (
          <li key={group.events[0].eventKey} className="gen-timeline-group">
            <div className="gen-timeline-group-label">{turnLabel(group.turn)}</div>
            <ol className="gen-timeline-group-events">
              {group.events.map((event) => (
                <AgentStreamRow
                  key={event.eventKey}
                  event={event}
                  isLatest={event.eventKey === latest?.eventKey}
                />
              ))}
            </ol>
          </li>
        ))}
      </ol>
      <button
        type="button"
        className="gen-timeline-collapse"
        aria-expanded="true"
        aria-controls="gen-timeline-log"
        onClick={() => setExpanded(false)}
      >
        收起执行记录
      </button>
    </div>
  );
});
