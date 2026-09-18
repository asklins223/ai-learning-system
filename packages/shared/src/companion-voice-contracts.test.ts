import assert from "node:assert/strict";
import test from "node:test";
import {
  COMPANION_VOICE_MAX_AUDIO_BYTES,
  companionVoiceSpeakRequestV1Schema,
  companionVoiceSpeakResultV1Schema,
} from "./companion-voice-contracts.ts";

const request = {
  version: 1 as const,
  text: "今天还有一张复习卡。",
};

const result = {
  version: 1 as const,
  mimeType: "audio/mpeg" as const,
  // "SUQz" 是 "ID3" 的 base64：示例保持 base64 与 byteLength 自洽。
  audioBase64: "SUQz",
  byteLength: 3,
  voice: "zh-CN-XiaoxiaoNeural",
};

test("CompanionVoiceSpeakRequestV1 accepts only bounded plain text", () => {
  assert.deepEqual(companionVoiceSpeakRequestV1Schema.parse(request), request);
  assert.deepEqual(companionVoiceSpeakRequestV1Schema.parse({ version: 1, text: "  慢慢来。  " }), {
    version: 1,
    text: "慢慢来。",
  });
  assert.throws(() => companionVoiceSpeakRequestV1Schema.parse({ version: 1, text: "" }));
  assert.throws(() => companionVoiceSpeakRequestV1Schema.parse({ version: 1, text: "   " }));
  assert.throws(() => companionVoiceSpeakRequestV1Schema.parse({ version: 1, text: "字".repeat(121) }));
  assert.throws(() => companionVoiceSpeakRequestV1Schema.parse({ ...request, debugText: "must not leak" }));
  assert.throws(() => companionVoiceSpeakRequestV1Schema.parse({ ...request, version: 2 }));
  assert.throws(() => companionVoiceSpeakRequestV1Schema.parse({ text: request.text }));
});

test("CompanionVoiceSpeakResultV1 accepts only bounded audio/mpeg bytes", () => {
  assert.deepEqual(companionVoiceSpeakResultV1Schema.parse(result), result);
  assert.throws(() => companionVoiceSpeakResultV1Schema.parse({ ...result, mimeType: "audio/wav" }));
  assert.throws(() => companionVoiceSpeakResultV1Schema.parse({ ...result, mimeType: "application/json" }));
  assert.throws(() => companionVoiceSpeakResultV1Schema.parse({ ...result, audioBase64: "" }));
  assert.throws(() => companionVoiceSpeakResultV1Schema.parse({ ...result, byteLength: 0 }));
  assert.throws(() => companionVoiceSpeakResultV1Schema.parse({ ...result, byteLength: 1.5 }));
  assert.throws(() =>
    companionVoiceSpeakResultV1Schema.parse({
      ...result,
      byteLength: COMPANION_VOICE_MAX_AUDIO_BYTES + 1,
    }));
  assert.throws(() => companionVoiceSpeakResultV1Schema.parse({ ...result, voice: "" }));
  assert.throws(() => companionVoiceSpeakResultV1Schema.parse({ ...result, voice: "v".repeat(65) }));
  assert.throws(() => companionVoiceSpeakResultV1Schema.parse({ ...result, audioPath: "/tmp/tts.mp3" }));
});
