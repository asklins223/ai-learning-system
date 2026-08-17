/**
 * Plan 23 FE-13..FE-18：学习目标库（Objective list）。
 *
 * - 数据：只消费 /v2/learning-objectives（ObjectiveListItemV3），不再调用
 *   listCards / listLearningCardsV2 / CardSet / legacy union adapter（§2.4）；
 * - 搜索/筛选/排序：自定义控件（button+menu，方向键/Home/End/Escape/读屏），
 *   不使用裸原生 select 外观（§36.4）；
 * - 分页：loaded/total/nextCursor 语义明确，不用加载数冒充 total（FE-16）；
 * - 行：标题 → 详情；状态 chip / 来源 / 时间 / typed action 层级稳定（§36 Demo）。
 */
"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type {
  ObjectiveListItemV3,
  LearningObjectivePrimaryActionV3,
} from "@ailearn/shared";
import { learningObjectiveApi } from "@/lib/learning-objective-api";
import { ObjectiveStatusChip, type ObjectiveChipState } from "./ObjectiveStatusChip";
import { ObjectiveSourceLine } from "./ObjectiveSourceLine";
import { ObjectivePrimaryAction } from "./ObjectivePrimaryAction";
import { ObjectiveSkeleton, ObjectiveError, ObjectiveEmpty } from "./ObjectiveStatePrimitives";

type LibraryFilter = "all" | "active" | "due" | "run" | "outdated" | "archived";
type LibrarySort = "recommended" | "newest" | "oldest";

const FILTERS: ReadonlyArray<{ key: LibraryFilter; label: string }> = [
  { key: "all", label: "全部" },
  { key: "active", label: "进行中" },
  { key: "due", label: "到期" },
  { key: "run", label: "可继续" },
  { key: "outdated", label: "来源待更新" },
  { key: "archived", label: "已归档" },
];

const SORTS: ReadonlyArray<{ key: LibrarySort; label: string }> = [
  { key: "recommended", label: "建议顺序" },
  { key: "newest", label: "最近创建" },
  { key: "oldest", label: "最早创建" },
];

function chipStateOf(item: ObjectiveListItemV3): ObjectiveChipState {
  if (item.lifecycle === "archived") return "archived";
  if (item.primaryAction.kind === "resume_run") return "run";
  if (item.primaryAction.kind === "create_review_run") return "due";
  if (item.freshness === "source_outdated") return "outdated";
  if (item.personalState.state === "unvalidated") return "ready";
  return "ready";
}

function itemHref(item: ObjectiveListItemV3): string {
  return "/learning-objectives/" + item.objectiveId;
}

