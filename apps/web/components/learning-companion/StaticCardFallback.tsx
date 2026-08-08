"use client";

/**
 * 任务 06-6：列表/静态卡 fallback（§10.6 / §8，06-w5 任务 06-6）。
 *
 * - **不依赖 Canvas**：星图不是唯一入口——搜索、卡片、"此刻"、复习均可
 *   直接开始（§10.6 星图不是唯一入口；移动端退化为星域列表 + 路线卡）；
 * - **静态卡**：纯 UI + props 回调，不调用服务端、不引用任何 canvas/webgl；
 *   内容与动作经 `entries` / `exploreActions` 注入（与 04-6/05-5 组件风格一致）；
 * - **学习卡一个主行动**（§8）：每张卡只有「开始/继续一小段航程」一个主行动，
 *   不把内部 Scene/route 枚举做成平级玩法菜单（00-3 §3）；
 * - **不展示伪精确掌握度**（§10.4）：meta.capabilityFacets 只展示已验证的
 *   能力切面标签，meta.dueLabel 是到期事实描述而非红色欠账清单（06-5 §9）；
 * - **explore（随便看看）**：听解释/证据浏览/开放问题/沙盘入口一律带
 *   practice-only 徽标（06-6 任务内容：全部 practice-only，不消费 schedule）。
 *
 * A11y（01-4 §13.4）：语义化 section/ul/button、type="button"、focus-visible
 * 描边；`compact` 用于移动端紧凑布局。
 */

import type { ReactElement, SVGProps } from "react";
import { Icon } from "@/components/ui/icons";

// ─── 类型 ─────────────────────────────────────────────────────────────────

/** 入口来源：星图不是唯一入口，搜索/卡片/此刻/复习均可直接开始。 */
export type StaticCardSource = "search" | "card" | "now" | "review";

export interface StaticCardSecondaryAction {
  label: string;
  onActivate: () => void;
}

export interface StaticCardEntry {
  id: string;
  keyPointId: string;
  title: string;
  summary: string;
  /** 入口来源（决定徽标与分组） */
  source: StaticCardSource;
  /** 主行动：开始/继续一小段航程（学习卡唯一主行动，§8） */
  onStart: () => void;
  /** 次级内容工具（朗读、查看证据等；不创建完整 formal Session 也必须可行） */
  secondaryActions?: StaticCardSecondaryAction[];
  meta?: {
    /** 到期事实描述，如 "3 天后到期"（不是红色欠账清单，06-5 §9） */
    dueLabel?: string;
    /** 已验证能力切面标签（只展示已证明事实，01-2 §7.4） */
    capabilityFacets?: string[];
    /** 该条目是否需要 Canvas 才能呈现（true → 显示"可在星图中查看"提示，不阻塞直接开始） */
    requiresCanvas?: boolean;
    /** 推荐路线标签（Supervisor 提议，非强制，06-5 §9） */
    routeLabel?: string;
  };
}

/** explore（随便看看）入口：听解释 / 证据浏览 / 开放问题 / 沙盘，全部 practice-only。 */
export interface ExploreAction {
  label: string;
  description?: string;
  onActivate: () => void;
}

export interface StaticCardFallbackProps {
  title?: string;
  description?: string;
  /** 可开始条目（来自搜索/卡片/此刻/复习入口） */
  entries: StaticCardEntry[];
  /** explore（随便看看）入口，全部 practice-only */
  exploreActions?: ExploreAction[];
  /** true → 移动端紧凑布局（星域列表 + 路线卡，§10.6） */
  compact?: boolean;
}

// ─── 来源元信息 ─────────────────────────────────────────────────────────────

type IconComponent = (props: SVGProps<SVGSVGElement>) => ReactElement;

const SOURCE_META: Readonly<Record<StaticCardSource, { label: string; icon: IconComponent }>> = {
  search: { label: "搜索", icon: Icon.Search },
  card: { label: "卡片", icon: Icon.Card },
  now: { label: "此刻", icon: Icon.Timeline },
  review: { label: "复习", icon: Icon.Review },
};

const SOURCE_ORDER: readonly StaticCardSource[] = ["card", "review", "now", "search"];

// ─── 组件 ──────────────────────────────────────────────────────────────────

