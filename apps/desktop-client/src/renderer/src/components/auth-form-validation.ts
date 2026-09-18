/**
 * Client-side checks for the access gate's sign-in and sign-up forms.
 *
 * These mirror `apps/api/src/modules/identity/routes.ts` (`registerV2Schema`
 * requires an 8–200 character password, `loginSchema` accepts anything from 4)
 * so a typo is answered with a precise local sentence instead of a round trip
 * that comes back as a generic server validation failure. The server stays the
 * authority; this only removes avoidable round trips.
 */

export const MIN_PASSWORD_LENGTH = 8;

/**
 * Deliberately loose: the API validates with zod's `.email()`, and rejecting a
 * syntactically unusual but server-accepted address here would be worse than
 * forwarding it.
 */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateAuthForm(input: {
  readonly mode: "login" | "register";
  readonly email: string;
  readonly password: string;
  readonly confirmPassword: string;
}): string | null {
  if (!input.email.trim()) return "请输入邮箱。";
  if (!EMAIL_PATTERN.test(input.email.trim())) return "邮箱格式看起来不对，请检查后重试。";
  if (!input.password) return "请输入密码。";
  if (input.mode === "register") {
    if (input.password.length < MIN_PASSWORD_LENGTH) return `密码至少需要 ${MIN_PASSWORD_LENGTH} 位。`;
    if (input.password !== input.confirmPassword) return "两次输入的密码不一致，请重新确认。";
  }
  return null;
}
