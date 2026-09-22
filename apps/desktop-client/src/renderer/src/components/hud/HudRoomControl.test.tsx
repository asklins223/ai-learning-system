// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useRoomStore } from "../../app/room-store";
import { HudRoomControl } from "./HudRoomControl";

/**
 * 顶栏空间胶囊是「我在哪个空间、我能不能改」的唯一常驻答案。审查里它不存在：
 * 药丸一折叠就只剩一枚印章，切换空间在屏幕上没有任何持续痕迹。这些用例钉住的
 * 正是"折叠态也必须在"这一条——按样式表推理不算数。
 */

afterEach(() => {
  cleanup();
  useRoomStore.getState().setSpaceIdentity(null);
});

describe("顶栏常驻空间胶囊", () => {
  it("折叠态也把空间名与角色摆在屏幕上", () => {
    useRoomStore.getState().setSpaceIdentity({ name: "量子力学共读", role: "member", isPersonal: false });
    render(<div className="hud-surface"><HudRoomControl /></div>);

    const chip = screen.getByRole("button", { name: /^当前学习空间 量子力学共读/ });
    expect(chip.textContent).toContain("量子力学共读");
    expect(chip.textContent).toContain("成员 · 只读");
    // 只读必须落成文字，不能只靠冷色（a11y 合同：颜色不能是唯一载体）。
    expect(chip.getAttribute("data-readonly")).toBe("true");
  });

  it("个人空间不再吞掉角色：写的是「个人空间 · 所有者」", () => {
    useRoomStore.getState().setSpaceIdentity({ name: "我的书房", role: "owner", isPersonal: true });
    render(<div className="hud-surface"><HudRoomControl /></div>);

    const chip = screen.getByRole("button", { name: /^当前学习空间 我的书房/ });
    expect(chip.textContent).toContain("个人空间 · 所有者");
    expect(chip.getAttribute("data-readonly")).toBeNull();
  });

  it("还没读到会话时明说在读，而不是留一个空白胶囊", () => {
    render(<div className="hud-surface"><HudRoomControl /></div>);

    const chip = screen.getByRole("button", { name: "正在读取你当前的学习空间" });
    expect(chip.textContent).toContain("正在读取空间");
  });

  it("04A 的装饰态药丸不能点，也不会冒充可用", () => {
    useRoomStore.getState().setSpaceIdentity({ name: "首次进入", role: "owner", isPersonal: true });
    render(<div className="hud-surface"><HudRoomControl decorative /></div>);

    expect(screen.getByRole("button", { name: /^当前学习空间 首次进入/ }).hasAttribute("disabled")).toBe(true);
  });
});

/**
 * B0（评审文档 §4）：折叠态把 6 个槽位的**宽度**回收，岛从 424px 收到 184px，
 * 胶囊于是被岛的左缘带着左移——它自己不参与任何动画。
 *
 * 这套用例钉的是「CSS 能生效的那些前提」。jsdom 不加载样式表，所以它测不到
 * width/transition；它测的是样式表用来点名槽位的那三条钩子：扁平结构、
 * `data-expanded` 状态、`inert` 归属。任何一条断了，末尾追加的规则就静默失效——
 * 「加了包裹层」正是最可能的那一种断法（6 个槽位是没有 class 的裸 button，
 * 只能靠 `> button:not(...)` 命名，包一层 div 会同时摘掉约 17 条规则）。
 */

/** 样式表用来命名那 6 个裸 button 的选择器，与 hud-surface.css 必须逐字一致。 */
const SLOT_SELECTOR = ":not(.room-control-trigger):not(.room-control-space)";

function renderIsland() {
  useRoomStore.getState().setSpaceIdentity({ name: "我的书房", role: "owner", isPersonal: true });
  render(<div className="hud-surface"><HudRoomControl /></div>);
  const root = document.querySelector(".room-control") as HTMLElement;
  const chip = root.querySelector(".room-control-space") as HTMLElement;
  const trigger = root.querySelector(".room-control-trigger") as HTMLElement;
  return { root, chip, trigger };
}

