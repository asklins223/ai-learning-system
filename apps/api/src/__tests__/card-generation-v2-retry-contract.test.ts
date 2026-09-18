/**
 * 「run 级就地重试」的跨端契约（2026-09-18）。
 *
 * ## 为什么需要这条测试
 * 就地重试由两侧配合完成，两侧分属不同包、此前没有任何机制保证它们对齐：
 *
 * 1. **API 侧**（`retryGenerationRunV2`）在派发重规划任务前，把 run 从
 *    `needs_attention` 推进到工作态（`checking`），让用户点完立刻看到"又动起来了"；
 * 2. **worker 侧**（`processReplanSetJob`）在真正执行前要校验 run 状态是否合法。
 *
 * 两者一旦不对齐，任务会以**非重试错误**失败：用户眼里就是"点了重试，一秒后变成
 * 生成失败"。这个缺陷**只有真实消费任务时才会暴露**——本仓库的单测全部通过，
 * 第一次真跑（worker 真的取走任务）当场失败，错误是
 * `replan requires review_ready/needs_attention run (got checking)`。
 *
 * 因此这里用源码文本把这条耦合钉住（与 `card-generation-v2-prompt-version-sync`、
 * `card-generation-v2-routes-contract` 同一手法）：API 推进到的状态，必须是 worker
 * 重规划门闩接受的状态之一。改动任一侧而忘了另一侧 → 本测试失败。
 */
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKSPACE_ROOT = join(__dirname, "../../../..");

const apiRetryServiceSource = readFileSync(
  join(WORKSPACE_ROOT, "apps/api/src/modules/card-generation-v2/generation-run-service.ts"),
  "utf8",
);
const workerHandlerSource = readFileSync(
  join(WORKSPACE_ROOT, "workers/ai-worker/src/handlers/card-generation-v2-handler.ts"),
  "utf8",
);

describe("card-generation run 级就地重试：API ↔ worker 状态门闩契约", () => {
  it("API 在派发重规划前把 run 推进到的状态，worker 的 replan 门闩必须接受", () => {
    // API 侧：retryGenerationRunV2 里推进 run 状态的那次更新。
    const retryFnStart = apiRetryServiceSource.indexOf("export async function retryGenerationRunV2");
    assert.ok(retryFnStart >= 0, "retryGenerationRunV2 must exist in the run service");
    const retryFnBody = apiRetryServiceSource.slice(retryFnStart, retryFnStart + 6000);
    const advancedTo = /\.set\(\{\s*status:\s*"([a-z_]+)"/.exec(retryFnBody);
    assert.ok(advancedTo, "retryGenerationRunV2 must advance the run status before dispatching the replan job");
    const targetStatus = advancedTo[1];

    // worker 侧：replan 任务的状态门闩。
    const gateMatch = /replan requires ([^`]+) run/.exec(workerHandlerSource);
    assert.ok(gateMatch, "processReplanSetJob must declare its accepted run statuses");
    const gateText = gateMatch[1];
    const accepted = gateText.split("/").map((s) => s.trim());

    assert.ok(
      accepted.includes(targetStatus),
      `API 把 run 推进到 "${targetStatus}"，但 worker 的 replan 门闩只接受 [${accepted.join(", ")}]`
      + "——任务会以非重试错误失败，用户看到「点了重试却变成生成失败」",
    );
  });

  it("重试服务派发的是 worker 已实现的重规划任务类型", () => {
    assert.ok(
      /jobType:\s*"card_generation_replan_set"/.test(apiRetryServiceSource)
      || apiRetryServiceSource.includes("card_generation_replan_set"),
      "retryGenerationRunV2 must dispatch the existing replan job type",
    );
    assert.ok(
      workerHandlerSource.includes('case "card_generation_replan_set"'),
      "worker must have a handler for the replan job type",
    );
  });
});
