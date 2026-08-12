import Link from "next/link";

/**
 * 404 品牌化页面（第七轮 P1-4）：此前用 Next 默认英文 404。
 */
export default function NotFound() {
  return (
    <main
      style={{
        display: "grid",
        placeItems: "center",
        minHeight: "100vh",
        fontFamily: "system-ui, sans-serif",
        padding: "2rem",
      }}
    >
      <div style={{ textAlign: "center", maxWidth: "32rem" }}>
        <p style={{ fontSize: "3rem", fontWeight: 700, margin: "0 0 0.5rem" }}>404</p>
        <h1 style={{ fontSize: "1.25rem", margin: "0 0 0.75rem" }}>这个页面不存在</h1>
        <p style={{ color: "#666", marginBottom: "1.5rem" }}>
          链接可能已失效，或内容已被移动。回到首页继续学习吧。
        </p>
        <Link
          href="/"
          style={{
            display: "inline-block",
            padding: "0.5rem 1.25rem",
            borderRadius: "0.5rem",
            border: "1px solid #ccc",
            background: "#f5f5f5",
            color: "inherit",
            textDecoration: "none",
          }}
        >
          回到首页
        </Link>
      </div>
    </main>
  );
}
