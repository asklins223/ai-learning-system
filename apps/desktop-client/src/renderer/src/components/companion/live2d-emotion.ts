export interface Live2DEmotionEvent {
  readonly emotion: string;
  /** 0..1. Renderer events use the renderer's monotonic clock when received. */
  readonly intensity: number;
  /** Optional monotonic timestamp. Wall-clock timestamps must not be passed here. */
  readonly at?: number;
}

export interface Live2DEmotionState {
  readonly emotion: string | null;
  readonly intensity: number;
}

export interface Live2DEmotionControllerOptions {
  readonly approachAlpha?: number;
  readonly holdMs?: number;
  readonly decayAlpha?: number;
  readonly minIntensity?: number;
}

const DEFAULT_OPTIONS: Required<Live2DEmotionControllerOptions> = {
  approachAlpha: 0.35,
  holdMs: 2_500,
  decayAlpha: 0.08,
  minIntensity: 0.02,
};

export function clampLive2DEmotionIntensity(value: number): number {
  return Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
}

/**
 * Smooths semantic character emotion without tying Live2D to React renders.
 * The controller deliberately accepts a monotonic timestamp so a wall-clock
 * jump cannot keep an expression alive or expire it unexpectedly.
 */
export class Live2DEmotionController {
  private readonly options: Required<Live2DEmotionControllerOptions>;
  private target: Live2DEmotionState = { emotion: null, intensity: 0 };
  private current: Live2DEmotionState = { emotion: null, intensity: 0 };
  private lastEventAt = 0;

  constructor(options: Live2DEmotionControllerOptions = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  push(event: Live2DEmotionEvent, receivedAt = event.at ?? 0): void {
    const emotion = typeof event.emotion === "string"
      ? event.emotion.trim().toLowerCase()
      : "";
    const intensity = clampLive2DEmotionIntensity(event.intensity);
    if (!emotion || intensity <= 0 || !Number.isFinite(receivedAt)) return;

    this.target = { emotion, intensity };
    this.lastEventAt = receivedAt;
  }

  getTarget(): Live2DEmotionState {
    return { ...this.target };
  }

  update(nowMs: number): Live2DEmotionState {
    if (!Number.isFinite(nowMs)) return { ...this.current };

    if (this.target.emotion !== null && nowMs - this.lastEventAt > this.options.holdMs) {
      this.target = { emotion: null, intensity: 0 };
    }

    const alpha = this.target.emotion === null
      ? Math.min(this.options.approachAlpha, this.options.decayAlpha)
      : this.options.approachAlpha;
    const nextIntensity = this.current.intensity
      + (this.target.intensity - this.current.intensity) * alpha;

    if (nextIntensity < this.options.minIntensity) {
      this.current = { emotion: null, intensity: 0 };
    } else {
      this.current = {
        emotion: this.target.emotion ?? this.current.emotion,
        intensity: clampLive2DEmotionIntensity(nextIntensity),
      };
    }
    return { ...this.current };
  }

  reset(): void {
    this.target = { emotion: null, intensity: 0 };
    this.current = { emotion: null, intensity: 0 };
    this.lastEventAt = 0;
  }
}
