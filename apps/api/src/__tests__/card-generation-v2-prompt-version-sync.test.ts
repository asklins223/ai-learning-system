/**
 * 2026-08-25（AI 设计审计修复）：prompt 版本双源一致性契约。
 *
 * worker 的 CARD_GENERATION_V2_PROMPT_VERSION 与 api generation-run-service
 * stageRuntimes 种子的 promptVersion 是两份手工同步的字面量；本数组参与
 * semanticSpecHash（审计闭包）。此前没有任何机制保证两侧一致——下一次 bump
 * 漏改任一侧时不会有测试红灯，审计记录会静默失真。本测试从源码文本断言
 * 末段版本号相等，作为 bump 流程的回归门禁（bump 时改任一侧必须同步另一侧，
 * 否则本测试失败）。
 *
 * 用源码文本断言而非 import：worker 的 prompts.ts 不在 api 的依赖闭包内
 * （跨包 import 会引入 worker→shared 之外的路径耦合），且常量是导出字面量，
 * 文本匹配足够稳定。
 */
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKSPACE_ROOT = join(__dirname, "../../../..");

const workerPromptsSource = readFileSync(
  join(WORKSPACE_ROOT, "workers/ai-worker/src/card-generation-v2/prompts.ts"),
  "utf8",
);
const apiRunServiceSource = readFileSync(
  join(WORKSPACE_ROOT, "apps/api/src/modules/card-generation-v2/generation-run-service.ts"),
  "utf8",
);

describe("card-generation-v2 prompt version sync", () => {
  it("worker CARD_GENERATION_V2_PROMPT_VERSION 末段与 api stageRuntimes promptVersion 一致", () => {
    const m = workerPromptsSource.match(
      /export const CARD_GENERATION_V2_PROMPT_VERSION = "(card-generation-v2\/([^"]+))"/,
    );
    assert.ok(m, "worker prompts.ts must export CARD_GENERATION_V2_PROMPT_VERSION literal");
    const [, fullVersion, tailVersion] = m;

    const seededVersions = [...apiRunServiceSource.matchAll(/promptVersion: "([^"]+)"/g)].map(
      (x) => x[1],
    );
    assert.ok(seededVersions.length >= 4, `api must seed all four stages, got ${seededVersions.length}`);
    for (const seeded of new Set(seededVersions)) {
      assert.equal(
        seeded,
        tailVersion,
        `api stageRuntimes promptVersion "${seeded}" out of sync with worker ${fullVersion} — bump both sides together`,
      );
    }
  });
});
