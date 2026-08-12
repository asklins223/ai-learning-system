import type { BrowserWindowConstructorOptions } from "electron";
import type { DesktopPetScaleV1 } from "@ailearn/shared";

export const PET_ROUTE_PATH = "/companion/pet" as const;
export const PET_WINDOW_BASE_SIZE = { width: 560, height: 520 } as const;
export const PET_CHARACTER_BASE_WIDTH = 244 as const;
export const PET_WINDOW_MARGIN_DIP = 8 as const;
export const PET_SPIKE_LABEL = "P0 SPIKE" as const;

export function extraWidthForPetScale(scale: DesktopPetScaleV1): number {
  return Math.ceil(PET_CHARACTER_BASE_WIDTH * (Math.max(1, scale) - 1));
}

export function petContentSizeForScale(scale: DesktopPetScaleV1): {
  width: number;
  height: 520;
} {
  return {
    width: PET_WINDOW_BASE_SIZE.width + extraWidthForPetScale(scale),
    height: PET_WINDOW_BASE_SIZE.height,
  };
}

export function petRouteUrl(baseUrl: string): string {
  return new URL(`${PET_ROUTE_PATH}?surface=electron`, `${baseUrl}/`).toString();
}

export function isPetRouteUrl(url: string, expectedOrigin: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.origin !== expectedOrigin) return false;
    // 2026-08-12（P6 真机验证）：未登录时中间件将 /companion/pet 307 到 /login，
    // will-redirect 守卫此前拦截该重定向 → loadURL ERR_FAILED → 桌宠窗口空白。
    // 放行同源登录页：桌宠窗口可直接登录，登录成功后自动跳回 pet 路由。
    return parsed.pathname === PET_ROUTE_PATH || parsed.pathname === "/login";
  } catch {
    return false;
  }
}

export function createPetWindowOptions(
  preload: string,
  alwaysOnTop: boolean,
): BrowserWindowConstructorOptions {
  return {
    width: PET_WINDOW_BASE_SIZE.width,
    height: PET_WINDOW_BASE_SIZE.height,
    useContentSize: true,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    closable: false,
    focusable: true,
    skipTaskbar: true,
    hasShadow: false,
    backgroundColor: "#00000000",
    alwaysOnTop,
    webPreferences: {
      preload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      devTools: process.env.NODE_ENV === "development",
    },
  };
}
