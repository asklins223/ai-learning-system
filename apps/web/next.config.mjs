import path from "node:path";
import { fileURLToPath } from "node:url";
import webpack from "next/dist/compiled/webpack/webpack-lib.js";

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const isDevelopment = process.env.NODE_ENV === "development";
const contentSecurityPolicy = [
  "default-src 'self'",
  // 2026-08-11 实测：Next 15.5 experimental.sri 只给外置 script 注入 integrity，
  // 8 个 inline bootstrap scripts（self.__next_f）无 hash——script-src 去
  // 'unsafe-inline' 会直接白屏（25 个 CSP 违规，Playwright 实测）。恢复
  // 'unsafe-inline'（Next 架构必需）；SRI 保留——外置 chunk 带 integrity，
  // 配合 'self' 阻断外置脚本篡改。真正的严格化需全站动态渲染 + nonce，
  // 属架构级权衡（P3 记录；XSS 面已全绿兜底）。dev 需 unsafe-eval。
  // 2026-08-13（Live2D 修复）：生产也需 'unsafe-eval'——PIXI v6 编译 WebGL
  // 着色器依赖 new Function（@pixi/unsafe-eval 缺失时抛错→Sprite 回退，
  // 实测打包版桌宠 Live2D 必现）。本地桌宠应用（非公网）风险可控。
  `script-src 'self' 'unsafe-inline' blob: 'unsafe-eval'`,
  // 2026-08-11：style 已全部外置（WorkspaceRouteLoading 内联 <style> 迁入
  // globals.css；CompanionAvatar 同前），生产 'self' 实测无违规；dev 保留
  // unsafe-inline（React dev overlay 注入）。
  `style-src 'self'${isDevelopment ? " 'unsafe-inline'" : ""}`,
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  // P3/P6 TTS playback creates an object URL from the authenticated audio
  // response.  Without an explicit media-src, Chromium falls back to
  // default-src and rejects the blob before HTMLAudioElement can decode it.
  "media-src 'self' blob:",
  // 2026-08-12（P6 真机验证）：本地 ASR 双路径采集用 AudioWorklet，处理器
  // 以 blob: URL 注册（addModule）。无 worker-src 时 Chromium 回退 script-src
  // （无 blob:）→ AbortError "Unable to load a worklet's module" → 本地 PCM
  // 缺失 → 识别降级 text_only。blob 只能由同源页面创建，风险可控。
  "worker-src 'self' blob:",
  // SSE 端点经 next rewrite 会被代理缓冲（chunk 不 flush），LearningRun
  // events/companion inbox 等长流在浏览器端直连 NEXT_PUBLIC_API_URL；
  // dev 默认 http://localhost:4000（API CORS 已允许）。生产 NEXT_PUBLIC_API_URL
  // 指向同源或已配 CORS 的 API 网关。
  `connect-src 'self'${isDevelopment ? " ws: wss: http://localhost:4000" : ""}`,
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: contentSecurityPolicy },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(self), geolocation=()" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
];

if (!isDevelopment) {
  // Browsers only honor HSTS over HTTPS, so the header is inert for the local
  // HTTP smoke stack and takes effect when production is terminated by TLS.
  securityHeaders.push({
    key: "Strict-Transport-Security",
    value: "max-age=31536000; includeSubDomains",
  });
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@ailearn/shared"],
  // 关闭开发环境左下角的 Next.js 调试浮层，避免覆盖侧栏账户头像。
  devIndicators: false,
  // 2026-08-12：Electron dev 以 http://localhost:<port> 加载页面，但
  // 渲染进程访问 /_next/* 时 referer 可能是 127.0.0.1（macOS localhost
  // 解析差异）。显式允许两种 dev origin，避免 "Cross origin request
  // detected" 拦截静态资源（否则 Pet 页面裸渲染、角色不出现）。
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  // 生产构建时启用 standalone 输出 — Next.js 会 trace 所有 import，
  // 只打包实际用到的 node_modules 文件，排除 playwright、typescript、
  // @types、vue 等运行时不需要的包。桌面端打包时直接使用 standalone 产物。
  output: isDevelopment ? undefined : "standalone",
  // 2026-08-11：CSP 配套——SRI 为构建产物外置 script 注入 integrity hash
  //（实测 Next 15.5 只覆盖外置 chunk，inline bootstrap scripts 无 hash，
  // 故 script-src 保留 'unsafe-inline'，见上方注释）。SRI 提供外置脚本
  // 篡改防护，配合 'self' 阻断 CDN/中间人替换。
  experimental: {
    sri: { algorithm: "sha256" },
    // 2026-08-15（桌面打包修复）：Next 15.5.21 build worker 模式下预渲染
    // 稳定崩溃（TypeError: a[d] is not a function @ webpack-runtime require，
    // 干净 .next 可 100% 复现，SRI 实验 + worker 分块加载相互干扰）；
    // worker=0（NEXT_PRIVATE_BUILD_WORKER=0）稳定成功。桌面 dist/pack 依赖
    // next build，显式禁用 webpack build worker 保证打包产物可复现。
    webpackBuildWorker: false,
  },
  // 2026-08-13（next build 修复）：@ailearn/shared 多个文件顶层 import
  // node: 内置模块（platform-config 的 fs、fingerprint 的 crypto 等——仅
  // 服务端使用）。客户端 bundle 经 SilentProofScene → index 全量导出被打包
  // → UnhandledSchemeError。客户端构建用 IgnorePlugin 忽略 node: 前缀请求
  //（web 端从不调用这些函数；服务端构建不受影响）。
  webpack: (config, { isServer }) => {
    if (!isServer) {
      // @ailearn/shared 的 index 全量导出会把服务端专属模块（task-router →
      // platform-config-node → node:fs/crypto）带进客户端 bundle →
      // UnhandledSchemeError。IgnorePlugin 在模块解析前拦截 node: 请求
      //（web 端从不调用这些函数；服务端构建不受影响）。
      config.plugins.push(new webpack.IgnorePlugin({ resourceRegExp: /^node:/ }));
    }
    return config;
  },
  // Keep standalone tracing anchored to this repository. Without this explicit
  // root, an unrelated lockfile above the workspace can make Next.js emit an
  // incompatible `Documents/study/apps/web` layout or race its own trace copy.
  outputFileTracingRoot: workspaceRoot,
  // Exclude packages that Next.js traces into standalone but are not
  // needed at runtime:
  // - sharp / @img: app does not use next/image (no image optimization)
  // - typescript: pulled in via @milkdown/components→vue, but we use
  //   @milkdown/react, not the Vue components
  outputFileTracingExcludes: {
    "/": ["./node_modules/@img/**", "./node_modules/sharp/**", "./node_modules/typescript/**"],
  },
  // R-012: 同源 /api 代理 — 浏览器请求 /api/xxx 被 rewrite 到 API 服务器，
  // 不再需要 NEXT_PUBLIC_API_URL 指向 localhost，远程访问不会请求访问者本机。
  async rewrites() {
    const dest = process.env.INTERNAL_API_URL ?? "http://localhost:4000";
    return [
      {
        source: "/api/:path*",
        destination: `${dest}/:path*`,
      },
    ];
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;
