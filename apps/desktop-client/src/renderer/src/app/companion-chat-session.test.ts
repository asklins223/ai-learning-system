// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { CompanionMessageV1 } from "@ailearn/shared/companion-conversation-contracts";
import {
  navChipsStillOutsideMessages,
  type CompanionNavChip,
} from "./companion-chat-session";

const NOTE_ID = "5a5a5a5a-5a5a-4a5a-8a5a-5a5a5a5a5a5a";

function chip(summary: string, route: CompanionNavChip["route"]): CompanionNavChip {
  return { id: `${summary}-1`, summary, route };
}

function messageWithNav(label: string, route: unknown): CompanionMessageV1 {
  return {
    blocks: [
      { type: "text", text: "带你去看。" },
      { type: "nav", label, route },
    ],
  } as CompanionMessageV1;
}

describe("navChipsStillOutsideMessages（§4.8：消息里的落点取代游离 chip）", () => {
  it("同一条落点已经进了消息，chip 行不再重复出现", () => {
    const messages = [messageWithNav("打开那篇笔记", { kind: "note", noteId: NOTE_ID })];
    const chips = [chip("打开那篇笔记", { kind: "note.detail", noteId: NOTE_ID })];
    expect(navChipsStillOutsideMessages(chips, messages)).toEqual([]);
  });

  it("桌面端没有等价形态的落点也不重复（消息里已留一行字，chip 只会再说一遍）", () => {
    const messages = [messageWithNav("去今日", { kind: "today" })];
    expect(navChipsStillOutsideMessages([chip("去今日", null)], messages)).toEqual([]);
  });

  it("消息里还没有的落点留着：确认后直接给出的落点、以及正在跑的这一轮", () => {
    const messages = [messageWithNav("打开那篇笔记", { kind: "note", noteId: NOTE_ID })];
    const kept = chip("去星图", { kind: "understanding.graph" });
    expect(navChipsStillOutsideMessages([kept], messages)).toEqual([kept]);
  });

  it("一条 nav 块都没有时不改变 chip 行（历史消息不受这条规则影响）", () => {
    const chips = [chip("去复习", { kind: "review.queue" })];
    expect(navChipsStillOutsideMessages(chips, [])).toEqual(chips);
    expect(navChipsStillOutsideMessages(chips, [
      { blocks: [{ type: "text", text: "只有正文" }] },
    ] as CompanionMessageV1[])).toEqual(chips);
  });
});
