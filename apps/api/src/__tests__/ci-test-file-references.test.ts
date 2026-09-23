/**
 * CI / npm 脚本点名的集成测试文件必须真的存在（doc 34 L31）。
 *
 * 病是这么来的：`apps/api/package.json` 的 `test:companion-integration:postgres`
 * 里写着 `assistant-deliveries-kind-constraint-postgres.integration.ts`，
 * 盘上那个文件却没有 `-postgres` 后缀；`.github/workflows/ci.yml` 又点着
 * `db-commit-port.integration.ts`，而那个测试早就不在了。两处都在
 * `fresh-migrations` 那条链上，`ci.yml` 的注释还写着"其中 kind-constraint 那条
 * 锁死『代码 kind 集合 == 库约束』"——**锁不锁得住取决于那个文件跑没跑**，
 * 而它跑不到：`node --test` 对不存在的文件直接失败，整个 job 红在"找不到文件"上，
 * 没人会去读那条真实断言。
 *
 * 这道检查故意写成单测而不是新增 CI 步骤：它跟着现有的 api 单元 job 一起跑，
 * 不需要动 workflow，也不会因为"新加的 job 没人看"而形同虚设。
 *
 * 一个真踩过的坑写在前面：**基准目录要跟着 `working-directory` 走**。
 * 第一版把 `workers/ai-worker/src/integration-tests/queue-postgres.integration.ts`
 * 报成了死引用——它在仓库根下当然不存在。凡是"引用不存在"的结论，
 * 先证明你是按谁的目录解析的。
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
// 本文件在 apps/api/src/__tests__ 下，到仓库根是四层。
// 数错层级的后果很阴：路径全都不存在，但断言只检查"引用都存在的文件都在"，
// 空清单会一路绿到底——所以下面还有一条"清单不得少于 20 条"的反向断言。
const repoRoot = resolve(here, "..", "..", "..", "..");

const INTEGRATION_REF = /src\/integration-tests\/([\w.-]+\.ts)/g;

function packageScripts(): Array<{ label: string; file: string }> {
  const found: Array<{ label: string; file: string }> = [];
  for (const pkg of ["apps/api", "workers/ai-worker", "apps/desktop-client"]) {
    const manifest = join(repoRoot, pkg, "package.json");
    if (!existsSync(manifest)) continue;
    const scripts = JSON.parse(readFileSync(manifest, "utf8")).scripts ?? {};
    for (const [name, body] of Object.entries(scripts)) {
      for (const match of String(body).matchAll(INTEGRATION_REF)) {
        found.push({ label: `${pkg} package.json → ${name}`, file: `${pkg}/src/integration-tests/${match[1]}` });
      }
    }
  }
  return found;
}

/**
 * ci.yml 里的引用按"当前 step 的 working-directory"解析：
 * 遇到新的 `- name:` 就退回仓库根（workflow 的默认目录）。
 */
function ciReferences(): Array<{ label: string; file: string }> {
  const workflow = join(repoRoot, ".github", "workflows", "ci.yml");
  if (!existsSync(workflow)) return [];
  const found: Array<{ label: string; file: string }> = [];
  let workingDirectory = "";
  for (const line of readFileSync(workflow, "utf8").split("\n")) {
    if (/^\s*-\s+name:/.test(line)) workingDirectory = "";
    const wd = line.match(/^\s*working-directory:\s*(\S+)/);
    if (wd) workingDirectory = wd[1].trim();
    for (const match of line.matchAll(INTEGRATION_REF)) {
      const relative = `${workingDirectory ? `${workingDirectory}/` : ""}src/integration-tests/${match[1]}`;
      found.push({ label: `ci.yml [wd=${workingDirectory || "."}] ${match[1]}`, file: relative });
    }
  }
  return found;
}

describe("CI 与脚本点名的集成测试文件都存在", () => {
  it("清单不为空（解析失败不能伪装成通过）", () => {
    const total = [...packageScripts(), ...ciReferences()];
    assert.ok(total.length >= 20, `只解析到 ${total.length} 条引用，八成是路径/正则坏了`);
  });

  for (const reference of [...packageScripts(), ...ciReferences()]) {
    it(reference.label, () => {
      assert.ok(
        existsSync(join(repoRoot, reference.file)),
        `引用了不存在的测试文件：${reference.file}——这条 job 会红在"找不到文件"上，`
        + "真实断言一条也没跑",
      );
    });
  }
});
