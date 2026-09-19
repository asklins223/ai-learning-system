import { Sparkles } from "lucide-react";
import "./companion-bubble.css";

/**
 * 伴星内容气泡。
 *
 * 只负责"长什么样"：定位交给挂载点（`.companion-visual-shell` 头顶、`.companion-page-cue`
 * 页面旁白锚点，或气泡坞），本组件不关心自己站在哪。
 *
 * 语气分四档：
 * - cue     主动提示（proactiveCue / 语义安排时的低频说话）；
 * - touch   触碰回应与学习完成庆祝（更暖一点纸色，无默认标签）；
 * - page    页面联动旁白（带 kicker 标签，对应旧「MAO · 页面联动」）；
 * - reply   对话回复（气泡坞，字号略大、可以更长，带朗读指示）。
 *
 * 2026-09-18 重做：纸面语言换成动森式对话气球——奶油纸色、外层浅描边 + 内层
 * 暗线双描边、大圆角与指向角色头顶的尾巴；控件（麦克风/输入）另走深色玻璃岛，
 * 具体通道位置由统一 HUD 与首页场景样式共同决定。
 */
export type CompanionBubbleTone = "cue" | "touch" | "page" | "reply";

export interface CompanionBubbleProps {
  readonly text: string;
  readonly tone?: CompanionBubbleTone;
  /** 顶部小标签（页面旁白用）；不传则不渲染标签行。 */
  readonly label?: string;
  /** 与全局 motionMode 对齐；off 时不播入场动画。 */
  readonly motionMode?: "full" | "lite" | "off";
  /** 正在朗读这句：尾部给出一个小随声起伏的指示。 */
  readonly speaking?: boolean;
  readonly className?: string;
}

export function CompanionBubble({
  text,
  tone = "cue",
  label,
  motionMode = "full",
  speaking = false,
  className,
}: CompanionBubbleProps) {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const classes = [
    "companion-bubble",
    `companion-bubble--${tone}`,
    motionMode === "off" ? "companion-bubble--static" : "",
    speaking ? "companion-bubble--speaking" : "",
    className ?? "",
  ].filter(Boolean).join(" ");
  return (
    <div
      className={classes}
      role="status"
      data-tone={tone}
      data-motion={motionMode}
      data-speaking={speaking || undefined}
    >
      {label ? (
        <span className="companion-bubble__label">
          <Sparkles size={10} aria-hidden="true" />
          {label}
        </span>
      ) : null}
      <span className="companion-bubble__text">{trimmed}</span>
      {speaking ? (
        <span className="companion-bubble__voice" aria-hidden="true">
          <i /><i /><i />
        </span>
      ) : null}
    </div>
  );
}
