import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PetVoiceVisualizer } from "./PetVoiceVisualizer";

test("listening renders the Liquid-Orb voice island with Siri preset and CSS fallback", () => {
  const html = renderToStaticMarkup(createElement(PetVoiceVisualizer, { phase: "listening" }));

  assert.match(html, /data-voice-visual="listening"/);
  assert.match(html, /pet-voice-island-content is-listening/);
  assert.match(html, /正在听你说/);
  assert.match(html, /说完再点一下结束/);
  // WebGPU host：液态玻璃球容器 + Siri 青色 preset
  assert.match(html, /pet-voice-liquid-orb/);
  assert.match(html, /data-liquid-orb-preset="siri"/);
  assert.match(html, /data-liquid-orb="fallback"/);
  // SSR（无 WebGPU）渲染旧 CSS 三态兜底
  assert.match(html, /pet-voice-orb/);
  assert.match(html, /pet-voice-bars/);
});

test("transcribing morphs the orb into the amber spectrum processing visual", () => {
  const html = renderToStaticMarkup(createElement(PetVoiceVisualizer, { phase: "transcribing" }));

  assert.match(html, /data-voice-visual="transcribing"/);
  assert.match(html, /pet-voice-island-content is-processing/);
  assert.match(html, /正在识别/);
  assert.match(html, /把声音变成文字/);
  assert.match(html, /data-liquid-orb-preset="spectrum"/);
  // 兜底渲染琥珀处理环
  assert.match(html, /pet-voice-ring/);
  assert.match(html, /pet-voice-ring-arc/);
});

test("speaking switches to the green voice-membrane visual with live status", () => {
  const html = renderToStaticMarkup(createElement(PetVoiceVisualizer, { phase: "speaking" }));

  assert.match(html, /data-voice-visual="speaking"/);
  assert.match(html, /role="status"/);
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /伴星正在说/);
  assert.match(html, /点按可以打断/);
  assert.match(html, /pet-voice-island-content is-listening/);
  assert.match(html, /data-liquid-orb-preset="voice"/);
  // 兜底渲染绿色扩散声波
  assert.match(html, /pet-voice-waves/);
});

test("finalizing maps to the spectrum processing visual", () => {
  const html = renderToStaticMarkup(createElement(PetVoiceVisualizer, { phase: "finalizing" }));

  assert.match(html, /data-liquid-orb-preset="spectrum"/);
  assert.match(html, /正在收好声音/);
});

test("requesting_permission maps to a calmer Siri visual", () => {
  const html = renderToStaticMarkup(createElement(PetVoiceVisualizer, { phase: "requesting_permission" }));

  assert.match(html, /data-liquid-orb-preset="siri"/);
  assert.match(html, /准备麦克风/);
});
