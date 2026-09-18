/**
 * Page 20 「伴星中心」 plots the memories the companion actually holds onto three
 * orbit bands. The mockup drew six fixed stars with hand-written captions; a real
 * workspace has an arbitrary number of memories, so the sky is derived here
 * instead — purely, so that "the same records always draw the same sky" is a
 * property a test can hold on to.
 *
 * Nothing in this module invents a memory, a link or a count. It only decides
 * where the records the server returned are drawn, and which ones do not fit.
 *
 * Geometry contract: `radius` is a percentage of a **square** sky plate (the
 * field keeps a centred square `aspect-ratio: 1` layer). Percent-of-width and
 * percent-of-height are therefore the same length, so an orbit stays a circle
 * instead of being stretched into a flat oval, and a star's `left` / `top`
 * percentages describe the same point on that circle.
 */

export type MemoryEntityLink = {
  readonly entityType: string;
  readonly entityId: string;
  /** True when the linked learning entity has been deleted. */
  readonly orphaned: boolean;
};

export type MemoryState = "pinned" | "active" | "candidate" | "archived";

/** The three states a memory can wear while it is on the trail. */
export type TrailState = Exclude<MemoryState, "archived">;

/** One memory, merged from the star map (links, state) and the list (scores). */
export type MemoryView = {
  readonly id: string;
  readonly content: string;
  readonly kind: string;
  readonly state: MemoryState;
  readonly importance: number | null;
  readonly confidence: number | null;
  readonly scope: string | null;
  readonly sourceType: string | null;
  readonly updatedAt: string | null;
  readonly createdAt: string | null;
  readonly links: readonly MemoryEntityLink[];
  /** False for archived records: they stay readable in the list, off the trail. */
  readonly onTrail: boolean;
};

/**
 * Three orbit bands, one per family of memory. Distance from the centre reads as
 * how far the memory is from the learner: what the companion knows about you,
 * what it noticed while you studied, and what you lived through together.
 *
 * The radii are spaced far enough apart that a two-line caption hanging under an
 * inner star still stops short of the next band's guide ring, and the inner
 * radius clears the focus card that sits on the centre of the plate.
 */
export const MEMORY_FAMILIES = [
  { id: "about-you", label: "关于你", kinds: ["preference", "goal"], radius: 30, capacity: 6 },
  { id: "study", label: "学习观察", kinds: ["learning_context", "interaction_note"], radius: 37, capacity: 8 },
  { id: "shared", label: "共同经历", kinds: ["episodic"], radius: 44, capacity: 8 },
] as const;

export type MemoryFamilyId = (typeof MEMORY_FAMILIES)[number]["id"];

/**
 * Stars are laid out on the golden angle rather than in even steps per band: a
 * workspace with one memory in each family would otherwise stack all three in a
 * vertical column. The sequence is fixed, so the sky is stable across renders.
 *
 * The sequence starts at 12 o'clock, so the sky has a top; it is not rotated by
 * band, because two stars on different bands sharing an angle is exactly the
 * "reading by distance" the bands are for.
 */
const GOLDEN_ANGLE_DEGREES = 137.508;
const FIRST_ANGLE_DEGREES = -90;

/** Anything the server names with a kind this client does not model reads as an experience. */
export function memoryFamilyOf(kind: string): number {
  const index = MEMORY_FAMILIES.findIndex((family) => (family.kinds as readonly string[]).includes(kind));
  return index === -1 ? MEMORY_FAMILIES.length - 1 : index;
}

export type StarSize = "major" | "normal" | "minor";

/**
 * Importance is a 0–1 score, not a pixel budget: three tiers are as much
 * resolution as a dot on a night sky can carry before it reads as noise.
 */
export function starSize(importance: number | null): StarSize {
  if (importance === null) return "normal";
  if (importance >= 0.7) return "major";
  if (importance <= 0.35) return "minor";
  return "normal";
}

