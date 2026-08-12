/**
 * P4 §8.3 步骤 5：Live2D 表现层优先级与恢复（纯逻辑）。
 *
 * 层优先级（高→低）：lipsync（说话）> facs（表情）> gaze（视线）> blink（眨眼）> idle。
 * - 同一参数被多层请求时，高优先级层胜出（每参数只写一次）；
 * - 同层同参数：时间序后者胜（最新意图）；
 * - 恢复：高层请求被移除/停用后，低层的值自然重新生效（仲裁函数按当前请求集
 *   重算，无持久覆盖——满足 §8.4 "动作层不会永久覆盖 blink/gaze/idle"）；
 * - 驱动每次写参数前必须经 clampLive2DParameter（allowlist + clamp），
 *   本模块产出 raw 值，clamp 在写层执行。
 */

export type Live2DLayer = "idle" | "blink" | "gaze" | "facs" | "lipsync";

export const LIVE2D_LAYER_PRIORITY: Record<Live2DLayer, number> = {
  idle: 0,
  blink: 1,
  gaze: 2,
  facs: 3,
  lipsync: 4,
};

export interface Live2DParameterRequest {
  layer: Live2DLayer;
  parameter: string;
  value: number;
}

export interface ArbitratedParameter {
  parameter: string;
  value: number;
}

/** 同参数多请求 → 高优先级层胜出；同层 → 后者胜。返回每参数唯一结果。 */
export function arbitrateLive2DParameters(
  requests: readonly Live2DParameterRequest[],
): ArbitratedParameter[] {
  const winner = new Map<string, { priority: number; value: number }>();
  for (const req of requests) {
    const priority = LIVE2D_LAYER_PRIORITY[req.layer];
    const current = winner.get(req.parameter);
    if (!current || priority >= current.priority) {
      winner.set(req.parameter, { priority, value: req.value });
    }
  }
  return [...winner.entries()].map(([parameter, v]) => ({
    parameter,
    value: v.value,
  }));
}

/** 层当前是否有活跃请求（用于驱动判断是否保留该层循环）。 */
export function layerHasActiveRequests(
  requests: readonly Live2DParameterRequest[],
  layer: Live2DLayer,
): boolean {
  return requests.some((r) => r.layer === layer);
}

/**
 * §8.4：高层动作（lipsync/facs/gaze）结束后，低层（blink/idle）自动恢复——
 * 即移除高层请求后重算。验证辅助：返回"被多层请求覆盖"的参数名（测试用）。
 */
export function overriddenByHigherLayer(
  requests: readonly Live2DParameterRequest[],
): Set<string> {
  const layersByParameter = new Map<string, Set<number>>();
  for (const r of requests) {
    const set = layersByParameter.get(r.parameter) ?? new Set<number>();
    set.add(LIVE2D_LAYER_PRIORITY[r.layer]);
    layersByParameter.set(r.parameter, set);
  }
  const overridden = new Set<string>();
  for (const [param, layers] of layersByParameter) {
    // 参数被 ≥2 个不同层请求 → 低层被高层覆盖（恢复时移除高层即回低层值）
    if (layers.size > 1) overridden.add(param);
  }
  return overridden;
}
