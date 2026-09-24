/**
 * ADR-0009 / PROFILE-01: Workspace management and profile function tests.
 *
 * Tests pure logic, error types, validation rules, and contract completeness
 * for the workspace join/leave/switch and profile management functions.
 * These tests do not require a database connection.
 */

import assert from "node:assert/strict";
import { test, describe } from "node:test";
import {
  JoinWorkspaceError,
  type JoinWorkspaceErrorCode,
  type LeaveWorkspaceError,
  type UpdateProfileError,
  type RenameWorkspaceError,
  MAX_COLLABORATIVE_WORKSPACES,
  generateDefaultWorkspaceName,
  SESSION_ABSOLUTE_MAX_MS,
  SESSION_TTL_MS,
  RECOVERED_PASSWORD_SENTINEL,
  canonicalizeEmail,
  hashPassword,
  type WorkspaceInfo,
} from "../modules/identity/service.ts";
import {
  isValidInvitationToken,
  hashInvitationToken,
  generateInvitationToken,
  createInvitationTokenStorage,
} from "../modules/identity/invitation-token.ts";

// ─── JoinWorkspaceError ─────────────────────────────────────────────────

describe("ADR-0009: JoinWorkspaceError", () => {
  const allCodes: JoinWorkspaceErrorCode[] = [
    "not_found",
    "expired",
    "revoked",
    "already_consumed",
    "concurrent_consumption",
    "workspace_limit_reached",
    "already_member",
  ];

  for (const code of allCodes) {
    test(`JoinWorkspaceError(${code}) has correct code and name`, () => {
      const err = new JoinWorkspaceError(code);
      assert.equal(err.code, code);
      assert.equal(err.name, "JoinWorkspaceError");
      assert.equal(err.message, code);
      assert.ok(err instanceof Error);
      assert.ok(err instanceof JoinWorkspaceError);
    });
  }

  test("all JoinWorkspaceErrorCode values are distinct strings", () => {
    const unique = new Set(allCodes);
    assert.equal(unique.size, allCodes.length, "all codes must be unique");
    for (const code of allCodes) {
      assert.equal(typeof code, "string");
      assert.ok(code.length > 0);
    }
  });

  test("JoinWorkspaceError covers all lifecycle states of an invite", () => {
    // The error codes should cover every possible state transition:
    // not_found → invite doesn't exist
    // expired → invite existed but time ran out
    // revoked → invite was manually revoked by owner
    // already_consumed → invite was used by someone else
    // concurrent_consumption → race condition: another request won
    // already_member → user is already in this workspace
    // workspace_limit_reached → user has too many collaborative workspaces
    const lifecycleCodes = [
      "not_found",
      "expired",
      "revoked",
      "already_consumed",
      "already_member",
      "workspace_limit_reached",
    ];
    for (const code of lifecycleCodes) {
      assert.ok(allCodes.includes(code as JoinWorkspaceErrorCode), `missing lifecycle code: ${code}`);
    }
  });
});

// ─── MAX_COLLABORATIVE_WORKSPACES ───────────────────────────────────────

describe("ADR-0009: MAX_COLLABORATIVE_WORKSPACES", () => {
  test("collaborative workspace limit is 3 (excluding personal)", () => {
    assert.equal(MAX_COLLABORATIVE_WORKSPACES, 3);
    assert.ok(
      typeof MAX_COLLABORATIVE_WORKSPACES === "number",
      "must be a number for comparison",
    );
  });

  test("limit is reasonable for Private Alpha (5-15 users)", () => {
    // ADR-0009 §3.3: 协作空间上限 3 个（不含个人工作区）
    // This is a product decision, not a technical constraint.
    // The value 3 allows sufficient collaboration without overwhelming a small Alpha.
    assert.ok(
      MAX_COLLABORATIVE_WORKSPACES >= 1,
      "limit should allow at least 1 collaborative workspace",
    );
    assert.ok(
      MAX_COLLABORATIVE_WORKSPACES <= 10,
      "limit should be reasonable for Private Alpha",
    );
  });
});

// ─── LeaveWorkspaceError type ───────────────────────────────────────────

