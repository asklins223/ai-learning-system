/**
 * 跨屏进度带的静态守卫（31 号文档 §9.1，批次 B10）。
 *
 * 放在 main 侧的理由和 `objective-flow-css-guard.test.ts` 一样：读文件要用
 * `node:fs`，而 `tsconfig.web.json` 的编译图里没有 Node 类型。
 *
 * 它钉的是这一批唯一的真风险：**三个屏各画一条"像进度条的东西"**，或者某个屏
 * 嫌查表不够灵活、自己从 rubric 计数里推一个位置出来。前者是原文的病，后者是
 * 合同明令禁止的（`learning-objective-surface-contracts.ts:232-235`：
 * 不得在各客户端按各自优先级重新推导）。
 */
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (relative: string) => {
  const fromCwd = `src/renderer/src/components/surfaces/${relative}`;
  const fromRoot = `apps/desktop-client/src/renderer/src/components/surfaces/${relative}`;
  const path = existsSync(fromCwd) ? fromCwd : existsSync(fromRoot) ? fromRoot : null;
  // 读不到就必须喊：静默跳过等于一条永远绿的空守卫。
  expect(path, `找不到 ${relative}（cwd=${process.cwd()}）`).not.toBeNull();
  return readFileSync(path as string, "utf8");
};

const SURFACES = ["WorkspaceLibrarySurface.tsx", "learning-run-surface.tsx"];

describe("三屏共用同一个进度组件", () => {
  // 验收口径写的是"四屏"，作答页这一屏没做：run 快照的 target 里只有题面、
  // 评分规则与练习件，**没有** personalState（learning-target-v2-contracts.ts:125-152）。
  // 在那里挂一条恒为 — 的带子不叫进度语言，叫噪音。
  it("列表焦点卡与详情页读 personalState，结算页读本次 outcome", () => {
    const library = read("WorkspaceLibrarySurface.tsx");
    expect(
      // 允许 `segment=` 之后还挂别的 prop（F03 加了 `submitted`），但读数那一句
      // 必须原样是查表调用。
      library.match(/<ObjectiveProgressBand\s+segment=\{progressSegmentForState\(([^)]+)\)\}/g),
      "列表与详情不再是同一个读数来源",
    ).toHaveLength(2);
    expect(read("learning-run-surface.tsx"))
      .toMatch(/<ObjectiveProgressBand segment=\{progressSegmentForOutcome\(result\?\.outcome\)\} \/>/);
  });

  it("没有任何一屏把进度带喂成自己算出来的数", () => {
    // 组件的 prop 只有 `segment: number | null`，所以"绕过查表自己推"唯一的形态
    // 就是传字面量或三元式。这条断言把每个调用点钉在查表函数上。
    const calls = SURFACES.flatMap((file) =>
      [...read(file).matchAll(/<ObjectiveProgressBand\s+segment=\{([^}]+)\}/g)].map((match) => ({ file, expr: match[1].trim() })));
    expect(calls.length, "一个调用点都没找到，这条守卫就是空的").toBeGreaterThanOrEqual(3);
    for (const call of calls) {
      expect(call.expr, `${call.file} 的调用点没走查表`).toMatch(/^progressSegmentFor(State|Outcome)\(/);
    }
    // 第二条腿：除 `segment` 之外还能挂哪些 prop，逐个列死。位置只能来自查表，
    // 但"带子上的措辞"也是同一屏的事实来源——放开成任意 prop 就等于允许第二个
    // 客户端自己推导出来的读数。
    for (const file of SURFACES) {
      for (const match of read(file).matchAll(/<ObjectiveProgressBand([^>]*?)\/>/g)) {
        const props = [...match[1].matchAll(/\b([a-zA-Z]+)=/g)].map((p) => p[1]);
        for (const prop of props) {
          expect(["segment", "submitted", "className"], `${file} 挂了没登记的 prop：${prop}`).toContain(prop);
        }
      }
    }
  });
});
