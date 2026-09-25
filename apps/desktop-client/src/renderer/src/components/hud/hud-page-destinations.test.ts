/**
 * 页面词表对账（39b §9.6 / 39d W2-1 的判据：「`HudPageId` 对账差集为空，判据从 schema 现读、
 * 不写死数字」）。
 *
 * 钉的是这一句：**她读得到的屏，要么跳得回去，要么被显式声明为跳不回去并给出理由。**
 * 两种失败形状过去都真实发生过：
 *  - 「今日」「设置」服务端发得出来、桌面端没有落点（跳过去打不开）；
 *  - 笔记库/学习卡/查找三页她**根本叫不出名字**，只能被就近塞进来源库和星图。
 * 而这四套词表当年各写一份，所以哪一处对不上，没有任何东西会红。
 *
 * 判据全部从 schema 现读（`HudPageId` 的 `Record` 形状、`companionPageKindValuesV2`、
 * 读侧 `pageKind` 枚举），**不抄第二份名字清单**——抄一份就等于给漂移留了第二个落点。
 */
import { mainPageContextInputV2Schema } from "@ailearn/shared/companion-bridge-contracts";
import { COMPANION_PAGE_DESTINATIONS_V2 } from "@ailearn/shared/companion-bridge-contracts";
import { describe, expect, it } from "vitest";

import { HUD_PAGE_DESTINATIONS, HUD_PAGES } from "./hud-pages";

/** 读侧 pageKind 的取值域：她从渲染层的页面上下文里**能看到**的那一屏。 */
function readablePageKinds(): string[] {
  const shape = mainPageContextInputV2Schema.shape.pageKind;
  return [...shape.options];
}

describe("页面词表对账（W2-1）", () => {
  it("每一屏都有对账条目，且落点值必须是词表里真有的档", () => {
    const hudIds = Object.keys(HUD_PAGES).sort();
    const mapped = Object.keys(HUD_PAGE_DESTINATIONS).sort();

    // 正控制：两边都得真的读到东西。
    expect(hudIds.length).toBeGreaterThan(15);
    expect(mapped.length).toBeGreaterThan(15);

    expect(mapped, "这一屏没有对账条目（漏了就是靠「反正没有」蒙过去）").toEqual(hudIds);

    const known = new Set<string>(COMPANION_PAGE_DESTINATIONS_V2.map((entry) => entry.kind));
    const bogus = Object.entries(HUD_PAGE_DESTINATIONS)
      .filter(([, destination]) => destination !== null && !known.has(destination))
      .map(([page, destination]) => `${page} → ${destination}`);
    expect(bogus, "对账表指向了词表里不存在的落点档").toEqual([]);
  });

  it("她读得到的屏都有去处，或写明为什么没有", () => {
    // 显式声明「读得到但跳不回去」的那几档，**每条都要有理由**（见 hud-pages.ts 的注释）。
    // 加一档而忘了填这里，下面那条差集就会红——这正是要它红的地方。
    const READABLE_WITHOUT_DESTINATION: Readonly<Record<string, string>> = {
      // 单篇笔记 / 单张卡：走各自专用的打开工具（companion_open_note / companion_open_card），
      // 不走 companion_open_page —— 那一个只收无参落点。
      note: "companion_open_note 专用工具",
      card: "companion_open_card 专用工具",
      // 单个学习目标：没有「单目标页」的无参落点（goal-detail 需要 objectiveId）。
      objective: "goal-detail 需要 objectiveId，无参落点不存在",
      // 正在跑的学习运行：assessment / result / resumable 都需要 runId。
      learning_run: "assessment/result/resumable 都需要 runId，无参落点不存在",
      // 渲染层自报「别的页」，不是一屏真实的屏。
      other: "渲染层的兜底值，不对应任何一屏",
    };

    const destinations = new Set<string>(COMPANION_PAGE_DESTINATIONS_V2.map((entry) => entry.kind));
    const orphans = readablePageKinds()
      .filter((kind) => !destinations.has(kind))
      .filter((kind) => !(kind in READABLE_WITHOUT_DESTINATION));

    expect(
      orphans,
      "这些屏她读得到、却没有落点、也没写明为什么——补一个落点档，或加进 READABLE_WITHOUT_DESTINATION 并给理由",
    ).toEqual([]);

    // 反向：声明表里不许留下已经不需要声明的条目（它已经能跳回去了就该删掉声明）。
    const stale = Object.keys(READABLE_WITHOUT_DESTINATION)
      .filter((kind) => destinations.has(kind));
    expect(stale, "这些屏已经有落点了，声明该删").toEqual([]);
  });

  it("正负对照：差集判据认得出「读得到没落点」的形状", () => {
    const detect = (readable: readonly string[], destinations: readonly string[], declared: Record<string, string>) =>
      readable.filter((kind) => !destinations.includes(kind)).filter((kind) => !(kind in declared));

    // 正控制——该报：新增一屏读得到、没落点、没声明。
    expect(detect(["today", "brand_new_room"], ["today"], {})).toEqual(["brand_new_room"]);
    // 负控制——不该报：声明了理由就放过。
    expect(detect(["today", "brand_new_room"], ["today"], { brand_new_room: "需要 id" })).toEqual([]);
  });
});
