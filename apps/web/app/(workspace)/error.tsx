"use client";

/**
 * workspace 路由组错误边界（第七轮 P1-4）：学习空间内的渲染异常就地降级，
 * 不冒泡到全局白屏。
 */
export default function WorkspaceError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main
      style={{
        display: "grid",
        placeItems: "center",
        minHeight: "60vh",
        fontFamily: "system-ui, sans-serif",
        padding: "2rem",
      }}
    >
      <div style={{ textAlign: "center", maxWidth: "32rem" }}>
        <h1 style={{ fontSize: "1.25rem", margin: "0 0 0.75rem" }}>学习空间出了点问题</h1>
        <p style={{ color: "#666", marginBottom: "1.5rem" }}>
          这个页面的内容暂时无法显示。你的学习数据不受影响。
        </p>
        <button
          type="button"
          onClick={reset}
          style={{
            padding: "0.5rem 1.25rem",
            borderRadius: "0.5rem",
            border: "1px solid #ccc",
            background: "#fff",
            cursor: "pointer",
          }}
        >
          重试
        </button>
      </div>
    </main>
  );
}
