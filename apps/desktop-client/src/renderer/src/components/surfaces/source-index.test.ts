import { describe, expect, it } from "vitest";
import type { DesktopSourceListItem } from "@ailearn/shared/desktop-surface-contracts";
import {
  SOURCE_PAGE_MAX,
  countSourcesByStatus,
  matchesSourceQuery,
  needsOriginAddress,
  needsStatusRefresh,
  readSourceLibrary,
  selectSources,
  sourcePoolFor,
  tabCount,
  type SourceLibraryPage,
} from "./source-index";

function source(overrides: Partial<DesktopSourceListItem> = {}): DesktopSourceListItem {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    workspaceId: "22222222-2222-4222-8222-222222222222",
    type: "markdown",
    title: "界面链路自检",
    origin: null,
    status: "ready",
    createdBy: "33333333-3333-4333-8333-333333333333",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    noteCount: 0,
    ...overrides,
  };
}

const emptyPage: SourceLibraryPage = { items: [], total: 0, nextCursor: null };

describe("readSourceLibrary", () => {
  it("follows the cursor until the API stops handing one back", async () => {
    const pages: SourceLibraryPage[] = [
      { items: [source({ id: "a" }), source()], total: 3, nextCursor: "cursor-1" },
      { items: [source()], total: 3, nextCursor: null },
    ];
    const seen: Array<string | undefined> = [];
    const library = await readSourceLibrary(async (cursor, status) => {
      if (status === "archived") return emptyPage;
      seen.push(cursor);
      return pages[seen.length - 1]!;
    });

    expect(seen).toEqual([undefined, "cursor-1"]);
    expect(library.items).toHaveLength(3);
    expect(library.total).toBe(3);
    expect(library.truncated).toBe(false);
  });

  it("stops at the page cap and reports the library as truncated", async () => {
    let calls = 0;
    const library = await readSourceLibrary(async (_cursor, status) => {
      if (status === "archived") return emptyPage;
      calls += 1;
      return { items: [source()], total: 10_000, nextCursor: `cursor-${calls}` };
    });

    expect(calls).toBe(SOURCE_PAGE_MAX);
    expect(library.truncated).toBe(true);
    expect(library.total).toBe(10_000);
  });

  it("stops when a page repeats a cursor that carries no rows", async () => {
    const library = await readSourceLibrary(async () => ({ items: [], total: 0, nextCursor: "loop" }));
    expect(library.items).toHaveLength(0);
    expect(library.truncated).toBe(false);
  });

  it("reads the archived slice the default index excludes", async () => {
    const archivedCalls: Array<string | undefined> = [];
    const library = await readSourceLibrary(async (cursor, status) => {
      if (status !== "archived") {
        return { items: [source({ id: "live-1" })], total: 1, nextCursor: null };
      }
      archivedCalls.push(cursor);
      return cursor
        ? { items: [source({ id: "gone-2", status: "archived" })], total: 2, nextCursor: null }
        : { items: [source({ id: "gone-1", status: "archived" })], total: 2, nextCursor: "cursor-a" };
    });

    expect(library.items.map((item) => item.id)).toEqual(["live-1"]);
    expect(library.archived.map((item) => item.id)).toEqual(["gone-1", "gone-2"]);
    expect(library.archivedTotal).toBe(2);
    expect(archivedCalls).toEqual([undefined, "cursor-a"]);
  });

  it("spends one probe request when the workspace archived nothing", async () => {
    let archivedCalls = 0;
    const library = await readSourceLibrary(async (_cursor, status) => {
      if (status === "archived") {
        archivedCalls += 1;
        return emptyPage;
      }
      return { items: [source()], total: 1, nextCursor: null };
    });

    expect(archivedCalls).toBe(1);
    expect(library.archived).toEqual([]);
    expect(library.archivedTruncated).toBe(false);
  });
});

describe("sourcePoolFor", () => {
  it("gives the archived tab its own rows and every other tab the index", () => {
    const library = {
      items: [source({ id: "live" })],
      archived: [source({ id: "gone", status: "archived" as const })],
    };
    expect(sourcePoolFor(library, "all").map((item) => item.id)).toEqual(["live"]);
    expect(sourcePoolFor(library, "ready").map((item) => item.id)).toEqual(["live"]);
    expect(sourcePoolFor(library, "archived").map((item) => item.id)).toEqual(["gone"]);
  });
});

describe("selectSources", () => {
  const items = [
    source({ id: "1", title: "间隔效应与学习计划", status: "failed" }),
    source({ id: "2", title: "认知负荷理论", status: "ready" }),
    source({ id: "3", title: "正在解析的材料", status: "processing" }),
  ];

  it("narrows to the tab's status", () => {
    expect(selectSources(items, "ready", "").map((item) => item.id)).toEqual(["2"]);
    expect(selectSources(items, "all", "").map((item) => item.id)).toEqual(["1", "2", "3"]);
  });

  it("matches the fields the list projection actually carries", () => {
    expect(matchesSourceQuery(items[0]!, "间隔")).toBe(true);
    expect(matchesSourceQuery(items[0]!, "markdown")).toBe(true);
    expect(matchesSourceQuery(items[0]!, "正文里才有的词")).toBe(false);
  });

  it("keeps a row the server matched by body text", () => {
    const found = selectSources(items, "all", "正文里才有的词", new Set(["3"]));
    expect(found.map((item) => item.id)).toEqual(["3"]);
  });
});

describe("counts", () => {
  it("counts every status the contract can return", () => {
    const counts = countSourcesByStatus([
      source({ status: "ready" }),
      source({ status: "ready" }),
      source({ status: "failed" }),
      source({ status: "archived" }),
    ]);
    expect(counts.ready).toBe(2);
    expect(counts.failed).toBe(1);
    expect(counts.archived).toBe(1);
    expect(counts.draft).toBe(0);
  });

  it("reports the workspace total for the 全部 tab, not the loaded rows", () => {
    const counts = countSourcesByStatus([source({ status: "ready" })]);
    expect(tabCount(counts, "all", 128)).toBe(128);
    expect(tabCount(counts, "processing", 128)).toBe(0);
    expect(tabCount(counts, "archived", 128)).toBe(0);
  });
});

describe("needsStatusRefresh", () => {
  it("is true while a source is queued or running, false once it settles", () => {
    expect(needsStatusRefresh([source({ status: "ready" })])).toBe(false);
    expect(needsStatusRefresh([source({ status: "processing" })])).toBe(true);
    // The state a fresh capture lands in: without it the index never polled and
    // the row stayed 待解析 until the reader left and came back.
    expect(needsStatusRefresh([source({ status: "draft" })])).toBe(true);
    expect(needsStatusRefresh([source({ status: "failed" })])).toBe(false);
  });
});

describe("needsOriginAddress", () => {
  it("only blames a source that was supposed to carry an address", () => {
    expect(needsOriginAddress(source({ type: "url", origin: null }))).toBe(true);
    expect(needsOriginAddress(source({ type: "url", origin: "https://example.com/a" }))).toBe(false);
    expect(needsOriginAddress(source({ type: "text", origin: null }))).toBe(false);
    expect(needsOriginAddress(source({ type: "markdown", origin: null }))).toBe(false);
    expect(needsOriginAddress(source({ type: "code", origin: "main.ts" }))).toBe(false);
  });
});
