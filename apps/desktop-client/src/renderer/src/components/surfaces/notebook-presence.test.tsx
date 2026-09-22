// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { NotebookPresence } from "./notebook-presence";

/**
 * 「谁还开着这一篇」那一排印章（批次 4.4 的 presence 界面）。
 *
 * 这三条各守一种说谎方式：一个人时凭空长出一排头像；对端没报名字时那一位悄悄少掉
 * （人数和头像对不上）；名字只写在悬停里，键盘和读屏用户拿不到。
 *
 * 夹具里的 `block: null` = 对端报了"在场但不在任何块里"。这一页只画人、不画
 * "他在写哪一段"，所以这里给 null；`NoteDocPeer` 要求这个字段，别为了省事把它删掉——
 * 少了它，`npm run typecheck` 会在 renderer 工程里报 TS2741。
 */

const stamps = () => [...document.querySelectorAll(".notebook-presence__peer")];
const letters = () => stamps().map((n) => n.textContent);
const labels = () => stamps().map((n) => n.getAttribute("aria-label"));
const text = () => document.body.textContent ?? "";

afterEach(cleanup);

describe("笔记页的在场印章", () => {
  it("没有别人开着这一篇时整排不出现", () => {
    const { container } = render(<NotebookPresence peers={[]} selfName="Asklins" />);
    expect(container.textContent).toBe("");
    expect(stamps()).toHaveLength(0);
  });

  it("自己排在最前，人数把两枚都算进去", () => {
    render(<NotebookPresence peers={[{ clientId: 7, name: "小琳", block: null }]} selfName="Asklins" />);
    expect(letters()).toEqual(["A", "小"]);
    expect(labels()).toEqual(["Asklins（你）", "小琳"]);
    expect(text()).toContain("2 人在看");
  });

  it("没报名字的对端仍占一枚印章，并说清是没留下名字", () => {
    render(<NotebookPresence peers={[{ clientId: 8, name: null, block: null }]} selfName="Asklins" />);
    expect(letters()).toEqual(["A", "?"]);
    expect(text()).toContain("2 人在看");
    expect(labels()[1]).toBe("没留下名字的协作者");
  });
});
