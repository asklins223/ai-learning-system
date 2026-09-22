/**
 * 首页聚合统计的跨进程合同（纯 zod，无 node: 依赖）。
 *
 * 为什么要有这一份：`GET /stats/overview` 从 2026 起就只按**当前空间**算数，
 * 而界面把它当"我的总览"读——切了空间，数字跟着变，读者却看不到"另一个空间
 * 里还有什么"。`GET /stats/overview/all` 把同一份每空间数字并排给出，再加上
 * 合计；形状必须在服务端、网关、渲染层之间是**同一份**定义，所以放在这里，
 * 而不是三处各写一遍。
 */
import { z } from "zod";

/**
 * 单个空间的聚合统计。字段与 `apps/api/src/modules/stats/service.ts` 的
 * `getStatsOverview` 返回值一一对应——那份实现是这些数字的唯一来源，
 * 这里只是它的线上形状。
 */
export const statsOverviewSchema = z.object({
  noteCount: z.number().int().min(0),
  cardCount: z.number().int().min(0),
  activeCardCount: z.number().int().min(0),
  evidenceCount: z.number().int().min(0),
  pendingReviewCount: z.number().int().min(0),
  hardEvidenceCount: z.number().int().min(0),
  /** R#6-5：降级标志——true 表示 activeCardCount 超过 STATS_ACTIVE_CARDS_MAX，
   *  明细聚合按前 MAX 张活跃卡计算，计数与明细口径可能不一致。 */
  capped: z.boolean(),
  /** Plan 23 CS-04：Objective 口径（与 /v2/learning-dashboard 对账；hidden alias=0）。 */
  activeObjectiveCount: z.number().int().min(0),
  objectiveReviewDueCount: z.number().int().min(0),
});

export type StatsOverviewV1 = z.infer<typeof statsOverviewSchema>;

/**
 * 一个空间一行。`isCurrent` 由服务端按会话里的当前空间标记——渲染层拿不到
 * workspaceId（空间身份只有名字/角色），由它自己按名字猜"哪一行是当前空间"
 * 会在同名空间上给出假答案。
 */
export const workspaceStatsOverviewRowSchema = z.object({
  workspaceId: z.string().uuid(),
  workspaceName: z.string(),
  role: z.string(),
  isPersonal: z.boolean(),
  isCurrent: z.boolean(),
  overview: statsOverviewSchema,
});

export type WorkspaceStatsOverviewRowV1 = z.infer<typeof workspaceStatsOverviewRowSchema>;

/**
 * 跨空间总览：每空间一行 + 一个合计。
 *
 * `capped` / `skippedWorkspaceCount` 说的是**扇出上限**（见服务端的
 * `STATS_OVERVIEW_WORKSPACE_MAX`），不是单个空间的 `overview.capped`：
 * 成员空间多于上限时只统计前 N 个，并且必须把"少算了几个"如实说出来，
 * 不能让合计冒充全部。
 */
export const allWorkspacesStatsOverviewSchema = z.object({
  version: z.literal(1),
  workspaces: z.array(workspaceStatsOverviewRowSchema),
  total: statsOverviewSchema,
  capped: z.boolean(),
  skippedWorkspaceCount: z.number().int().min(0),
});

export type AllWorkspacesStatsOverviewV1 = z.infer<typeof allWorkspacesStatsOverviewSchema>;
