import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { safeSseWrite, safeWriteWithBackpressure } from "../lib/safe-sse-write.ts";

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

test("safeSseWrite propagates writable backpressure", () => {
  const raw = {
    writableEnded: false,
    destroyed: false,
    write() {
      return false;
    },
  };
  assert.equal(safeSseWrite(raw, "data: buffered\n\n"), false);
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

test("safeWriteWithBackpressure waits for drain", async () => {
  const emitter = new EventEmitter();
  const raw = Object.assign(emitter, {
    writableEnded: false,
    destroyed: false,
    write() {
      return false;
    },
  });
  const pending = safeWriteWithBackpressure(raw, "line\n");
  emitter.emit("drain");
  assert.equal(await pending, true);
});

test("safeWriteWithBackpressure returns false when the socket closes", async () => {
  const emitter = new EventEmitter();
  const raw = Object.assign(emitter, {
    writableEnded: false,
    destroyed: false,
    write() {
      return false;
    },
  });
  const pending = safeWriteWithBackpressure(raw, "line\n");
  emitter.emit("close");
  assert.equal(await pending, false);
});
