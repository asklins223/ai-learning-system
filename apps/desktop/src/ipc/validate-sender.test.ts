import test from "node:test";
import assert from "node:assert/strict";
import { isTrustedSender } from "./validate-sender";

function event(id: number, url: string) {
  return {
    sender: { id, getURL: () => url },
    senderFrame: { url },
  } as never;
}

test("sender and dynamic origin are both required", () => {
  const origin = "http://127.0.0.1:3007";
  assert.equal(isTrustedSender(event(10, `${origin}/companion/pet?surface=electron`), 10, origin, "pet"), true);
  assert.equal(isTrustedSender(event(11, `${origin}/companion/pet`), 10, origin, "pet"), false);
  assert.equal(isTrustedSender(event(10, "http://localhost:3007/companion/pet"), 10, origin, "pet"), false);
  assert.equal(isTrustedSender(event(10, `${origin}/settings`), 10, origin, "pet"), false);
  assert.equal(isTrustedSender(event(10, `${origin}/settings`), 10, origin, "main"), true);
});
