"use client";

/**
 * 任务 07-5：学习卡一个主行动与四入口共享内核（§8/§3，W6 任务 07-5）。
 *
 * - **学习卡一个主行动**（§8）：前台只保留一个主行动「开始/继续一小段航程」；
 *   Supervisor 决定本轮使用语音、排序、修复还是情境（`journeyHint` 是一行提示，
 *   **不是平级玩法菜单**）；不渲染「动/试」等平级玩法按钮；
 * - **内容工具**（不是平级玩法）：朗读（TTS 播放摘要/论点/证据）、查看证据
 *   （展开 exact evidence 与 semantic support）、问一问（当前 target 有界 Tutor
 *   detour）——不必创建完整 formal Session；朗读/查看/Tutor 按实际暴露内容记录
 *   exposure（由父级在「实际播放/展开」时触发回调），随后开始航程遵守
 *   assistance cooldown（`assistanceCooldownActive` 提示「本轮为练习模式」）；
 * - **学习卡状态 ≠ 用户理解**（§8/07-5）：`published` 只表示资产过生成与证据 Gate；
 *   `contact`（打开/收听/收藏）只表示接触；`practiceEventCount` 是 Tutor 解释产生
 *   practice 事件；只有 `trustedChange`（trusted contract 的验证/复习事件）才改变
 *   个人理解投影——状态徽标区分展示，不把活动量包装成知识成长（§10.4）；
 * - **不展示伪精确掌握度**（§10.4）：`capabilityFacets` 只展示已验证能力切面，
 *   `dueLabel` 是到期事实描述而非红色欠账清单；
 * - **每处可「在星图中查看」但不强制跳转**（§3 四入口）：`onViewInStarMap` 为可选
 *   动作，星图不是唯一入口（§10.6）；
 * - 纯 UI + props 回调（与 06-6 StaticCardFallback 一致）：不调用服务端、不引用
 *   canvas/webgl；exposure 记录由父级经回调按实际暴露内容落账。
 *
 * A11y（01-4 §13.4）：语义化 section/ul/button、type="button"、focus-visible 描边；
 * 键盘主路径完整（主行动按钮最先聚焦，内容工具紧随其后）。
 */

import type { ReactElement, SVGProps } from "react";
import { Icon } from "@/components/ui/icons";
import { LEARNING_CARD_PRIMARY_ACTION } from "@/lib/learning-companion/four-entry-origin";

// ─── 类型 ─────────────────────────────────────────────────────────────

export interface LearningCardContact {
  opened?: boolean;
  listened?: boolean;
  favorited?: boolean;
}

/** 只有 trusted contract 的验证/复习事件才改变个人理解投影（§8） */
export interface LearningCardTrustedChange {
  count: number;
  facets: readonly string[];
}

export interface LearningCardActionHandlers {
  /** 唯一主行动：开始/继续一小段航程（§8） */
  onStartJourney: () => void;
  /** 内容工具：朗读（TTS 摘要/论点/证据）；实际播放时记录 exposure */
  onReadAloud: () => void;
  /** 内容工具：查看证据（exact evidence + semantic support）；实际展开时记录 exposure */
  onViewEvidence: () => void;
  /** 内容工具：问一问（当前 target 有界 Tutor detour）；实际发生时记录 exposure */
  onAskTutor: () => void;
  /** 可选：「在星图中查看」，不强制跳转（§3 四入口 / §10.6） */
  onViewInStarMap?: () => void;
}

export interface LearningCardActionsProps extends LearningCardActionHandlers {
  cardId: string;
  keyPointId: string;
  title: string;
  summary: string;
  /** 论点（朗读时可读；仅文本展示，不含答案泄漏风险） */
  keyPoints?: readonly { id: string; claim: string }[];
  /** 已验证能力切面（只展示已证明事实，不展示伪精确掌握度） */
  capabilityFacets?: readonly string[];
  /** 到期事实描述（如「3 天后到期」，非红色欠账清单） */
  dueLabel?: string;
  /** 已发布：资产过生成与证据 Gate（不等于用户理解） */
  published?: boolean;
  /** 接触状态：打开/收听/收藏只表示接触（§8） */
  contact?: LearningCardContact;
  /** Tutor 解释产生的 practice 事件数（Tutor 解释只产生 practice 事件） */
  practiceEventCount?: number;
  /** trusted 验证/复习事件：改变个人理解投影的唯一来源 */
  trustedChange?: LearningCardTrustedChange;
  /** 内容工具暴露后处于 assistance cooldown：随后开始航程必须遵守（本轮练习模式） */
  assistanceCooldownActive?: boolean;
  /** Supervisor 决定的本轮形式提示（语音/排序/修复/情境；不是平级玩法菜单） */
  journeyHint?: string;
  /** true → 移动端紧凑布局 */
  compact?: boolean;
}

