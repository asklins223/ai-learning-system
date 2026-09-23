// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { plainCompanionBubbleText, renderCompanionMarkdown } from "./companion-markdown";

/** 打开通道换成记账替身：这个文件只验"点了有没有把地址交出去、交的是哪一条"。 */
const { opened } = vi.hoisted(() => ({ opened: [] as string[] }));
vi.mock("./companion-link", () => ({
  openCompanionExternalLink: (url: string) => { opened.push(url); return Promise.resolve(true); },
}));

function show(text: string) {
  return render(<div data-testid="root">{renderCompanionMarkdown(text)}</div>);
}

afterEach(() => {
  opened.length = 0;
  cleanup();
});

describe("renderCompanionMarkdown（§4.8：可见正文保留结构，由渲染层排版）", () => {
  it("行内加粗 / 斜体 / 代码变成元素，标记符号不留在文字里", () => {
    show("先**关燃气**，公式是 `I=U/R`，*慢慢来*。");
    expect(screen.getByText("关燃气").tagName).toBe("STRONG");
    expect(screen.getByText("I=U/R").tagName).toBe("CODE");
    expect(screen.getByText("慢慢来").tagName).toBe("EM");
    expect(screen.getByTestId("root").textContent).toBe("先关燃气，公式是 I=U/R，慢慢来。");
  });

  it("代码块整段原样保留，不当成正文折行", () => {
    show("例子：\n\n```ts\nconst a = 1;\nconst b = 2;\n```\n");
    const pre = screen.getByTestId("root").querySelector("pre");
    expect(pre?.textContent).toBe("const a = 1;\nconst b = 2;");
    expect(pre?.getAttribute("data-lang")).toBe("ts");
    expect(screen.getByTestId("root").textContent).not.toContain("```");
  });

  it("无序与有序列表各成列表，条目文字不含项目符号", () => {
    show("- 关燃气\n- 带应急包\n\n1. 走安全通道\n2. 到集合点");
    const root = screen.getByTestId("root");
    expect(root.querySelectorAll("ul")).toHaveLength(1);
    expect(root.querySelectorAll("ol")).toHaveLength(1);
    expect([...root.querySelectorAll("li")].map((li) => li.textContent))
      .toEqual(["关燃气", "带应急包", "走安全通道", "到集合点"]);
  });

  it("标题行排成强调行，井号不留在文字里", () => {
    show("### 疏散四步\n\n第一步是关燃气。");
    const heading = screen.getByText("疏散四步");
    expect(heading.tagName).toBe("P");
    expect(heading.className).toContain("companion-md__heading");
    expect(screen.getByTestId("root").textContent).not.toContain("###");
  });

  it("不吞 HTML：模型给出的尖括号内容只作为文字出现", () => {
    show('看这个 <img src=x onerror="alert(1)"> 和 <script>alert(2)</script>');
    const root = screen.getByTestId("root");
    expect(root.querySelectorAll("img")).toHaveLength(0);
    expect(root.querySelectorAll("script")).toHaveLength(0);
    expect(root.textContent).toContain('<img src=x onerror="alert(1)">');
  });

  it("流式半截（标记没闭合）照字面显示，不吞字也不整段变粗", () => {
    show("这一步要**先关燃气");
    expect(screen.getByTestId("root").textContent).toBe("这一步要**先关燃气");
  });

  it("星号用于乘法时不被当成斜体标记", () => {
    show("面积 = 长 * 宽 * 高");
    expect(screen.getByTestId("root").textContent).toBe("面积 = 长 * 宽 * 高");
  });

  it("气泡用的纯文本投影去掉标记，但保留行结构（驱动器数的是字符）", () => {
    expect(plainCompanionBubbleText("### 疏散四步\n\n**先关燃气**，再 `带应急包`。"))
      .toBe("疏散四步\n\n先关燃气，再 带应急包。");
    // 没闭合的标记按字面留着，不吞掉半句话
    expect(plainCompanionBubbleText("这一步要**先关燃气")).toBe("这一步要**先关燃气");
  });
});

describe("链接（方案 35 F7）", () => {
  it("http 链接不再吐 markdown 原文：标签与去处都看得见", () => {
    show("详见[疏散手册](https://example.com/a)：");
    const root = screen.getByTestId("root");
    expect(screen.getByText("疏散手册").tagName).toBe("SPAN");
    expect(screen.getByText("https://example.com/a").tagName).toBe("SMALL");
    expect(root.textContent).not.toContain("](");
    expect(root.querySelector("a")).toBeNull();
    // 不画 `<a>` 是刻意的：应用内永远不导航出去（主进程 will-navigate 拦外链），
    // 点了要交给系统浏览器，那是一颗按钮该干的事，不是一条导航链接。
  });

  /** 画成能点的，是因为真能点开：这条用例钉的就是"点了确实把地址交出去了"。 */
  it("点击链接：原样的地址交给打开通道，不重新拼、不截断", () => {
    show("详见[疏散手册](https://example.com/a?x=1&y=2)");
    const control = screen.getByText("疏散手册").closest("button");
    expect(control?.tagName).toBe("BUTTON");
    fireEvent.click(control as HTMLButtonElement);
    expect(opened).toEqual(["https://example.com/a?x=1&y=2"]);
  });

  it("非 http(s) 的 scheme 不解析成结构，照字面留成文字", () => {
    show("坏链接 [点我](javascript:alert(1))");
    const root = screen.getByTestId("root");
    expect(root.querySelector(".companion-md__link")).toBeNull();
    expect(root.textContent).toContain("[点我](javascript:alert(1))");
  });

  it("链接与加粗混排时两种标记都成立（组号错位会立刻露出来）", () => {
    show("先**关燃气**，再看[手册](https://e.com/x)");
    const root = screen.getByTestId("root");
    expect(screen.getByText("关燃气").tagName).toBe("STRONG");
    expect(screen.getByText("手册").tagName).toBe("SPAN");
    expect(root.textContent).toBe("先关燃气，再看手册https://e.com/x");
  });

  it("气泡那侧仍然只留标签：朗读不该念 URL", () => {
    expect(plainCompanionBubbleText("详见[疏散手册](https://example.com/a)")).toBe("详见疏散手册");
  });
});
