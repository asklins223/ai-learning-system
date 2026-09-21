import { describe, expect, it, vi } from "vitest";
import type { CompanionActivityDeliveryV1 } from "@ailearn/shared/companion-memory-desktop-contracts";
import {
  createCueDeliveryReporter,
  findCueDelivery,
  type CueDeliveryRef,
} from "./companion-cue-delivery";

function delivery(overrides: Partial<CompanionActivityDeliveryV1> = {}): CompanionActivityDeliveryV1 {
  return {
    version: 1,
    deliveryId: "11111111-1111-4111-8111-111111111111",
    inboxSequence: 42,
    state: "queued",
    kind: "system_event",
    label: "「潮汐力」那张卡到点了",
    target: { kind: "none" },
    expired: false,
    createdAt: "2026-09-21T05:27:57.000Z",
    expiresAt: "2026-09-21T07:27:57.000Z",
    ...overrides,
  };
}

describe("主动气泡投递的认领（findCueDelivery）", () => {
  it("按 sequence 精确对上投影给出的那条 cue", () => {
    const ref = findCueDelivery([delivery({ inboxSequence: 43 }), delivery()], 42);
    expect(ref).toEqual<CueDeliveryRef>({
      deliveryId: "11111111-1111-4111-8111-111111111111",
      inboxSequence: 42,
    });
  });

  it("投影与时间线之间有写入间隙时不能拿最新一条顶替", () => {
    // cue.revision 就是投递行的 inboxSequence，对不上说明这一页里没有它。
    // 「取 items[0]」会把回执写到一个从没露出过的投递上，日预算立刻又开始说谎。
    expect(findCueDelivery([delivery({ inboxSequence: 44, deliveryId: "22222222-2222-4222-8222-222222222222" })], 42)).toBeNull();
    expect(findCueDelivery([], 42)).toBeNull();
  });
});

function harness() {
  const lookup = vi.fn(async (): Promise<CueDeliveryRef | null> => ({
    deliveryId: "11111111-1111-4111-8111-111111111111",
    inboxSequence: 42,
  }));
  const present = vi.fn(async () => undefined);
  const act = vi.fn(async () => undefined);
  const reporter = createCueDeliveryReporter({ lookup, present, act });
  return { lookup, present, act, reporter };
}

describe("主动气泡的展示回执", () => {
  it("气泡露出即回执 displayed——服务端只认这一条来判断「她真的说过」", async () => {
    const { reporter, present } = harness();
    await reporter.shown({ cueKey: "ordinary:42", inboxSequence: 42 });
    expect(present).toHaveBeenCalledTimes(1);
    expect(present).toHaveBeenCalledWith({
      deliveryId: "11111111-1111-4111-8111-111111111111",
      inboxSequence: 42,
    });
  });

  it("同一条气泡因投影刷新重跑一遍生命周期，不会重复回执", async () => {
    const { reporter, present, lookup } = harness();
    await reporter.shown({ cueKey: "ordinary:42", inboxSequence: 42 });
    await reporter.shown({ cueKey: "ordinary:42", inboxSequence: 42 });
    expect(present).toHaveBeenCalledTimes(1);
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it("下一念头是新的一条，必须还能回执", async () => {
    const { reporter, present } = harness();
    await reporter.shown({ cueKey: "ordinary:42", inboxSequence: 42 });
    await reporter.shown({ cueKey: "ordinary:47", inboxSequence: 47 });
    expect(present).toHaveBeenCalledTimes(2);
  });

  it("点开是 acted，与 displayed 各记一次，且共用同一次投递查找", async () => {
    const { reporter, present, act, lookup } = harness();
    await reporter.shown({ cueKey: "ordinary:42", inboxSequence: 42 });
    await reporter.opened({ cueKey: "ordinary:42", inboxSequence: 42 });
    expect(act).toHaveBeenCalledTimes(1);
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it("找不到对应投递时一条回执都不发", async () => {
    const present = vi.fn();
    const act = vi.fn();
    const reporter = createCueDeliveryReporter({
      lookup: vi.fn(async () => null),
      present,
      act,
    });
    await reporter.shown({ cueKey: "ordinary:42", inboxSequence: 42 });
    await reporter.opened({ cueKey: "ordinary:42", inboxSequence: 42 });
    expect(present).not.toHaveBeenCalled();
    expect(act).not.toHaveBeenCalled();
  });

  it("回执失败不打扰用户，但下一次露出还会重试", async () => {
    const present = vi.fn()
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce(undefined);
    const reporter = createCueDeliveryReporter({
      lookup: vi.fn(async () => ({
        deliveryId: "11111111-1111-4111-8111-111111111111",
        inboxSequence: 42,
      })),
      present,
      act: vi.fn(),
    });
    await expect(reporter.shown({ cueKey: "ordinary:42", inboxSequence: 42 })).resolves.toBeUndefined();
    await reporter.shown({ cueKey: "ordinary:42", inboxSequence: 42 });
    expect(present).toHaveBeenCalledTimes(2);
  });

  it("这一页暂时找不到那条投递时，下一次露出要重新找", async () => {
    // 动态时间线是一页最新 50 条。刚入队的念头投影先到、时间线后到是正常顺序，
    // 把"这一次没找到"当成永久结论，气泡的回执就再也发不出去了。
    let lookups = 0;
    const lookup = vi.fn(async (): Promise<CueDeliveryRef | null> => {
      lookups += 1;
      return lookups === 1 ? null : {
        deliveryId: "11111111-1111-4111-8111-111111111111",
        inboxSequence: 42,
      };
    });
    const present = vi.fn();
    const reporter = createCueDeliveryReporter({ lookup, present, act: vi.fn() });
    await reporter.shown({ cueKey: "ordinary:42", inboxSequence: 42 });
    expect(present).not.toHaveBeenCalled();
    await reporter.shown({ cueKey: "ordinary:42", inboxSequence: 42 });
    expect(present).toHaveBeenCalledTimes(1);
  });

  it("查找失败不留脏缓存", async () => {
    let lookups = 0;
    const lookup = vi.fn(async (): Promise<CueDeliveryRef | null> => {
      lookups += 1;
      if (lookups === 1) throw new Error("timeout");
      return {
        deliveryId: "11111111-1111-4111-8111-111111111111",
        inboxSequence: 42,
      };
    });
    const present = vi.fn();
    const reporter = createCueDeliveryReporter({ lookup, present, act: vi.fn() });
    await reporter.shown({ cueKey: "ordinary:42", inboxSequence: 42 });
    expect(present).not.toHaveBeenCalled();
    await reporter.shown({ cueKey: "ordinary:42", inboxSequence: 42 });
    expect(present).toHaveBeenCalledTimes(1);
  });
});