export type StarPoint = {
  readonly view: MemoryView;
  readonly familyIndex: number;
  readonly angle: number;
  /** Percentages of the square sky plate, ready for `left` / `top`. */
  readonly x: number;
  readonly y: number;
  /** Below 76% of the plate a caption hangs under the star; past it, it flips up. */
  readonly captionAbove: boolean;
  readonly size: StarSize;
};

export type MemorySky = {
  readonly points: readonly StarPoint[];
  /** Plotted memories per band, in `MEMORY_FAMILIES` order. */
  readonly bandCounts: readonly number[];
  /** How many memories exist but did not fit on the plate. */
  readonly hidden: number;
  /** Which memories those are, so the page can offer a way to reach them. */
  readonly hiddenIds: readonly string[];
};

/**
 * Places every trail-eligible memory on its family's orbit. A band keeps its
 * most important members and reports the rest as hidden rather than piling them
 * on top of each other — the page turns that count into an honest footnote that
 * still leads somewhere.
 */
export function plotMemoryStars(views: readonly MemoryView[]): MemorySky {
  const bands = MEMORY_FAMILIES.map((family, index) => {
    const members = views
      .filter((view) => view.onTrail && memoryFamilyOf(view.kind) === index)
      .sort((a, b) => (b.importance ?? 0) - (a.importance ?? 0));
    return { family, members, shown: members.slice(0, family.capacity) };
  });

  // One shared ordinal across all bands, so two stars never share an angle even
  // when they sit on different orbits.
  let ordinal = -1;
  const points = bands.flatMap((band, familyIndex) => band.shown.map((view) => {
    ordinal += 1;
    const angle = FIRST_ANGLE_DEGREES + GOLDEN_ANGLE_DEGREES * ordinal;
    const radians = (angle * Math.PI) / 180;
    const y = 50 + band.family.radius * Math.sin(radians);
    return {
      view,
      familyIndex,
      angle,
      x: 50 + band.family.radius * Math.cos(radians),
      y,
      // A caption always hangs below its star — every band is concentric, so
      // "inward" is already full of rings and other captions. The only exception
      // is the bottom of the plate, where a caption would fall off the sky.
      captionAbove: y > 76,
      size: starSize(view.importance),
    };
  }));

  const hiddenIds = bands.flatMap((band) => band.members.slice(band.shown.length).map((view) => view.id));

  return {
    points,
    bandCounts: bands.map((band) => band.shown.length),
    hidden: hiddenIds.length,
    hiddenIds,
  };
}

const MEMORY_KIND_LABEL: Record<string, string> = {
  preference: "偏好",
  goal: "目标",
  learning_context: "学习情境",
  interaction_note: "互动札记",
  episodic: "经历",
};

export function memoryKindLabel(kind: string): string {
  return MEMORY_KIND_LABEL[kind] ?? kind;
}

const MEMORY_SOURCE_LABEL: Record<string, string> = {
  user_stated: "你亲口说的",
  model_inferred: "伴星推断",
  confirmed: "确认过的事实",
  summary: "日记摘要",
};

export function memorySourceLabel(sourceType: string): string {
  return MEMORY_SOURCE_LABEL[sourceType] ?? sourceType;
}

const MEMORY_SCOPE_LABEL: Record<string, string> = {
  global: "账号级",
  workspace: "工作区级",
  task: "任务级",
};

export function memoryScopeLabel(scope: string): string {
  return MEMORY_SCOPE_LABEL[scope] ?? scope;
}

export function memoryStateLabel(state: MemoryState): string {
  switch (state) {
    case "pinned": return "已固定";
    case "active": return "进行中";
    case "candidate": return "待确认";
    case "archived": return "已归档";
  }
}

/**
 * A caption is a pointer to the record, not the record: the full sentence lives
 * in the focus card and in the button's own label. The cap here is only a DOM
 * guard — the visual cut is a two-line clamp in CSS, because a Chinese sentence
 * wrapped onto a second line reads as text, while the same sentence chopped at a
 * character count reads as a broken string.
 */
export const STAR_CAPTION_MAX_LENGTH = 48;

