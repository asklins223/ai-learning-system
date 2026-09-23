/**
 * 语音外发同意门的守卫（doc 34 L13）。
 *
 * 为什么用"读源码点名"而不是只靠运行时用例：这三条端点的真实行为要连库、连外部
 * 合成服务才能验（共享 dev 库上有并发会话，跑一次就动别人的现场）。
 * 而 L13 的病恰恰是**结构性的**——判据写在 worker 那一侧，语音这条 HTTP 路径上
 * 根本没有这道门。结构性的洞先用结构性的断言兜住：
 * 谁把 `requireAiConsent` 从任一条外发语音端点上摘掉，这里就红。
 *
 * 同款先例见 `note-visibility-read-sites.test.ts`（按文件点名读判据出现次数）。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const ROUTES = "src/modules/learning-sessions/voice-routes.ts";
const source = readFileSync(ROUTES, "utf8");

/**
 * 会把学习正文或用户音频送出本机的端点。
 * `/voice/preference` 读写的是本机偏好、`playback-outcome` 只上报一个状态，
 * 三者都不外发内容，所以不在这张名单里。
 */
const OUTBOUND = ["/voice/tts", "/voice/tts/stream", "/voice/transcribe"];

describe("语音外发端点必须过同意门", () => {
  for (const path of OUTBOUND) {
    it(`${path} 挂在 requireAiConsent 之后`, () => {
      // 精确匹配注册那一行，避免"文件里某处出现过这个名字"就算过。
      const registered = source.match(
        new RegExp(`app\\.post\\("${path}",\\s*\\{\\s*preHandler:\\s*\\[([^\\]]*)\\]`),
      );
      assert.ok(registered, `找不到 ${path} 的注册行——改名或删掉都要先解释`);
      const hooks = registered[1];
      assert.match(hooks, /requireSession/, `${path} 丢了会话门`);
      assert.match(hooks, /requireAiConsent/, `${path} 可以在没签同意的情况下外发`);
    });
  }

  it("判据只有一份：语音这边不另写 consent 表达式", () => {
    // 语音模块自己算 `consentAt && consentVersion` 就会造出第二个来源，
    // 一处放宽一处收紧是迟早的事。判据住在 identity/ai-consent-gate.ts。
    const voiceModule = source;
    assert.doesNotMatch(voiceModule, /consentAt\s*&&/, "语音侧不得重写同意判据");
    assert.doesNotMatch(voiceModule, /consentVersion\s*&&/, "语音侧不得重写同意判据");
  });
});
