import test from "node:test";
import assert from "node:assert/strict";
import { safeSseWrite } from "../lib/safe-sse-write.ts";

test("safeSseWrite writes when socket is open", () => {
  const chunks: string[] = [];
  const raw = {
    writableEnded: false,
    destroyed: false,
    write(chunk: string) {
      chunks.push(chunk);
      return true;
    },
  };
  assert.equal(safeSseWrite(raw, "data: ok\n\n"), true);
  assert.deepEqual(chunks, ["data: ok\n\n"]);
});

test("safeSseWrite refuses after writableEnded", () => {
  const raw = {
    writableEnded: true,
    destroyed: false,
    write() {
      throw new Error("should not be called");
    },
  };
  assert.equal(safeSseWrite(raw, "data: x\n\n"), false);
});

test("safeSseWrite refuses after destroyed", () => {
  const raw = {
    writableEnded: false,
    destroyed: true,
    write() {
      throw new Error("should not be called");
    },
  };
  assert.equal(safeSseWrite(raw, "data: x\n\n"), false);
});

test("safeSseWrite swallows write errors and returns false", () => {
  const raw = {
    writableEnded: false,
    destroyed: false,
    write() {
      throw new Error("ERR_STREAM_WRITE_AFTER_END");
    },
  };
  assert.equal(safeSseWrite(raw, "data: x\n\n"), false);
});
