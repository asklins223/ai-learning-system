import type { IpcMainInvokeEvent } from "electron";
import { isPetRouteUrl } from "../windows/pet-window-contract.ts";

export type TrustedWindowRole = "main" | "pet";

export function isTrustedSender(
  event: Pick<IpcMainInvokeEvent, "sender" | "senderFrame">,
  expectedWebContentsId: number | null,
  expectedOrigin: string,
  role: TrustedWindowRole,
): boolean {
  if (expectedWebContentsId === null || event.sender.id !== expectedWebContentsId) return false;
  const rawUrl = event.senderFrame?.url ?? event.sender.getURL();
  try {
    const url = new URL(rawUrl);
    if (url.origin !== expectedOrigin) return false;
    if (role === "pet") {
      // 2026-08-12（P6 真机验证）：pet 窗口可访问 /companion/pet 或未登录时
      // 被中间件 307 到的同源 /login。ASR IPC 需在两种状态下都可用（登录中
      // 即可注入），故按 isPetRouteUrl 放行，而不是仅限 pet 路由本身。
      if (!isPetRouteUrl(rawUrl, expectedOrigin)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

export function requireTrustedSender(
  event: Pick<IpcMainInvokeEvent, "sender" | "senderFrame">,
  expectedWebContentsId: number | null,
  expectedOrigin: string,
  role: TrustedWindowRole,
): void {
  if (!isTrustedSender(event, expectedWebContentsId, expectedOrigin, role)) {
    throw new Error("UNTRUSTED_DESKTOP_SENDER");
  }
}
