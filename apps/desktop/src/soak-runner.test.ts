import assert from "node:assert/strict";
import { test } from "node:test";
import { SoakRunner } from "./soak-runner.ts";

test("soak runner：采集值先脱敏，再写入 snapshot", async () => {
  const written: unknown[] = [];
  const runner = new SoakRunner({
    intervalMs: 1_000,
    collect: () => ({ window_count: 2, recent_error_count: "private message" }),
    write: (snapshot) => {
      written.push(snapshot);
    },
  });
  await runner.sampleNow();
  await runner.stop();
  assert.equal(written.length, 1);
  const snapshot = written[0] as { samples: Array<{ at: number; category: string; value: unknown }> };
  assert.deepEqual(snapshot.samples, [{
    at: snapshot.samples[0].at,
    category: "window_count",
    value: 2,
  }]);
});

test("soak runner：start 幂等，stop 清理定时器并等待采集完成", async () => {
  let writes = 0;
  const runner = new SoakRunner({
    intervalMs: 1_000,
    collect: () => ({ window_count: 1 }),
    write: async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      writes += 1;
    },
  });
  runner.start();
  runner.start();
  await runner.stop();
  assert.equal(writes, 1);
});

test("soak runner：连续采样只写增量，避免 JSONL 随时间平方增长", async () => {
  const written: Array<{ samples: Array<{ category: string }> }> = [];
  let count = 0;
  const runner = new SoakRunner({
    collect: () => ({ window_count: ++count }),
    write: (snapshot) => {
      written.push(snapshot);
    },
  });
  await runner.sampleNow();
  await runner.sampleNow();
  assert.deepEqual(written.map((snapshot) => snapshot.samples.map((sample) => sample.category)), [
    ["window_count"],
    ["window_count"],
  ]);
});
