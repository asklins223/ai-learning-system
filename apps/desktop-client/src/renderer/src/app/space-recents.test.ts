import { describe, expect, it } from "vitest";
import { markSpaceUsed, readSpaceRecents } from "./space-recents";

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() { return data.size; },
    clear: () => data.clear(),
    getItem: (key: string) => data.get(key) ?? null,
    key: (index: number) => [...data.keys()][index] ?? null,
    removeItem: (key: string) => { data.delete(key); },
    setItem: (key: string, value: string) => { data.set(key, value); },
  };
}

describe("space-recents", () => {
  it("记下一次进入就落进本机存储，重启后读得回来", () => {
    const storage = memoryStorage();
    markSpaceUsed("space-a", 1_000, storage);
    markSpaceUsed("space-b", 2_000, storage);

    expect(readSpaceRecents(storage)).toEqual({ "space-a": 1_000, "space-b": 2_000 });
    // 落盘才是"重启后还在"：读的是存储，不是模块里的内存。
    expect(JSON.parse(storage.getItem("ailearn:space-recents") ?? "null"))
      .toEqual({ "space-a": 1_000, "space-b": 2_000 });
  });

  it("同一个空间再进一次会覆盖旧时间，不会留下两条", () => {
    const storage = memoryStorage();
    markSpaceUsed("space-a", 1_000, storage);
    expect(markSpaceUsed("space-a", 9_000, storage)).toEqual({ "space-a": 9_000 });
    expect(readSpaceRecents(storage)).toEqual({ "space-a": 9_000 });
  });

  it("手改坏了的记录当没有：菜单不该被一条读不出来的偏好挡住", () => {
    const storage = memoryStorage();
    storage.setItem("ailearn:space-recents", "{不是 JSON");
    expect(readSpaceRecents(storage)).toEqual({});

    storage.setItem("ailearn:space-recents", JSON.stringify(["space-a"]));
    expect(readSpaceRecents(storage)).toEqual({});

    storage.setItem("ailearn:space-recents", JSON.stringify({ "space-a": "昨天", "space-b": 5 }));
    expect(readSpaceRecents(storage)).toEqual({ "space-b": 5 });
  });

  it("写不进去（配额满 / 没有 localStorage）也只影响这一次会话的排序", () => {
    const full: Pick<Storage, "getItem" | "setItem"> = {
      getItem: () => null,
      setItem: () => { throw new Error("quota exceeded"); },
    };
    expect(markSpaceUsed("space-a", 1_000, full)).toEqual({ "space-a": 1_000 });
    expect(markSpaceUsed("space-b", 2_000, null)).toEqual({ "space-b": 2_000 });
  });
});