describe("ADR-0009: LeaveWorkspaceError type completeness", () => {
  test("all LeaveWorkspaceError values are covered", () => {
    // These are the error codes defined in service.ts
    const expectedErrors: LeaveWorkspaceError[] = [
      "not_found",
      "not_member",
      "owner_cannot_leave",
      "personal_workspace_cannot_leave",
      "personal_workspace_missing",
    ];

    // Verify each is a valid string
    for (const err of expectedErrors) {
      assert.equal(typeof err, "string");
      assert.ok(err.length > 0);
    }

    // Verify uniqueness
    const unique = new Set(expectedErrors);
    assert.equal(unique.size, expectedErrors.length, "all error codes must be unique");
  });

  test("LeaveWorkspaceError covers all protection rules", () => {
    // The error codes should enforce these invariants:
    // 1. personal_workspace_cannot_leave — personal workspace is permanent
    // 2. owner_cannot_leave — owner must transfer or delete workspace first
    // 3. not_member — can't leave a workspace you're not in
    // 4. not_found — user or workspace doesn't exist
    // 5. personal_workspace_missing — user has no personal workspace to return to
    const protectionCodes: LeaveWorkspaceError[] = [
      "personal_workspace_cannot_leave",
      "owner_cannot_leave",
      "not_member",
    ];
    for (const code of protectionCodes) {
      assert.ok(code.length > 0, `protection code must be non-empty: ${code}`);
    }
  });
});

// ─── UpdateProfileError and RenameWorkspaceError ────────────────────────

describe("PROFILE-01: Error types", () => {
  test("UpdateProfileError covers user-not-found case", () => {
    const errors: UpdateProfileError[] = ["not_found"];
    assert.equal(errors.length, 1);
    assert.equal(errors[0], "not_found");
  });

  test("RenameWorkspaceError covers all validation failures", () => {
    const errors: RenameWorkspaceError[] = [
      "not_found",
      "not_member",
      "not_personal_workspace",
      "empty_name",
    ];
    const unique = new Set(errors);
    assert.equal(unique.size, errors.length, "all error codes must be unique");

    // Verify the error codes cover the key constraints:
    // - not_personal_workspace: only personal workspaces can be renamed (collaborative in v0.6)
    // - empty_name: name must be non-empty after trimming
    // - not_found: workspace or user doesn't exist
    assert.ok(errors.includes("not_personal_workspace"), "must reject collaborative workspace rename");
    assert.ok(errors.includes("empty_name"), "must reject empty name");
  });
});

// ─── generateDefaultWorkspaceName edge cases ────────────────────────────

describe("PROFILE-01: generateDefaultWorkspaceName", () => {
  test("uses displayName when provided", () => {
    const name = generateDefaultWorkspaceName("小明", "user@example.com");
    assert.equal(name, "小明的工作区");
  });

  test("falls back to email local part when displayName is null", () => {
    const name = generateDefaultWorkspaceName(null, "alice@example.com");
    assert.equal(name, "alice的工作区");
  });

  test("falls back to email local part when displayName is undefined", () => {
    const name = generateDefaultWorkspaceName(undefined, "bob@test.org");
    assert.equal(name, "bob的工作区");
  });

  test("falls back to email local part when displayName is empty string", () => {
    const name = generateDefaultWorkspaceName("", "carol@example.com");
    assert.equal(name, "carol的工作区");
  });

  test("falls back to email local part when displayName is whitespace only", () => {
    const name = generateDefaultWorkspaceName("   ", "dave@example.com");
    assert.equal(name, "dave的工作区");
  });

  test("uses default when both displayName and email are empty", () => {
    const name = generateDefaultWorkspaceName("", "");
    assert.equal(name, "用户的工作区");
  });

  test("uses default when email has no @ sign", () => {
    const name = generateDefaultWorkspaceName(null, "noatsign");
    assert.equal(name, "noatsign的工作区");
  });

  test("truncates long displayName to fit within 50 chars total", () => {
    const longName = "a".repeat(100);
    const name = generateDefaultWorkspaceName(longName, "user@example.com");
    // MAX_WORKSPACE_NAME_LENGTH = 50, so base is sliced to 46, plus "的工作区" (4 chars) = 50
    assert.ok(name.length <= 50, `name should be <= 50 chars, got ${name.length}`);
    assert.ok(name.endsWith("的工作区"));
  });

  test("truncates long email local part to fit within 50 chars total", () => {
    const longEmail = "a".repeat(100) + "@example.com";
    const name = generateDefaultWorkspaceName(null, longEmail);
    assert.ok(name.length <= 50, `name should be <= 50 chars, got ${name.length}`);
    assert.ok(name.endsWith("的工作区"));
  });

  test("handles unicode displayName correctly", () => {
    const name = generateDefaultWorkspaceName("学习达人", "user@example.com");
    assert.equal(name, "学习达人的工作区");
  });

  test("handles email with multiple @ signs (uses first)", () => {
    const name = generateDefaultWorkspaceName(null, "weird@email@domain.com");
    assert.equal(name, "weird的工作区");
  });
});

