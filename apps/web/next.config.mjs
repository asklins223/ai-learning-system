const isDevelopment = process.env.NODE_ENV === "development";
const contentSecurityPolicy = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDevelopment ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
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
  // 生产构建时启用 standalone 输出 — Next.js 会 trace 所有 import，
  // 只打包实际用到的 node_modules 文件，排除 playwright、typescript、
  // @types、vue 等运行时不需要的包。桌面端打包时直接使用 standalone 产物。
  output: isDevelopment ? undefined : "standalone",
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
