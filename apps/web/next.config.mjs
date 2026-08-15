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
  `script-src 'self' 'unsafe-inline' blob:${isDevelopment ? " 'unsafe-eval'" : ""}`,
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
  `connect-src 'self'${isDevelopment ? " ws: wss:" : ""}`,
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
  // 2026-08-15（R36+ 桌面打包放行）：@ailearn/shared 的 index 含少数
  // node 内置模块依赖（platform-config/fingerprint/content-hash/
  // card-generation-v2-hashing——均按惰性约定，浏览器 bundle 不实际调用）。
  // webpack 5 客户端构建对 `node:` scheme 顶层 import 报 UnhandledSchemeError；
  // 这里对客户端构建把 node 内置模块解析为存根，服务端构建保持真实模块。
  webpack(config, { isServer, webpack }) {
    if (!isServer) {
      config.resolve.fallback = {
        ...config.resolve.fallback,
        "node:fs": false,
        "node:path": false,
        "node:crypto": false,
        "node:module": false,
        "node:url": false,
        "node:os": false,
        "node:util": false,
        "node:stream": false,
        "node:buffer": false,
        "node:events": false,
        "node:http": false,
        "node:https": false,
        "node:zlib": false,
        "node:net": false,
        "node:tls": false,
        "node:child_process": false,
        "node:worker_threads": false,
        "node:assert": false,
        "node:querystring": false,
        "node:string_decoder": false,
        "node:timers": false,
        "node:async_hooks": false,
        "node:perf_hooks": false,
        "node:vm": false,
        "node:readline": false,
        "node:cluster": false,
        "node:dns": false,
        "node:constants": false,
        "node:punycode": false,
        "node:process": false,
        "node:repl": false,
        "node:tty": false,
      };
      // `node:` scheme 在 resolve 阶段就会抛 UnhandledSchemeError（fallback 不
      // 拦截 scheme 解析，NormalModuleReplacementPlugin 触发时机也在 scheme
      // 检查之后）。2026-08-15 恢复：IgnorePlugin 在解析早期拦截 node: 请求
      //（shared 惰性约定保证浏览器运行时不会真正调用这些函数）。
      config.plugins.push(new webpack.IgnorePlugin({ resourceRegExp: /^node:/ }));
    }
    return config;
  },
};

export default nextConfig;
