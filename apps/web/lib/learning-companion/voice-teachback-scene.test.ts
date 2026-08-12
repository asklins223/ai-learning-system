/**
 * 任务 14 阶段 A：VoiceTeachBackScene 契约单测（14-...-multimodal-reconstruction §3.3 / §3.7）。
 *
 * 覆盖：
 * - friendlyReviewVoiceError：白名单错误码 → 友好文案；未知错误 → 通用文案，
 *   不透出服务端/浏览器错误原文（与 VoiceInputPanel 同约定）；
 * - 源码契约（仓库既有源码断言风格）：
 *   - 无倒计时、无速度评分（04-1 / §13.4）；
 *   - live region 播报状态、role=alert 走错误（A11y，§13.4）；
 *   - fail-open：麦克风被拒/浏览器不支持/ASR 失败 → 提示改用文字（§3.7，
 *     决策 1 落回 text，不允许卡死）；
 *   - 确认的逐字 transcript 经 onSubmit 提交（宿主接 submitValidationAnswer 链，
 *     §3.6「多样性只在前端作答层，真相写入路径不变」）；
 *   - 原始音频不进入评估输入（04-1/04-2）：组件只提交 transcript 文本；
 *   - 编辑过转写内容时明示「以文字内容提交评估」，不伪装为纯语音。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { friendlyReviewVoiceError } from "@/components/learning-companion/scenes/VoiceTeachBackScene";

const source = readFileSync(
  new URL("../../components/learning-companion/scenes/VoiceTeachBackScene.tsx", import.meta.url),
  "utf8",
);

function apiError(code: string): unknown {
  return Object.assign(new Error("internal detail"), { code, name: "ApiError" });
}

describe("friendlyReviewVoiceError：错误归一化", () => {
  it("白名单错误码 → 友好文案（不走 err.message）", () => {
    assert.equal(friendlyReviewVoiceError(apiError("AUDIO_TOO_LARGE")), "这段语音太长，请缩短后重试，或改用文字回答。");
    assert.equal(friendlyReviewVoiceError(apiError("UNSUPPORTED_MEDIA_TYPE")), "这段录音格式不受支持，请重录或改用文字回答。");
    assert.equal(friendlyReviewVoiceError(apiError("EMPTY_AUDIO")), "没有识别到声音，请重录或改用文字回答。");
  });

  it("未知错误码/未知 Error → 通用文案（不透出内部细节）", () => {
    assert.equal(friendlyReviewVoiceError(apiError("INTERNAL_SECRET_ERR")), "语音转写暂时不可用，请重试或改用文字回答。");
    assert.equal(friendlyReviewVoiceError(new Error("sensitive detail")), "语音转写暂时不可用，请重试或改用文字回答。");
    assert.equal(friendlyReviewVoiceError(null), "语音转写暂时不可用，请重试或改用文字回答。");
    assert.equal(friendlyReviewVoiceError(undefined), "语音转写暂时不可用，请重试或改用文字回答。");
  });

  it("白名单原文绝不进入输出（含 message 含码值的场景）", () => {
    const out = friendlyReviewVoiceError(
      Object.assign(new Error("AUDIO_TOO_LARGE 内部细节"), { code: "UNKNOWN" }),
    );
    assert.equal(out.includes("内部细节"), false);
  });
});

describe("VoiceTeachBackScene：§13.4 交互约束（源码契约）", () => {
  it("无倒计时、无速度评分（计时器/限时/速度评分只以否定形式出现）", () => {
    assert.match(source, /无倒计时 · 不限速度/);
    // 允许「无倒计时」徽标文案本身；禁止任何限时/速度评分机制
    assert.doesNotMatch(source, /限时\s*\d|speed|score|秒内|开始计时/);
    assert.doesNotMatch(source, /setInterval\(|倒计时到/);
  });

  it("live region 播报状态（role=status + aria-live），错误走 role=alert", () => {
    assert.match(source, /role="status" aria-live="polite"/);
    assert.match(source, /role="alert"/);
  });

  it("确认/重录/放弃/取消全部使用原生 button + textarea（键盘可完成）", () => {
    assert.match(source, /<button\s+type="button"/);
    assert.match(source, /<textarea\s+id="voice-teachback-transcript"/);
  });
});

describe("VoiceTeachBackScene：fail-open（§3.7，不允许卡死）", () => {
  it("麦克风被拒 → 提示改用文字 + 重新申请入口", () => {
    assert.match(source, /麦克风权限被拒绝/);
    assert.match(source, /改用文字回答/);
    assert.match(source, /重新申请麦克风权限/);
  });

  it("浏览器不支持录音 → 提示使用文字回答", () => {
    assert.match(source, /当前浏览器不支持录音，请使用文字回答/);
  });

  it("ASR 失败 → 通用错误 + 重录/改用文字（fail-open 不回退为假通过）", () => {
    assert.match(source, /语音转写暂时不可用，请重试或改用文字回答/);
    assert.match(source, /没有识别到文字内容，请重录或改用文字回答/);
  });

  it("voiceUnavailable（ASR policy 不满足）→ 不出现录音入口，只提示", () => {
    assert.match(source, /语音能力当前不可用，请使用文字回答/);
    assert.match(source, /data-testid="voice-teachback-unavailable"/);
    // 录音入口必须被 fail-open 条件包裹：不可用时不得渲染主区
    assert.match(source, /!forceTextHint \? \(/);
  });
});

describe("VoiceTeachBackScene：canonical 提交语义（§3.6 / 04-1 / 04-2）", () => {
  it("确认的逐字 transcript 经 onSubmit 交给宿主（组件内不直接调用服务端提交端点）", () => {
    assert.match(source, /onSubmit\(\s*text\s*\)/);
    assert.match(source, /await onSubmit\(text\)/);
    // 组件内部不得出现端点调用（注释中的链名不算调用）
    assert.doesNotMatch(source, /api\.submitValidationAnswer|fetch\(.*submit|learningSessionClient/);
  });

  it("原始音频不进入评估输入：组件内没有把 audio blob 传给提交路径", () => {
    assert.doesNotMatch(source, /onSubmit\(\s*blob/);
    assert.match(source, /const text = transcript\.trim\(\)/);
  });

  it("编辑过转写内容 → 明示以文字提交，不伪装为纯语音", () => {
    assert.match(source, /已修改转写内容：将以文字内容提交评估，不再视为纯语音/);
    assert.match(source, /transcriptEdited/);
  });

  it("空 transcript 禁止提交", () => {
    assert.match(source, /transcript\.trim\(\) === "" \|\| submitting/);
  });
});

describe("VoiceTeachBackScene：宿主接线（ValidationFocus voiceEntry）", () => {
  it("ValidationFocus 支持可选 voiceEntry（缺省 undefined = 纯 text 行为不变）", () => {
    const focusSource = readFileSync(
      new URL("../../components/ValidationFocus.tsx", import.meta.url),
      "utf8",
    );
    assert.match(focusSource, /voiceEntry\?: \{/);
    assert.match(focusSource, /onVoiceSubmit: \(transcript: string\) => void/);
    assert.match(focusSource, /voiceEntry \? \(/);
  });

  it("复习页把确认 transcript 提交到既有 submitValidationAnswer 链（handleSubmit overrideAnswer）", () => {
    const focusSource = readFileSync(
      new URL("../../components/ValidationFocus.tsx", import.meta.url),
      "utf8",
    );
    assert.match(focusSource, /handleSubmit = useCallback\(async \(overrideAnswer\?: string\)/);
    assert.match(focusSource, /const answer = \(overrideAnswer \?\? answerRef\.current\)\.trim\(\)/);
    assert.match(focusSource, /onVoiceSubmit=\{\(transcript\) => void handleSubmit\(transcript\)\}/);
  });

  it("复习页路由只在该 flag 开启时传 voiceEntry（fail-closed 门禁）", () => {
    const pageSource = readFileSync(
      new URL("../../app/(workspace)/(focus)/review/[scheduleId]/page.tsx", import.meta.url),
      "utf8",
    );
    assert.match(pageSource, /isReviewVoiceEntryEnabled\(\)/);
    assert.match(pageSource, /reviewVoiceEnabled/);
    assert.match(pageSource, /transcribePlain/);
  });
});
