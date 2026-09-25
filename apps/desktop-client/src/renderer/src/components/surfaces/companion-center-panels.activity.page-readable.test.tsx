// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ActivityPanel } from "./companion-center-panels";
import {
  companionJourneyBootstrapSchema,
  type CompanionJourneyBootstrap,
} from "@ailearn/shared/companion-journey-contracts";
import {
  companionActivityDeliveryV1Schema,
  type CompanionActivityDeliveryV1,
} from "@ailearn/shared/companion-memory-desktop-contracts";
import { useRoomStore } from "../../app/room-store";
import type { PageReadableV1 } from "@ailearn/shared/companion-bridge-contracts";

/**
 * 伴星中心「动态」这一块登记给伴星读的是什么（39d W2-7）。
 *
 * 这一屏是**三段各说一句**（继续学习／伴星旅程／最近动态），所以 `state` 一律是
 * "这一行来自哪一段"（同一个字段只准有一个含义），投递自己那层"待处理／已失效"
 * 不混进来。**收在 `<details>` 里的历史动态不是屏幕此刻露出的行**：那条分组标题
 * 写着条数，所以条数进 `notice`，行本身一条都不登记。
 */

type ActivityPanelProps = Parameters<typeof ActivityPanel>[0];

const noop = () => undefined;

const USER_ID = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";

function bootstrap(overrides: Record<string, unknown> = {}): CompanionJourneyBootstrap {
  return companionJourneyBootstrapSchema.parse({
    invitation: {
      version: 2,
      userId: USER_ID,
      status: "accepted",
      offeredAt: null,
      decidedAt: null,
      deferredUntil: null,
      replayRequestedAt: null,
      revision: 1,
    },
    journey: null,
    ...overrides,
  });
}

function journey(overrides: Record<string, unknown> = {}) {
  return {
    version: 2,
    journeyId: "33333333-3333-4333-8333-333333333333",
    userId: USER_ID,
    workspaceId: WORKSPACE_ID,
    assistantSessionId: null,
    status: "active",
    branch: "own_material",
    currentStep: null,
    stepRevision: 0,
    dismissedNarrationSteps: [],
    refs: {},
    lastDomainEventId: null,
    pausedAt: null,
    pauseReason: null,
    resumeTokenRef: null,
    resumeExpiresAt: null,
    completionKind: null,
    error: null,
    revision: 1,
    ...overrides,
  };
}

function delivery(id: number, label: string, state: CompanionActivityDeliveryV1["state"], expired = false): CompanionActivityDeliveryV1 {
  return companionActivityDeliveryV1Schema.parse({
    version: 1,
    deliveryId: `44444444-4444-4444-8444-00000000000${id}`,
    inboxSequence: id,
    state,
    kind: "message",
    label,
    target: { kind: "none" },
    expired,
    createdAt: "2026-09-24T00:00:00.000Z",
    expiresAt: "2026-10-24T00:00:00.000Z",
  });
}

function timeline(items: CompanionActivityDeliveryV1[] = []) {
  return {
    version: 1 as const,
    items,
    nextCursor: 0,
    serverTime: "2026-09-25T00:00:00.000Z",
  };
}

const unavailableSection = { ok: false, message: "服务暂时不可用" } as const;

function renderPanel(props: Partial<ActivityPanelProps> = {}) {
  const base: ActivityPanelProps = {
    section: { ok: true, value: bootstrap() },
    learningContextSection: unavailableSection,
    deliverySection: { ok: true, value: timeline() },
    deliveries: [],
    busy: false,
    error: null,
    onStart: noop,
    onAction: noop,
    onResumeLearning: noop,
    onOpenObjective: noop,
    onPresent: noop,
    onDelivery: noop,
    onRetry: noop,
  };
  render(<ActivityPanel {...base} {...props} />);
}

function publishedView(): PageReadableV1 | null {
  return useRoomStore.getState().pageReadableView?.view ?? null;
}

afterEach(() => {
  cleanup();
  useRoomStore.setState({ pageReadableView: null });
});

describe("伴星中心 · 动态：三段各说各的，折叠里的不算露出", () => {
  it("三段都在说「没有」：登记三行，每行都标着自己属于哪一段", () => {
    renderPanel();
    const view = publishedView()!;
    expect(view.pageId).toBe("companion");
    expect(view.title).toBe("伴星中心");
    const cards = [...document.querySelectorAll(".companion-section-state strong")].map((node) => node.textContent);
    expect(cards).toHaveLength(3);
    expect(view.items?.map((entry) => entry.label)).toEqual(cards);
    expect(view.items?.map((entry) => entry.ordinal)).toEqual([1, 2, 3]);
    expect(view.items?.map((entry) => entry.state)).toEqual(
      [...document.querySelectorAll(".companion-activity-feed > h4")].map((node) => node.textContent),
    );
    expect(view.notice).toBeUndefined();
  });

  it("旅程进行中：登记的是那张卡自己写着的标题", () => {
    renderPanel({ section: { ok: true, value: bootstrap({ journey: journey() }) } });
    const view = publishedView()!;
    const journeyTitle = document.querySelector(".companion-activity-card.is-journey strong")?.textContent;
    expect(journeyTitle).toBe("旅程状态");
    expect(view.items?.map((entry) => entry.label)).toContain(journeyTitle);
  });

  it("有历史动态时：折叠里的行一条都不登记，只有那行标题上的条数进 notice", () => {
    renderPanel({
      deliverySection: { ok: true, value: timeline() },
      deliveries: [
        delivery(1, "第三章那段还缺一个反例", "delivered"),
        delivery(2, "上一轮已经答过", "acted"),
        delivery(3, "更早的一条", "dismissed"),
      ],
    });
    const view = publishedView()!;
    expect(view.items?.map((entry) => entry.label)).toContain("第三章那段还缺一个反例");
    expect(view.items?.map((entry) => entry.label)).not.toContain("上一轮已经答过");
    expect(view.items?.map((entry) => entry.label)).not.toContain("更早的一条");
    expect(view.notice).toBe(document.querySelector(".companion-delivery-group summary")?.textContent);
    expect(view.notice).toBe("历史动态 · 2 条");
  });

  it("报错那一行写什么，statusLine 就是什么", () => {
    renderPanel({ error: "主动投递这次没读出来" });
    expect(publishedView()!.statusLine).toBe(document.querySelector(".companion-error")?.textContent);
  });
});
