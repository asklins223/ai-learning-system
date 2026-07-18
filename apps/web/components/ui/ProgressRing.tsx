/**
 * 进度环 / 仪表（V0.2 升级）。
 * - 圆角虚线描边（不再是严格圆环），更"仪表"
 * - 数字在中，等宽数字感
 * - 颜色按 tone
 */
type Tone = "verified" | "solid" | "unstable" | "weak" | "sun";

const TONE_COLOR: Record<Tone, string> = {
  verified: "#21B573",
  solid: "#2DBE9F",
  unstable: "#F5A524",
  weak: "#EF5B5B",
  sun: "#FACC15",
};

export function ProgressRing({
  value,
  size = 44,
  stroke = 5,
  tone = "verified",
  label,
  hideValue,
}: {
  value: number; // 0-100
  size?: number;
  stroke?: number;
  tone?: Tone;
  label?: string;
  hideValue?: boolean;
}) {
  const clamped = Math.max(0, Math.min(100, value));
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const offset = c - (clamped / 100) * c;
  const color = TONE_COLOR[tone];

  return (
    <span
      className="relative inline-flex items-center justify-center"
      style={{ width: size, height: size }}
    >
      <svg width={size} height={size} className="-rotate-90">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="#ECEAE0"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray="2 6"
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeDasharray={c}
          strokeDashoffset={offset}
          strokeLinecap="round"
          style={{ transition: "stroke-dashoffset 0.5s ease" }}
        />
      </svg>
      {!hideValue && (
        <span className="absolute text-[12px] font-semibold tabular-nums text-ink">
          {label ?? Math.round(clamped)}
        </span>
      )}
    </span>
  );
}
