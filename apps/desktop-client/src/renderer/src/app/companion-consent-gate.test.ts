/**
 * 伴星 AI 同意门禁（2026-09-19）。
 *
 * 这里锁的是"什么时候拦、什么时候放行"：拦错了会把能用的工作区挡在门外，
 * 放行错了就回到静默失败。
 */

import { describe, expect, it } from "vitest";
import {
  COMPANION_CONSENT_REQUIRED_LINE,
  COMPANION_RUN_ERROR_AI_CONSENT_REQUIRED,
  companionConsentGate,
  isCompanionConsentFailure,
} from "./companion-consent-gate";

describe("companionConsentGate", () => {
  it("需要签署且尚未签署 → 引导（consent_required）", () => {
    expect(companionConsentGate({ requiresConsent: true, consentVersion: null })).toBe("consent_required");
  });

  it("已签署 → 放行", () => {
    expect(companionConsentGate({ requiresConsent: true, consentVersion: "v0.7-ai-use-2026-08-12" })).toBeNull();
  });

  it("部署不要求签署（本机模型）→ 放行", () => {
    expect(companionConsentGate({ requiresConsent: false, consentVersion: null })).toBeNull();
  });

  it("设置读不到（null）→ 不在渲染层替服务端做安全决策", () => {
    expect(companionConsentGate(null)).toBeNull();
  });
});

describe("isCompanionConsentFailure", () => {
  it("只认 worker 写的那个错误码", () => {
    expect(isCompanionConsentFailure(COMPANION_RUN_ERROR_AI_CONSENT_REQUIRED)).toBe(true);
    expect(isCompanionConsentFailure("INTERNAL_ERROR")).toBe(false);
    expect(isCompanionConsentFailure(undefined)).toBe(false);
    expect(isCompanionConsentFailure(42)).toBe(false);
  });
});

describe("固定台词", () => {
  it("说清三件事：缺同意、已打开设置页、按签署", () => {
    expect(COMPANION_CONSENT_REQUIRED_LINE).toContain("AI 使用同意");
    expect(COMPANION_CONSENT_REQUIRED_LINE).toContain("设置页已经打开");
    expect(COMPANION_CONSENT_REQUIRED_LINE).toContain("签署");
    // 语音会念这句：别塞错误码/英文技术词。
    expect(COMPANION_CONSENT_REQUIRED_LINE).not.toMatch(/[A-Z_]{4,}/);
  });
});
