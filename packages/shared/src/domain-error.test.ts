import { test } from "node:test";
import assert from "node:assert/strict";
import { DomainError } from "./domain-error.ts";

test("DomainError sets name, code, message, statusCode", () => {
  class MyError extends DomainError {
    constructor(code: string, message: string, statusCode = 400) {
      super({ name: "MyError", code, message, statusCode });
    }
  }
  const err = new MyError("not_found", "资源不存在", 404);
  assert.equal(err.name, "MyError");
  assert.equal(err.code, "not_found");
  assert.equal(err.message, "资源不存在");
  assert.equal(err.statusCode, 404);
  assert.ok(err instanceof Error);
  assert.ok(err instanceof DomainError);
});

test("DomainError defaults statusCode to 500", () => {
  class SimpleError extends DomainError {
    constructor(code: string, message: string) {
      super({ name: "SimpleError", code, message });
    }
  }
  const err = new SimpleError("internal", "内部错误");
  assert.equal(err.statusCode, 500);
});
