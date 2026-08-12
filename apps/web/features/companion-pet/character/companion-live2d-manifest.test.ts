import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  COMPANION_LIVE2D_MANIFEST,
  LIVE2D_PARAMETER_ALLOWLIST,
} from "./companion-live2d-manifest.ts";

const PUBLIC_ROOT = join(import.meta.dirname, "../../../public");

function readManifest(): Record<string, unknown> {
  const path = join(PUBLIC_ROOT, "images/companion/pet/live2d-v1/manifest.json");
  assert.ok(existsSync(path), `manifest 缺失: ${path}`);
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

function modelRuntimeReferences(): string[] {
  const modelPath = join(
    PUBLIC_ROOT,
    COMPANION_LIVE2D_MANIFEST.modelUrl.replace(/^\//, ""),
  );
  const model = JSON.parse(readFileSync(modelPath, "utf8")) as {
    FileReferences?: {
      Moc?: string;
      Textures?: string[];
      Expressions?: { File?: string }[];
      Motions?: Record<string, { File?: string }[]>;
      Physics?: string;
      Pose?: string;
      UserData?: string;
    };
  };
  const refs = model.FileReferences ?? {};
  return [...new Set([
    refs.Moc,
    ...(refs.Textures ?? []),
    ...(refs.Expressions ?? []).map((entry) => entry.File),
    ...Object.values(refs.Motions ?? {}).flat().map((entry) => entry.File),
    refs.Physics,
    refs.Pose,
    refs.UserData,
  ].filter((value): value is string => Boolean(value)))].map(
    (value) => `mao-pro/runtime/${value}`,
  );
}

test("P4 §8.3 步骤 1：manifest 结构完整（来源/许可/运行时/owner 批准）", () => {
  const m = readManifest();
  assert.equal(m.modelId, "companion-live2d-mao-pro-v1");
  assert.equal(m.status, "production"); // Owner 2026-08-11 确认 Mao PRO 免费，转 production
  const owner = m.ownerApproved as { by?: string; date?: string };
  assert.equal(owner.by, "Owner");
  assert.ok(owner.date);
  const license = m.modelLicense as {
    commercialReleaseAllowed?: boolean;
    redistributionAllowed?: boolean;
    usage?: string;
  };
  assert.equal(license.commercialReleaseAllowed, true); // Owner 2026-08-11：免费，无需商业许可
  assert.equal(license.redistributionAllowed, false);
  assert.ok(license.usage?.includes("无需商业许可")); // Owner 2026-08-11：免费
  assert.equal(
    COMPANION_LIVE2D_MANIFEST.license.commercialReleaseAllowed,
    license.commercialReleaseAllowed,
    "代码 manifest 与 public manifest 的商业使用边界必须一致",
  );
  assert.equal(
    COMPANION_LIVE2D_MANIFEST.license.usage.includes("redistribution remains restricted"),
    true,
    "代码 manifest 必须保留再分发限制",
  );
  const runtime = m.runtime as Record<string, string>;
  assert.ok(runtime.model3?.includes("live2d-v1"));
});

test("P4 §8.3 步骤 1：manifest 文件 hash 与磁盘一致", () => {
  const m = readManifest();
  const hashes = m.fileSha256 as Record<string, string>;
  assert.equal(Object.keys(hashes).length, 24, "vendor + model3 全部资源 hash 已归档");
  const live2dRoot = join(PUBLIC_ROOT, "images/companion/pet/live2d-v1");
  for (const [rel, expected] of Object.entries(hashes)) {
    // vendor 路径在 public 根（/live2d-dev/...），模型文件相对 live2d-v1
    const isVendor = rel.startsWith("/live2d-dev");
    const path = isVendor
      ? join(PUBLIC_ROOT, rel.replace(/^\//, ""))
      : join(live2dRoot, rel);
    assert.ok(existsSync(path), `文件缺失: ${rel}`);
    const actual = createHash("sha256").update(readFileSync(path)).digest("hex");
    assert.equal(actual, expected, `hash 不匹配: ${rel}`);
  }
});

test("P4 §8.3 步骤 1：model3 引用闭包全部进入 manifest hash", () => {
  const hashes = readManifest().fileSha256 as Record<string, string>;
  for (const rel of modelRuntimeReferences()) {
    assert.ok(hashes[rel], `model3 引用未归档 hash: ${rel}`);
  }
});

test("P4 §8.3 步骤 4：参数 allowlist 全部在模型参数集内（从 cdi3 读取）", () => {
  const cdi = JSON.parse(
    readFileSync(
      join(PUBLIC_ROOT, "images/companion/pet/live2d-v1/mao-pro/runtime/mao_pro.cdi3.json"),
      "utf8",
    ),
  ) as { Parameters?: { Id?: string }[] };
  const ids = new Set((cdi.Parameters ?? []).map((p) => p.Id));
  assert.ok(ids.size > 0, "cdi3 参数集非空");
  for (const name of Object.keys(LIVE2D_PARAMETER_ALLOWLIST)) {
    assert.ok(ids.has(name), `allowlist 参数不在模型内: ${name}`);
  }
});

test("P4 §8.3 步骤 4：allowlist clamp 范围合法（min<=max）", () => {
  for (const [name, range] of Object.entries(LIVE2D_PARAMETER_ALLOWLIST)) {
    assert.ok(range.min <= range.max, `${name} min>max`);
    assert.ok(Number.isFinite(range.min) && Number.isFinite(range.max), `${name} 非有限`);
  }
});

test("P4：驱动 modelUrl/vendor 指向生产路径且文件存在", () => {
  for (const script of COMPANION_LIVE2D_MANIFEST.vendorScripts) {
    const path = join(PUBLIC_ROOT, script.replace(/^\//, ""));
    assert.ok(existsSync(path), `vendor 缺失: ${script}`);
  }
  const modelPath = join(
    PUBLIC_ROOT,
    COMPANION_LIVE2D_MANIFEST.modelUrl.replace(/^\//, ""),
  );
  assert.ok(existsSync(modelPath), "model3.json 缺失");
});

test("P4 §8.3 步骤 4：clamp——已知参数 clamp 到范围、未知参数 fail closed null", () => {
  const { clampLive2DParameter } = require("./companion-live2d-manifest.ts");
  assert.equal(clampLive2DParameter("ParamEyeLOpen", 0.5), 0.5);
  assert.equal(clampLive2DParameter("ParamEyeLOpen", 2), 1, "超上限 clamp");
  assert.equal(clampLive2DParameter("ParamEyeLOpen", -3), 0, "低于下限 clamp");
  assert.equal(clampLive2DParameter("ParamAngleX", 999), 30);
  assert.equal(clampLive2DParameter("ParamInjectedUnknown", 0.5), null, "未知参数 fail closed");
});
