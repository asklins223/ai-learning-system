"use client";

/**
 * 根错误边界（第七轮 P1-4）：此前无 global-error.tsx，任何客户端渲染异常
 * 冒泡到 Next 默认 500 白屏。此组件替换根布局的错误渲染，提供恢复入口。
 * 注意：global-error 必须包含自己的 <html>/<body>。
 */

export default function GlobalError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="zh-CN">
      <body>
        <main style={{ display: "grid", placeItems: "center", minHeight: "100vh", fontFamily: "system-ui, sans-serif", padding: "2rem" }}>
          <div style={{ textAlign: "center", maxWidth: "32rem" }}>
            <h1 style={{ fontSize: "1.5rem", marginBottom: "0.75rem" }}>页面出了点问题</h1>
            <p style={{ color: "#666", marginBottom: "1.5rem" }}>
              应用遇到了意外错误。你可以尝试重新加载，或回到首页继续学习。
            </p>
            <div style={{ display: "flex", gap: "0.75rem", justifyContent: "center" }}>
              <button
                type="button"
                onClick={reset}
                style={{ padding: "0.5rem 1.25rem", borderRadius: "0.5rem", border: "1px solid #ccc", background: "#fff", cursor: "pointer" }}
              >
                重试
              </button>
              {/* 2026-08-11：eslint no-html-link-for-pages——global-error 在
                  root layout 之外，next/link 需要 <html> 内 Router 上下文，
                  此处用原生 <a> 并声明式跳转（error boundary 不保证 Router 可用） */}
              {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
              <a href="/" style={{ padding: "0.5rem 1.25rem", borderRadius: "0.5rem", border: "1px solid #ccc", background: "#f5f5f5", color: "inherit", textDecoration: "none" }}>
                回到首页
              </a>
            </div>
          </div>
        </main>
      </body>
    </html>
  );
}
