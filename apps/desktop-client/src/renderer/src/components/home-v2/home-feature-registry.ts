export const HOME_FEATURE_REGION_IDS = Object.freeze([
  "desk",
  "shelf",
  "window",
  "rest",
] as const);

export type HomeFeatureRegionId = (typeof HOME_FEATURE_REGION_IDS)[number];

export const HOME_FEATURE_GROUPS = Object.freeze([
  { id: "today", title: "今天" },
  { id: "organize", title: "收录与整理" },
  { id: "explore", title: "探索与巩固" },
  { id: "companion", title: "伴星" },
  { id: "system", title: "账户与系统" },
] as const);

export type HomeFeatureGroupId = (typeof HOME_FEATURE_GROUPS)[number]["id"];

export const HOME_FEATURE_IDS = Object.freeze([
  "continue",
  "today-review",
  "quick-capture",
  "current-notebook",
  "all-notes",
  "sources",
  "learning-cards",
  "room-search",
  "global-search",
  "catalog",
  "current-target",
  "understanding-graph",
  "learning-activity",
  "companion",
  "companion-diary",
  "companion-persona",
  "companion-memory",
  "memory-graph",
  "personal-center",
  "settings",
] as const);

export type HomeFeatureId = (typeof HOME_FEATURE_IDS)[number];

export type HomeFeatureIconId =
  | "activity"
  | "book"
  | "brain"
  | "calendar"
  | "cards"
  | "catalog"
  | "capture"
  | "companion"
  | "notebook"
  | "orbit"
  | "profile"
  | "search"
  | "settings"
  | "target";

export type HomeFeatureDefinitionV1 = Readonly<{
  id: HomeFeatureId;
  title: string;
  purpose: string;
  icon: HomeFeatureIconId;
  region: HomeFeatureRegionId | "system";
  group: HomeFeatureGroupId;
  regionOrder: number;
  catalogOrder: number;
  availability: "native" | "pending";
  catalogVisible: boolean;
  pendingTitle?: string;
  pendingDetail?: string;
}>;

const pending = (
  feature: Omit<HomeFeatureDefinitionV1, "availability" | "catalogVisible">,
): HomeFeatureDefinitionV1 => Object.freeze({
  ...feature,
  availability: WIRED_HOME_FEATURE_IDS.has(feature.id) ? "native" : "pending",
  catalogVisible: true,
});

/** Surfaces backed by the current desktop IPC M2 contract. Features not in
 * this set keep the honest pending notice until their write path exists. */
const WIRED_HOME_FEATURE_IDS = new Set<HomeFeatureId>([
  "continue",
  "today-review",
  "current-notebook",
  "all-notes",
  "sources",
  "learning-cards",
  "room-search",
  "global-search",
  "current-target",
  "understanding-graph",
  "companion-diary",
  "companion-persona",
  "companion-memory",
  "memory-graph",
  "personal-center",
  "settings",
]);

