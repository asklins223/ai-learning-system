/**
 * 回复气泡的显现模型（2026-09-18）。
 *
 * 气泡要回答两个问题：现在该露出哪些字、没有语音可播时该停留多久。
 * 都是纯计算，放在这里而不是组件里，好让边界（还没开口、念到一半、
 * 超出预览容量）直接单测。
 */

/** 收起态保留的最新文字长度；展开态可以在气泡里滚动阅读全文。 */
export const COMPANION_BUBBLE_MAX_CHARS = 320;

/**
 * 气泡的视觉下限（px）：**脚本还没跑起来时的兜底值**，也是 `companionBubbleLineHeights`
 * 测不到行高时的退化值。运行时的高度来自那两个实测函数，写进 `companion-hud.css` 的
 * `min-height: var(--companion-bubble-min-h, 72px)` / `max-height: var(--companion-bubble-max-h, …)`
 * ——CSS 里那份兜底与本值对齐，两处不许各说各话。
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
 * 气泡的高度必须落在**整行**上（2026-09-20 用户反馈："自动就给我滚动下去了，上一行
 * 只能看到半截"）。
 *
 * 长回复装满气泡后，正文在内部滚动、跟随把最新一行钉在底部：只要容器高度不是行高的
 * 整数倍，钉底之后**最上面那一行永远是半截**——它被容器的上边缘切开。把上下限都对齐到
 * 行高网格，`scrollTop` 的落点就必然是行高的整数倍，露出来的每一行都是完整的一行；
 * 短回复（装得下、不滚）也顺带拿到"整行高度的气泡"，不会出现半行留白。
 *
 * `chrome` 是正文以外的垂直占用（上下内边距 + 边框 + 失败说明行 + 生成期给胶囊留的
 * 留白）——它随窗口断点、胶囊在场与否变化，所以由调用方实测传入，不在这里写死。
 * 容量不够放两行时退回一行：宁可气泡比预算略高（头顶轨道在实际渲染里是收起态），
 * 也不要交出一个半行。
 */
export function companionBubbleLineHeights(input: {
  /** 气泡底边到视口顶之间还能用多少（`companionBubbleMaxHeightPx` 的结果）。 */
  readonly available: number;
  /** 正文以外的垂直占用；测不出来时传 NaN。 */
  readonly chrome: number;
  /** 一行的行高（`getComputedStyle(body).lineHeight`）；测不出来时传 NaN。 */
  readonly lineHeight: number;
}): { readonly minHeight: number; readonly maxHeight: number } {
  const usableLine = Number.isFinite(input.lineHeight) && input.lineHeight > 0 ? input.lineHeight : 0;
  const usableChrome = Number.isFinite(input.chrome) && input.chrome > 0 ? input.chrome : 0;
  const available = Number.isFinite(input.available) && input.available > 0 ? input.available : 0;
  // 测量还没到位（气泡不在 / 样式未落）：退回"只有下限"的老行为，别把高度写成 NaN。
  if (usableLine === 0) {
    const maxHeight = Math.max(COMPANION_BUBBLE_MIN_HEIGHT_PX, Math.round(available));
    return { minHeight: COMPANION_BUBBLE_MIN_HEIGHT_PX, maxHeight };
  }
  const lines = Math.max(1, Math.floor((available - usableChrome) / usableLine));
  const minHeight = Math.round(usableChrome + usableLine);
  const maxHeight = Math.max(minHeight, Math.round(usableChrome + lines * usableLine));
  return { minHeight, maxHeight };
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

/** 收起态始终跟随最新文字；展开态由调用方直接显示已到达的全文。 */
export function companionBubblePreviewText(text: string, revealedChars: number): string {
  const full = text.trim();
  const visible = revealedChars >= full.length ? full : full.slice(0, Math.max(0, revealedChars));
  if (visible.length <= COMPANION_BUBBLE_MAX_CHARS) return visible;
  return `…${visible.slice(-COMPANION_BUBBLE_MAX_CHARS)}`;
}

/** 纯计时器的停留时长；与 `companionBubbleText` 搭配使用。 */
export function estimateCompanionReadDurationMs(charCount: number): number {
  const raw = Math.round(Math.max(0, charCount) * COMPANION_READ_MS_PER_CHAR);
  return Math.min(READ_MAX_MS, Math.max(READ_MIN_MS, raw));
}

/**
 * 回复念完后的停留时长（2026-09-19 方案 §3）：旧实现固定 1.1s，长内容根本读不完。
 * 这里按文字长度自适应 2.4–6s：起步 2.4s，每字 +12ms——300 字（气泡容量上限）时
 * 正好到 6s 封顶。悬停、聚焦、待选卡片、朗读中的暂停语义由调用方实现，这里只算
 * "该停留多久"这一个纯量。
 */
const HOLD_BASE_MS = 2_400;
const HOLD_MAX_MS = 6_000;
const HOLD_MS_PER_CHAR = 12;

export function companionBubbleHoldMs(charCount: number): number {
  const extra = Math.max(0, Math.floor(charCount)) * HOLD_MS_PER_CHAR;
  return Math.min(HOLD_MAX_MS, HOLD_BASE_MS + extra);
}
