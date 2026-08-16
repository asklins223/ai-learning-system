import { BrowserWindow } from "electron";
import { createPetWindowOptions, PET_ROUTE_PATH, petRouteUrl } from "./pet-window-contract";
import { isAllowedWindowNavigation } from "./window-security";

export interface CreatePetWindowOptions {
  baseUrl: string;
  preload: string;
  alwaysOnTop: boolean;
  onClosed?: () => void;
}

export function createPetWindow(options: CreatePetWindowOptions): BrowserWindow {
  const expectedOrigin = new URL(options.baseUrl).origin;
  const window = new BrowserWindow(createPetWindowOptions(options.preload, options.alwaysOnTop));

  window.setIgnoreMouseEvents(true, { forward: process.platform !== "linux" });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  const navigationGuard = (event: Electron.Event, url: string) => {
    if (!isAllowedWindowNavigation(url, expectedOrigin, "pet")) event.preventDefault();
  };
  window.webContents.on("will-navigate", navigationGuard);
  window.webContents.on("will-redirect", navigationGuard);
  window.on("closed", () => options.onClosed?.());
  // 2026-08-11：loadURL 失败静默记录（此前无 catch——导航失败时仅控制台报错，
  // 不阻塞启动；记录便于排障）。
  // 2026-08-12（P6 streaming 真机验证）：web server 冷启动瞬间创建 Pet Window
  // 时，/companion/pet 路由首访触发 Next dev 编译，首次 loadURL 会 ERR_FAILED(-2)
  // 且无重试 → Pet Window 永久空白/消失。加 5 次指数退避重试（web ready 标志
  // 与路由首编译完成之间的竞争窗口实测可达 15s+，尤其 .next 冷缓存时）。
  const targetUrl = petRouteUrl(options.baseUrl);
  let attempt = 0;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  const cancelRetry = () => {
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
  };
  const loadWithRetry = (): void => {
    // 窗口已销毁（closed）后不再尝试 loadURL（原实现残留的定时器仍会对
    // 已销毁窗口调用 loadURL）。
    if (window.isDestroyed()) return;
    attempt += 1;
    void window.loadURL(targetUrl).catch((error: unknown) => {
      if (window.isDestroyed()) return;
      if (attempt >= 5) {
        console.error(`[pet] loadURL failed after ${attempt} attempts:`, error);
        return;
      }
      // 1s / 2s / 4s / 8s —— 累计约 15s 窗口覆盖冷编译。
      retryTimer = setTimeout(loadWithRetry, 1_000 * 2 ** (attempt - 1));
    });
  };
  loadWithRetry();
  // 关闭时取消仍在排队的 loadURL 重试定时器，避免对已销毁窗口调用 loadURL。
  window.on("closed", cancelRetry);
  // 2026-08-12（P6 streaming 真机验证）：Pet Window 选项为 show:false 且
  // 此前无人触发显示——窗口创建后一直隐藏，桌宠"不出现"的根因。合同 §6.2
  // 要求 ready-to-show 后 showInactive()（不抢焦点）。ready-to-show 只在
  // loadURL 真正完成后触发，重试成功路径同样覆盖。
  // 2026-08-12（登录页小窗口修复）：未登录时 /companion/pet 被中间件 307
  // 到 /login，此时显示会变成右下角一个"小登录窗口"（用户不明所以）。
  // 只有加载到 pet 路由本体才显示；登录成功后 bootstrap ready 由
  // handlePetBootstrap 负责 showInactive。
  window.once("ready-to-show", () => {
    if (window.isDestroyed()) return;
    // 2026-08-12（登录页小窗口修复）：只有加载到 pet 路由本体才显示。
    // 注意不能用 isPetRouteUrl（它按导航守卫语义放行 /login——登录态
    // 桌宠窗口会停在那里，显示会变成"小登录窗口"）。严格限定 pet 路由。
    let isPetRoute = false;
    try {
      isPetRoute = new URL(window.webContents.getURL()).pathname === PET_ROUTE_PATH;
    } catch {
      isPetRoute = false;
    }
    if (isPetRoute) {
      window.showInactive();
    }
  });
  return window;
}
