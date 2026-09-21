import { PROGRESS_SEGMENTS, progressBandLabel } from "./objective-progress-band";

/**
 * 贯穿列表 / 详情 / 结算的**同一个**进度对象（31 号文档 §9.1，批次 B10）。
 *
 * 三个屏各画一条"像进度条的东西"是最容易犯的错——那正是原文里
 * 「四屏各说各话」的病。所以这里只接受一个数字：第几段，或者 null。
 * 数字从哪来由调用方决定（列表与详情用 personalState，结算用本次的 outcome），
 * 组件自己不查、不推、不补。
 *
 * null 的画法：三段刻度照旧在（否则这块地方会空掉，看起来像没渲染出来），
 * 但**一格都不点亮**，末尾补一个 `—`。DESIGN.md:178 要的就是这个——没有读数
 * 时显示 `—`，而不是拿 0 冒充"还没答过"。
 */
export function ObjectiveProgressBand({ segment, className }: { segment: number | null; className?: string }) {
  return (
    <div
      className={`objective-progress${className ? ` ${className}` : ""}`}
      role="img"
      aria-label={progressBandLabel(segment)}
      data-segment={segment ?? "none"}
    >
      {PROGRESS_SEGMENTS.map((label, index) => (
        <span
          key={label}
          className="objective-progress__seg"
          data-lit={segment !== null && index <= segment ? "true" : "false"}
          data-current={segment === index ? "true" : "false"}
        >
          <span className="objective-progress__bar" aria-hidden="true" />
          <span className="objective-progress__label">{label}</span>
        </span>
      ))}
      {segment === null ? <span className="objective-progress__none">—</span> : null}
    </div>
  );
}
