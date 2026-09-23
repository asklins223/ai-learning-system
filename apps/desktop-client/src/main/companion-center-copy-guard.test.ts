/**
 * 伴星中心「活跃度」这颗旋钮的文案守卫（doc 34 L24）。
 *
 * 病是这么来的：人格页的「活跃度」管的是**说多少**——`activeness` 只被用在回复长度
 * （`companion-dialogue-content.ts`）与日记段数（`companion-daily-summary.ts`）上；
 * **多久主动开口一次**由账户页的「主动介入」决定（`intervention_level` →
 * `PROACTIVE_CADENCE_MS`）。两处的三档名字一模一样，而人格页此前写的是
 * "控制伴星主动出现的频率"——把用户指向错的旋钮。
 * `companion-account-presence.ts` 顶部注释早就点名过这个"三档同名、不是一回事"，
 * 只是没人去改那句文案。
 *
 * 放在 main 侧的理由同 `objective-flow-copy-guard.test.ts`：读文件要 `node:fs`，
 * `tsconfig.web.json` 的编译图里没有 Node 类型。
 */
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (relative: string): string => {
  const fromCwd = relative;
  const fromRoot = `apps/desktop-client/${relative}`;
  const path = existsSync(fromCwd) ? fromCwd : existsSync(fromRoot) ? fromRoot : null;
  // 读不到就必须喊：静默跳过等于一条永远绿的空守卫。
  expect(path, `找不到 ${relative}（cwd=${process.cwd()}）`).not.toBeNull();
  return readFileSync(path as string, "utf8");
};

// 2026-09-23：伴星中心拆成概述/面板两片，这句说明跟着「人格」面板搬到了
// `companion-center-panels.tsx`。守卫按设计跟着文案走，不跟着文件名。
const surface = read("src/renderer/src/components/surfaces/companion-center-panels.tsx");
const activenessLine = surface
  .split("\n")
  .find((text: string) => text.includes("<h4>活跃度</h4>")) ?? "";

describe("「活跃度」不再冒充频率开关", () => {
  it("那颗旋钮的说明句还在——文案被挪走也要有人来看一眼", () => {
    expect(activenessLine, "找不到「活跃度」那行说明").not.toBe("");
  });

  it("不得再声称它控制主动出现的频率", () => {
    expect(activenessLine).not.toMatch(/频率/);
    expect(activenessLine).not.toMatch(/主动出现/);
  });

  it("必须把「多久开口一次」指回真正管它的旋钮", () => {
    expect(activenessLine).toContain("主动介入");
  });
});
