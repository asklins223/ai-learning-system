import type { Config } from "tailwindcss";

/**
 * AI 原生学习系统 UI 令牌 — Tailwind 映射层。
 *
 * 所有颜色、阴影、圆角均映射 CSS 变量（来自 styles/tokens.css）。
 * tailwind.config.ts 不再维护独立色值，唯一事实来源为 tokens.css。
 *
 */
const config: Config = {
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./features/**/*.{ts,tsx}",
    "./lib/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        /* ── 环境层 ── */
        canvas: "var(--color-canvas)",
        "canvas-deep": "var(--color-canvas-deep)",

        /* ── 壳层 ── */
        shell: "var(--color-shell)",
        "shell-glass": "var(--color-shell-glass)",

        /* ── 控件表面 ── */
        surface: "var(--color-surface)",
        "surface-raised": "var(--color-surface-raised)",
        "surface-soft": "var(--color-surface-soft)",

        /* ── 纸面 ── */
        paper: "var(--color-paper)",
        paperDeep: "var(--color-paper-deep)",
        paperNote: "var(--color-paper-note)",

        /* ── 边框 ── */
        border: "var(--color-border)",
        "border-strong": "var(--color-border-strong)",
        divider: "var(--color-divider)",

        /* ── 文本 ── */
        ink: "var(--color-text)",
        muted: "var(--color-text-secondary)",
        faint: "var(--color-text-tertiary)",
        disabled: "var(--color-text-disabled)",

        /* ── 主操作 ── */
        action: "var(--color-action)",
        "action-hover": "var(--color-action-hover)",
        "on-action": "var(--color-on-action)",

        /* ── 语义色 ── */
        verified: "var(--color-success)",
        success: "var(--color-success)",
        "success-text": "var(--color-success-text)",
        "success-soft": "var(--color-success-soft)",

        evidence: "var(--color-evidence)",
        "evidence-text": "var(--color-evidence-text)",
        "evidence-soft": "var(--color-evidence-soft)",

        highlight: "var(--color-highlight)",
        "highlight-soft": "var(--color-highlight-soft)",

        warning: "var(--color-warning)",
        "warning-text": "var(--color-warning-text)",
        "warning-soft": "var(--color-warning-soft)",

        danger: "var(--color-danger)",
        "danger-text": "var(--color-danger-text)",
        "danger-soft": "var(--color-danger-soft)",

        running: "var(--color-running)",
        "running-text": "var(--color-running-text)",
        "running-soft": "var(--color-running-soft)",

        solid: "var(--color-success)",
        unstable: "var(--color-warning)",
        weak: "var(--color-danger)",
        untouched: "var(--color-text-disabled)",

      },

      fontFamily: {
        sans: [
          "var(--font-ui)",
        ],
        mono: ["var(--font-mono)"],
        editorial: ["var(--font-editorial)"],
        scribe: [
          '"Caveat"',
          '"Permanent Marker"',
          '"Bradley Hand"',
          '"Comic Sans MS"',
          '"PingFang SC"',
          "cursive",
        ],
      },

      borderRadius: {
        DEFAULT: "var(--radius-sm)",
        xs: "var(--radius-xs)",
        sm: "var(--radius-sm)",
        card: "var(--radius-md)",
        note: "var(--radius-lg)",
        shell: "var(--radius-shell)",
        pill: "var(--radius-pill)",
      },

      maxWidth: {
        shell: "1600px",
      },

      boxShadow: {
        control: "var(--shadow-control)",
        panel: "var(--shadow-panel)",
        paper: "var(--shadow-paper)",
        floating: "var(--shadow-floating)",
        shell: "var(--shadow-shell)",
        card: "var(--shadow-control)",
        lift: "var(--shadow-panel)",
        pop: "var(--shadow-floating)",
        sticky: "var(--shadow-panel)",
        highlight: "inset 0 -0.45em 0 rgba(250, 204, 21, 0.6)",
        highlightPink: "inset 0 -0.45em 0 rgba(251, 113, 133, 0.55)",
        highlightMint: "inset 0 -0.45em 0 rgba(167, 243, 208, 0.7)",
      },

      backgroundImage: {
        desk: "linear-gradient(180deg, var(--color-canvas) 0%, var(--color-canvas-deep) 100%)",
        dotted: "radial-gradient(rgba(120,100,70,0.10) 1px, transparent 1px)",
      },

      backgroundSize: {
        "dot-22": "22px 22px",
      },

      screens: {
        sm: "640px",
        md: "768px",
        lg: "960px",
        xl: "1180px",
        "2xl": "1440px",
      },

      keyframes: {
        breathe: {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0.4" },
        },
        slideIn: {
          from: { transform: "translateX(16px)", opacity: "0" },
          to: { transform: "translateX(0)", opacity: "1" },
        },
        fadeIn: {
          from: { opacity: "0" },
          to: { opacity: "1" },
        },
        slideUp: {
          from: { transform: "translateY(16px)", opacity: "0" },
          to: { transform: "translateY(0)", opacity: "1" },
        },
        rise: {
          from: { transform: "translateY(8px)", opacity: "0" },
          to: { transform: "translateY(0)", opacity: "1" },
        },
        wobble: {
          "0%, 100%": { transform: "rotate(-1deg)" },
          "50%": { transform: "rotate(1deg)" },
        },
        sweep: {
          "0%": { backgroundPosition: "0% 50%" },
          "100%": { backgroundPosition: "200% 50%" },
        },
        fillDash: {
          from: { strokeDashoffset: "100" },
          to: { strokeDashoffset: "0" },
        },
      },

      animation: {
        breathe: "breathe 1.6s ease-in-out infinite",
        slideIn: "slideIn 0.18s ease-out",
        "fade-in": "fadeIn 0.16s ease-out",
        "slide-up": "slideUp 0.22s ease-out",
        rise: "rise 0.32s cubic-bezier(.21,1.02,.73,1) both",
        wobble: "wobble 4s ease-in-out infinite",
        sweep: "sweep 2.4s linear infinite",
      },
    },
  },
  plugins: [],
};

export default config;
