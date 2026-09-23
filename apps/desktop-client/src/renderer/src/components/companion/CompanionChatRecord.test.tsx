// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CompanionMessageV1 } from "@ailearn/shared/companion-conversation-contracts";
import type { CompanionChatSession } from "../../app/companion-chat-session";
import { useSourceImage } from "../surfaces/source-image";
import { hasForeignModal } from "./companion-modal-ownership";
import { CompanionChatRecordArticle, MonthCalendar } from "./CompanionChatRecord";

// 站内图字节通道整模块换掉：这三态是渲染分支的契约，不该靠真 fetch 去凑。
vi.mock("../surfaces/source-image", () => ({ useSourceImage: vi.fn() }));

function message(overrides: Partial<CompanionMessageV1> = {}): CompanionMessageV1 {
  return {
    version: 1,
    id: "3f1a2b3c-4d5e-4f60-8a7b-1c2d3e4f5a6b",
    workspaceId: "0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f",
    conversationId: "1e1e1e1e-1e1e-4e1e-9e1e-1e1e1e1e1e1e",
    seq: 12,
    role: "assistant",
    kind: "text",
    blocks: [{ type: "text", text: "带你去看那篇笔记。" }],
    runId: null,
    clientMessageId: null,
    contentSha256: "0".repeat(64),
    createdAt: "2026-09-21T00:00:00.000Z",
    editedAt: null,
    ...overrides,
  } as CompanionMessageV1;
}

function session(goToRoute = vi.fn().mockResolvedValue(undefined)): CompanionChatSession {
  return {
    runTraces: [],
    proposalStates: {},
    decideProposal: vi.fn(),
    goToRoute,
  } as unknown as CompanionChatSession;
}

afterEach(() => cleanup());

