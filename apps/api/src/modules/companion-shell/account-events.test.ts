import assert from "node:assert/strict";
import test from "node:test";
import {
  formatCompanionAccountGlobalOffSse,
  resolveAccountCursor,
} from "./account-events.ts";
import {
  emitCompanionAccountNotifyForTests,
  subscribeCompanionAccountEvents,
} from "../companion-conversation/companion-notify.ts";

const USER_ID = "11111111-1111-4111-8111-111111111111";

test("account SSE cursor accepts the larger valid after/Last-Event-ID", () => {
  assert.deepEqual(resolveAccountCursor({
    userId: USER_ID,
    afterRaw: "2",
    lastEventId: `${USER_ID}:7`,
  }), { ok: true, after: 7 });
});

test("account SSE cursor rejects a foreign user or malformed epoch", () => {
  assert.deepEqual(resolveAccountCursor({
    userId: USER_ID,
    afterRaw: "0",
    lastEventId: "22222222-2222-4222-8222-222222222222:1",
  }), { ok: false, code: "INVALID_CURSOR" });
  assert.deepEqual(resolveAccountCursor({
    userId: USER_ID,
    afterRaw: "-1",
    lastEventId: null,
  }), { ok: false, code: "INVALID_CURSOR" });
});

test("account global-off SSE is content-free and carries the epoch fence", () => {
  const wire = formatCompanionAccountGlobalOffSse({ userId: USER_ID, epoch: 4 });
  assert.match(wire, new RegExp(`^id: ${USER_ID}:4\\nevent: companion\\.account\\n`));
  const dataLine = wire.split("\n").find((line) => line.startsWith("data: ")) ?? "";
  assert.deepEqual(JSON.parse(dataLine.slice("data: ".length)), {
    version: 1,
    type: "account.global_off",
    userId: USER_ID,
    epoch: 4,
  });
});

test("account NOTIFY fan-out is user-scoped and unsubscribable", () => {
  const received: number[] = [];
  const unsubscribe = subscribeCompanionAccountEvents(USER_ID, (payload) => {
    received.push(payload.epoch);
  });
  emitCompanionAccountNotifyForTests({ userId: "22222222-2222-4222-8222-222222222222", epoch: 9 });
  emitCompanionAccountNotifyForTests({ userId: USER_ID, epoch: 4 });
  unsubscribe();
  emitCompanionAccountNotifyForTests({ userId: USER_ID, epoch: 5 });
  assert.deepEqual(received, [4]);
});
