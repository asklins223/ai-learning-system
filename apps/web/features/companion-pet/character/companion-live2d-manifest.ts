/**
 * P4 Live2D 模型注册（Mao PRO，当前 Owner 批准的运行时资产）。
 *
 * Owner 批准（2026-08-11）：使用当前在用的 Live2D 模型（Mao PRO）作为
 * P4 角色模型。许可边界（如实记录，见 public manifest.json）：
 * - Live2D Free Material License：commercialReleaseAllowed=true（Owner 2026-08-11
 *   确认免费、无需商业许可）、redistributionAllowed=false（再分发仍受限）；
 * - 当前资产无需另行商业许可；再分发仍受 Live2D Free Material 条款约束。
 *
 * 资产 manifest（来源/hash/参数/动作）权威位置：
 * `/images/companion/pet/live2d-v1/manifest.json`（companion-live2d-manifest.test.ts
 * 校验结构 + 文件 hash）。
 */

export const COMPANION_LIVE2D_MANIFEST = {
  modelId: "companion-live2d-mao-pro-v1",
  displayName: "Mao PRO (P4 current model)",
  manifestUrl: "/images/companion/pet/live2d-v1/manifest.json",
  modelUrl: "/images/companion/pet/live2d-v1/mao-pro/runtime/mao_pro.model3.json",
  vendorScripts: [
    "/live2d-dev/vendor/pixi.min.js",
    "/live2d-dev/vendor/live2dcubismcore.min.js",
    "/live2d-dev/vendor/cubism4.min.js",
  ],
  license: {
    name: "Live2D Free Material License Agreement and Terms of Use",
    termsUrl: "https://www.live2d.com/en/download/sample-data/",
    commercialReleaseAllowed: true,
    usage:
      "current model approved by Owner 2026-08-11; free material use does not require a separate commercial license; redistribution remains restricted",
  },
} as const;

/**
 * §8.3 步骤 4：Mao PRO 模型参数 allowlist（白名单 + clamp 范围）。
 * 参数名取自 mao_pro.cdi3.json 的 ParameterGroups（dev manifest 同源）。
 * 未知参数名一律拒绝（fail closed）；范围外 clamp 到 [min,max]。
 */
export const LIVE2D_PARAMETER_ALLOWLIST: Record<string, { min: number; max: number }> = {
  "ParamAngleX": { min: -30, max: 30 },
  "ParamAngleY": { min: -30, max: 30 },
  "ParamAngleZ": { min: -30, max: 30 },
  "ParamEyeLOpen": { min: 0, max: 1 },
  "ParamEyeROpen": { min: 0, max: 1 },
  "ParamEyeLSmile": { min: 0, max: 1 },
  "ParamEyeRSmile": { min: 0, max: 1 },
  "ParamBrowLY": { min: -1, max: 1 },
  "ParamBrowRY": { min: -1, max: 1 },
  // Mao PRO 用 ParamMouthUp/Down/Angry + 元音（ParamA/I/U/E/O）驱动 lipsync，
  // 非 Cubism 标准 ParamMouthOpenY/ParamMouthForm（cdi3 无后者）。
  "ParamMouthUp": { min: 0, max: 1 },
  "ParamMouthDown": { min: 0, max: 1 },
  "ParamMouthAngry": { min: 0, max: 1 },
  "ParamA": { min: 0, max: 1 },
  "ParamI": { min: 0, max: 1 },
  "ParamU": { min: 0, max: 1 },
  "ParamE": { min: 0, max: 1 },
  "ParamO": { min: 0, max: 1 },
  "ParamEyeBallX": { min: -1, max: 1 },
  "ParamEyeBallY": { min: -1, max: 1 },
  "ParamBodyAngleX": { min: -10, max: 10 },
  "ParamBreath": { min: 0, max: 1 },
  "ParamCheek": { min: 0, max: 1 },
} as const;

/**
 * §8.3 步骤 4：参数值应用——allowlist 过滤 + clamp。
 * 未知参数名返回 null（fail closed：驱动不得设置）；范围内值 clamp 到 [min,max]。
 * 驱动每次写模型参数都必须经此函数（LLM/任意参数注入测试失败关闭）。
 */
export function clampLive2DParameter(name: string, value: number): number | null {
  const range = LIVE2D_PARAMETER_ALLOWLIST[name];
  if (!range) return null;
  return Math.min(range.max, Math.max(range.min, value));
}