export function starLabel(content: string): string {
  const trimmed = content.trim().replace(/\s+/g, " ");
  return trimmed.length > STAR_CAPTION_MAX_LENGTH
    ? trimmed.slice(0, STAR_CAPTION_MAX_LENGTH)
    : trimmed;
}

/**
 * Memory links store the raw entity type the extractor wrote, so unknown types
 * fall through to their own name rather than being silently relabelled.
 */
export function entityTypeLabel(entityType: string): string {
  switch (entityType) {
    case "note": return "笔记";
    case "source": return "来源";
    case "objective": return "理解目标";
    case "learning_run": return "测评";
    case "card": return "学习卡";
    case "conversation": return "对话";
    default: return entityType;
  }
}

/* --- sky atmosphere -------------------------------------------------------
 * The web star map this page descends from ("理解星图",
 * `apps/web/components/study/UnderstandingUniverse.tsx`) earned its sense of
 * place from three cheap deterministic layers: a deep-sky gradient, two nebula
 * glows, and a field of slowly twinkling dust stars. The trails here keep that
 * atmosphere but hang it off the same deterministic-hash trick the web map
 * used, so a given plate always twinkles the same way and a test can hold the
 * sky still.
 * ----------------------------------------------------------------------- */

/** One background dust star on the sky plate, in plate percentages. */
export type SkyDust = {
  readonly x: number;
  readonly y: number;
  /** Diameter in px, sub-pixel on purpose: dust must never read as a memory. */
  readonly size: number;
  readonly alpha: number;
  /** Twinkle period and phase, seconds, for the CSS animation. */
  readonly duration: number;
  readonly delay: number;
};

/** A deterministic 0–1 hash, so the dust never reshuffles between renders. */
function hashNumber(value: number): number {
  const sine = Math.sin(value * 12.9898 + 78.233) * 43758.5453;
  return sine - Math.floor(sine);
}

/** The focus card sits on this radius; dust under it is wasted and muddies it. */
const DUST_CORE_CLEAR_RADIUS = 26;

/**
 * Dust is a property of the plate, not of the records: `count` scales with the
 * plate the caller measured, and the same count always yields the same sky.
 * Points under the central focus card are dropped — they can never be seen, so
 * drawing them is both noise and paint cost. The clear radius follows the
 * caller's centre: the page-20 trail keeps a focus card on the plate's centre,
 * while page 19's centre is open sky and only needs the middle itself kept clear.
 */
export function skyDust(count: number, coreClearRadius: number = DUST_CORE_CLEAR_RADIUS): readonly SkyDust[] {
  const dust: SkyDust[] = [];
  for (let index = 0; dust.length < count; index += 1) {
    const x = hashNumber(index * 7 + 1) * 100;
    const y = hashNumber(index * 7 + 2) * 100;
    if (Math.hypot(x - 50, y - 50) < coreClearRadius) continue;
    dust.push({
      x,
      y,
      size: 0.5 + hashNumber(index * 7 + 3) * 1.3,
      alpha: 0.14 + hashNumber(index * 7 + 4) * 0.36,
      duration: 3.2 + hashNumber(index * 7 + 5) * 3.8,
      delay: hashNumber(index * 7 + 6) * -7,
    });
  }
  return dust;
}

/**
 * The control point for a provenance curve. The web map bent its relation edges
 * with a per-edge deterministic bend so parallel links never overlapped; a link
 * line here gets the same treatment scaled to the plate's 0–100 space.
 */
export function curveControlPoint(
  from: { readonly x: number; readonly y: number },
  to: { readonly x: number; readonly y: number },
  seed: string,
): { x: number; y: number } {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.max(1, Math.hypot(dx, dy));
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  const bend = ((hash >>> 0) / 4294967295 - 0.5) * Math.min(9, length * 0.16);
  return {
    x: (from.x + to.x) / 2 - (dy / length) * bend,
    y: (from.y + to.y) / 2 + (dx / length) * bend,
  };
}
