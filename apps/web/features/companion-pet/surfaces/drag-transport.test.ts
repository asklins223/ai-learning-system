import assert from "node:assert/strict";
import test from "node:test";
import { DragTransportV1, type DragFrameSchedulerV1 } from "./drag-transport";

function fakeScheduler() {
  let nextId = 1;
  const callbacks = new Map<number, () => void>();
  const scheduler: DragFrameSchedulerV1 = {
    request(callback) {
      const id = nextId++;
      callbacks.set(id, callback);
      return id;
    },
    cancel(id) {
      callbacks.delete(id);
    },
  };
  return {
    scheduler,
    runFrame() {
      const entries = [...callbacks.entries()];
      callbacks.clear();
      entries.forEach(([, callback]) => callback());
    },
    count: () => callbacks.size,
  };
}

test("drag transport coalesces all movement within one frame", async () => {
  const frame = fakeScheduler();
  const sent: Array<[number, number]> = [];
  const transport = new DragTransportV1({
    scheduler: frame.scheduler,
    send: async (x, y) => { sent.push([x, y]); },
    onSettled: () => {},
  });

  transport.push(3, 4);
  transport.push(5, -1);
  assert.equal(frame.count(), 1);
  frame.runFrame();
  await Promise.resolve();
  assert.deepEqual(sent, [[8, 3]]);
});

test("drag transport keeps one request in flight and merges later movement", async () => {
  const frame = fakeScheduler();
  const sent: Array<[number, number]> = [];
  let releaseFirst!: () => void;
  const first = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const transport = new DragTransportV1({
    scheduler: frame.scheduler,
    send: async (x, y) => {
      sent.push([x, y]);
      if (sent.length === 1) await first;
    },
    onSettled: () => {},
  });

  transport.push(10, 0);
  frame.runFrame();
  transport.push(2, 3);
  transport.push(4, 5);
  assert.equal(frame.count(), 0);
  releaseFirst();
  await first;
  await Promise.resolve();
  assert.equal(frame.count(), 1);
  frame.runFrame();
  await Promise.resolve();
  assert.deepEqual(sent, [[10, 0], [6, 8]]);
});

test("ending flushes pending movement before settling exactly once", async () => {
  const frame = fakeScheduler();
  const sent: Array<[number, number]> = [];
  let settled = 0;
  const transport = new DragTransportV1({
    scheduler: frame.scheduler,
    send: async (x, y) => { sent.push([x, y]); },
    onSettled: () => { settled += 1; },
  });

  transport.push(-13, 7);
  transport.end();
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(sent, [[-13, 7]]);
  assert.equal(settled, 1);
  transport.end();
  assert.equal(settled, 1);
});