// ─── 状态徽标 ─────────────────────────────────────────────────────────

type IconComponent = (props: SVGProps<SVGSVGElement>) => ReactElement;

interface StateBadge {
  key: string;
  label: string;
  icon: IconComponent;
  /** 是否「理解投影变化」（trusted 专属） */
  isUnderstandingChange: boolean;
}

function collectStateBadges(props: {
  published?: boolean;
  contact?: LearningCardContact;
  practiceEventCount?: number;
  trustedChange?: LearningCardTrustedChange;
}): StateBadge[] {
  const badges: StateBadge[] = [];
  if (props.published === true) {
    badges.push({
      key: "published",
      label: "已发布",
      icon: Icon.Check,
      isUnderstandingChange: false,
    });
  }
  const contactKinds: [keyof LearningCardContact, string][] = [
    ["opened", "已打开"],
    ["listened", "已收听"],
    ["favorited", "已收藏"],
  ];
  for (const [field, label] of contactKinds) {
    if (props.contact?.[field] === true) {
      badges.push({ key: field, label, icon: Icon.Inbox, isUnderstandingChange: false });
    }
  }
  if ((props.practiceEventCount ?? 0) > 0) {
    badges.push({
      key: "practice",
      label: `练习 ${props.practiceEventCount ?? 0} 次`,
      icon: Icon.Sparkle,
      isUnderstandingChange: false,
    });
  }
  if ((props.trustedChange?.count ?? 0) > 0) {
    badges.push({
      key: "trusted",
      label: `已验证 ${props.trustedChange?.count ?? 0} 次`,
      icon: Icon.Target,
      isUnderstandingChange: true,
    });
  }
  return badges;
}

// ─── 组件 ─────────────────────────────────────────────────────────────

