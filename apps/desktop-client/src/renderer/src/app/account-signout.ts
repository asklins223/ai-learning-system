import { createRequestMeta, unwrapGatewayResult } from "./desktop-client";
import { publishGateInvalidation } from "./gate-invalidation";

/**
 * 顶栏的账户小框和设置页都有一条「退出登录」，两边必须说同一句话、走同一个动作，
 * 所以这个动作只有一份实现放在这里。
 *
 * 结局有三种，且不能互相压缩：
 * 1. 本机清干净、学习服务也撤了销 —— 不需要留话，登录页本身就是答案。
 * 2. 本机清干净了，撤销请求没送达（离线或超时）—— 上一次的登录状态还留在
 *    学习服务那边直到自动过期，用户换到别人设备上时有权知道这一点。
 * 3. 请求整体失败 —— 主进程在失败分支里同样已经拆掉了本机会话，所以「失败了」
 *    与「什么都没发生」都不成立。
 */
const REVOCATION_UNCONFIRMED = "这台设备已经退出登录。这次的登录状态没能通知学习服务撤销，它会在学习服务那边留到自动过期。";
const SIGN_OUT_INCOMPLETE = "退出这一步没有全部完成：这台设备上的登录状态已经清空，但学习服务那边可能没有收到撤销。";

/**
 * 结论为什么停在模块里而不是组件 state：退出会 `publishGateInvalidation`，门禁把
 * 整棵房间换成登录页，任何 surface 自己的 state 都活不过这一次；房间 store 也不行，
 * 边界重置（`resetWorkspaceScope`）会连新加的字段一起清回去。这与空间切换回执用的是
 * 同一套手法。
 */
let pendingNotice: string | null = null;

/** 登录页读取用。可重复调用（渲染期调用，不能消费掉自己）。 */
export function peekAccountSignOutNotice(): string | null {
  return pendingNotice;
}

/** 会话重新成立、或用户开始下一次登录时调用，避免这句话活到下一个不相干的场合。 */
export function clearAccountSignOutNotice(): void {
  pendingNotice = null;
}

export async function signOutCurrentAccount(): Promise<void> {
  let notice: string | null = null;
  try {
    const result = unwrapGatewayResult(
      await window.ailearn.auth.logout({ meta: createRequestMeta() }),
    );
    if (!result.serverRevoked) notice = REVOCATION_UNCONFIRMED;
  } catch {
    // `unwrapGatewayResult` 已经把网关错误广播给门禁了；这里只负责换成一句人话，
    // 因为原始 code 与地址端口都不该出现在给用户读的句子裡。
    notice = SIGN_OUT_INCOMPLETE;
  }
  pendingNotice = notice;
  // 无论哪种结局，屏幕上都不该继续留着上一个账号的房间。
  publishGateInvalidation("auth_required");
}
