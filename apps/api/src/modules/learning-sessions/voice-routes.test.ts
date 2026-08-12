import assert from "node:assert/strict";
import test from "node:test";
import { audioMagicMatchesDeclaration, parseCompanionMultipartFields } from "./voice-routes.ts";

const field = (value: string) => ({ type: "field", value });

test("Companion multipart fields require the fixed P3 profile", () => {
  assert.deepEqual(
    parseCompanionMultipartFields({
      purpose: field("companion_dialogue"),
      language: field("zh-CN"),
      durationMs: field("1200"),
    }),
    { ok: true, language: "zh-CN", durationMs: 1200 },
  );
  assert.deepEqual(
    parseCompanionMultipartFields({
      purpose: field("companion_dialogue"),
      language: field("zh-CN"),
      durationMs: field("1200"),
      file: { type: "file", filename: "voice.webm" },
    }),
    { ok: true, language: "zh-CN", durationMs: 1200 },
  );
});

test("Companion multipart fields fail closed on unknown, duplicate, or invalid fields", () => {
  assert.equal(
    parseCompanionMultipartFields({
      purpose: field("companion_dialogue"),
      language: field("zh-CN"),
      durationMs: field("1200"),
      extra: field("unexpected"),
    }).ok,
    false,
  );
  assert.equal(
    parseCompanionMultipartFields({
      purpose: [field("companion_dialogue"), field("companion_dialogue")],
      language: field("zh-CN"),
      durationMs: field("1200"),
    }).ok,
    false,
  );
  assert.equal(
    parseCompanionMultipartFields({
      purpose: field("companion_dialogue"),
      language: field("en-US"),
      durationMs: field("1200"),
    }).ok,
    false,
  );
  assert.equal(
    parseCompanionMultipartFields({
      purpose: field("companion_dialogue"),
      language: field("zh-CN"),
      durationMs: field("100"),
    }).ok,
    false,
  );
});

test("audio upload validates declared type against magic bytes", () => {
  const wav = Buffer.alloc(12);
  wav.write("RIFF", 0, "ascii");
  wav.write("WAVE", 8, "ascii");
  assert.equal(audioMagicMatchesDeclaration(wav, "voice.wav", "audio/wav"), true);
  assert.equal(audioMagicMatchesDeclaration(wav, "voice.mp3", "audio/mpeg"), false);
  assert.equal(audioMagicMatchesDeclaration(wav, "voice.wav", "application/octet-stream"), true);
  assert.equal(audioMagicMatchesDeclaration(Buffer.from("not audio"), "voice.wav", "audio/wav"), false);
});