export function LearningCardActions({
  title,
  summary,
  keyPoints = [],
  capabilityFacets = [],
  dueLabel,
  published = false,
  contact,
  practiceEventCount = 0,
  trustedChange,
  assistanceCooldownActive = false,
  journeyHint,
  compact = false,
  onStartJourney,
  onReadAloud,
  onViewEvidence,
  onAskTutor,
  onViewInStarMap,
}: LearningCardActionsProps) {
  const badges = collectStateBadges({
    published,
    contact,
    practiceEventCount,
    trustedChange,
  });
  const hasTrustedChange = (trustedChange?.count ?? 0) > 0;
  const trustedFacets = trustedChange?.facets ?? [];

  return (
    <section
      aria-label={`学习卡：${title}`}
      data-ui="lc-learning-card-actions"
      className={compact ? "flex flex-col gap-3" : "flex flex-col gap-5"}
    >
      <header className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <h2 className="text-sm font-medium text-ink">{title}</h2>
          {badges.map((badge) => {
            const BadgeIcon = badge.icon;
            return (
              <span
                key={badge.key}
                data-ui={badge.isUnderstandingChange ? "lc-card-trusted" : "lc-card-state"}
                className="inline-flex items-center gap-1 rounded-full bg-surface-soft px-2 py-0.5 text-[11px] text-muted"
              >
                <BadgeIcon className="size-3" />
                {badge.label}
              </span>
            );
          })}
        </div>
        <p className="text-xs text-muted">{summary}</p>
      </header>

      {keyPoints.length > 0 && (
        <ul aria-label="论点" className="flex flex-col gap-1.5">
          {keyPoints.map((point) => (
            <li key={point.id} className="text-xs text-ink">
              <span aria-hidden="true" className="mr-1.5 text-muted">
                ·
              </span>
              {point.claim}
            </li>
          ))}
        </ul>
      )}

      {(capabilityFacets.length > 0 || trustedFacets.length > 0) && (
        <div className="flex flex-col gap-1">
          <p className="text-[11px] text-muted">已验证能力切面</p>
          <ul aria-label="已验证能力切面" className="flex flex-wrap gap-1">
            {capabilityFacets.map((facet) => (
              <li
                key={facet}
                className="inline-flex items-center rounded-full bg-surface-soft px-2 py-0.5 text-[11px] text-ink"
              >
                {facet}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* 唯一主行动：开始/继续一小段航程（§8） */}
      <div className="flex flex-col gap-1.5">
        <button
          type="button"
          onClick={onStartJourney}
          data-ui="lc-card-primary-action"
          className="inline-flex items-center justify-center gap-1.5 rounded-full bg-action px-4 py-2 text-sm font-medium text-on-action focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-action"
        >
          <Icon.Play className="size-4" />
          {LEARNING_CARD_PRIMARY_ACTION}
        </button>
        {assistanceCooldownActive && (
          <p className="text-[11px] text-muted" data-ui="lc-card-cooldown">
            内容已提前暴露：本轮按练习模式进行，不改变理解状态（冷却后再独立验证）。
          </p>
        )}
        {journeyHint && (
          <p className="text-[11px] text-muted" data-ui="lc-card-journey-hint">
            本轮由伴星安排：{journeyHint}
          </p>
        )}
      </div>

      {/* 内容工具（不是平级玩法菜单；按实际暴露内容记录 exposure） */}
      <div className="flex flex-col gap-2">
        <p className="text-[11px] text-muted">内容工具</p>
        <ul className="flex flex-wrap gap-2">
          <ContentTool
            label="朗读"
            detail="播放摘要/论点/证据"
            icon={Icon.Quote}
            onActivate={onReadAloud}
          />
          <ContentTool
            label="查看证据"
            detail="exact evidence 与 semantic support"
            icon={Icon.Eye}
            onActivate={onViewEvidence}
          />
          <ContentTool
            label="问一问"
            detail="当前目标的有界讲解"
            icon={Icon.Compass}
            onActivate={onAskTutor}
          />
        </ul>
        <p className="text-[11px] text-muted" data-ui="lc-card-exposure-note">
          朗读/查看/问一问会按实际暴露内容记录，随后开始航程遵守冷却。
        </p>
      </div>

      {/* 学习卡状态 ≠ 用户理解（§8） */}
      <p className="text-[11px] text-muted" data-ui="lc-card-understanding-note">
        发布、打开、收听、收藏只表示接触；Tutor 讲解只产生练习事件；
        {hasTrustedChange
          ? "本卡已有 trusted 验证/复习事件改变你的理解投影。"
          : "只有 trusted 验证/复习事件才会改变你的理解投影。"}
      </p>

      {dueLabel && (
        <p className="text-[11px] text-muted" data-ui="lc-card-due">
          {dueLabel}
        </p>
      )}

      {/* 每处可「在星图中查看」但不强制跳转（§3 四入口） */}
      {onViewInStarMap && (
        <button
          type="button"
          onClick={onViewInStarMap}
          data-ui="lc-card-view-in-star-map"
          className="inline-flex items-center gap-1.5 self-start rounded-full px-3 py-1.5 text-xs text-muted hover:bg-surface-soft hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-action"
        >
          <Icon.StarMap className="size-3.5" />
          在星图中查看
        </button>
      )}
    </section>
  );
}

// ─── 内容工具行 ────────────────────────────────────────────────────────

function ContentTool({
  label,
  detail,
  icon: ToolIcon,
  onActivate,
}: {
  label: string;
  detail: string;
  icon: IconComponent;
  onActivate: () => void;
}) {
  return (
    <li className="flex items-center gap-2 rounded-card border border-border bg-surface px-3 py-2">
      <ToolIcon aria-hidden="true" className="size-4 text-muted" />
      <span className="flex flex-col">
        <button
          type="button"
          onClick={onActivate}
          className="text-left text-xs font-medium text-ink hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-action"
        >
          {label}
        </button>
        <span className="text-[11px] text-muted">{detail}</span>
      </span>
    </li>
  );
}
