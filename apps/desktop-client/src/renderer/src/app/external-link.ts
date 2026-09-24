import { createRequestMeta } from "./desktop-client";

/**
 * 把一条网页链接交给系统浏览器。
 *
 * 协议白名单**不在这里判**：主进程那关用的是合同里那份 `isWebLinkUrl`，渲染层画不画
 * 成能点的也用同一份，所以不存在"画得能点、点了被拒"这种两套口径。
 *
 * 这里刻意不走 `unwrapGatewayResult`：它会对**任何**错误码 `publishGateInvalidation`，
 * 一条链接打不开不该把整个应用弹回门禁。失败时返回值只是给调用方一个信号——去处
 * （那条地址）本来就写在链接下面一行，用户随时能自己复制，所以不额外占一条提示位。
 */
export async function openExternalLink(url: string): Promise<boolean> {
  try {
    const result = await window.ailearn.shell.openExternal({ meta: createRequestMeta(), request: { url } });
    return result.ok;
  } catch {
    return false;
  }
}
