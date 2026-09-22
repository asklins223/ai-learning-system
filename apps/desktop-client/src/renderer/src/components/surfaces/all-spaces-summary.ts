/**
 * 「全部空间」栏的展示层投影（纯函数、不碰 React）。
 *
 * 这一栏存在的理由，是审计里那句"个人进度被空间硬切分，切走就看不到"：
 * 首页上所有数字都是**当前空间**的，读者却把它们读成"我的"。服务端的
 * `/stats/overview/all` 把同一份每空间数字并排给出，这里只负责把它翻成
 * 渲染层直接可用、且**口径写在脸上**的行——哪个空间、什么身份、哪一行是
 * 你现在看的这个、合计里有没有少算。
 *
 * 与 `today-log.ts` 同一原则：判定逻辑离开 JSX，可以脱离渲染器测。
 */
import type { AllWorkspacesStatsOverviewV1, StatsOverviewV1 } from "@ailearn/shared/stats-overview-contracts";

/** 一行里的四个数字。选它们是因为它们分别回答"有什么/学什么/为什么/该做什么"。 */
export type AllSpacesMetric = {
  readonly key: "notes" | "cards" | "objectives" | "reviews";
  readonly label: string;
  readonly value: number;
};

export type AllSpacesRow = {
  readonly workspaceId: string;
  readonly name: string;
  /** 个人 / 协作：空间类型属于空间本身，不因为看的人而变。 */
  readonly kindLabel: string;
  readonly roleLabel: string;
  /** 服务端按会话标记；渲染层没有 workspaceId，按名字猜会在同名空间上出错。 */
  readonly isCurrent: boolean;
  readonly metrics: readonly AllSpacesMetric[];
};

export type AllSpacesSummary = {
  readonly rows: readonly AllSpacesRow[];
  readonly totalMetrics: readonly AllSpacesMetric[];
  /** 合计里混进了降级口径（某个空间活跃卡触顶）时必须承认。 */
  readonly totalDegraded: boolean;
  /** 成员空间多于扇出上限时，合计不是全部——这句话不能省。 */
  readonly skippedNote: string | null;
};

function metricsOf(overview: StatsOverviewV1): readonly AllSpacesMetric[] {
  return [
    { key: "notes", label: "笔记", value: overview.noteCount },
    { key: "cards", label: "卡片", value: overview.cardCount },
    { key: "objectives", label: "目标", value: overview.activeObjectiveCount },
    { key: "reviews", label: "待复习", value: overview.pendingReviewCount },
  ];
}

function kindLabel(isPersonal: boolean): string {
  return isPersonal ? "个人" : "协作";
}

function roleLabel(role: string): string {
  if (role === "owner") return "所有者";
  if (role === "member") return "成员";
  // 未知角色照原样说，不替服务端编一个更漂亮的说法。
  return role;
}

export function buildAllSpacesSummary(overview: AllWorkspacesStatsOverviewV1): AllSpacesSummary {
  return {
    rows: overview.workspaces.map((row) => ({
      workspaceId: row.workspaceId,
      name: row.workspaceName,
      kindLabel: kindLabel(row.isPersonal),
      roleLabel: roleLabel(row.role),
      isCurrent: row.isCurrent,
      metrics: metricsOf(row.overview),
    })),
    totalMetrics: metricsOf(overview.total),
    totalDegraded: overview.total.capped,
    skippedNote: overview.skippedWorkspaceCount > 0
      ? `还有 ${overview.skippedWorkspaceCount} 个空间没有计入合计。`
      : null,
  };
}