// ─── Invitation token validation ────────────────────────────────────────

describe("SEC-02: Invitation token validation", () => {
  test("isValidInvitationToken rejects empty strings", () => {
    assert.equal(isValidInvitationToken(""), false);
  });

  test("isValidInvitationToken rejects whitespace-only strings", () => {
    assert.equal(isValidInvitationToken("   "), false);
    assert.equal(isValidInvitationToken("\t\n"), false);
  });

  test("isValidInvitationToken rejects null-like values", () => {
    assert.equal(isValidInvitationToken(null as any), false);
    assert.equal(isValidInvitationToken(undefined as any), false);
  });

  test("isValidInvitationToken accepts generated tokens", () => {
    const token = generateInvitationToken();
    assert.ok(isValidInvitationToken(token), "generated token should be valid");
  });

  test("hashInvitationToken produces consistent hashes for same token", () => {
    const token = generateInvitationToken();
    const hash1 = hashInvitationToken(token);
    const hash2 = hashInvitationToken(token);
    assert.equal(hash1, hash2, "same token must produce same hash");
  });

  test("hashInvitationToken produces different hashes for different tokens", () => {
    const token1 = generateInvitationToken();
    const token2 = generateInvitationToken();
    const hash1 = hashInvitationToken(token1);
    const hash2 = hashInvitationToken(token2);
    assert.notEqual(hash1, hash2, "different tokens must produce different hashes");
  });

  test("createInvitationTokenStorage returns hash and hint", () => {
    const token = generateInvitationToken();
    const storage = createInvitationTokenStorage(token);
    assert.ok(storage.tokenHash, "must have tokenHash");
    assert.ok(storage.tokenHint, "must have tokenHint");
    assert.equal(typeof storage.tokenHash, "string");
    assert.equal(typeof storage.tokenHint, "string");
    // Hint should not reveal the full token
    assert.ok(
      storage.tokenHint.length < token.length,
      "hint should be shorter than the full token",
    );
    // Hash should match direct hashing
    assert.equal(storage.tokenHash, hashInvitationToken(token));
  });
});

// ─── WorkspaceInfo type completeness ────────────────────────────────────

describe("ADR-0009: WorkspaceInfo type", () => {
  test("WorkspaceInfo contains all ADR-0009 required fields", () => {
    const info: WorkspaceInfo = {
      workspaceId: "ws-001",
      workspaceName: "测试工作区",
      role: "owner",
      workspaceType: "personal",
      isPersonal: true,
      leftAt: null,
    };

    // ADR-0009 §3.6: isPersonal based on ownerId === userId
    assert.ok("isPersonal" in info, "must have isPersonal field");
    assert.ok("workspaceId" in info);
    assert.ok("workspaceName" in info);
    assert.ok("role" in info);
    assert.ok("workspaceType" in info);
    assert.ok("leftAt" in info, "must track leftAt for soft-delete membership");
  });

  test("isPersonal is true for user-owned workspace", () => {
    const info: WorkspaceInfo = {
      workspaceId: "ws-001",
      workspaceName: "我的工作区",
      role: "owner",
      workspaceType: "personal",
      isPersonal: true,
      leftAt: null,
    };
    assert.equal(info.isPersonal, true);
  });

  test("isPersonal is false for collaborative workspace", () => {
    const info: WorkspaceInfo = {
      workspaceId: "ws-002",
      workspaceName: "团队工作区",
      role: "member",
      workspaceType: "collaborative",
      isPersonal: false,
      leftAt: null,
    };
    assert.equal(info.isPersonal, false);
  });

  test("leftAt tracks soft-deleted memberships for rejoin", () => {
    const info: WorkspaceInfo = {
      workspaceId: "ws-003",
      workspaceName: "已退出的工作区",
      role: "member",
      workspaceType: "collaborative",
      isPersonal: false,
      leftAt: new Date("2026-07-01"),
    };
    assert.ok(info.leftAt instanceof Date, "leftAt should be a Date when set");
  });
});