describe("CompanionChatRecordArticle 的跳转块（方案 29 §4.8）", () => {
  it("nav 块渲染成消息里可点的落点，点击走同一条 goToRoute", () => {
    const goToRoute = vi.fn().mockResolvedValue(undefined);
    render(
      <CompanionChatRecordArticle
        message={message({
          blocks: [
            { type: "text", text: "带你去看那篇笔记。" },
            {
              type: "nav",
              label: "打开《消防疏散与灭火器使用》",
              route: { kind: "note", noteId: "5a5a5a5a-5a5a-4a5a-8a5a-5a5a5a5a5a5a" },
            },
          ],
        })}
        chat={session(goToRoute)}
      />,
    );
    const link = screen.getByRole("button", { name: "打开《消防疏散与灭火器使用》" });
    fireEvent.click(link);
    expect(goToRoute).toHaveBeenCalledWith({
      kind: "note.detail",
      noteId: "5a5a5a5a-5a5a-4a5a-8a5a-5a5a5a5a5a5a",
    });
  });

  it("落点失败时就地说明并允许重试", async () => {
    const goToRoute = vi.fn().mockRejectedValueOnce(new Error("导航失败")).mockResolvedValueOnce(undefined);
    render(<CompanionChatRecordArticle message={message({ blocks: [
      { type: "nav", label: "去复习", route: { kind: "review" } },
    ] })} chat={session(goToRoute)} />);
    const button = screen.getByRole("button", { name: "去复习" });
    fireEvent.click(button);
    await waitFor(() => expect(screen.getByRole("status")).toBeTruthy());
    expect(button.hasAttribute("disabled")).toBe(false);
    fireEvent.click(button);
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
    expect(goToRoute).toHaveBeenCalledTimes(2);
  });

  it("桌面端没有等价形态的落点：留下她去过哪里的痕迹，但不给假按钮", () => {
    const goToRoute = vi.fn();
    render(
      <CompanionChatRecordArticle
        message={message({
          blocks: [
            { type: "text", text: "今天这页给你看看。" },
            { type: "nav", label: "去今日", route: { kind: "today" } },
          ],
        })}
        chat={session(goToRoute)}
      />,
    );
    expect(screen.queryByRole("button", { name: "去今日" })).toBeNull();
    expect(screen.getByText("去今日")).toBeTruthy();
    expect(goToRoute).not.toHaveBeenCalled();
  });

  it("同一句话里多个落点按顺序都在", () => {
    render(
      <CompanionChatRecordArticle
        message={message({
          blocks: [
            { type: "text", text: "两个都打开。" },
            { type: "nav", label: "去复习", route: { kind: "review" } },
            {
              type: "nav",
              label: "去星图",
              route: { kind: "star_map", keyPointId: "6b6b6b6b-6b6b-4b6b-8b6b-6b6b6b6b6b6b" },
            },
          ],
        })}
        chat={session()}
      />,
    );
    const labels = ["去复习", "去星图"].map((label) => screen.getByRole("button", { name: label }));
    expect(labels[0].compareDocumentPosition(labels[1]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("没有 nav 块的消息一个字都不多渲染（历史消息不受影响）", () => {
    render(<CompanionChatRecordArticle message={message()} chat={session()} />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("带你去看那篇笔记。")).toBeTruthy();
  });

  it("quote 块：她读到的原文带着标题时间留在消息里，不是她转述过的版本", () => {    render(
      <CompanionChatRecordArticle
        message={message({
          blocks: [
            { type: "text", text: "写了四步：关燃气、带应急包、走安全通道、到集合点。" },
            { type: "quote", label: "《消防疏散与灭火器使用》· 3 天前", text: "多层住宅疏散：先关燃气总阀……" },
          ],
        })}
        chat={session()}
      />,
    );
    expect(screen.getByText("《消防疏散与灭火器使用》· 3 天前")).toBeTruthy();
    expect(screen.getByText("多层住宅疏散：先关燃气总阀……")).toBeTruthy();
    // 原文不会被并进正文（否则同一段出现两遍）
    expect(screen.getByText("写了四步：关燃气、带应急包、走安全通道、到集合点。")).toBeTruthy();
  });

  it("diagram 块：步骤按顺序排成竖向流程，带编号与补充说明", () => {
    render(
      <CompanionChatRecordArticle
        message={message({
          blocks: [
            { type: "text", text: "疏散四步给你列出来：" },
            {
              type: "diagram",
              title: "消防疏散四步",
              steps: [
                { label: "关燃气阀门" },
                { label: "带应急包" },
                { label: "走安全通道", detail: "高层用防烟楼梯间，别坐电梯" },
                { label: "到集合点报到" },
              ],
            },
          ],
        })}
        chat={session()}
      />,
    );
    expect(screen.getByText("消防疏散四步")).toBeTruthy();
    const items = [...document.querySelectorAll(".companion-record__diagram li")];
    expect(items.map((li) => li.textContent)).toEqual([
      "1关燃气阀门",
      "2带应急包",
      "3走安全通道高层用防烟楼梯间，别坐电梯",
      "4到集合点报到",
    ]);
  });

  it("card 块：题面与「这张卡在考什么」一起出现，缺摘要也不显示 null", () => {
    render(
      <CompanionChatRecordArticle
        message={message({
          blocks: [
            { type: "text", text: "这张卡考的是比例关系。" },
            {
              type: "card",
              cardId: "7c7c7c7c-7c7c-4c7c-8c7c-7c7c7c7c7c7c",
              front: "在质量相同的情况下，施加两倍合外力，加速度会如何变化？",
              summary: "理解牛顿第二定律在质量不变时，加速度与合外力成正比。",
              knowledgeForm: "application_rule",
            },
          ],
        })}
        chat={session()}
      />,
    );
    expect(screen.getByText("在质量相同的情况下，施加两倍合外力，加速度会如何变化？")).toBeTruthy();
    expect(screen.getByText(/加速度与合外力成正比/)).toBeTruthy();
    expect(document.body.textContent).not.toContain("null");
  });
});

/**
 * 图片块（方案 29 §4.8 里 B6 剩下的那一块）。
 *
 * 图由 `companion_show_image` 服务端拼出 `/api/uploads/{objectKey}`，字节走 main 的
 * 站内图片通道（渲染层 origin 是 `ailearn-app://`，相对路径会 404，外链又被 CSP 拦）。
 * 这三态断言钉的是：**载入中不能出现破图**、取不回来要说得出人话而不是留一个空框、
 * 以及图注要跟图在一起（一篇笔记可能有 13 张图，没有图注就不知道她说的是哪张）。
 */
describe("CompanionChatRecordArticle 的图片块", () => {
  const imageBlock = {
    type: "image" as const,
    url: "/api/uploads/0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f/notes/a7/98d6.png",
    label: "《消防疏散》· 第 2 张",
  };

  const retry = vi.fn();

  function renderWithState(state: { status: string; src?: string }) {
    vi.mocked(useSourceImage).mockReturnValue({ state, retry } as never);
    render(
      <CompanionChatRecordArticle
        message={message({
          blocks: [
            { type: "text", text: "就是这张图。" },
            imageBlock,
          ],
        })}
        chat={session()}
      />,
    );
  }

  it("字节就位时渲染真图，图注跟着图走", () => {
    renderWithState({ status: "ready", src: "blob:app/abc" });
    const img = screen.getByRole("img");
    expect(img.getAttribute("src")).toBe("blob:app/abc");
    expect(img.getAttribute("alt")).toContain("消防疏散");
    expect(screen.getByText("《消防疏散》· 第 2 张")).toBeTruthy();
    const turn = img.closest("article");
    expect(turn?.classList.contains("companion-record__rich-turn")).toBe(true);
    expect(img.closest(".companion-record__body")).toBeNull();
  });

  it("还在取字节时不给破图，只给一句载入中", () => {
    renderWithState({ status: "loading" });
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByText(/正在载入图片/)).toBeTruthy();
  });

  it("取不回来时照实说，并留下重试而不是永久空框", () => {
    renderWithState({ status: "unavailable" });
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByText(/图片取不回来/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /重试/ }));
    expect(retry).toHaveBeenCalledTimes(1);
  });
});

describe("引用块的高度上限（实机量到一条长引用把正文撑到 1256px）", () => {
  const ownScroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight");
  const ownClient = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");
  const restore = () => {
    if (ownScroll) Object.defineProperty(HTMLElement.prototype, "scrollHeight", ownScroll);
    if (ownClient) Object.defineProperty(HTMLElement.prototype, "clientHeight", ownClient);
  };
  const fake = (scrollHeight: number, clientHeight: number) => {
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", { configurable: true, get: () => scrollHeight });
    Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => clientHeight });
  };
  afterEach(restore);

  const quoteMessage = () => message({
    blocks: [
      { type: "text", text: "这篇的原文给你贴在下面。" },
      { type: "quote", label: "《IndexTTS 2.5》· 3 天前", text: "一段很长的原文……" },
    ],
  });

  it("正文超出折叠高度才出「展开原文」，展开之后还能收回去", () => {
    fake(1256, 168);
    render(<CompanionChatRecordArticle message={quoteMessage()} chat={session()} />);
    const figure = document.querySelector(".companion-record__quote")!;
    expect(figure.hasAttribute("data-expanded")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "展开原文" }));
    expect(figure.getAttribute("data-expanded")).toBe("true");
    expect(screen.getByRole("button", { name: "收起原文" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "收起原文" }));
    expect(figure.hasAttribute("data-expanded")).toBe(false);
  });

  it("没超出就一个节点都不多：短引用不该带按钮", () => {
    fake(160, 160);
    render(<CompanionChatRecordArticle message={quoteMessage()} chat={session()} />);
    expect(screen.queryByRole("button", { name: /原文/ })).toBeNull();
  });

  it("按钮不能被裁进受高度的那段里（否则收起来就展不开）", () => {
    fake(1256, 168);
    render(<CompanionChatRecordArticle message={quoteMessage()} chat={session()} />);
    const text = document.querySelector(".companion-record__quote p")!;
    const toggle = screen.getByRole("button", { name: "展开原文" });
    expect(text.contains(toggle)).toBe(false);
    expect(toggle.parentElement?.classList.contains("companion-record__quote")).toBe(true);
  });
});

