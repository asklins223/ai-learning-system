/**
 * 桌面测试必须解析到 `packages/shared` 的**实时源码**（doc 34 L41）。
 *
 * 为什么钉在配置文件上而不是钉在结果上：pnpm 对 `file:` 依赖是**安装期快照**——
 * 没编辑过的文件是硬链接（内容跟着源码走），编辑过的文件在 `node_modules` 里
 * 留下的是编辑**之前**的那一份。于是"改了合同，桌面测试还是绿的"，而且
 * `npm run typecheck`（tsconfig paths → 源码）和 `npm test`（node_modules → 快照）
 * 读的不是同一份代码，两边可以各自全绿。
 * 2026-09-23 的真实代价：一个新导出的函数在快照里是 `undefined`，调用即抛，
 * 被点击处理器的 `void` 吞掉，测试只报"某个 spy 调用 0 次"——排了三轮才找到根。
 *
 * 修法已经落地（`shared-alias.ts` 一份，构建与测试共用），这条门禁保证它不会被
 * 谁在改配置时悄悄摘掉：摘掉的那一秒它就是红的，而不是等到某次"看不见的红"。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// 这个文件在 src/main/ 下，包根要往上两层（少一层就会去读 src/vitest.config.ts 然后 ENOENT）。
const here = resolve(import.meta.dirname, "..", "..");
const vitestConfig = readFileSync(resolve(here, "vitest.config.ts"), "utf8");
const aliasSource = readFileSync(resolve(here, "shared-alias.ts"), "utf8");
const electronConfig = readFileSync(resolve(here, "electron.vite.config.ts"), "utf8");

describe("桌面测试与构建解析同一份 @ailearn/shared", () => {
  it("两个配置用的是同一份别名定义（不是各自复制一遍）", () => {
    expect(vitestConfig).toContain("from './shared-alias.ts'");
    expect(electronConfig).toContain("from './shared-alias.ts'");
    // 定义只该有一份：谁再在配置里内联写第二个 alias，就又是两个来源。
    expect(electronConfig).not.toMatch(/const sharedAlias = \[/);
  });

  it("别名确实指向 packages/shared/src，且覆盖 barrel 与子路径两种导入", () => {
    expect(aliasSource).toContain("packages/shared/src");
    // 两条 find 都在：一条管 `@ailearn/shared`，一条管子路径深导入。
    // 只留一条的话，桌面另一端会用 node_modules 里那份快照，而它看起来一样能编译。
    expect(aliasSource).toContain("/^@ailearn\\/shared$/");
    expect(aliasSource).toContain("/^@ailearn\\/shared\\/(.*)$/");
  });

  it("vitest 的 alias 数组里两条都在（prosemirror 那条是另一件事，别顺手删）", () => {
    expect(vitestConfig).toMatch(/alias:\s*\[\s*prosemirrorResolve\(\),\s*\.\.\.sharedAlias\s*,?\s*\]/);
  });
});