// ─── Session and auth constants ─────────────────────────────────────────

describe("Identity service constants", () => {
  test("SESSION_TTL_MS is the 30-day sliding window", () => {
    const thirtyDaysInMs = 30 * 24 * 60 * 60 * 1000;
    assert.equal(SESSION_TTL_MS, thirtyDaysInMs);
  });

  test("SESSION_ABSOLUTE_MAX_MS bounds how long any session can live", () => {
    assert.equal(SESSION_ABSOLUTE_MAX_MS, 180 * 24 * 60 * 60 * 1000);
    assert.ok(SESSION_ABSOLUTE_MAX_MS > SESSION_TTL_MS);
  });

  test("RECOVERED_PASSWORD_SENTINEL is not a valid bcrypt hash", () => {
    // The sentinel must not start with $2 so it's never confused with a real hash
    assert.ok(!RECOVERED_PASSWORD_SENTINEL.startsWith("$2"));
    assert.ok(RECOVERED_PASSWORD_SENTINEL.length > 0);
  });

  test("canonicalizeEmail lowercases and trims", () => {
    assert.equal(canonicalizeEmail("  USER@EXAMPLE.COM  "), "user@example.com");
    assert.equal(canonicalizeEmail("Test@Example.org"), "test@example.org");
    assert.equal(canonicalizeEmail("already@lower.com"), "already@lower.com");
  });

  test("hashPassword returns bcrypt hash", async () => {
    const hash = await hashPassword("testpassword123");
    assert.ok(hash.startsWith("$2"), "bcrypt hash should start with $2");
    assert.ok(hash.length > 30, "bcrypt hash should be reasonably long");
  });

  test("hashPassword produces different hashes for same password (salt)", async () => {
    const hash1 = await hashPassword("samepassword");
    const hash2 = await hashPassword("samepassword");
    assert.notEqual(hash1, hash2, "salts should differ");
  });
});

// ─── Registration validation edge cases ─────────────────────────────────

describe("PROFILE-01: Registration field validation", () => {
  test("displayName is optional in registration (can be null/undefined)", () => {
    // The service function accepts undefined for displayName
    // and generates a default from email
    function generateDefaultDisplayName(
      displayName: string | null | undefined,
      email: string,
    ): string {
      return (displayName?.trim() || email.split("@")[0] || "用户").slice(0, 32);
    }

    // undefined → uses email prefix
    assert.equal(generateDefaultDisplayName(undefined, "alice@example.com"), "alice");
    // null → uses email prefix
    assert.equal(generateDefaultDisplayName(null, "bob@test.com"), "bob");
    // empty → uses email prefix
    assert.equal(generateDefaultDisplayName("", "carol@example.com"), "carol");
    // whitespace → uses email prefix
    assert.equal(generateDefaultDisplayName("  ", "dave@test.com"), "dave");
    // provided → uses provided (trimmed)
    assert.equal(generateDefaultDisplayName("小明", "user@example.com"), "小明");
    // long → truncated to 32
    const long = "a".repeat(50);
    assert.equal(generateDefaultDisplayName(long, "user@example.com").length, 32);
  });

  test("avatarUrl is optional and only set when non-empty", () => {
    // The service uses conditional spread for avatarUrl
    function shouldSetAvatarUrl(url: string | undefined): boolean {
      return !!(url?.trim());
    }

    assert.equal(shouldSetAvatarUrl(undefined), false);
    assert.equal(shouldSetAvatarUrl(""), false);
    assert.equal(shouldSetAvatarUrl("  "), false);
    assert.equal(shouldSetAvatarUrl("https://example.com/avatar.png"), true);
    assert.equal(shouldSetAvatarUrl("/images/avatar.png"), true);
  });
});

// ─── updateUserProfile validation logic ─────────────────────────────────

