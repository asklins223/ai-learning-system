import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

type ModuleContract = {
  name: string;
  handlers: number;
  services: number;
  /** 处理器数 / 其中"不在路由体里开 workspace 事务"的条数（必须有行为用例顶替）。 */
  handlerWithoutInlineTransaction?: number;
};

const MODULE_CONTRACTS: ModuleContract[] = [
  // Desktop NOTE-READ/NOTE-SAVE V2 is the only note route surface.
  // 11 条里唯一"路由体里没有 withWorkspaceTransaction(" 的是 `/v2/notes/:id/doc-update`
  // （批次 4.3 的增量上送口）：正文的写入边界在协同那一侧（`collaboration.ts` 的
  // applyUploadedDocUpdate 按 (workspaceId, userId) 开事务，落盘走 onStoreDocument
  // 自己的事务），把它们都塞进一条事务反而会把 Hocuspocus 的活文档锁在事务里。
  // 跨空间不可见不再靠这条字符串计数保证，而由 `note-collaboration-postgres.integration.ts`
  // 的行为用例证明（别人的空间上送 → 404 且库里没动）。豁免数只准减不准加：
  // 新处理器要么自带事务，要么先补一条行为用例。
  // services 9 → 10：批次 4.5 加了 `setNoteShareScope`（「共享给空间」那个显式动作）。
  // 它同样以 `executor: ApiTransaction` 开头，所以下面那条"每个导出函数都必须显式收
  // 事务执行器"的断言仍然成立——这里只是把数量对上，不是放宽判据。
  // handlers 11 → 12：批次 4.5 的 `PATCH /v2/notes/:id/share-scope`（「共享给空间」）。
  // 它同样自己开 `withWorkspaceTransaction` 并带上 (workspaceId, userId)，所以另外两条断言一起过。
  { name: "note", handlers: 12, services: 10, handlerWithoutInlineTransaction: 1 },
  // 删掉无人调用的 POST /sources/statuses 后：7 路由 / 7 服务。
  { name: "source", handlers: 7, services: 7 },
  // v0.6 新增 /search/drift 与 /search/auto-fix 后：4 路由 / 4 服务
  { name: "search", handlers: 4, services: 4 },
];

function readModuleFile(moduleName: string, fileName: "routes.ts" | "service.ts"): string {
  return readFileSync(new URL(`../modules/${moduleName}/${fileName}`, import.meta.url), "utf8");
}

test("protected content handlers keep one explicit workspace transaction boundary", async (t) => {
  for (const contract of MODULE_CONTRACTS) {
    await t.test(contract.name, () => {
      const routes = readModuleFile(contract.name, "routes.ts");
      const handlerCount = routes.match(/\bapp\.(?:get|post|patch|delete)/g)?.length ?? 0;
      const exempt = contract.handlerWithoutInlineTransaction ?? 0;
      const transactionCount = routes.match(/\bwithWorkspaceTransaction\(/g)?.length ?? 0;
      const sessionContextCount = routes.match(
        /\{ workspaceId: req\.session\.workspaceId, userId: req\.session\.userId \}/g,
      )?.length ?? 0;

      assert.equal(handlerCount, contract.handlers);
      assert.equal(transactionCount, handlerCount - exempt);
      // 豁免的那条同样要带上 (workspaceId, userId) 作用域——只是它交给下层去开事务，
      // 所以这两个字段不再以那个单行字面量的形式出现。
      assert.equal(sessionContextCount, handlerCount - exempt);
    });
  }
});

test("content services require an ApiTransaction and cannot escape to global db", async (t) => {
  for (const contract of MODULE_CONTRACTS) {
    await t.test(contract.name, () => {
      const service = readModuleFile(contract.name, "service.ts");
      const exportedServiceCount = service.match(/export async function\s+\w+\s*\(/g)?.length ?? 0;
      const executorFirstCount = service.match(
        /export async function\s+\w+\s*\(\s*executor: ApiTransaction,/g,
      )?.length ?? 0;

      assert.equal(exportedServiceCount, contract.services);
      assert.equal(executorFirstCount, exportedServiceCount);
      assert.doesNotMatch(service, /\bdb\./);
      assert.doesNotMatch(service, /from ["']\.\.\/\.\.\/lib\/search-index\.ts["']/);
      assert.doesNotMatch(service, /\bwithWorkspaceTransaction\b/);
    });
  }
});
