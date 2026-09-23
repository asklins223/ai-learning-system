/**
 * 首页功能"接线状态"必须与真正的处理器对账（doc 34 L35）。
 *
 * 病的确切形状不是"有个没用的弹窗"，而是**两份手抄名单**：
 * `home-feature-registry.ts` 里的 `WIRED_HOME_FEATURE_IDS` 决定目录上写
 * 「小屋可用」还是「新版页面尚未接入」，而 `HomeV2Experience.runFeature` 的分支
 * 决定按下去到底会不会发生事。两边各写一遍，就没有任何东西保证它们说的是同一件事：
 * 今天 11 个 id 两边都齐，于是注册表里 8 组"尚未接入"的文案全部不可达（那是死文案），
 * 而哪天加了 id 却忘了加分支，界面就会挂着"新版页面尚未接入"——**这句话反倒变成假话的反面**：
 * 它会让用户以为只是没接线，其实点下去真的什么都没发生。
 *
 * 所以这道门禁双向检查：标成 native 的必须真有分支，有分支的不许还标着 pending。
 * `HomeFeatureNoticeDialog` 本身**保留**——它是未来真·未接入功能唯一的落点，
 * 删掉它才会让"诚实 pending"彻底没有实现。
 */
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = process.cwd().endsWith("apps/desktop-client") ? "." : "../..";
const read = (relative: string): string => {
  const path = `${root}/${relative}`;
  expect(existsSync(path), `找不到 ${path}（cwd=${process.cwd()}）`).toBe(true);
  return readFileSync(path, "utf8");
};

const registry = read("src/renderer/src/components/home-v2/home-feature-registry.ts");
const experience = read("src/renderer/src/components/home-v2/HomeV2Experience.tsx");

/** 注册表声明的全部功能 id。 */
const declaredIds = [...registry.matchAll(/^\s*"([a-z][a-z0-9-]*)",$/gm)].map((m) => m[1] ?? "");
/** 被标成已接线的那一份名单。 */
const wiredList = registry.slice(
  registry.indexOf("WIRED_HOME_FEATURE_IDS = new Set"),
  registry.indexOf("]);", registry.indexOf("WIRED_HOME_FEATURE_IDS = new Set")),
);
const wiredIds = [...wiredList.matchAll(/"([a-z][a-z0-9-]*)"/g)].map((m) => m[1] ?? "");
/** `runFeature` 里真的处理了的 id（两条写法都算：`feature.id === "x"` 与 `case "x"`）。 */
const handledIds = [
  ...[...experience.matchAll(/feature\.id === "([a-z][a-z0-9-]*)"/g)].map((m) => m[1] ?? ""),
  ...[...experience.matchAll(/case "([a-z][a-z0-9-]*)":/g)].map((m) => m[1] ?? ""),
];


/** 注册表里最终被判成 native 的 id：走名单的 + 直接写死 `availability: "native"` 的。
 *  `catalog` 属于后者（它是房间内的目录动作，不是"某条待接入页面"），
 *  只看 WIRED 名单会把它误报成"已接线却写着未接入"。 */
const nativeIds = new Set<string>(wiredIds);
for (const match of registry.matchAll(/id: "([a-z][a-z0-9-]*)"[^\n]*availability: "native"/g)) {
  if (match[1]) nativeIds.add(match[1]);
}

describe("首页接线状态与处理器一致", () => {
  it("四份清单都解析到了东西（解析失败会伪装成全绿）", () => {
    expect(declaredIds.length, `声明的 id：${declaredIds.join(",")}`).toBeGreaterThanOrEqual(10);
    expect(wiredIds.length).toBeGreaterThan(0);
    expect(handledIds.length).toBeGreaterThan(0);
    expect(nativeIds.size).toBeGreaterThan(0);
  });

  it("名单里不含拼错的 id", () => {
    for (const id of wiredIds) expect(declaredIds, `"${id}" 不在 HOME_FEATURE_IDS 里`).toContain(id);
    for (const id of handledIds) {
      if (!declaredIds.includes(id)) continue; // switch 里也会写 surface 名，只放过声明过的
    }
  });

  it("标成已接线的，`runFeature` 里就必须真有分支", () => {
    const lying = [...nativeIds].filter((id) => !handledIds.includes(id));
    expect(lying, `这些功能写着「小屋可用」，按下去却没有任何分支处理：${lying.join(", ")}`).toEqual([]);
  });

  it("有分支处理的，不许还留在未接线名单上（那会显示假的\u201c尚未接入\u201d）", () => {
    const stale = handledIds.filter((id) => declaredIds.includes(id) && !nativeIds.has(id));
    expect(stale, `这些功能已经接线了，目录上却会说"新版页面尚未接入"：${stale.join(", ")}`).toEqual([]);
  });
});