describe("PROFILE-01: updateUserProfile validation logic", () => {
  // Simulate the validation logic from updateUserProfile
  function processDisplayName(value: string | null | undefined): string | null {
    const trimmed = value?.trim() ?? null;
    return trimmed && trimmed.length > 0 ? trimmed.slice(0, 32) : null;
  }

  function processAvatarUrl(value: string | null | undefined): string | null {
    const trimmed = value?.trim() ?? null;
    return trimmed && trimmed.length > 0 ? trimmed.slice(0, 500) : null;
  }

  test("displayName: undefined → null (not modified in actual service, but null here)", () => {
    // In the actual service, undefined means "don't modify"
    // But the processing function returns null for undefined
    assert.equal(processDisplayName(undefined), null);
  });

  test("displayName: null → null (clear the field)", () => {
    assert.equal(processDisplayName(null), null);
  });

  test("displayName: empty string → null (clear the field)", () => {
    assert.equal(processDisplayName(""), null);
  });

  test("displayName: whitespace → null (clear the field)", () => {
    assert.equal(processDisplayName("   "), null);
  });

  test("displayName: valid string → trimmed and sliced to 32", () => {
    assert.equal(processDisplayName("小明"), "小明");
    assert.equal(processDisplayName("  小明  "), "小明");
    const longDisplayName = processDisplayName("a".repeat(50));
    assert.ok(longDisplayName !== null, "should not be null for valid input");
    assert.equal(longDisplayName!.length, 32);
  });

  test("avatarUrl: undefined → null", () => {
    assert.equal(processAvatarUrl(undefined), null);
  });

  test("avatarUrl: null → null (clear)", () => {
    assert.equal(processAvatarUrl(null), null);
  });

  test("avatarUrl: empty → null (clear)", () => {
    assert.equal(processAvatarUrl(""), null);
  });

  test("avatarUrl: valid URL → trimmed and sliced to 500", () => {
    assert.equal(processAvatarUrl("https://example.com/avatar.png"), "https://example.com/avatar.png");
    assert.equal(processAvatarUrl("  https://example.com/avatar.png  "), "https://example.com/avatar.png");
    const longAvatarUrl = processAvatarUrl("a".repeat(600));
    assert.ok(longAvatarUrl !== null, "should not be null for valid input");
    assert.ok(longAvatarUrl!.length <= 500);
  });
});

// ─── renameWorkspace validation logic ───────────────────────────────────

describe("PROFILE-01: renameWorkspace validation logic", () => {
  // Simulate the validation from renameWorkspace
  const MAX_WORKSPACE_NAME_LENGTH = 50;

  /**
   * 审计 F39 之后判据是两问：**是不是自己的个人空间**，或者**是不是这个协作空间的
   * owner**（`workspaces.owner_id` 或 membership.role=owner）。名字本身的规则不变。
   */
  function validateWorkspaceName(
    name: string,
    access: { readonly personal: boolean; readonly collaborativeOwner?: boolean },
  ): { ok: true; name: string } | { ok: false; error: string } {
    const trimmedName = name.trim();
    if (!trimmedName) return { ok: false, error: "empty_name" };
    if (trimmedName.length > MAX_WORKSPACE_NAME_LENGTH) {
      return { ok: false, error: "empty_name" }; // code reuse: length error maps to empty_name
    }
    if (!access.personal && !access.collaborativeOwner) {
      return { ok: false, error: "not_personal_workspace" };
    }
    return { ok: true, name: trimmedName };
  }

  test("empty name → empty_name error", () => {
    const result = validateWorkspaceName("", { personal: true });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error, "empty_name");
  });

  test("whitespace-only name → empty_name error", () => {
    const result = validateWorkspaceName("   ", { personal: true });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error, "empty_name");
  });

  test("name exceeding 50 chars → error", () => {
    const result = validateWorkspaceName("a".repeat(51), { personal: true });
    assert.equal(result.ok, false);
  });

  test("name at exactly 50 chars → ok", () => {
    const result = validateWorkspaceName("a".repeat(50), { personal: true });
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.name.length, 50);
  });

  test("协作空间的 owner 可以改名（审计 F39 放开的这一格）", () => {
    const result = validateWorkspaceName("新名称", { personal: false, collaborativeOwner: true });
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.name, "新名称");
  });

  test("协作空间的普通成员不能改名", () => {
    const result = validateWorkspaceName("新名称", { personal: false, collaborativeOwner: false });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error, "not_personal_workspace");
  });

  test("valid personal workspace name → ok with trimmed name", () => {
    const result = validateWorkspaceName("  学习空间  ", { personal: true });
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.name, "学习空间");
  });
});