export const HOME_FEATURE_REGISTRY_V1: readonly HomeFeatureDefinitionV1[] = Object.freeze([
  pending({ id: "continue", title: "今日下一步", purpose: "回到今天真正停下的位置", icon: "book", region: "desk", group: "today", regionOrder: 0, catalogOrder: 0, pendingTitle: "今日下一步尚未接入新版页面", pendingDetail: "首页会展示服务端确认的下一步和恢复状态，但当前版本不会跳入旧任务页面。" }),
  pending({ id: "today-review", title: "今日复习", purpose: "处理到期与需要巩固的内容", icon: "calendar", region: "desk", group: "today", regionOrder: 1, catalogOrder: 1, pendingTitle: "今日复习尚未接入新版页面", pendingDetail: "待复习数量来自真实投影；新的复习页面完成前，这里只保留准确入口与建设状态。" }),
  pending({ id: "quick-capture", title: "快速收录", purpose: "收录文本、Markdown、代码或链接", icon: "capture", region: "desk", group: "organize", regionOrder: 2, catalogOrder: 0, pendingTitle: "快速收录尚未接入新版页面", pendingDetail: "后端授权状态会如实展示，桌面端的新收录流程仍在建设中。" }),

  pending({ id: "current-notebook", title: "当前研究册", purpose: "查看正在整理的研究主题", icon: "notebook", region: "shelf", group: "organize", regionOrder: 0, catalogOrder: 1, pendingTitle: "当前研究册尚未接入新版页面", pendingDetail: "首页只展示服务端确认的研究册书签；新版阅读与编辑页面完成前不会打开旧页面。" }),
  pending({ id: "all-notes", title: "全部笔记", purpose: "管理笔记、版本与回收内容", icon: "book", region: "shelf", group: "organize", regionOrder: 1, catalogOrder: 2, pendingTitle: "全部笔记尚未接入新版页面", pendingDetail: "笔记库的新建、导入、版本和回收流程正在重新设计。" }),
  pending({ id: "sources", title: "来源资料", purpose: "查看资料的收录、解析与归档", icon: "cards", region: "shelf", group: "organize", regionOrder: 2, catalogOrder: 3, pendingTitle: "来源资料尚未接入新版页面", pendingDetail: "资料列表、处理状态与转为笔记的新版桌面链路仍在建设中。" }),
  pending({ id: "learning-cards", title: "学习卡", purpose: "管理目标、版本与证据", icon: "cards", region: "shelf", group: "explore", regionOrder: 3, catalogOrder: 0, pendingTitle: "学习卡尚未接入新版页面", pendingDetail: "首页会保留真实生成与恢复状态；新版学习卡页面完成前不会显示示例内容。" }),
  pending({ id: "room-search", title: "房内查找", purpose: "查找当前公开目标与摘要", icon: "search", region: "shelf", group: "explore", regionOrder: 4, catalogOrder: 1, pendingTitle: "房内查找尚未接入新版页面", pendingDetail: "搜索范围和结果页面正在迁移，当前不会绕过新版信息架构打开旧搜索。" }),
  pending({ id: "global-search", title: "全局搜索", purpose: "搜索笔记、来源与全部目标", icon: "search", region: "shelf", group: "explore", regionOrder: 5, catalogOrder: 2, pendingTitle: "全局搜索尚未接入新版页面", pendingDetail: "跨来源、笔记与目标的统一搜索仍在接入桌面端。" }),
  Object.freeze({ id: "catalog", title: "魔法目录", purpose: "查看小屋里的全部功能", icon: "catalog", region: "shelf", group: "system", regionOrder: 6, catalogOrder: 99, availability: "native", catalogVisible: false }),

  pending({ id: "current-target", title: "当前学习目标", purpose: "查看正在推进的目标与下一步", icon: "target", region: "window", group: "today", regionOrder: 0, catalogOrder: 2, pendingTitle: "当前学习目标尚未接入新版页面", pendingDetail: "目标状态来自服务端投影；新版目标页面完成前不会打开旧学习卡。" }),
  // 星图页已经在 Home V2 里接线（见 HomeV2Experience 的 understanding-graph 分支），
  // 所以这里不再需要 pending 文案——那段「尚未接入新版页面」的说明只会在
  // 「新版页面尚未接入」弹窗里出现，而那个弹窗永远不会为这个入口打开。
  pending({ id: "understanding-graph", title: "理解星图", purpose: "查看来源、目标与证据的关系", icon: "orbit", region: "window", group: "explore", regionOrder: 1, catalogOrder: 3 }),
  pending({ id: "learning-activity", title: "学习动态", purpose: "回看真实的学习轨迹", icon: "activity", region: "window", group: "explore", regionOrder: 2, catalogOrder: 4, pendingTitle: "学习动态尚未接入新版页面", pendingDetail: "稳定的活动账本页面仍在建设，首页不会用本机记录拼出一条假时间线。" }),

  Object.freeze({ id: "companion", title: "唤醒伴星", purpose: "打开当前 Live2D 伴星的对话面板", icon: "companion", region: "rest", group: "companion", regionOrder: 0, catalogOrder: 0, availability: "native", catalogVisible: true }),
  pending({ id: "companion-diary", title: "伴星日记", purpose: "查看每日总结与历史日期", icon: "calendar", region: "rest", group: "companion", regionOrder: 1, catalogOrder: 1, pendingTitle: "伴星日记尚未接入新版页面", pendingDetail: "日总结服务仍受功能门控，新版日记页面尚未开放。" }),
  pending({ id: "companion-persona", title: "伴星人格", purpose: "管理语气、关系与互动边界", icon: "profile", region: "rest", group: "companion", regionOrder: 2, catalogOrder: 2, pendingTitle: "伴星人格尚未接入新版页面", pendingDetail: "人格档案和关系边界会保留，新版设置页面仍在建设中。" }),
  pending({ id: "companion-memory", title: "伴星记忆", purpose: "查看、确认与管理记忆", icon: "brain", region: "rest", group: "companion", regionOrder: 3, catalogOrder: 3, pendingTitle: "伴星记忆尚未接入新版页面", pendingDetail: "记忆确认与管理页面尚未接入，首页不会展示本机推测的记忆。" }),
  pending({ id: "memory-graph", title: "记忆星图", purpose: "查看记忆之间的联系", icon: "orbit", region: "rest", group: "companion", regionOrder: 4, catalogOrder: 4, pendingTitle: "记忆星图尚未接入新版页面", pendingDetail: "伴星记忆的真实拓扑接口尚未进入当前桌面合同。" }),

  pending({ id: "personal-center", title: "个人中心", purpose: "管理账户资料与工作区身份", icon: "profile", region: "system", group: "system", regionOrder: 0, catalogOrder: 0, pendingTitle: "个人中心尚未接入新版页面", pendingDetail: "账户资料、工作区身份与伴星人格将统一放在这里，新版页面仍在建设中。" }),
  pending({ id: "settings", title: "设置中心", purpose: "管理工作区、隐私、数据与导入导出", icon: "settings", region: "system", group: "system", regionOrder: 1, catalogOrder: 1, pendingTitle: "设置中心尚未接入新版页面", pendingDetail: "工作区、隐私、AI 数据政策与导入导出入口尚未接入新版桌面端。" }),
]);

