import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const MODULE_CONTRACTS = [
  { name: "note", handlers: 9, services: 9 },
  { name: "source", handlers: 8, services: 8 },
  // v0.6 新增 /search/drift 与 /search/auto-fix 后：4 路由 / 4 服务
  { name: "search", handlers: 4, services: 4 },
] as const;

function readModuleFile(moduleName: string, fileName: "routes.ts" | "service.ts"): string {
  return readFileSync(new URL(`../modules/${moduleName}/${fileName}`, import.meta.url), "utf8");
}

test("protected content handlers keep one explicit workspace transaction boundary", async (t) => {
  for (const contract of MODULE_CONTRACTS) {
    await t.test(contract.name, () => {
      const routes = readModuleFile(contract.name, "routes.ts");
      const handlerCount = routes.match(/\bapp\.(?:get|post|patch|delete)/g)?.length ?? 0;
      const transactionCount = routes.match(/\bwithWorkspaceTransaction\(/g)?.length ?? 0;
      const sessionContextCount = routes.match(
        /\{ workspaceId: req\.session\.workspaceId, userId: req\.session\.userId \}/g,
      )?.length ?? 0;

      assert.equal(handlerCount, contract.handlers);
      assert.equal(transactionCount, handlerCount);
      assert.equal(sessionContextCount, handlerCount);
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
