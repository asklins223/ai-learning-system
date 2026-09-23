/**
 * 气泡正文的跟随滚动（2026-09-20）。
 *
 * 长回复在气泡里是"文字自己在滚"（`.companion-hud__output p` 的 `overflow-y: auto`），
 * 而新字永远从底部冒出来。没有人把它往下推时，用户盯着的永远是开头那几行，最新的字
 * 长在视野之外——长消息在气泡里看起来像卡住不动（2026-09-20 用户截图）。
 *
 * 跟随必须是**可被用户推翻**的：他往上滚去看前文时不能被拽回来；他自己回到底部、
 * 或换了一轮新回复时，跟随恢复。所以这里只有一条纯判据：此刻算不算"还在底部"。
 */

/**
 * 离底多少像素以内算"还在底部"。
 *
 * 取一行文字的高度量级：滚动条浮点误差、尾行贴着底边的余量都不该被读成"用户在往回读"，
 * 而真正的回读动作（滚轮一格）远大于这个数。
 */
export const COMPANION_BUBBLE_FOLLOW_SLACK_PX = 24;

interface CompanionBubbleScrollState {
  readonly scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
}

/**
 * 此刻是否在底部（在容差内）。
 *
 * 内容比容器矮时 `scrollHeight - clientHeight` 为 0、距离是负数，同样算在底部：
 * 还没有滚动条的短消息天然处于"跟随"状态。
 */
export function companionBubbleAtBottom(state: CompanionBubbleScrollState): boolean {
  return state.scrollHeight - state.scrollTop - state.clientHeight <= COMPANION_BUBBLE_FOLLOW_SLACK_PX;
}

export interface CompanionBubbleFollow {
  /** 有人滚了一下（用户滚轮 / 拖动滚动条，或程序自己钉底）：按此刻的位置决定还跟不跟。 */
  noteScroll(state: CompanionBubbleScrollState): void;
  /** 新一轮（新气泡挂载）：回到"跟随"。 */
  reset(): void;
  /**
   * 跟随中该钉到的位置；用户已经接管（自己在往上读）时返回 `null`——调用方什么都不做。
   * 返回的是 `scrollHeight`：赋给 `scrollTop` 后由浏览器钳到真正的底部。
   */
  pinnedScrollTop(state: CompanionBubbleScrollState): number | null;
  readonly following: boolean;
}

/**
 * 跟随的**状态机**只有一件事要记：用户接管了没有。
 *
 * 判据全在 `companionBubbleAtBottom` 上，这里只是把"什么时候重新跟随"的规则收在一处：
 * 用户回到底部（或换了新一轮）就跟着走，否则让位给他。做成纯对象而不是组件里的一个
 * `useRef<boolean>`，是为了让"往上滚 → 不再抢位置 → 回到底部 → 恢复"这条链能在单测里
 * 跑一遍——回复太短的线上轮次根本等不到第二次滚动，就看不见这个分支。
 */
export function createCompanionBubbleFollow(): CompanionBubbleFollow {
  let following = true;
  return {
    noteScroll(state: CompanionBubbleScrollState): void {
      following = companionBubbleAtBottom(state);
    },
    reset(): void {
      following = true;
    },
    pinnedScrollTop(state: CompanionBubbleScrollState): number | null {
      return following ? state.scrollHeight : null;
    },
    get following(): boolean {
      return following;
    },
  };
}
