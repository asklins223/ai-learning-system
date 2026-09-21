// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { plainCompanionBubbleText, renderCompanionMarkdown } from "./companion-markdown";

function show(text: string) {
  return render(<div data-testid="root">{renderCompanionMarkdown(text)}</div>);
}

afterEach(() => cleanup());

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
