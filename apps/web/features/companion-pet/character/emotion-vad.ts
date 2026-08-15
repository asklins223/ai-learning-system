/**
 * 15 方案 §5 待办 2：VAD 情绪状态机（soullink EmotionStateController 思路迁移）。
 *
 * 输入：情绪事件（{ emotion, intensity, at }——来自 character.cue 与
 *       voice.segment.emotion）。
 * 输出：平滑后的当前情绪（emotion + intensity），供 facs 参数帧消费。
 *
 * 语义（对齐 soullink EmotionStateController）：
 * - target：最近一次事件的"目标情绪"；current：指数逼近中的当前值；
 * - 指数逼近：每帧 current 向 target 按 approachAlpha 收敛（强度平滑，
 *   emotion 切换立即生效）；
 * - 静默衰减：超过 holdMs 无新事件 → target 回落到 neutral（强度 0），
 *   current 按 decayAlpha 衰减；
 * - 情绪保持：衰减期间 emotion 保持显示，直到强度低于 minIntensity 归零
 *   （避免情绪"瞬间消失"的生硬切换）。
 */
export interface EmotionVadEvent {
  emotion: string;
  /** 0..1 */
  intensity: number;
  /** 事件时间戳（ms） */
  at: number;
}

export interface EmotionVadOutput {
  /** 当前主导情绪（null = neutral） */
  emotion: string | null;
  /** 0..1 平滑强度 */
  intensity: number;
}

export interface EmotionVadOptions {
  /** 指数逼近系数（默认 0.25；越大收敛越快） */
  approachAlpha?: number;
  /** 情绪保持时长 ms（默认 2500；超过后开始静默衰减） */
  holdMs?: number;
  /** 静默衰减系数（默认 0.08；衰减期每帧强度下降比例） */
  decayAlpha?: number;
  /** 强度低于该值视为 neutral（默认 0.02） */
  minIntensity?: number;
}

const DEFAULT_OPTIONS: Required<EmotionVadOptions> = {
  approachAlpha: 0.25,
  holdMs: 2500,
  decayAlpha: 0.08,
  minIntensity: 0.02,
};

export class EmotionVadController {
  private readonly options: Required<EmotionVadOptions>;
  private target: { emotion: string | null; intensity: number } = { emotion: null, intensity: 0 };
  private current: { emotion: string | null; intensity: number } = { emotion: null, intensity: 0 };
  private lastEventAt = 0;

  constructor(options: EmotionVadOptions = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  /** 推入一个情绪事件（覆盖 target；无效强度忽略）。 */
  push(event: EmotionVadEvent): void {
    const intensity = Math.min(1, Math.max(0, event.intensity));
    if (intensity <= 0 || event.emotion.length === 0) return;
    this.target = { emotion: event.emotion, intensity };
    this.lastEventAt = event.at;
  }

  /** 当前未平滑的输出（测试/调试用）。 */
  getTarget(): EmotionVadOutput {
    return { ...this.target };
  }

  /** 每帧调用：指数逼近 + 静默衰减，返回平滑后的情绪。 */
  update(nowMs: number): EmotionVadOutput {
    const { approachAlpha, holdMs, decayAlpha, minIntensity } = this.options;

    // 1. 静默衰减：超过 holdMs 无新事件 → target 回落 neutral
    if (this.target.emotion !== null && nowMs - this.lastEventAt > holdMs) {
      this.target = { emotion: null, intensity: 0 };
    }

    // 2. 强度指数逼近（衰减期同样收敛，decayAlpha 由同一 alpha 承担；
    //    若需更慢的衰减可调低 approachAlpha——保持单一系数更简单）
    const alpha = this.target.emotion === null ? Math.min(approachAlpha, decayAlpha) : approachAlpha;
    const nextIntensity = this.current.intensity + (this.target.intensity - this.current.intensity) * alpha;

    // 3. emotion 跟随：target 有情绪 → 立即切换；target neutral 时保持
    //    当前 emotion 直到强度低于 minIntensity（情绪保持）。
    if (nextIntensity < minIntensity) {
      this.current = { emotion: null, intensity: 0 };
    } else {
      const nextEmotion = this.target.emotion ?? this.current.emotion;
      this.current = { emotion: nextEmotion, intensity: nextIntensity };
    }
    return { ...this.current };
  }
}
