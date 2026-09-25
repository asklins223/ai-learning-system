/**
 * 「正式作答期间伴星不念出来」这条门的判据（doc 34 L12 / L15）。
 *
 * 这条门以前只存在于桌面渲染层的一个页面状态里（念不念由界面决定），服务端照样切句、
 * 照样把正文交给外部合成服务——**门只装在半条路上**。现在服务端这一侧也判，
 * 而这组用例钉的是三件容易各自漂移的东西：
 * ① 阶段清单（哪些算"正在作答"）；② 决策的优先级；③ 判据在仓库里只有一份。
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, it } from "node:test";
import {
  decideCompanionVoiceDelivery,
  FORMAL_ANSWER_PHASES,
} from "./formal-answer-signal.ts";

const WORKER_ROOT = join(import.meta.dirname, "..", "..");
const REPO_ROOT = join(WORKER_ROOT, "..", "..");

describe("正式作答的阶段清单", () => {
  it("只认这六个阶段，顺序与取值都冻结", () => {
    assert.deepEqual([...FORMAL_ANSWER_PHASES], [
      "preparing", "active", "assessing", "checkpoint", "committing", "paused",
    ]);
  });

  it("`recoverable_error` 有意不算：那一刻人不在答题，挡她只会让她更找不到北", () => {
    assert.equal(FORMAL_ANSWER_PHASES.includes("recoverable_error" as typeof FORMAL_ANSWER_PHASES[number]), false);
  });
});

describe("伴星这一段该不该变成语音", () => {
  it("旗标关闭 = 这条能力不存在，与\"这一刻不该打扰\"不混成一个 reason", () => {
    assert.equal(decideCompanionVoiceDelivery({
      voiceDialogueEnabled: false,
      formalAnswerInProgress: false,
    }), "feature_disabled");
    assert.equal(decideCompanionVoiceDelivery({
      voiceDialogueEnabled: false,
      formalAnswerInProgress: true,
    }), "feature_disabled", "两个都命中时报的是能力不存在——顺序反过来就没人知道旗标到底开没开");
  });

  it("能力开着、人在正式作答 → 不念，但文字不受影响", () => {
    assert.equal(decideCompanionVoiceDelivery({
      voiceDialogueEnabled: true,
      formalAnswerInProgress: true,
    }), "formal_answer_in_progress");
  });

  it("两问都不成立才放行", () => {
    assert.equal(decideCompanionVoiceDelivery({
      voiceDialogueEnabled: true,
      formalAnswerInProgress: false,
    }), "delivered");
  });
});

describe("判据只有一份", () => {
  function sources(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry === "dist") continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) sources(full, out);
      // 测试专用件不进扫描集：`integration-tests/` 整个目录都是（那里有造数夹具，
      // 夹具当然要写 purpose='formal'，把算它一份"判据分叉"是误伤）。
      else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts") && !entry.endsWith(".integration.ts")
        && !full.split(/[\\/]/).includes("integration-tests")) {
        out.push(full);
      }
    }
    return out;
  }
  const scanned = [...sources(join(REPO_ROOT, "workers", "ai-worker", "src")), ...sources(join(REPO_ROOT, "apps", "api", "src"))];
  const withPurpose = scanned
    .map((file) => ({ file: relative(REPO_ROOT, file), source: readFileSync(file, "utf8") }))
    .filter((entry) => /purpose\s*=\s*'formal'/.test(entry.source));

  it("扫描真的读到了东西（空集与走错目录都不算通过）", () => {
    // 元断言按"该被扫到的文件在不在集合里"判，不按文件数猜一个阈值：
    // 第一次我就是写了个 `> 300`，实际 228 个源文件——阈值本身没意义。
    const names = scanned.map((file) => file.split("/").pop());
    assert.ok(names.includes("formal-answer-signal.ts"), "没扫到判据自己，路径不对");
    assert.ok(names.includes("companion-thought.ts"), "没扫到念头管线，路径不对");
    assert.ok(names.includes("memory-service.ts"), "没扫到 api 侧，路径不对");
    assert.equal(
      withPurpose.length,
      1,
      `purpose='formal' 出现在 ${withPurpose.map((e) => e.file).join(", ")} ——判据开始分叉了`,
    );
  });

  it("语音投递那条路上确实问了这条判据（不是只写了没人调）", () => {
    const dialogue = readFileSync(join(WORKER_ROOT, "src", "handlers", "companion-dialogue.ts"), "utf8");
    // 判据函数改名成"取身份"（`findFormalAnswerTarget`）：静音与暴露记账共用同一次
    // 读取，boolean 只是它的非空判断。这条断言盯的还是"语音那条路问了这道判据"。
    assert.match(dialogue, /findFormalAnswerTarget\(tx,/);
    assert.match(dialogue, /if \(voiceDeliveryDecision !== "delivered"\) return;/);
  });
});
