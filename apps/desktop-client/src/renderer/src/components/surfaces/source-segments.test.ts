import { describe, expect, it } from "vitest";
import type { DesktopSourceSegment } from "@ailearn/shared/desktop-surface-contracts";
import {
  describeStructure,
  excerpt,
  listSegment,
  parseStateLine,
  pickFocusSegment,
  segmentText,
  splitHighlight,
} from "./source-segments";

let ordinal = 0;
function segment(segmentType: string, text: string): DesktopSourceSegment {
  ordinal += 1;
  return {
    id: `1111111${ordinal}-1111-4111-8111-11111111111${ordinal}`,
    sourceId: "22222222-2222-4222-8222-222222222222",
    workspaceId: "33333333-3333-4333-8333-333333333333",
    ordinal,
    text,
    charStart: 0,
    charEnd: text.length,
    segmentType,
  };
}

describe("segmentText", () => {
  it("drops the block marker the element itself draws", () => {
    expect(segmentText(segment("heading", "# 界面链路自检"))).toBe("界面链路自检");
    expect(segmentText(segment("quote", "> 引用第一行\n> 引用第二行"))).toBe("引用第一行\n引用第二行");
    expect(segmentText(segment("image", "![架构图](https://example.com/a.png)"))).toBe("架构图");
    expect(segmentText(segment("image", "![](https://example.com/a.png)"))).toBe("https://example.com/a.png");
  });

  it("leaves code and prose exactly as the parser stored them", () => {
    expect(segmentText(segment("code", "# not a heading\nconst a = 1;"))).toBe("# not a heading\nconst a = 1;");
    expect(segmentText(segment("paragraph", "正文 # 不是标题"))).toBe("正文 # 不是标题");
  });
});

describe("listSegment", () => {
  it("splits a multi-line fragment into items and keeps its numbering", () => {
    expect(listSegment("- 走的是 real IPC\n- 落到 POST /sources")).toEqual({
      ordered: false,
      items: ["走的是 real IPC", "落到 POST /sources"],
    });
    expect(listSegment("1. 第一项\n2. 第二项")).toEqual({
      ordered: true,
      items: ["第一项", "第二项"],
    });
  });

  it("drops blank lines instead of rendering empty bullets", () => {
    expect(listSegment("- 甲\n\n- 乙").items).toEqual(["甲", "乙"]);
  });
});

describe("pickFocusSegment", () => {
  it("prefers a quote, then a substantial paragraph", () => {
    const quote = segment("quote", "> 提取会重组未来的访问路径。");
    const long = segment("paragraph", "真正有效的练习，需要让学习者在答案出现之前先经历一次有意义的检索过程。");
    expect(pickFocusSegment([long, quote])?.id).toBe(quote.id);
    expect(pickFocusSegment([long])?.id).toBe(long.id);
  });

  it("never marks a heading as the evidence", () => {
    const heading = segment("heading", "# 界面链路自检");
    expect(pickFocusSegment([heading])).toBeNull();
    expect(pickFocusSegment([heading, segment("code", "const a = 1;")])).toBeNull();
  });

  it("accepts a short paragraph rather than inventing a target", () => {
    const short = segment("paragraph", "困难本身不是目标。");
    expect(pickFocusSegment([short])?.id).toBe(short.id);
  });
});

describe("splitHighlight", () => {
  it("marks a whole sentence, not the first clause it finds", () => {
    const text = "真正有效的练习，需要让学习者在答案出现之前先经历一次有意义的检索。这正是难点。";
    const [lead, rest] = splitHighlight(text);
    expect(lead).toBe("真正有效的练习，需要让学习者在答案出现之前先经历一次有意义的检索。");
    expect(rest).toBe("这正是难点。");
  });

  it("marks the whole fragment when it carries no sentence break", () => {
    expect(splitHighlight("一段没有句号的短句")).toEqual(["一段没有句号的短句", ""]);
  });

  it("does not cut a one-word lead into its own mark", () => {
    expect(splitHighlight("好。后面还有很多内容")).toEqual(["好。后面还有很多内容", ""]);
  });
});

describe("describeStructure", () => {
  it("counts what parsing produced with the right measure word", () => {
    const line = describeStructure([
      segment("heading", "# 一"),
      segment("code", "const a = 1;"),
      segment("code", "const b = 2;"),
      segment("paragraph", "正文"),
    ], "ready");
    expect(line).toBe("正文已识别为 4 个片段：1 个小标题、2 段代码。");
  });

  it("says parsing is still running for both unsettled states", () => {
    expect(describeStructure([], "draft")).toBe("正在解析，完成后这里会列出结构与片段。");
    expect(describeStructure([], "processing")).toBe("正在解析，完成后这里会列出结构与片段。");
    expect(describeStructure([], "failed")).toBe("解析没有成功完成，因此没有结构可以展示。");
  });
});

describe("parseStateLine", () => {
  it("tells the queued source apart from the running one", () => {
    expect(parseStateLine("draft")).toContain("排进解析队列");
    expect(parseStateLine("processing")).toContain("正在解析这份材料");
    expect(parseStateLine("failed")).toContain("重新采集");
  });
});

describe("excerpt", () => {
  it("truncates with an ellipsis instead of cutting silently", () => {
    expect(excerpt("短句")).toBe("短句");
    expect(excerpt("一".repeat(60))).toBe(`${"一".repeat(46)}…`);
  });
});