const HOME_FEATURE_BY_ID = new Map(HOME_FEATURE_REGISTRY_V1.map((feature) => [feature.id, feature]));

export function isHomeFeatureId(value: unknown): value is HomeFeatureId {
  return typeof value === "string" && HOME_FEATURE_BY_ID.has(value as HomeFeatureId);
}

export function getHomeFeature(id: HomeFeatureId): HomeFeatureDefinitionV1 {
  const feature = HOME_FEATURE_BY_ID.get(id);
  if (!feature) throw new Error(`Unknown Home V2 feature: ${id}`);
  return feature;
}

export function homeFeaturesForRegion(region: HomeFeatureRegionId): readonly HomeFeatureDefinitionV1[] {
  return HOME_FEATURE_REGISTRY_V1
    .filter((feature) => feature.region === region)
    .sort((left, right) => left.regionOrder - right.regionOrder);
}

export function homeFeaturesForGroup(group: HomeFeatureGroupId): readonly HomeFeatureDefinitionV1[] {
  return HOME_FEATURE_REGISTRY_V1
    .filter((feature) => feature.group === group && feature.catalogVisible)
    .sort((left, right) => left.catalogOrder - right.catalogOrder);
}

export function homeFeatureRegistryIssues(): readonly string[] {
  const issues: string[] = [];
  if (new Set(HOME_FEATURE_REGISTRY_V1.map((feature) => feature.id)).size !== HOME_FEATURE_REGISTRY_V1.length) {
    issues.push("feature ids must be unique");
  }
  for (const id of HOME_FEATURE_IDS) {
    if (!HOME_FEATURE_BY_ID.has(id)) issues.push(`feature ${id} is missing`);
  }
  for (const feature of HOME_FEATURE_REGISTRY_V1) {
    if (!feature.title.trim() || !feature.purpose.trim()) issues.push(`feature ${feature.id} needs complete copy`);
    if (feature.availability === "pending" && (!feature.pendingTitle?.trim() || !feature.pendingDetail?.trim())) {
      issues.push(`pending feature ${feature.id} needs a complete notice`);
    }
  }
  return issues;
}