/**
 * 用户 2026-09-21 的原话：「这里图片放大应该全屏放大啊，不然放大一点效果都没有，
 * 抽屉的窗口那么小」——实机量的灯箱是 406×778，正好等于抽屉。
 * 两条一起钉：① 灯箱必须挂在 body 上（否则抽屉的 animation fill-mode 让它只能铺满抽屉）；
 * ② 挂到 body 之后必须带"伴星自家"标记，否则存在层又会把它当外部模态、把抽屉关掉
 *    （那正是这次改动要修的前一个 bug）。
 */
describe("CompanionChatRecordArticle 的图片放大", () => {
  const retry = vi.fn();

  function renderImage() {
    vi.mocked(useSourceImage).mockReturnValue({
      state: { status: "ready", src: "blob:companion-image" },
      retry,
    } as never);
    render(
      <CompanionChatRecordArticle
        message={message({
          blocks: [
            { type: "text", text: "就是这张图。" },
            {
              type: "image",
              url: "/api/uploads/0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f/notes/a7/98d6.png",
              label: "《消防疏散》· 第 2 张",
            },
          ],
        })}
        chat={session()}
      />,
    );
    fireEvent.click(screen.getByAltText("《消防疏散》· 第 2 张"));
  }

  it("灯箱挂在 body 上，而不是被困在消息列里", () => {
    renderImage();
    const lightbox = document.querySelector(".image-lightbox");
    expect(lightbox).toBeTruthy();
    expect(lightbox?.parentElement).toBe(document.body);
    expect(document.querySelector(".companion-record__image .image-lightbox")).toBeNull();
  });

  it("portal 之后仍然被认成伴星自己的模态（否则抽屉会再次被关掉）", () => {
    renderImage();
    const lightbox = document.querySelector(".image-lightbox")!;
    expect(lightbox.getAttribute("data-companion-owned")).toBe("true");
    expect(hasForeignModal(document)).toBe(false);
  });
});

