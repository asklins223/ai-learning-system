import { describe, expect, it } from "vitest";
import {
  anomalyPhase,
  anomalyStep,
  buildTodayAnomalyGroups,
  buildTodayLogRows,
  buildTodayVerdict,
  formatLogTime,
  sharedAnomalyStep,
  sortAnomalyGroups,
  todayAnomalyTruncationNote,
  todayLogTruncationNote,
  todaySpan,
} from "./today-log";
import type { ActivityAnomalyV1, ActivityEventV1, TodayActivityV1 } from "@ailearn/shared/activity-surface-contracts";

function anomaly(overrides: Partial<ActivityAnomalyV1> = {}): ActivityAnomalyV1 {
  return {
    id: "anomaly.card_generation:r1",
    kind: "card_generation",
    status: "needs_attention",
    title: "《笔记》的卡片生成",
    detail: "服务端要求你先判断",
    occurredAt: at(10, 0),
    target: { kind: "card_generation", id: "r1", noteVersionId: null },
    ...overrides,
  };
}

/** 本地钟面测试：时间标签按读者本地时钟渲染，固件用本地时间构造。 */
function at(hour: number, minute: number): string {
  return new Date(2026, 8, 18, hour, minute).toISOString();
}

function event(overrides: Partial<ActivityEventV1> = {}): ActivityEventV1 {
  return {
    id: "note.created:n1",
    at: at(9, 5),
    kind: "note",
    verb: "note.created",
    title: "牛顿第二定律",
    detail: null,
    target: { kind: "note", id: "n1", noteVersionId: null },
    ...overrides,
  };
}

describe("formatLogTime", () => {
  it("renders HH:MM in the reader's own clock", () => {
    expect(formatLogTime(at(9, 5))).toBe("09:05");
    expect(formatLogTime(at(15, 40))).toBe("15:40");
  });

  it("never crashes on a missing timestamp", () => {
    expect(formatLogTime("")).toBe("--:--");
  });
});

describe("buildTodayLogRows", () => {
  it("keeps the server's newest-first order and labels each row", () => {
    const rows = buildTodayLogRows([
      event({ id: "note.updated:n1", at: at(14, 0), verb: "note.updated" }),
      event({ id: "note.created:n1", at: at(9, 5) }),
    ]);
    expect(rows.map((row) => row.id)).toEqual(["note.updated:n1", "note.created:n1"]);
    expect(rows[0].time).toBe("14:00");
    expect(rows[0].action).toBe("更新笔记");
    expect(rows[0].kindLabel).toBe("笔记");
    expect(rows[1].action).toBe("新建笔记");
  });

  it("keeps jump targets so every row can be traced back", () => {
    const rows = buildTodayLogRows([event()]);
    expect(rows[0].target).toEqual({ kind: "note", id: "n1", noteVersionId: null });
  });

  it("keeps display-only rows (target null) targetless", () => {
    const rows = buildTodayLogRows([
      event({ id: "learning_run.completed:r1", verb: "learning_run.completed", kind: "learning_run", target: null }),
    ]);
    expect(rows[0].target).toBeNull();
  });
});

describe("todaySpan", () => {
  it("reads the day's window from today's operations only", () => {
    // 异常事务是按"今天或近期"查的，实测跨到了前一天；混进来会得到
    // "22:43 – 19:50" 这种倒挂区间。所以只认正向操作。
    expect(todaySpan({ events: [event(), event({ id: "note.updated:n1", at: at(16, 30) })] })).toBe(
      "09:05 – 16:30",
    );
  });

  it("does not draw a range out of a single moment", () => {
    expect(todaySpan({ events: [event()] })).toBe("09:05");
  });

  it("has nothing to draw when the day is empty", () => {
    expect(todaySpan({ events: [] })).toBeNull();
  });
});

describe("buildTodayVerdict", () => {
  it("leads with the numbers and keeps the sentence free of them", () => {
    // 数字进 metrics、判断进 headline —— 同一屏不能把同一个数说两遍。
    const verdict = buildTodayVerdict({
      events: [event(), event({ id: "note.updated:n1", at: at(14, 0), verb: "note.updated" })],
      anomalies: [anomaly()],
      truncated: false,
    });
    expect(verdict.metrics.map((metric) => `${metric.label}${metric.value}`)).toEqual([
      "记录2",
      "待处理1",
      "时段09:05 – 14:00",
    ]);
    expect(verdict.headline).toBe("有事务停在半路，处理完就能继续推进");
    expect(verdict.detail).toBe("笔记 2");
  });

  it("says the day is clear when nothing is stuck", () => {
    const verdict = buildTodayVerdict({
      events: [event(), event({ id: "source.created:s1", kind: "source", verb: "source.created" })],
      anomalies: [],
      truncated: false,
    });
    expect(verdict.headline).toBe("今天的操作都推进得顺利");
    expect(verdict.detail).toBe("笔记 1 · 来源 1");
    expect(verdict.metrics.some((metric) => metric.key === "pending")).toBe(false);
  });

  it("does not dress an empty day up with two zeroes", () => {
    const verdict = buildTodayVerdict({ events: [], anomalies: [], truncated: false });
    expect(verdict.metrics).toEqual([]);
    expect(verdict.headline).toBe("今天还没有留下记录");
  });

  it("keeps the plus sign when the server capped the log", () => {
    const verdict = buildTodayVerdict({ events: [event()], anomalies: [], truncated: true });
    expect(verdict.metrics[0].value).toBe("1+");
  });
});

