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
  "current-notebook",
  "all-notes",
  "sources",
  "global-search",
  "catalog",
  "current-target",
  "understanding-graph",
  "companion-center",
  "settings",
] as const);

export type HomeFeatureId = (typeof HOME_FEATURE_IDS)[number];

export type HomeFeatureIconId =
  | "book"
  | "calendar"
  | "cards"
  | "catalog"
  | "companion"
  | "notebook"
  | "orbit"
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
  "global-search",
  "current-target",
  "understanding-graph",
  "companion-center",
  "settings",
]);

export const HOME_FEATURE_REGISTRY_V1: readonly HomeFeatureDefinitionV1[] = Object.freeze([
  pending({ id: "continue", title: "今日下一步", purpose: "回到今天真正停下的位置", icon: "book", region: "desk", group: "today", regionOrder: 0, catalogOrder: 0, pendingTitle: "今日下一步尚未接入新版页面", pendingDetail: "首页会展示已经定下的下一步和恢复状态，但当前版本不会跳入旧任务页面。" }),
  pending({ id: "today-review", title: "今日复习", purpose: "处理到期与需要巩固的内容", icon: "calendar", region: "desk", group: "today", regionOrder: 1, catalogOrder: 1, pendingTitle: "今日复习尚未接入新版页面", pendingDetail: "待复习数量来自真实记录；新的复习页面完成前，这里只保留准确入口与建设状态。" }),

  pending({ id: "current-notebook", title: "当前研究册", purpose: "查看正在整理的研究主题", icon: "notebook", region: "shelf", group: "organize", regionOrder: 0, catalogOrder: 1, pendingTitle: "当前研究册尚未接入新版页面", pendingDetail: "首页只展示已经存好的研究册；新版阅读与编辑页面完成前不会打开旧页面。" }),
  pending({ id: "all-notes", title: "全部笔记", purpose: "管理笔记、版本与回收内容", icon: "book", region: "shelf", group: "organize", regionOrder: 1, catalogOrder: 2, pendingTitle: "全部笔记尚未接入新版页面", pendingDetail: "笔记库的新建、导入、版本和回收流程正在重新设计。" }),
  pending({ id: "sources", title: "来源资料", purpose: "查看资料的收录、解析与归档", icon: "cards", region: "shelf", group: "organize", regionOrder: 2, catalogOrder: 3, pendingTitle: "来源资料尚未接入新版页面", pendingDetail: "资料列表、处理状态与转为笔记的新版桌面链路仍在建设中。" }),
  pending({ id: "global-search", title: "搜索", purpose: "搜索笔记、来源与全部目标", icon: "search", region: "shelf", group: "explore", regionOrder: 3, catalogOrder: 2, pendingTitle: "搜索尚未接入新版页面", pendingDetail: "跨来源、笔记与目标的统一搜索仍在接入桌面端。" }),
  Object.freeze({ id: "catalog", title: "魔法目录", purpose: "查看小屋里的全部功能", icon: "catalog", region: "shelf", group: "system", regionOrder: 6, catalogOrder: 99, availability: "native", catalogVisible: false }),

  pending({ id: "current-target", title: "当前学习卡", purpose: "查看正在推进的目标与下一步", icon: "target", region: "window", group: "today", regionOrder: 0, catalogOrder: 2, pendingTitle: "当前学习卡尚未接入新版页面", pendingDetail: "目标状态来自服务器上的真实进度；新版学习卡页面完成前不会打开旧版卡片页。" }),
  // 星图页已经在 Home V2 里接线（见 HomeV2Experience 的 understanding-graph 分支），
  // 所以这里不再需要 pending 文案——那段「尚未接入新版页面」的说明只会在
  // 「新版页面尚未接入」弹窗里出现，而那个弹窗永远不会为这个入口打开。
  pending({ id: "understanding-graph", title: "理解星图", purpose: "查看来源、目标与证据的关系", icon: "orbit", region: "window", group: "explore", regionOrder: 1, catalogOrder: 3 }),

  // 伴星中心的对话/日记/人格/记忆是同一个 surface 的四个页签，目录只保留
  // 一条入口，不再按页签拆成四条同名跳转。
  Object.freeze({ id: "companion-center", title: "伴星中心", purpose: "对话、日记、人格与记忆都在这里", icon: "companion", region: "rest", group: "companion", regionOrder: 0, catalogOrder: 0, availability: "native", catalogVisible: true }),

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
