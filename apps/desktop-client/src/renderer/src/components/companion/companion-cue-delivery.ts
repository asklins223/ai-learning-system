import type { CompanionActivityDeliveryV1 } from "@ailearn/shared/companion-memory-desktop-contracts";

/**
 * 主动气泡的「她真的说过」回执。
 *
 * 服务端把每一次主动开口写成一条 `assistant_deliveries`（`kind='system_event'`），
 * 而两条规则都建立在"这一条被看见过"之上：
 * - 念头日预算（`companion-thought.ts` 的 `delivered_today`）只算 opened/displayed/
 *   acted/dismissed，避免从没露出的念头白占一天的额度；
 * - 划走降权（`proactive-hook.ts` 的 `feedbackStates`）只看已送达之后的状态。
 * 可是首页气泡这一路从来没人回执过：实测 22 条 system_event 里 21 条停在 `queued`，
 * 唯一一条 `displayed` 来自伴星中心动态页。也就是说预算的"被看见"这一栏永远是 0，
 * 上面两条闸都建在不存在的数据上。
 *
 * 这里只补回执，不改判定：气泡在屏幕上露出来 → `displayed`；用户点开她的原话 → `acted`。
 * 停留时长不够、被焦点打断而没露出的那些**不算**——那正是这次要区分开的东西。
 */

export interface CueDeliveryRef {
  readonly deliveryId: string;
  readonly inboxSequence: number;
}

/**
 * 投影里 cue 的 `revision` 就是投递行的 `inboxSequence`（`readProactiveCue` 直接取它），
 * 所以按 sequence 精确认领。`proactiveCue` 里没有 deliveryId，只能这样对回来。
 *
 * 对不上就返回 null：动态时间线是一页最新 50 条，取"第一条"会在有更新的投递挤进来时
 * 把回执写到一条从没露出过的气泡上——那正是这次要消灭的那类谎。
 */
export function findCueDelivery(
  items: readonly CompanionActivityDeliveryV1[],
  inboxSequence: number,
): CueDeliveryRef | null {
  const hit = items.find((item) => item.inboxSequence === inboxSequence);
  return hit ? { deliveryId: hit.deliveryId, inboxSequence: hit.inboxSequence } : null;
}

export interface CueDeliveryReporterDeps {
  readonly lookup: (inboxSequence: number) => Promise<CueDeliveryRef | null>;
  readonly present: (ref: CueDeliveryRef) => Promise<unknown>;
  readonly act: (ref: CueDeliveryRef) => Promise<unknown>;
}

export interface CueDeliveryTarget {
  readonly cueKey: string;
  readonly inboxSequence: number;
}

/**
 * 每个「气泡 + 结果」只回执一次。
 *
 * 必须去重：揭示回调所在的 effect 依赖 `companionProjection.projection`，投影每刷新一次
 * （切页面、来新投递）它就重跑一遍，而 `prioritizedCue.key` 不变。
 * 失败要放开重来的机会：一次网络抖动不能把这条气泡的回执永久丢掉——丢了的后果不是
 * "少一条记录"，而是那一条**永远**不占额度，于是她能在一天里反复开口。
 */
export function createCueDeliveryReporter(deps: CueDeliveryReporterDeps) {
  const settled = new Set<string>();
  const refs = new Map<number, CueDeliveryRef>();

  const send = async (target: CueDeliveryTarget, outcome: "displayed" | "acted") => {
    const key = `${target.cueKey}:${outcome}`;
    if (settled.has(key)) return;
    settled.add(key);
    try {
      let ref = refs.get(target.inboxSequence);
      if (!ref) {
        const found = await deps.lookup(target.inboxSequence);
        // 只缓存找到的：一次翻页没赶上不是永久结论。
        if (found) refs.set(target.inboxSequence, found);
        ref = found ?? undefined;
      }
      if (!ref) {
        settled.delete(key);
        return;
      }
      await (outcome === "displayed" ? deps.present(ref) : deps.act(ref));
    } catch {
      settled.delete(key);
    }
  };

  return {
    shown: (target: CueDeliveryTarget) => send(target, "displayed"),
    opened: (target: CueDeliveryTarget) => send(target, "acted"),
  };
}
