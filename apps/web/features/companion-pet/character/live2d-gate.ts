/**
 * P4 §8.3 步骤 8：Live2D 启用门控（纯逻辑）。
 *
 * - reducedMotion 或 animationOff 时"完全绕过循环表现"：不加载 Live2D
 *   （当前模型也不渲染），直接走 Sprite（Sprite 内部同样遵守
 *   reducedMotion/animationOff 布局）；
 * - 服务端未授权 P4（live2dEnabled=false）时不加载，保持独立能力门控。
 */

export interface Live2DGateInput {
  live2dEnabled: boolean;
  reducedMotion: boolean;
  animationOff: boolean;
  /** Deployment-owned vendor files are optional in the repository build. */
  vendorAssetsAvailable?: boolean;
}

/** 是否加载 Live2D 驱动。reducedMotion/animationOff 完全绕过。 */
export function shouldLoadLive2D(input: Live2DGateInput): boolean {
  if (!input.live2dEnabled) return false;
  if (input.vendorAssetsAvailable === false) return false;
  if (input.reducedMotion) return false;
  if (input.animationOff) return false;
  return true;
}

/** 已加载 Live2D 时，是否运行循环表现（blink/gaze/idle 等）。 */
export function shouldRunLive2DLoop(input: {
  reducedMotion: boolean;
  animationOff: boolean;
}): boolean {
  if (input.reducedMotion) return false;
  if (input.animationOff) return false;
  return true;
}
