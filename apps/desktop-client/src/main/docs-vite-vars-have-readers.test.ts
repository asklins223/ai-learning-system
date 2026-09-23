/**
 * 治理文档点名的构建期变量，源码里必须真有人读（doc 34 L32）。
 *
 * 触发这件事的是一条写在 `PRODUCT.md` / `DESIGN.md` / `docs/feature-flag-inventory.md`
 * 里的合同：`VITE_HOME_SCENE_VARIANT=v2` 启用「魔法伴星小屋」，发布门禁全绿前
 * 保留 V1 回退分支。**代码里没有那个旗标**——全仓 `SCENE_VARIANT` 唯一的命中是
 * `package.json` 里一条截图脚本给它赋值，`HomeV2Provider` 在 `App.tsx:145` 无条件挂载；
 * inventory 还写着"dev 的 `.env.development` 为 v2"，而 `apps/desktop-client` 下
 * 根本没有 `.env*` 文件。
 *
 * 为什么值得一条断言：文档是这个项目的合同来源（视觉确认、权限边界、发布门禁都靠它），
 * 一句"由旗标控制"会让人以为存在回退路径，进而把"改门禁"当成安全的决定。
 *
 * 放在 main 侧同 `objective-flow-copy-guard.test.ts`：读文件要 `node:fs`。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const repoRoot = process.cwd().endsWith("apps/desktop-client")
  ? "../.."
  : existsSync("PRODUCT.md") ? "." : "..";
const docPath = (relative: string) =>
  existsSync(join(repoRoot, relative)) ? join(repoRoot, relative) : null;

const DOCS = ["PRODUCT.md", "DESIGN.md", "docs/feature-flag-inventory.md"];

/**
 * 文档可以点名一个**不存在**的开关（我们已经把它写进校正句，防止有人再去找它），
 * 但必须同时在那一行明说它不存在——否则这条豁免就成了永久免检。
 */
const DECLARED_NONEXISTENT: Record<string, RegExp> = {
  VITE_HOME_SCENE_VARIANT: /不存在|没有那个旗标|不再声称/,
};

function docLines(numericName: string): string[] {
  const out: string[] = [];
  for (const doc of DOCS) {
    const path = docPath(doc);
    if (!path) continue;
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (line.includes(numericName)) out.push(line);
    }
  }
  return out;
}

/** 在桌面端源码里找读取点；**排除测试文件**——守卫自己引用了变量名，
 *  不排除的话它会一直匹配到自己，永远绿。 */
function hasReadSite(variable: string): boolean {
  try {
    const hits = execSync(
      `grep -rIl --exclude-dir=node_modules --exclude-dir=dist --exclude=*.test.ts --exclude=*.test.tsx ${variable} src`,
      { cwd: join(repoRoot, "apps/desktop-client"), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    return hits.length > 0;
  } catch {
    return false; // grep 无命中时退出码为 1
  }
}

describe("文档点名的 VITE_* 变量必须真有读取点", () => {
  const named = new Set<string>();
  const missingDocs: string[] = [];
  for (const doc of DOCS) {
    if (!docPath(doc)) {
      missingDocs.push(doc);
      continue;
    }
    for (const match of readFileSync(docPath(doc) as string, "utf8").matchAll(/\b(VITE_[A-Z0-9_]+)\b/g)) {
      named.add(match[1]);
    }
  }

  it("三份文档都读得到（少一份就可能悄悄把空集当成通过）", () => {
    expect(missingDocs, `读不到：${missingDocs.join(", ")}`).toEqual([]);
    expect(named.size).toBeGreaterThan(0);
  });

  for (const variable of named) {
    it(`${variable} 有读取点，或文档已就地声明它不存在`, () => {
      if (hasReadSite(variable)) return;
      const exemption = DECLARED_NONEXISTENT[variable];
      const lines = docLines(variable);
      expect(
        exemption && lines.length > 0 && lines.every((line) => exemption.test(line)),
        `${variable} 在桌面端源码里没有读取点，文档也没写它不存在——`
        + "文档描述的回退/门禁路径并不存在",
      ).toBe(true);
    });
  }
});