/**
 * 月历本身的两条合同。伴星中心的日记筛选要复用这张面板（2026-09-22 用户指定
 * 「换成历史纪录那里的那种日期面板」），而日记侧**没有**「哪几天有内容」的数据
 * ——daily.get 一次只给一天。所以这里钉住：不给 pool 时只按 maxDay 决定可选性。
 */
describe("MonthCalendar 的可选范围", () => {
  afterEach(cleanup);

  /** 格子按「日子是它自己的那一段文字」来找，不受角标数字（`10` + `2`）干扰。 */
  const dayButton = (day: number) => [...document.querySelectorAll<HTMLButtonElement>(".companion-record__calendar-grid button")]
    .find((button) => button.firstChild?.textContent === String(day));

  const renderCalendar = (props: Parameters<typeof MonthCalendar>[0]) =>
    render(<MonthCalendar {...props} />);

  it("不给 pool 时，只把 maxDay 之后的日子禁掉", () => {
    renderCalendar({ selected: "2026-09-10", maxDay: "2026-09-15", onPick: () => undefined });
    expect(dayButton(10)?.disabled).toBe(false);
    expect(dayButton(15)?.disabled).toBe(false);
    expect(dayButton(16)?.disabled).toBe(true);
    expect(dayButton(30)?.disabled).toBe(true);
    // 没有计数数据就不许编出角标——那会是「今天有 0 篇」这种假话。
    expect(document.querySelector(".companion-record__calendar-grid button i")).toBeNull();
  });

  it("给 pool 时仍然只放开有记录的日子，并把条数标出来", () => {
    renderCalendar({
      pool: [
        message({ createdAt: "2026-09-10T00:00:00.000Z" }),
        message({ createdAt: "2026-09-10T01:00:00.000Z" }),
        message({ createdAt: "2026-09-12T00:00:00.000Z" }),
      ],
      selected: "2026-09-10",
      onPick: () => undefined,
    });
    expect(dayButton(10)?.disabled).toBe(false);
    expect(dayButton(11)?.disabled).toBe(true);
    expect(dayButton(10)?.querySelector("i")?.textContent).toBe("2");
    expect(dayButton(12)?.querySelector("i")?.textContent).toBe("1");
    expect(dayButton(10)?.getAttribute("data-selected")).toBe("true");
  });
});