describe("anomaly triage", () => {
  it("puts the thickest pile first", () => {
    // 服务端给的是时间倒序，×3 那组排在最后；分诊要把它翻到最前。
    const groups = sortAnomalyGroups(
      buildTodayAnomalyGroups([
        anomaly({ id: "anomaly.card_generation:a", title: "《甲》的卡片生成" }),
        anomaly({ id: "anomaly.card_generation:b", title: "《乙》的卡片生成" }),
        anomaly({ id: "anomaly.card_generation:b2", title: "《乙》的卡片生成" }),
        anomaly({ id: "anomaly.card_generation:b3", title: "《乙》的卡片生成" }),
      ]),
    );
    expect(groups.map((group) => [group.title, group.count])).toEqual([
      ["《乙》的卡片生成", 3],
      ["《甲》的卡片生成", 1],
    ]);
  });

  it("hoists a step that every group repeats", () => {
    const groups = buildTodayAnomalyGroups([
      anomaly({ id: "a1", title: "《甲》的卡片生成" }),
      anomaly({ id: "a2", title: "《乙》的卡片生成" }),
    ]);
    expect(sharedAnomalyStep(groups)).toBe("需要处理 · 服务端要求你先判断");
  });

  it("does not hoist a step that belongs to one group only", () => {
    const groups = buildTodayAnomalyGroups([
      anomaly({ id: "a1", title: "《甲》的卡片生成" }),
      anomaly({ id: "a2", title: "《乙》的卡片生成", detail: "证据对不上，需要重新对齐" }),
    ]);
    expect(sharedAnomalyStep(groups)).toBeNull();
    // 一组的处置语没有 detail 时只说状态词，不留一个悬空的分隔点。
    expect(anomalyStep(groups[1])).toBe("需要处理 · 证据对不上，需要重新对齐");
    expect(anomalyStep(buildTodayAnomalyGroups([anomaly({ detail: null })])[0])).toBe("需要处理");
  });
});

describe("todayLogTruncationNote", () => {
  it("discloses the cap only when the server says so", () => {
    expect(todayLogTruncationNote({ events: [], truncated: false })).toBeNull();
    const note = todayLogTruncationNote({ events: [event()], truncated: true });
    expect(note).toContain("1 条");
  });
});

describe("anomalyPhase", () => {
  it("calls a stuck learning run broken even though its phase looks in flight", () => {
    // 卡住的旅程 phase 仍是 active/preparing；给它转轮等于骗读者"正在推进"。
    expect(anomalyPhase({ kind: "learning_run", status: "active" })).toBe("broken");
    expect(anomalyPhase({ kind: "learning_run", status: "preparing" })).toBe("broken");
  });

  it("separates waiting from broken for everything else", () => {
    expect(anomalyPhase({ kind: "job", status: "running" })).toBe("inflight");
    expect(anomalyPhase({ kind: "job", status: "failed" })).toBe("broken");
    expect(anomalyPhase({ kind: "card_generation", status: "needs_attention" })).toBe("broken");
  });
});

describe("buildTodayAnomalyGroups", () => {
  it("maps server statuses to reader labels", () => {
    const groups = buildTodayAnomalyGroups([
      anomaly(),
      anomaly({
        id: "anomaly.job:j1",
        kind: "job",
        status: "dead",
        title: "后台任务已重试耗尽",
        detail: null,
        occurredAt: at(11, 0),
        target: { kind: "source", id: "j1", noteVersionId: null },
      }),
    ]);
    expect(groups.map((group) => group.statusLabel)).toEqual(["需要处理", "重试耗尽"]);
  });

  it("collapses repeats of the same thing and counts them", () => {
    // 真实数据：26 条异常只有 4 个不同标题，逐条渲染就是一堵分不清的墙。
    const groups = buildTodayAnomalyGroups([
      anomaly(),
      anomaly({ id: "anomaly.card_generation:r2", occurredAt: at(10, 30), target: { kind: "card_generation", id: "r2", noteVersionId: null } }),
      anomaly({ id: "anomaly.card_generation:r3", occurredAt: at(9, 0), target: { kind: "card_generation", id: "r3", noteVersionId: null } }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].count).toBe(3);
    // 服务端按时间倒序，所以跳转取的是最近的那一条。
    expect(groups[0].target).toEqual({ kind: "card_generation", id: "r1", noteVersionId: null });
  });

  it("keeps a jump target when the server could resolve one, and null otherwise", () => {
    const withTarget = buildTodayAnomalyGroups([anomaly()]);
    expect(withTarget[0].target).not.toBeNull();
    const without = buildTodayAnomalyGroups([anomaly({ id: "anomaly.job:j2", kind: "job", target: null })]);
    expect(without[0].target).toBeNull();
  });
});

describe("todayAnomalyTruncationNote", () => {
  it("discloses the anomaly cap only when the server says so", () => {
    expect(todayAnomalyTruncationNote({ anomaliesTruncated: false })).toBeNull();
    expect(todayAnomalyTruncationNote({ anomaliesTruncated: true })).toContain("只列最近");
  });
});