describe("顶栏灵动岛的折叠结构", () => {
  afterEach(cleanup);

  it("岛是扁平的 8 颗 button，槽位能被样式表那条选择器点到", () => {
    const { root, chip, trigger } = renderIsland();

    // 包裹层一旦加进来，children 变成 3，:nth-child 错峰与 > button 全部失配。
    expect(root.children).toHaveLength(8);
    [...root.children].forEach((child) => expect(child.tagName).toBe("BUTTON"));
    expect(root.firstElementChild).toBe(chip);
    expect(root.lastElementChild).toBe(trigger);

    for (let index = 2; index <= 7; index += 1) {
      const slot = root.children[index - 1];
      expect(slot.matches(`:scope > button:nth-child(${index})${SLOT_SELECTOR}`), `槽位 ${index} 选不中了`).toBe(true);
    }
  });

  it("data-expanded 是真值或整个不存在，且与印章的 aria-expanded 同步", () => {
    const { root, trigger } = renderIsland();
    expect(root.hasAttribute("data-expanded")).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "展开学习空间控制" }));
    expect(root.getAttribute("data-expanded")).toBe("true");
    expect(trigger.getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "收起学习空间控制" }));
    expect(root.hasAttribute("data-expanded")).toBe(false);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("inert 只跟着展开态管那 6 个槽位，胶囊两态都可点", () => {
    const { root, chip, trigger } = renderIsland();
    const slots = [...root.children].slice(1, 7);

    // 折叠态：胶囊是「我在哪个空间」的唯一常驻答案，绝不能被 inert 掉。
    slots.forEach((slot) => expect(slot.hasAttribute("inert")).toBe(true));
    expect(chip.hasAttribute("inert")).toBe(false);
    expect(trigger.hasAttribute("inert")).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "展开学习空间控制" }));
    slots.forEach((slot) => expect(slot.hasAttribute("inert")).toBe(false));
  });

  it("Esc 收起岛并把焦点还给印章", () => {
    const { root, trigger } = renderIsland();
    fireEvent.click(screen.getByRole("button", { name: "展开学习空间控制" }));
    expect(root.getAttribute("data-expanded")).toBe("true");

    fireEvent.keyDown(window, { key: "Escape" });
    expect(root.hasAttribute("data-expanded")).toBe(false);
    return waitFor(() => expect(document.activeElement).toBe(trigger));
  });
});

/**
 * 账户槽位（2026-09-21）：这个槽位以前是一个 `UserRound` 图标，点下去直接跳设置页。
 * 于是「这台设备上登录的是谁」在屏幕上没有答案，而换账号最需要的退出无处可点。
 * 现在它报得出账号，点开是一个与学习空间同款的窄框。
 */

function stubAccountGateway() {
  const envelope = <T,>(data: T) => ({
    version: 1 as const,
    ok: true as const,
    data,
    requestId: "r",
    correlationId: "c",
    schemaRevision: "desktop-ipc-v1",
  });
  Object.defineProperty(window, "ailearn", {
    configurable: true,
    value: {
      auth: {
        getProfile: async () => envelope({ version: 1, displayName: null, avatarUrl: null }),
        getAvatar: async () => envelope({ version: 1, mimeType: "image/png", imageBase64: "" }),
        logout: async () => envelope({ loggedOut: true as const, serverRevoked: true as const }),
      },
    },
  });
}

describe("顶栏账户槽位", () => {
  afterEach(() => {
    cleanup();
    Reflect.deleteProperty(window, "ailearn");
    useRoomStore.setState({ accountIdentity: null, accountAvatar: null });
  });

  it("槽位说得出当前登录的是哪个账号", () => {
    stubAccountGateway();
    useRoomStore.getState().setAccountIdentity({ email: "asklins@example.com", displayName: "Asklins" });
    render(<div className="hud-surface"><HudRoomControl /></div>);

    const account = screen.getByRole("button", { name: /^当前登录账号 Asklins/ });
    expect(account.getAttribute("aria-label")).toContain("asklins@example.com");
    expect(account.className).toContain("room-control-account");
  });

  it("还没读到会话时不冒充知道是谁", () => {
    stubAccountGateway();
    render(<div className="hud-surface"><HudRoomControl /></div>);

    expect(screen.getByRole("button", { name: "正在读取这台设备登录的账号" })).toBeTruthy();
  });

  it("点账户槽位会展开岛并弹出小框，退出登录就在里面", () => {
    stubAccountGateway();
    useRoomStore.getState().setAccountIdentity({ email: "asklins@example.com", displayName: null });
    render(<div className="hud-surface"><HudRoomControl /></div>);

    const account = screen.getByRole("button", { name: /^当前登录账号 asklins@example.com/ });
    expect(account.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(account);

    expect(account.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("button", { name: /^退出登录/ })).toBeTruthy();
  });

  it("账户小框与空间菜单互斥：一屏上不会同时挂两张卡", () => {
    stubAccountGateway();
    useRoomStore.getState().setSpaceIdentity({ name: "我的书房", role: "owner", isPersonal: true });
    useRoomStore.getState().setAccountIdentity({ email: "asklins@example.com", displayName: null });
    render(<div className="hud-surface"><HudRoomControl /></div>);

    fireEvent.click(screen.getByRole("button", { name: /^当前学习空间/ }));
    expect(document.querySelectorAll(".room-control-menu")).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: /^当前登录账号/ }));
    expect(document.querySelectorAll(".room-control-menu")).toHaveLength(1);
    expect(screen.getByRole("button", { name: /^退出登录/ })).toBeTruthy();

    // 反过来也一样：点空间胶囊不会把两张卡叠起来。
    fireEvent.click(screen.getByRole("button", { name: /^当前学习空间/ }));
    expect(screen.queryByRole("button", { name: /^退出登录/ })).toBeNull();
  });

  it("Esc 先关小框、把焦点还给账户槽位，岛本身不收", async () => {
    stubAccountGateway();
    useRoomStore.getState().setAccountIdentity({ email: "asklins@example.com", displayName: null });
    render(<div className="hud-surface"><HudRoomControl /></div>);

    const account = screen.getByRole("button", { name: /^当前登录账号/ });
    fireEvent.click(account);
    const root = document.querySelector(".room-control") as HTMLElement;

    fireEvent.keyDown(window, { key: "Escape" });

    expect(root.getAttribute("data-expanded")).toBe("true");
    expect(account.getAttribute("aria-expanded")).toBe("false");
    await waitFor(() => expect(document.activeElement).toBe(account));
  });

  it("04A 的装饰态药丸里账户槽位同样不能点", () => {
    stubAccountGateway();
    useRoomStore.getState().setAccountIdentity({ email: "first@example.com", displayName: null });
    render(<div className="hud-surface"><HudRoomControl decorative /></div>);

    expect(screen.getByRole("button", { name: /^当前登录账号/ }).hasAttribute("disabled")).toBe(true);
  });
});

