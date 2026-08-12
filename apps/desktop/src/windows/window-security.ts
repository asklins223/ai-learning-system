import { isPetRouteUrl } from "./pet-window-contract";

export function isAllowedWindowNavigation(
  url: string,
  expectedOrigin: string,
  role: "main" | "pet",
): boolean {
  if (role === "pet") return isPetRouteUrl(url, expectedOrigin);
  try {
    return new URL(url).origin === expectedOrigin;
  } catch {
    return false;
  }
}

// M12（审计修复）：https 协议校验不足以防止被攻破的 renderer 通过
// open-external 打开任意钓鱼/恶意 https 页面。改为显式 host 白名单
// （fail-closed）：只有登记过的域名允许打开。当前应用无已知合法外链需求
// （该桥接通道无 web 调用方），默认白名单为空——未来新增外链须在此显式
// 登记并走安全评审。
export const ALLOWED_EXTERNAL_HOSTS: readonly string[] = [];

export function isAllowedExternalUrl(
  url: string,
  allowedHosts: readonly string[] = ALLOWED_EXTERNAL_HOSTS,
): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return false;
    return allowedHosts.includes(parsed.hostname);
  } catch {
    return false;
  }
}