function actionHref(action: LearningObjectivePrimaryActionV3): string | null {
  switch (action.kind) {
    case "create_run": {
      const params = new URLSearchParams({
        origin: "card",
        cardId: action.cardId ?? action.objectiveId,
        keyPointId: action.objectiveId,
        goal: action.goal,
        returnTo: "/cards",
      });
      return "/learning-runs/new?" + params.toString();
    }
    case "resume_run":
      return "/learning-runs/" + action.runId + "?returnTo=" + encodeURIComponent("/cards");
    case "create_review_run": {
      const params = new URLSearchParams({
        origin: "review",
        scheduleId: action.scheduleId,
        keyPointId: action.objectiveId,
        generation: String(action.generation),
        returnTo: "/cards",
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

export function ObjectiveLibrary(): JSX.Element {
  const router = useRouter();
  const [items, setItems] = useState<ObjectiveListItemV3[] | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchText, setSearchText] = useState("");
  const [filter, setFilter] = useState<LibraryFilter>("all");
  const [sort, setSort] = useState<LibrarySort>("recommended");
  const [filterOpen, setFilterOpen] = useState(false);
  const [sortOpen, setSortOpen] = useState(false);
  const requestRef = useRef(0);

  const load = useCallback(async (cursor?: string) => {
    const requestId = ++requestRef.current;
    if (cursor) setLoadingMore(true);
    else setLoading(true);
    try {
      const page = await learningObjectiveApi.listObjectives({
        cursor,
        limit: 50,
      });
      if (requestId !== requestRef.current) return;
      setItems((prev) => (cursor ? [...(prev ?? []), ...page.items] : page.items));
      setTotal(page.total);
      setNextCursor(page.nextCursor);
      setError(null);
    } catch {
      if (requestId !== requestRef.current) return;
      setError("学习目标库暂时不可用");
    } finally {
      if (requestId === requestRef.current) {
        setLoading(false);
        setLoadingMore(false);
      }
    }
  }, []);

  useEffect(() => {
    void load();
    return () => {
      requestRef.current += 1;
    };
  }, [load]);

  // 客户端搜索/筛选/排序（正式读取已在服务端按 lifecycle/cursor 完成）
  const visible = useMemo(() => {
    if (!items) return [];
    const query = searchText.trim().toLowerCase();
    let result = items.filter((item) => {
      if (filter === "active" && item.lifecycle !== "active") return false;
      if (filter === "archived" && item.lifecycle !== "archived") return false;
      if (filter === "due" && item.primaryAction.kind !== "create_review_run") return false;
      if (filter === "run" && item.primaryAction.kind !== "resume_run") return false;
      if (filter === "outdated" && item.freshness !== "source_outdated") return false;
      if (query) {
        const haystack = [
          item.conceptLabel ?? "",
          item.publicSummary,
          item.primaryNoteTitle ?? "",
        ].join(" ").toLowerCase();
        if (!haystack.includes(query)) return false;
      }
      return true;
    });
    const actionRank = (item: ObjectiveListItemV3): number => {
      switch (item.primaryAction.kind) {
        case "resume_run": return 0;
        case "create_review_run": return 1;
        case "create_run": return 2;
        case "practice_only": return 3;
        case "view_successor": return 4;
        case "refresh": return 5;
        default: return 6;
      }
    };
    if (sort === "newest") {
      result = [...result].sort((a, b) => b.objectiveId.localeCompare(a.objectiveId));
    } else if (sort === "oldest") {
      result = [...result].sort((a, b) => a.objectiveId.localeCompare(b.objectiveId));
    } else {
      result = [...result].sort((a, b) => actionRank(a) - actionRank(b));
    }
    return result;
  }, [items, searchText, filter, sort]);

  const execute = (action: LearningObjectivePrimaryActionV3) => {
    if (action.kind === "refresh") {
      void load();
      return;
    }
    const href = actionHref(action);
    if (href) router.push(href);
  };

  if (loading && !items) return <ObjectiveSkeleton rows={8} />;
  if (error && !items) return <ObjectiveError message={error} retryable onRetry={() => void load()} />;

  const shownTotal = total ?? items?.length ?? 0;

  return (
    <div className="objective-library">
      {error && items && (
        <div className="objective-library-inline-error" role="status">
          {error} <button type="button" onClick={() => void load()}>重试</button>
        </div>
      )}

      <div className="objective-library-toolbar">
        <label className="objective-library-search">
          <span className="objective-sr-only">搜索学习目标</span>
          <input
            type="search"
            value={searchText}
            onChange={(event) => setSearchText(event.target.value)}
            placeholder="搜索概念、说明或来源…"
          />
        </label>

        <MenuButton
          label="筛选"
          open={filterOpen}
          onToggle={() => { setFilterOpen(!filterOpen); setSortOpen(false); }}
          onClose={() => setFilterOpen(false)}
          current={FILTERS.find((f) => f.key === filter)?.label ?? "全部"}
        >
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              role="option"
              aria-selected={filter === f.key}
              onClick={() => { setFilter(f.key); setFilterOpen(false); }}
            >
              {f.label}
            </button>
          ))}
        </MenuButton>

        <MenuButton
          label="排序"
          open={sortOpen}
          onToggle={() => { setSortOpen(!sortOpen); setFilterOpen(false); }}
          onClose={() => setSortOpen(false)}
          current={SORTS.find((s) => s.key === sort)?.label ?? "建议顺序"}
        >
          {SORTS.map((s) => (
            <button
              key={s.key}
              type="button"
              role="option"
              aria-selected={sort === s.key}
              onClick={() => { setSort(s.key); setSortOpen(false); }}
            >
              {s.label}
            </button>
          ))}
        </MenuButton>

        <span className="objective-library-count">
          已加载 {items?.length ?? 0} / 共 {shownTotal}
        </span>
      </div>

      {visible.length === 0 ? (
        items && total === 0 ? (
          <ObjectiveEmpty message="暂无学习目标" hint="先从笔记生成一张可验证的学习卡。" />
        ) : (
          <ObjectiveEmpty message="没有匹配的学习目标" hint="换个关键词或筛选条件试试。" />
        )
      ) : (
        <ul className="objective-library-list">
          {visible.map((item) => (
            <li key={item.objectiveId} className="objective-library-row">
              <div className="objective-library-row-main">
                <div className="objective-library-row-topline">
                  <ObjectiveStatusChip state={chipStateOf(item)} />
                  <span className="objective-library-row-form">{item.knowledgeForm}</span>
                </div>
                <h3>
                  <Link href={itemHref(item)}>
                    {item.conceptLabel ?? item.publicSummary.slice(0, 40)}
                  </Link>
                </h3>
                <p>{item.publicSummary.slice(0, 120)}</p>
                <ObjectiveSourceLine
                  noteTitle={item.primaryNoteTitle}
                  freshness={item.freshness}
                />
              </div>
              <div className="objective-library-row-action">
                <ObjectivePrimaryAction
                  action={item.primaryAction}
                  onExecute={execute}
                />
              </div>
            </li>
          ))}
        </ul>
      )}

      {nextCursor && (
        <div className="objective-library-pagination">
          <button
            type="button"
            className="objective-secondary-action"
            disabled={loadingMore}
            onClick={() => void load(nextCursor)}
          >
            {loadingMore ? "加载中…" : "加载更多"}
          </button>
        </div>
      )}
    </div>
  );
}

/** 自定义菜单（FE-15）：button + popover；方向键/Home/End/Escape/焦点回归。 */
function MenuButton(props: {
  label: string;
  current: string;
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  children: React.ReactNode;
}): JSX.Element {
  const listRef = useRef<HTMLDivElement>(null);
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (!props.open) return;
    const buttons = Array.from(
      listRef.current?.querySelectorAll<HTMLButtonElement>("button[role=option]") ?? [],
    );
    if (buttons.length === 0) return;
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "Escape") {
      event.preventDefault();
      props.onClose();
      (event.currentTarget as HTMLElement).querySelector("button")?.focus();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      buttons[Math.min(index + 1, buttons.length - 1)]?.focus();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      buttons[Math.max(index - 1, 0)]?.focus();
    } else if (event.key === "Home") {
      event.preventDefault();
      buttons[0]?.focus();
    } else if (event.key === "End") {
      event.preventDefault();
      buttons[buttons.length - 1]?.focus();
    }
  };
  return (
    <div className="objective-library-menu" onKeyDown={onKeyDown}>
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={props.open}
        onClick={props.onToggle}
        className="objective-library-menu-trigger"
      >
        <span>{props.label}：{props.current}</span>
      </button>
      {props.open && (
        <div ref={listRef} role="listbox" aria-label={props.label} className="objective-library-menu-popover">
          {props.children}
        </div>
      )}
    </div>
  );
}