/**
 * 再点一次同一个槽位就该把手里的卡收回去（2026-09-22 用户报："再次点击头像不能缩放
 * 或者关闭回去浮窗"）。这条对顶栏两张卡都成立：账户小框是新加的，空间胶囊是旧的，
 * 但人的手感一样——那颗东西还在那儿、还亮着，就是在等我再点它一下。
 */
describe("再点同一个槽位收起它的卡", () => {
  afterEach(() => {
    cleanup();
    Reflect.deleteProperty(window, "ailearn");
    useRoomStore.setState({ accountIdentity: null, accountAvatar: null });
  });

  function openAccountCard() {
    fireEvent.click(screen.getByRole("button", { name: "展开学习空间控制" }));
    fireEvent.click(screen.getByRole("button", { name: /^当前登录账号/ }));
    expect(document.querySelectorAll(".room-control-menu")).toHaveLength(1);
  }

  it("再点头像：卡片收掉，岛留在展开态", () => {
    stubAccountGateway();
    useRoomStore.getState().setAccountIdentity({ email: "asklins@example.com", displayName: null });
    render(<div className="hud-surface"><HudRoomControl /></div>);
    openAccountCard();

    fireEvent.click(screen.getByRole("button", { name: /^当前登录账号/ }));

    expect(document.querySelectorAll(".room-control-menu")).toHaveLength(0);
    expect((document.querySelector(".room-control") as HTMLElement).dataset.expanded).toBe("true");
    expect(screen.getByRole("button", { name: /^当前登录账号/ }).getAttribute("aria-expanded")).toBe("false");
  });

  it("再点头像关掉后，第三次点又能打开（不是只关不开）", () => {
    stubAccountGateway();
    useRoomStore.getState().setAccountIdentity({ email: "asklins@example.com", displayName: null });
    render(<div className="hud-surface"><HudRoomControl /></div>);
    openAccountCard();
    fireEvent.click(screen.getByRole("button", { name: /^当前登录账号/ }));

    fireEvent.click(screen.getByRole("button", { name: /^当前登录账号/ }));

    expect(document.querySelectorAll(".room-control-menu")).toHaveLength(1);
    expect(screen.getByRole("button", { name: /^退出登录/ })).toBeTruthy();
  });

  it("卡开着时头像处于激活态（告诉人这张卡归它管）", () => {
    stubAccountGateway();
    useRoomStore.getState().setAccountIdentity({ email: "asklins@example.com", displayName: null });
    render(<div className="hud-surface"><HudRoomControl /></div>);
    openAccountCard();

    expect(screen.getByRole("button", { name: /^当前登录账号/ }).className).toContain("active");
  });

  it("空间胶囊同样 toggle：再点一次收起学习空间那张卡", () => {
    stubAccountGateway();
    useRoomStore.getState().setSpaceIdentity({ name: "我的书房", role: "owner", isPersonal: true });
    render(<div className="hud-surface"><HudRoomControl /></div>);
    fireEvent.click(screen.getByRole("button", { name: "展开学习空间控制" }));
    fireEvent.click(screen.getByRole("button", { name: /^当前学习空间/ }));
    expect(document.querySelectorAll(".room-control-menu")).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: /^当前学习空间/ }));

    expect(document.querySelectorAll(".room-control-menu")).toHaveLength(0);
  });
});
