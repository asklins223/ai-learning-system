import { describe, expect, it } from "vitest";
import { MIN_PASSWORD_LENGTH, validateAuthForm } from "./auth-form-validation";

const base = { mode: "register" as const, email: "student@example.com", password: "long-enough", confirmPassword: "long-enough" };

describe("validateAuthForm", () => {
  it("accepts a well-formed registration", () => {
    expect(validateAuthForm(base)).toBeNull();
  });

  it("accepts a short password when signing in, because the API does", () => {
    expect(validateAuthForm({ ...base, mode: "login", password: "abcd", confirmPassword: "" })).toBeNull();
  });

  it("requires an email", () => {
    expect(validateAuthForm({ ...base, email: "   " })).toBe("请输入邮箱。");
  });

  it("rejects an address the API would reject", () => {
    expect(validateAuthForm({ ...base, email: "not-an-email" })).toBe("邮箱格式看起来不对，请检查后重试。");
  });

  it("names the real minimum instead of a generic failure", () => {
    expect(validateAuthForm({ ...base, password: "1234567", confirmPassword: "1234567" }))
      .toBe(`密码至少需要 ${MIN_PASSWORD_LENGTH} 位。`);
  });

  it("accepts exactly the minimum length", () => {
    expect(validateAuthForm({ ...base, password: "12345678", confirmPassword: "12345678" })).toBeNull();
  });

  it("catches a mistyped confirmation before the account is created", () => {
    expect(validateAuthForm({ ...base, confirmPassword: "long-enogh" })).toBe("两次输入的密码不一致，请重新确认。");
  });

  it("checks the password before the confirmation, so the fix order is obvious", () => {
    expect(validateAuthForm({ ...base, password: "short", confirmPassword: "different" }))
      .toBe(`密码至少需要 ${MIN_PASSWORD_LENGTH} 位。`);
  });
});
