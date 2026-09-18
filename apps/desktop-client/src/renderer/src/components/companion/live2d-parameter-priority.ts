export type Live2DParameterLayer = "idle" | "blink" | "gaze" | "facs" | "lipsync";

export const LIVE2D_PARAMETER_LAYER_PRIORITY: Readonly<Record<Live2DParameterLayer, number>> = {
  idle: 0,
  blink: 1,
  gaze: 2,
  facs: 3,
  lipsync: 4,
};

export interface Live2DParameterRequest {
  readonly layer: Live2DParameterLayer;
  readonly parameter: string;
  readonly value: number;
}

export interface Live2DParameterValue {
  readonly parameter: string;
  readonly value: number;
}

/** Return one winning value per parameter; higher layers own the parameter. */
export function arbitrateLive2DParameters(
  requests: readonly Live2DParameterRequest[],
): Live2DParameterValue[] {
  const winners = new Map<string, { readonly priority: number; readonly value: number }>();
  for (const request of requests) {
    const priority = LIVE2D_PARAMETER_LAYER_PRIORITY[request.layer];
    const current = winners.get(request.parameter);
    if (!current || priority >= current.priority) {
      winners.set(request.parameter, { priority, value: request.value });
    }
  }

  return [...winners.entries()].map(([parameter, winner]) => ({
    parameter,
    value: winner.value,
  }));
}
