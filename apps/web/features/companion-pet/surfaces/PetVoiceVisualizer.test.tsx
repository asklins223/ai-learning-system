import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PetVoiceVisualizer } from "./PetVoiceVisualizer";

test("listening renders the Siri-style orb with dancing voice bars", () => {
  const html = renderToStaticMarkup(createElement(PetVoiceVisualizer, { phase: "listening" }));

  assert.match(html, /data-voice-visual="listening"/);
  assert.match(html, /pet-voice-island-content is-listening/);
  assert.match(html, /正在听你说/);
  assert.match(html, /说完再点一下结束/);
  assert.match(html, /pet-voice-orb/);
  assert.match(html, /pet-voice-bars/);
  // bars use scaleY dance, ring/waves stay hidden for this phase
  assert.doesNotMatch(html, /pet-voice-liquid|pet-voice-ribbon|pet-voice-to-text/);
});

test("transcribing morphs the orb into the amber processing ring", () => {
  const html = renderToStaticMarkup(createElement(PetVoiceVisualizer, { phase: "transcribing" }));

  assert.match(html, /data-voice-visual="transcribing"/);
  assert.match(html, /pet-voice-island-content is-processing/);
  assert.match(html, /正在识别/);
  assert.match(html, /把声音变成文字/);
  assert.match(html, /pet-voice-ring/);
  assert.match(html, /pet-voice-ring-arc/);
  assert.doesNotMatch(html, /pet-voice-ingest|pet-voice-focus|pet-voice-text-lines/);
});

test("speaking switches to the green outward voice waves with live status", () => {
  const html = renderToStaticMarkup(createElement(PetVoiceVisualizer, { phase: "speaking" }));

  assert.match(html, /data-voice-visual="speaking"/);
  assert.match(html, /role="status"/);
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /伴星正在说/);
  assert.match(html, /点按可以打断/);
  assert.match(html, /pet-voice-island-content is-listening/);
  assert.match(html, /pet-voice-waves/);
});
