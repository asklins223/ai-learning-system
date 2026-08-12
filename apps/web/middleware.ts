import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/**
 * 服务端首跳鉴权（第七轮 P1-3）。
 *
 * 此前 (workspace) 布局的鉴权是纯客户端门：SSR 恒渲染 loading，挂载后才调
 * /auth/me——每次硬刷新受保护页都白屏 + 至少一次往返，服务端不校验会话。
 *
 * middleware 只做"无 session cookie 直接重定向 /login"的首跳拦截；
 * cookie 存在但失效时仍由客户端 getMe 兜底（避免 middleware 每次请求
 * 都打 DB 校验会话）。
 *
 * matcher 排除：登录/注册、静态资源、_next 内部、API 与 favicon。
 */
export function middleware(request: NextRequest) {
  const session = request.cookies.get("ailearn_session");
  if (!session?.value) {
    const url = new URL("/login", request.url);
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  matcher: [
    // 2026-08-11：补 avif/json/txt 扩展名；api 前缀显式排除
    // 2026-08-12（构建面审计 P2-4）：login/register 改为精确匹配（$ 结尾）——
    // 此前负向前瞻是前缀匹配，/loginxxx 类路径也会被豁免（当前无此类路由，
    // 属收窄防御面）。
    "/((?!api|_next/static|_next/image|favicon\\.ico|login$|register$|.*\\.(?:png|jpg|jpeg|svg|gif|webp|ico|css|js|woff2?|avif|json|txt)$).*)",
  ],
};
