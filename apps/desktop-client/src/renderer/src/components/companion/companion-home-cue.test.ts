import { describe, expect, it } from "vitest";
import {
  COMPANION_ORDINARY_CUE_DEBOUNCE_MS,
  companionCueAllowed,
  companionCueRank,
  shouldCompanionBorrowPlacement,
  type CompanionCuePriority,
} from "./companion-home-placement";

const PRIORITY_ORDER: readonly CompanionCuePriority[] = [
  "ordinary",
  "due-review",
  "active-learning",
  "interrupted-task",
  "sync-error",
];

describe("companion cue arbitration", () => {
  it("ranks the five priorities as sync-error > interrupted-task > active-learning > due-review > ordinary", () => {
    const ranks = PRIORITY_ORDER.map(companionCueRank);
    for (let index = 1; index < ranks.length; index += 1) {
      expect(ranks[index]).toBeGreaterThan(ranks[index - 1]);
    }
  });
});

/**
 * 客户端这一层**不再定义"她多久主动说一次"**——那是服务端的
 * `PROACTIVE_CADENCE_MS(intervention_level)`（用户 2026-09-21 的口径：
 * 按偏好定频率，触发式不进频率限制）。
 *
 * 原来这里还有第二套节奏：quiet 档是 `null` = **永不**。它比服务端更狠——
 * 用户设成"安静"之后，哪怕服务端放行了一条，客户端也会把它吞掉，
 * 而且吞掉的时候没有任何记录（体感就是"她从不主动提醒"，抱怨 #8 的另一半）。
 * 现在只剩一个固定去抖：投影会在一次揭示节拍里刷新多次，别把同一次开口叠成两个气泡。
 */
describe("主动气泡的显示闸", () => {
  it("节奏不在客户端：只剩一个固定去抖", () => {
    expect(COMPANION_ORDINARY_CUE_DEBOUNCE_MS).toBe(90_000);
  });

  it("例行念头：去抖之内不叠第二条，去抖一到就放行", () => {
    const now = 1_000_000_000;
    expect(companionCueAllowed({
      origin: "thought", priority: "ordinary", lastOrdinaryCueAt: now - 89_000, now,
    })).toBe(false);
    expect(companionCueAllowed({
      origin: "thought", priority: "ordinary", lastOrdinaryCueAt: now - 90_000, now,
    })).toBe(true);
    expect(companionCueAllowed({
      origin: "thought", priority: "ordinary", lastOrdinaryCueAt: 0, now,
    })).toBe(true);
  });

  it("触发式（到点提醒、系统事件）永远不被去抖吞掉", () => {
    const now = 1_000_000_000;
    for (const origin of ["reminder", "system"] as const) {
      expect(companionCueAllowed({
        origin, priority: "ordinary", lastOrdinaryCueAt: now, now,
      })).toBe(true);
    }
  });

  it("读不到上次时间（隐私模式/第一次）不能判成「刚说过」", () => {
    // 读不到时按 0 处理，所以 `now` 必须是真实墙钟毫秒：拿 1000 当 now，
    // "0 + 去抖"就已经超过了它，这条测试会在错误的数量级上假装通过。
    const now = 1_790_000_000_000;
    expect(companionCueAllowed({
      origin: "thought", priority: "ordinary", lastOrdinaryCueAt: Number.NaN, now,
    })).toBe(true);
  });

  it("非 ordinary 优先级不受这条闸管（它们本来就走另一条通道）", () => {
    const now = 1_000_000_000;
    for (const priority of PRIORITY_ORDER.filter((entry) => entry !== "ordinary")) {
      expect(companionCueAllowed({
        origin: "thought", priority, lastOrdinaryCueAt: now, now,
      })).toBe(true);
    }
  });
});

describe("companion placement borrowing", () => {
  it("never borrows a user-chosen world position, including for key reminders", () => {
    expect(shouldCompanionBorrowPlacement({ priority: "due-review", placementOwner: "user", dragging: false })).toBe(false);
    expect(shouldCompanionBorrowPlacement({ priority: "sync-error", placementOwner: "user", dragging: false })).toBe(false);
    expect(shouldCompanionBorrowPlacement({ priority: "ordinary", placementOwner: "user", dragging: false })).toBe(false);
  });

  it("never borrows while a semantic anchor owns placement or a pointer is active", () => {
    expect(shouldCompanionBorrowPlacement({ priority: "due-review", placementOwner: "semantic", dragging: false })).toBe(false);
    expect(shouldCompanionBorrowPlacement({ priority: "due-review", placementOwner: "user", dragging: true })).toBe(false);
  });
});
