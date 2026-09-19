/**
 * 回复气泡的显现模型（2026-09-18）。
 *
 * 气泡要回答三个问题：现在该露出哪些字、没有语音可播时该停留多久、要不要给出去
 * 抽屉看全文的入口。都是纯计算，放在这里而不是组件里，好让边界（还没开口、念到
 * 一半、超出气泡容量）直接单测。
 */

/** 超过这个长度就不再让气泡长下去：截断 + 省略号 + 引导去抽屉看全文。 */
export const COMPANION_BUBBLE_MAX_CHARS = 320;

/**
 * 气泡的视觉下限，必须与 `companion-hud.css` 里 `.companion-hud__output` 的
 * `min-height: 72px` 对齐——否则会出现"变量说还能长 40px、CSS 渲染 72px"的两套真话。
 */
export const COMPANION_BUBBLE_MIN_HEIGHT_PX = 72;

/**
 * 气泡向上能长到多高（px）。
 *
 * 气泡底边是钉死的（CSS `bottom: calc(100% + 12px)`），所以它能长多高取决于**它离视口顶
 * 还有多远**减去头顶那块预算（步骤轨道 + 两端留白）。这两个数一个来自 `getBoundingClientRect`、
 * 一个来自 CSS 变量，纯 CSS 算不出来：气泡里的 `100%` 指的是 HUD 的高度，跟"到视口顶的距离"
 * 没有固定关系。没有这道钳制，320 字的回复能撑到 ~470px，把气泡连头顶轨道一起顶出窗口。
 */
export function companionBubbleMaxHeightPx(
  bubbleBottom: number,
  reserve: number,
  minPx: number = COMPANION_BUBBLE_MIN_HEIGHT_PX,
): number {
  if (!Number.isFinite(bubbleBottom) || !Number.isFinite(reserve)) return minPx;
  return Math.max(minPx, Math.round(bubbleBottom - reserve));
}

/**
 * 没有语音时的阅读节奏：约 60ms 一个字，两端各设护栏。
 *
 * 这个数字是**同一条时间线**的兜底节奏，所以对外导出：`companion-reveal-driver` 按它
 * 推进"该露多少字"，这里是唯一一份真话（不许两处各写一个 60）。
 */
export const COMPANION_READ_MS_PER_CHAR = 60;
const READ_MIN_MS = 1_200;
const READ_MAX_MS = 12_000;

/**
 * 已念完的字数 → 气泡里应显示的文本。
 *
 * `spokenChars` 来自真实播放进度（见 companion-voice-playback）；音频播不了时由
 * 调用方按 `estimateCompanionReadDurationMs` 推进同一个计数——那是"阅读计时器"，
 * 不是假装在播语音。
 */
export function companionBubbleText(text: string, spokenChars: number): string {
  const full = text.trim();
  const visible = spokenChars >= full.length ? full : full.slice(0, Math.max(0, spokenChars));
  if (visible.length <= COMPANION_BUBBLE_MAX_CHARS) return visible;
  return `${visible.slice(0, COMPANION_BUBBLE_MAX_CHARS)}…`;
}

/** 纯计时器的停留时长；与 `companionBubbleText` 搭配使用。 */
export function estimateCompanionReadDurationMs(charCount: number): number {
  const raw = Math.round(Math.max(0, charCount) * COMPANION_READ_MS_PER_CHAR);
  return Math.min(READ_MAX_MS, Math.max(READ_MIN_MS, raw));
}

/** 气泡装不下这条回复：需要给出去抽屉看全文的入口。 */
export function companionBubbleOverflows(text: string): boolean {
  return text.trim().length > COMPANION_BUBBLE_MAX_CHARS;
}
