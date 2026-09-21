// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
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