export function StaticCardFallback({
  title = "星域列表",
  description = "无需打开星图，从这里直接开始一小段航程：搜索、卡片、「此刻」和复习都可以作为入口。",
  entries,
  exploreActions = [],
  compact = false,
}: StaticCardFallbackProps) {
  const groups = SOURCE_ORDER.map((source) => ({
    source,
    entries: entries.filter((entry) => entry.source === source),
  })).filter((group) => group.entries.length > 0);

  return (
    <section
      aria-label={title}
      data-ui="lc-static-card-fallback"
      className={compact ? "flex flex-col gap-3" : "flex flex-col gap-5"}
    >
      <header className="flex flex-col gap-1">
        <h2 className="text-sm font-medium text-ink">{title}</h2>
        <p className="text-xs text-muted">{description}</p>
      </header>

      {groups.length === 0 && (
        <p className="text-xs text-muted" data-ui="lc-fallback-empty">
          还没有可开始的内容。
        </p>
      )}

      {groups.map((group) => {
        const meta = SOURCE_META[group.source];
        const SourceIcon = meta.icon;
        return (
          <section key={group.source} aria-label={meta.label} className="flex flex-col gap-2">
            <h3 className="flex items-center gap-1.5 text-xs font-medium text-muted">
              <SourceIcon className="size-3.5" />
              {meta.label}
            </h3>
            <ul className={compact ? "flex flex-col gap-2" : "grid grid-cols-1 gap-2"}>
              {group.entries.map((entry) => (
                <StaticCardRow key={entry.id} entry={entry} />
              ))}
            </ul>
          </section>
        );
      })}

      {exploreActions.length > 0 && (
        <section aria-label="随便看看" className="flex flex-col gap-2">
          <h3 className="flex items-center gap-1.5 text-xs font-medium text-muted">
            <Icon.Sparkle className="size-3.5" />
            随便看看
          </h3>
          <ul className="flex flex-col gap-2">
            {exploreActions.map((action) => (
              <ExploreRow key={action.label} action={action} />
            ))}
          </ul>
        </section>
      )}
    </section>
  );
}

// ─── 内部行组件 ──────────────────────────────────────────────────────────────

function StaticCardRow({ entry }: { entry: StaticCardEntry }) {
  const sourceMeta = SOURCE_META[entry.source];
  const SourceIcon = sourceMeta.icon;
  const meta = entry.meta;

  return (
    <li
      data-ui="lc-fallback-entry"
      data-source={entry.source}
      className="flex flex-col gap-2 rounded-card border border-border bg-surface p-3"
    >
      <div className="flex items-start gap-2.5">
        <span
          aria-hidden="true"
          className="mt-0.5 inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-surface-soft text-muted"
        >
          <SourceIcon className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <h4 className="truncate text-sm font-medium text-ink">{entry.title}</h4>
            <span className="inline-flex items-center rounded-full bg-surface-soft px-2 py-0.5 text-[11px] text-muted">
              {sourceMeta.label}
            </span>
            {meta?.requiresCanvas === true && (
              <span
                className="inline-flex items-center rounded-full bg-surface-soft px-2 py-0.5 text-[11px] text-muted"
                data-ui="lc-fallback-requires-canvas"
              >
                可在星图中查看
              </span>
            )}
          </div>
          <p className="mt-1 line-clamp-2 text-xs text-muted">{entry.summary}</p>
        </div>
      </div>

      {(meta?.capabilityFacets?.length ?? 0) > 0 && (
        <ul aria-label="已验证能力切面" className="flex flex-wrap gap-1">
          {(meta?.capabilityFacets ?? []).map((facet) => (
            <li
              key={facet}
              className="inline-flex items-center rounded-full bg-surface-soft px-2 py-0.5 text-[11px] text-ink"
            >
              {facet}
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {meta?.routeLabel && (
          <span className="text-[11px] text-muted">路线：{meta.routeLabel}</span>
        )}
        {meta?.dueLabel && (
          <span className="text-[11px] text-muted" data-ui="lc-fallback-due">
            {meta.dueLabel}
          </span>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={entry.onStart}
          className="inline-flex items-center gap-1.5 rounded-full bg-action px-3 py-1.5 text-xs font-medium text-on-action focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-action"
        >
          <Icon.Play className="size-3.5" />
          开始/继续一小段航程
        </button>
        {(entry.secondaryActions ?? []).map((action) => (
          <button
            key={action.label}
            type="button"
            onClick={action.onActivate}
            className="inline-flex items-center gap-1 rounded-full px-3 py-1.5 text-xs text-muted hover:bg-surface-soft hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-action"
          >
            {action.label}
          </button>
        ))}
      </div>
    </li>
  );
}

function ExploreRow({ action }: { action: ExploreAction }) {
  return (
    <li className="flex items-center gap-2 rounded-card border border-dashed border-border bg-surface p-3">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-ink">{action.label}</p>
        {action.description && <p className="mt-0.5 text-xs text-muted">{action.description}</p>}
      </div>
      <span
        className="inline-flex shrink-0 items-center rounded-full bg-surface-soft px-2 py-0.5 text-[11px] text-muted"
        data-ui="lc-fallback-explore-practice-only"
      >
        练习模式 · 不影响进度
      </span>
      <button
        type="button"
        onClick={action.onActivate}
        className="inline-flex shrink-0 items-center gap-1 rounded-full px-3 py-1.5 text-xs text-muted hover:bg-surface-soft hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-action"
      >
        随便看看
      </button>
    </li>
  );
}
