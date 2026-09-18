import { describe, expect, it } from "vitest";
import {
  MEMORY_FAMILIES,
  STAR_CAPTION_MAX_LENGTH,
  curveControlPoint,
  entityTypeLabel,
  memoryFamilyOf,
  memoryStateLabel,
  plotMemoryStars,
  skyDust,
  starLabel,
  starSize,
  type MemoryView,
} from "./companion-star-trail";

let sequence = 0;

function memory(overrides: Partial<MemoryView> = {}): MemoryView {
  sequence += 1;
  return {
    id: `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
    content: `记忆 ${sequence}`,
    kind: "preference",
    state: "active",
    importance: 0.5,
    confidence: 0.5,
    scope: "workspace",
    sourceType: "user_stated",
    updatedAt: "2026-09-16T00:00:00.000Z",
    createdAt: "2026-09-16T00:00:00.000Z",
    links: [],
    onTrail: true,
    ...overrides,
  };
}

describe("companion star trail", () => {
  it("puts each kind on its own orbit and keeps an unknown kind on the outer one", () => {
    expect(memoryFamilyOf("preference")).toBe(0);
    expect(memoryFamilyOf("goal")).toBe(0);
    expect(memoryFamilyOf("learning_context")).toBe(1);
    expect(memoryFamilyOf("interaction_note")).toBe(1);
    expect(memoryFamilyOf("episodic")).toBe(2);
    // A kind this client does not model still has to be plotted somewhere.
    expect(memoryFamilyOf("brand_new_kind")).toBe(MEMORY_FAMILIES.length - 1);
  });

  it("draws the same sky for the same records, twice", () => {
    const views = [
      memory({ kind: "goal", importance: 0.9 }),
      memory({ kind: "learning_context", importance: 0.4 }),
      memory({ kind: "episodic", importance: 0.7 }),
      memory({ kind: "preference", importance: 0.2 }),
    ];
    expect(plotMemoryStars(views)).toEqual(plotMemoryStars(views));
  });

  it("keeps every star inside the plate and never stacks two on one angle", () => {
    const views = Array.from({ length: 20 }, (_, index) => memory({
      kind: (["preference", "goal", "learning_context", "interaction_note", "episodic"] as const)[index % 5],
      importance: 1 - index / 40,
    }));
    const { points } = plotMemoryStars(views);

    expect(points.length).toBeGreaterThan(0);
    for (const point of points) {
      expect(point.x).toBeGreaterThan(0);
      expect(point.x).toBeLessThan(100);
      expect(point.y).toBeGreaterThan(0);
      expect(point.y).toBeLessThan(100);
    }
    // Distinct angles across bands is what stops two captions colliding.
    expect(new Set(points.map((point) => point.angle.toFixed(6))).size).toBe(points.length);
  });

  it("puts every star on its own band's circle, measured from the centre", () => {
    const views = Array.from({ length: 20 }, (_, index) => memory({
      kind: (["preference", "goal", "learning_context", "interaction_note", "episodic"] as const)[index % 5],
      importance: 0.5,
    }));
    const { points } = plotMemoryStars(views);

    for (const point of points) {
      // The plate is square, so one radius is the same number of percent on both
      // axes — the property that keeps an orbit a circle instead of an oval.
      const dx = point.x - 50;
      const dy = point.y - 50;
      const radius = Math.hypot(dx, dy);
      expect(radius).toBeCloseTo(MEMORY_FAMILIES[point.familyIndex].radius, 6);
    }
  });

  it("flips a caption up only when hanging it down would leave the plate", () => {
    const views = Array.from({ length: 20 }, (_, index) => memory({
      kind: (["preference", "goal", "learning_context", "interaction_note", "episodic"] as const)[index % 5],
      importance: 0.5,
    }));
    for (const point of plotMemoryStars(views).points) {
      expect(point.captionAbove).toBe(point.y > 76);
    }
  });

  it("ranks a band by importance, keeps its most important members and reports the rest", () => {
    const views = Array.from({ length: MEMORY_FAMILIES[0].capacity + 3 }, (_, index) => memory({
      kind: "goal",
      importance: index / 10,
    }));
    const { points, hidden, hiddenIds, bandCounts } = plotMemoryStars(views);

    expect(bandCounts[0]).toBe(MEMORY_FAMILIES[0].capacity);
    expect(points).toHaveLength(MEMORY_FAMILIES[0].capacity);
    expect(hidden).toBe(3);
    // The ones that did not fit are named, not just counted: the page offers a
    // way to reach them, and it can only do that if it knows which they are.
    expect(hiddenIds).toHaveLength(3);
    expect(hiddenIds.every((id) => !points.some((point) => point.view.id === id))).toBe(true);
    // Highest importance first, so the kept set is the strongest one.
    const kept = points.map((point) => point.view.importance ?? 0);
    expect(kept).toEqual([...kept].sort((a, b) => b - a));
    expect(Math.min(...kept)).toBeGreaterThan(0);
  });

  it("leaves archived records off the trail but keeps them plottable on request", () => {
    const archived = memory({ state: "archived", onTrail: false });
    const active = memory({ kind: "goal" });
    const { points } = plotMemoryStars([archived, active]);

    expect(points.map((point) => point.view.id)).toEqual([active.id]);
  });

  it("plots candidates, because a hollow star is how the page asks for a decision", () => {
    const candidate = memory({ state: "candidate", kind: "learning_context" });
    const { points } = plotMemoryStars([candidate]);
    expect(points).toHaveLength(1);
    expect(points[0].view.state).toBe("candidate");
    expect(points[0].familyIndex).toBe(1);
  });

  it("reads importance as three dot sizes, because a dot carries three", () => {
    expect(starSize(0.9)).toBe("major");
    expect(starSize(0.7)).toBe("major");
    expect(starSize(0.69)).toBe("normal");
    expect(starSize(null)).toBe("normal");
    expect(starSize(0.36)).toBe("normal");
    expect(starSize(0.35)).toBe("minor");
    expect(starSize(0.05)).toBe("minor");
  });

  it("hands the whole sentence to the caption and leaves the cut to CSS", () => {
    // A caption is a pointer, not the record: the full text belongs to the focus
    // card, and a Chinese sentence is wrapped onto two lines rather than chopped
    // at a character count.
    expect(starLabel("完成第一轮复习")).toBe("完成第一轮复习");
    expect(starLabel("我开始能区分熟悉和理解之间的差别")).toBe("我开始能区分熟悉和理解之间的差别");
    expect(starLabel("  前后  有空格  ")).toBe("前后 有空格");
    const long = "一".repeat(STAR_CAPTION_MAX_LENGTH + 10);
    expect(starLabel(long)).toHaveLength(STAR_CAPTION_MAX_LENGTH);
    expect(entityTypeLabel("note")).toBe("笔记");
    expect(entityTypeLabel("objective")).toBe("理解目标");
    // A type the extractor invented falls through to its own name, never a guess.
    expect(entityTypeLabel("sandbox")).toBe("sandbox");
    expect(memoryStateLabel("candidate")).toBe("待确认");
    expect(memoryStateLabel("archived")).toBe("已归档");
  });

  it("draws the same dust for the same count, and nothing dust-sized passes for a star", () => {
    const sky = skyDust(96);
    const again = skyDust(96);
    expect(again).toEqual(sky);
    expect(sky).toHaveLength(96);
    for (const star of sky) {
      expect(star.x).toBeGreaterThanOrEqual(0);
      expect(star.x).toBeLessThanOrEqual(100);
      expect(star.y).toBeGreaterThanOrEqual(0);
      expect(star.y).toBeLessThanOrEqual(100);
      // Sub-pixel diameters: dust must never read as a memory dot.
      expect(star.size).toBeLessThan(2);
      expect(star.alpha).toBeLessThanOrEqual(0.5);
      // Nothing under the focus card: it can never be seen there.
      expect(Math.hypot(star.x - 50, star.y - 50)).toBeGreaterThanOrEqual(26);
    }
    expect(skyDust(0)).toHaveLength(0);
  });

  it("bends provenance curves off the straight line, deterministically", () => {
    const from = { x: 20, y: 50 };
    const to = { x: 94, y: 50 };
    const first = curveControlPoint(from, to, "note-1");
    const second = curveControlPoint(from, to, "note-1");
    expect(second).toEqual(first);
    // The bend is perpendicular, so the curve still starts and ends on the axis.
    expect(first.y).not.toBe(50);
    expect(first.x).toBeGreaterThan(20);
    expect(first.x).toBeLessThan(94);
    // A different seed bends the other way at least sometimes; two seeds must
    // not collapse onto one shared curve.
    const other = curveControlPoint(from, to, "card-9");
    expect(other).not.toEqual(first);
  });
});
