/**
 * 共享导航配置 — 桌面侧栏和移动底部导航使用同一数据源。
 *
 * - DesktopSidebar 和 MobileNav 不得各自维护独立的导航数组。
 * - 当前路由状态通过统一映射得到。
 */

import { Icon } from "@/components/ui/icons";

/* ── 主导航项 ── */

export interface NavItem {
  icon: React.ComponentType<React.SVGProps<SVGSVGElement>>;
  label: string;
  href: string;
  /** 移动端底部导航的标签（短文案） */
  mobileLabel?: string;
  /** 是否在移动底部导航中显示 */
  showInMobile?: boolean;
  /** 移动底部导航分组 */
  mobileGroup?: "primary" | "explore" | "mine";
}

export const primaryNavItems: NavItem[] = [
  {
    icon: Icon.Compass,
    label: "今日学习",
    href: "/",
    mobileLabel: "学习",
    showInMobile: true,
    mobileGroup: "primary",
  },
  {
    icon: Icon.Review,
    label: "复习",
    href: "/review",
    showInMobile: true,
    mobileGroup: "primary",
  },
];

export const exploreNavItems: NavItem[] = [
  {
    icon: Icon.Card,
    label: "学习卡",
    href: "/cards",
    mobileLabel: "探索",
    showInMobile: true,
    mobileGroup: "explore",
  },
  {
    icon: Icon.StarMap,
    label: "理解星图",
    href: "/graph",
  },
  {
    icon: Icon.Search,
    label: "搜索",
    href: "/search",
  },
];

export const mineNavItems: NavItem[] = [
  {
    icon: Icon.Notepad,
    label: "笔记",
    href: "/notes",
  },
  {
    icon: Icon.Inbox,
    label: "来源资料",
    href: "/sources",
  },
  {
    icon: Icon.Timeline,
    label: "学习动态",
    href: "/today",
  },
  {
    icon: Icon.Sparkle,
    label: "桌宠日记",
    href: "/companion/daily",
  },
  {
    icon: Icon.StarMap,
    label: "记忆星图",
    href: "/companion/memory/star-map",
  },
  {
    icon: Icon.Pin,
    label: "伴星记忆",
    href: "/companion/memory",
  },
];

/** 移动端“我的”面板比桌面侧栏多提供设置入口。 */
export const mobileMineNavItems: NavItem[] = [
  ...mineNavItems,
  {
    icon: Icon.Settings,
    label: "设置",
    href: "/settings",
  },
];

/** 合并所有侧栏导航项（桌面使用） */
export const allSidebarNavItems: NavItem[] = [
  ...primaryNavItems,
  ...exploreNavItems,
  ...mineNavItems,
];

/** 为平板顶栏等紧凑壳层提供稳定的当前页面名称。 */
export function getCurrentPageLabel(pathname: string | null): string {
  if (!pathname) return "理解引擎";
  const item = allSidebarNavItems.find((candidate) => isNavActive(candidate.href, pathname));
  if (item) return item.label;
  if (pathname.startsWith("/settings")) return "设置";
  if (pathname.startsWith("/benchmark")) return "理解评测";
  if (pathname.startsWith("/learning-cards/")) return "学习卡详情";
  if (pathname === "/cards" || pathname.startsWith("/cards/")) return "学习目标库";
  if (pathname.startsWith("/notes/")) return "笔记编辑";
  if (pathname.startsWith("/sources/")) return "来源阅读";
  return "理解引擎";
}

/** 移动底部导航的 5 个固定入口 */
export const mobileBottomNavItems: NavItem[] = [
  primaryNavItems[0], // 学习 → /
  primaryNavItems[1], // 复习 → /review
  {
    icon: Icon.Plus,
    label: "新建",
    href: "#quick-capture",
    mobileLabel: "新建",
    showInMobile: true,
    mobileGroup: "primary",
  },
  exploreNavItems[0], // 探索 → /cards
  {
    icon: Icon.User,
    label: "我的",
    href: "#mine",
    mobileLabel: "我的",
    showInMobile: true,
    mobileGroup: "mine",
  },
];

/**
 * 判断导航项是否高亮。
 * - 首页 `/` 需要精确匹配。
 * - 其他路由使用前缀匹配。
 * - 如果两个导航项存在前缀包含关系（如 /companion/memory 和 /companion/memory/star-map），
 *   更长的路径优先匹配，避免短路径错误地高亮。
 */
export function isNavActive(href: string, pathname: string | null): boolean {
  if (!pathname) return false;
  if (href === "/") return pathname === "/";
  if (pathname === href) return true;
  // 前缀匹配：pathname 必须以 href + "/" 开头（子路由），或精确等于 href。
  return pathname.startsWith(href + "/");
}
