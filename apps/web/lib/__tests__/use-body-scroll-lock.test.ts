import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  acquireBodyScrollLock,
  type BodyScrollLockTarget,
} from "../use-body-scroll-lock.ts";

describe("body scroll lock", () => {
  it("keeps scrolling locked until the final overlapping modal releases", () => {
    const target: BodyScrollLockTarget = { style: { overflow: "auto" } };

    const releaseFirst = acquireBodyScrollLock(target);
    const releaseSecond = acquireBodyScrollLock(target);
    assert.equal(target.style.overflow, "hidden");

    releaseFirst();
    assert.equal(target.style.overflow, "hidden");

    releaseSecond();
    assert.equal(target.style.overflow, "auto");
  });

  it("makes each release idempotent", () => {
    const target: BodyScrollLockTarget = { style: { overflow: "clip" } };
    const release = acquireBodyScrollLock(target);

    release();
    release();

    assert.equal(target.style.overflow, "clip");
  });
});
