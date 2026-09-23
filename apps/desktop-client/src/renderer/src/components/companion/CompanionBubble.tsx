import "./companion-bubble.css";

/**
 * 伴星**主动提示**的气泡。
 *
 * 只负责"长什么样"：定位交给挂载点（`.companion-hud` 里那颗可点开的念头气泡，
 * 或她头顶的通道），本组件不关心自己站在哪。
 *
 * 语气两档：
 * - cue    主动提示（念头 / 低频说话）；
 * - touch  触碰回应与学习完成庆祝（更暖一点纸色）。
 *
 * 2026-09-22 收口：这里原本写着四档（另两档是"页面旁白"与"对话回复"）还带了
 * `label` 与 `speaking` 两个 prop。它们一个调用点都没有、`reply` 与 `speaking`
 * 连样式都没人接手（朗读指示是三个没有任何 CSS 的 `<i>`，画不出来），
 * 而回复气泡实际住的是 `.companion-hud__output`。整条删掉，不留在注释里当合同。
 */
export type CompanionBubbleTone = "cue" | "touch";

export interface CompanionBubbleProps {
  readonly text: string;
  readonly tone?: CompanionBubbleTone;
  /** 与全局 motionMode 对齐；off 时不播入场动画。 */
  readonly motionMode?: "full" | "lite" | "off";
}

export function CompanionBubble({
  text,
  tone = "cue",
  motionMode = "full",
}: CompanionBubbleProps) {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const classes = [
    "companion-bubble",
    `companion-bubble--${tone}`,
    motionMode === "off" ? "companion-bubble--static" : "",
  ].filter(Boolean).join(" ");
  return (
    <div
      className={classes}
      role="status"
      data-tone={tone}
      data-motion={motionMode}
    >
      <span className="companion-bubble__text">{trimmed}</span>
    </div>
  );
}
