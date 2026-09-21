import { beforeEach, describe, expect, it } from "vitest";
import {
  readObjectiveLibraryView,
  resetObjectiveLibraryView,
  retargetObjectiveLibraryView,
  writeObjectiveLibraryView,
} from "./objective-library-view-state";

describe("理解目标库视图态", () => {
  beforeEach(() => {
    retargetObjectiveLibraryView("ws-1");
  });

  it("跨挂载保留搜索、筛选与滚动——这是它存在的全部理由", () => {
    writeObjectiveLibraryView({ query: "惯性", filter: "stable", scrollTop: 240 });
    expect(readObjectiveLibraryView()).toMatchObject({ query: "惯性", filter: "stable", scrollTop: 240 });
  });

  it("从别的流程跳进来时清空，但别把当前工作区也清掉", () => {
    writeObjectiveLibraryView({ query: "惯性", filter: "stable", scrollTop: 240 });
    resetObjectiveLibraryView();
    expect(readObjectiveLibraryView()).toEqual({
      workspaceId: "ws-1", query: "", filter: "all", scrollTop: 0,
    });
  });

  it("换工作区时连工作区标识一起换；上一批目标的筛选对新空间没有意义", () => {
    writeObjectiveLibraryView({ query: "惯性", filter: "attention" });
    retargetObjectiveLibraryView("ws-2");
    expect(readObjectiveLibraryView()).toEqual({
      workspaceId: "ws-2", query: "", filter: "all", scrollTop: 0,
    });
  });
});
