/**
 * 登录/注册页 auth-surface manifest 的签名契约（此前零覆盖）。
 *
 * 这个端点是**不鉴权**的公开面，客户端用它决定登录页能显示什么、伴星能做什么。
 * 关键性质：
 *   1. 密钥存在时，响应签名必须能用该密钥独立验签（测试里自己重算 HMAC）；
 *   2. 密钥缺失时降级为 testMode=true，且签名可被公开测试密钥复现——这是刻意
 *      披露的降级，客户端据此把签名视为不可信（fail closed），不能悄悄当成正式签名；
 *   3. manifest 随构建缓存一次（signedAt/签名不随请求变化），避免每请求重签；
 *   4. credential 零采集：所有 surface 的 visibleEntityRefs 为空、动作在 allowlist 内。
 *
 * 模块级缓存使两种密钥模式无法在同一模块实例内共存，因此按模式用唯一查询串
 * 重新导入模块（绕过 import cache），而不是把任何一种模式留给"环境碰巧是什么"。
 */
import { createHmac } from "node:crypto";
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import {
  canonicalSerializeAuthSurfacePayload,
  type AuthSurfaceManifestPayload,
} from "@ailearn/shared";

const SECRET_ENV = "AUTH_SURFACE_MANIFEST_SECRET";
const savedSecret = process.env[SECRET_ENV];

after(() => {
  if (savedSecret === undefined) delete process.env[SECRET_ENV];
  else process.env[SECRET_ENV] = savedSecret;
});

/** 用唯一查询串导入一份全新的模块实例（绕过进程内缓存与 env 快照）。 */
async function freshModule(tag: string) {
  return import(`./auth-surface.ts?case=${tag}`) as Promise<
    typeof import("./auth-surface.ts")
  >;
}

function hmacHex(secret: string, payload: AuthSurfaceManifestPayload): string {
  return createHmac("sha256", secret).update(canonicalSerializeAuthSurfacePayload(payload)).digest("hex");
}

describe("resolveAuthSurfaceManifestSecret", () => {
  it("未设置 / 空串 / 纯空白 → null（触发测试模式降级）", async () => {
    const { resolveAuthSurfaceManifestSecret } = await freshModule("resolve");
    for (const value of [undefined, "", "   "]) {
      if (value === undefined) delete process.env[SECRET_ENV];
      else process.env[SECRET_ENV] = value;
      assert.equal(resolveAuthSurfaceManifestSecret(), null, `值 ${JSON.stringify(value)} 必须视为缺失`);
    }
  });

  it("已设置 → 去除首尾空白后的值", async () => {
    const { resolveAuthSurfaceManifestSecret } = await freshModule("resolve2");
    process.env[SECRET_ENV] = "  real-secret  ";
    assert.equal(resolveAuthSurfaceManifestSecret(), "real-secret");
  });
});

describe("配置了密钥：签名可用该密钥独立验签，且非 testMode", () => {
  it("签名 = HMAC-SHA256(canonical payload, secret)，testMode=false", async () => {
    process.env[SECRET_ENV] = "integration-secret-1";
    const { getAuthSurfaceManifestInfo } = await freshModule("signed");

    const info = getAuthSurfaceManifestInfo();
    assert.equal(info.testMode, false);
    const { signature, ...payload } = info.manifest;
    assert.equal(signature, hmacHex("integration-secret-1", payload as AuthSurfaceManifestPayload));
    assert.match(signature, /^[0-9a-f]{64}$/, "SHA-256 hex 摘要");
  });

  it("换密钥后签名不同（证明签名真的用了 AUTH_SURFACE_MANIFEST_SECRET）", async () => {
    process.env[SECRET_ENV] = "integration-secret-2";
    const { getAuthSurfaceManifestInfo } = await freshModule("signed2");
    const info = getAuthSurfaceManifestInfo();
    const { signature, ...payload } = info.manifest;
    assert.equal(signature, hmacHex("integration-secret-2", payload as AuthSurfaceManifestPayload));
    assert.notEqual(
      signature,
      hmacHex("integration-secret-1", payload as AuthSurfaceManifestPayload),
      "不同密钥必须产生不同签名",
    );
  });

  it("进程内缓存：重复调用返回同一对象（signedAt / 签名不随请求变化）", async () => {
    process.env[SECRET_ENV] = "integration-secret-3";
    const { getAuthSurfaceManifestInfo } = await freshModule("cached");
    const first = getAuthSurfaceManifestInfo();
    const second = getAuthSurfaceManifestInfo();
    assert.equal(first, second, "必须是同一次构建的缓存结果");
    assert.equal(first.manifest.signedAt, second.manifest.signedAt);
  });
});

describe("密钥缺失：显式降级为 testMode 且签名可被公开测试密钥复现", () => {
  it("testMode=true，签名等于公开测试密钥的 HMAC（客户端可据此判定不可信）", async () => {
    delete process.env[SECRET_ENV];
    const { getAuthSurfaceManifestInfo } = await freshModule("testmode");

    const info = getAuthSurfaceManifestInfo();
    assert.equal(info.testMode, true, "缺密钥必须显式披露降级");
    const { signature, ...payload } = info.manifest;
    assert.equal(
      signature,
      hmacHex("auth-surface-manifest-test-mode-secret-do-not-use-in-production", payload as AuthSurfaceManifestPayload),
      "测试模式签名必须可被公开常量复现——这正是它不可信的原因",
    );
  });
});

describe("manifest 内容不变量（credential 零采集）", () => {
  it("所有 surface 的 visibleEntityRefs 为空，动作只在 allowlist 内，且登录/注册各三档", async () => {
    process.env[SECRET_ENV] = "integration-secret-4";
    const { getAuthSurfaceManifestInfo } = await freshModule("invariants");
    const { manifest } = getAuthSurfaceManifestInfo();

    assert.ok(manifest.surfaces.length > 0);
    for (const surface of manifest.surfaces) {
      assert.deepEqual(
        surface.visibleEntityRefs,
        [],
        `${surface.surfaceId} 不得引用任何可见实体（登录页伴星读不到账号内容）`,
      );
      assert.ok(surface.allowedActions.length > 0, `${surface.surfaceId} 必须声明可执行动作`);
    }
    const ids = manifest.surfaces.map((surface) => surface.surfaceId).sort();
    assert.deepEqual(ids, [
      "login:silent_anchor",
      "login:static_help",
      "login:transitional",
      "register:silent_anchor",
      "register:static_help",
      "register:transitional",
    ]);
    // 登录页与注册页都不得出现「读账号」「读密码」类动作。
    for (const surface of manifest.surfaces) {
      for (const action of surface.allowedActions) {
        assert.equal(
          /credential|password|secret|read_account/i.test(action),
          false,
          `禁止的动作出现在 ${surface.surfaceId}: ${action}`,
        );
      }
    }
  });
});
