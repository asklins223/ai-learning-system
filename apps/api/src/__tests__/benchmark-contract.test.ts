import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BENCHMARK_MIN_SAMPLE_COUNT,
  BENCHMARK_QUALITY_THRESHOLDS,
} from "@ailearn/shared";
import { BUILTIN_NOTES } from "../modules/benchmark/service.ts";

describe("v0.4 benchmark contract", () => {
  it("ships a versionable dataset with at least thirty unique samples", () => {
    assert.ok(BUILTIN_NOTES.length >= BENCHMARK_MIN_SAMPLE_COUNT);
    assert.equal(new Set(BUILTIN_NOTES.map((note) => note.file)).size, BUILTIN_NOTES.length);
    assert.equal(new Set(BUILTIN_NOTES.map((note) => note.title)).size, BUILTIN_NOTES.length);
    assert.ok(BUILTIN_NOTES.every((note) => note.blocks.length >= 2));
  });

  it("covers metadata noise, code, lists, bilingual text, and short/long inputs", () => {
    const allBlocks = BUILTIN_NOTES.flatMap((note) => note.blocks);
    const allText = allBlocks.map((block) => block.content).join("\n");
    assert.ok(allBlocks.some((block) => block.type === "code"));
    assert.ok(allBlocks.some((block) => block.type === "list"));
    assert.match(allText, /Release 2\.4\.1/);
    assert.match(allText, /The trigger was/);
    assert.ok(BUILTIN_NOTES.some((note) => note.blocks.length <= 2));
    assert.ok(BUILTIN_NOTES.some((note) => note.blocks.length >= 7));
  });

  it("uses the v0.4 release quality thresholds", () => {
    assert.deepEqual(BENCHMARK_QUALITY_THRESHOLDS, {
      hardCitationPrecision: 0.9,
      keyPointHardCoverage: 0.85,
      expectedBlockHardCoverage: 0.85,
    });
  });
});
