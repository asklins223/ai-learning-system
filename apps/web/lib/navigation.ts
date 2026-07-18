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
    mobileLabel: "学习流",
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
    label: "今日变化",
    href: "/today",
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

/** 移动底部导航的 5 个固定入口 */
export const mobileBottomNavItems: NavItem[] = [
  primaryNavItems[0], // 学习流 → /
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
 */
export function isNavActive(href: string, pathname: string | null): boolean {
  if (!pathname) return false;
  if (href === "/") return pathname === "/";
  return pathname.startsWith(href);
}
