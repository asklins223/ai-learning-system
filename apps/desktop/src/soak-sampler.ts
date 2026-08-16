/**
 * P6 顺序 10：24h soak 采样器（纯逻辑，可测）。
 *
 * §10.4 最低采样：至少每 30 分钟记录 CPU/内存/窗口/track/连接/计数。
 * 本模块定义采样点结构 + 脱敏规则（**不记录消息正文/敏感内容**）：
 * - 采样点：时间 + 类别 + 数值（number）或枚举；
 * - 脱敏：文本字段仅允许白名单枚举（errorCode/phase 等），自由文本一律丢弃；
 * - 快照：一批采样点 + 单调序号，供持久化/上报。
 */

export type SoakCategory =
  | "electron_main_cpu"
  | "pet_renderer_cpu"
  | "main_renderer_cpu"
  | "electron_main_memory"
  | "gpu_process"
  | "window_count"
  | "media_track_count"
  | "audio_context_count"
  | "sse_connection_count"
  | "timer_count"
  | "pet_position_x"
  | "pet_position_y"
  | "display_fingerprint"
  | "click_through"
  | "api_restart_count"
  | "worker_restart_count"
  | "db_connection_count"
  | "job_backlog"
  | "recent_error_count";

export interface SoakSample {
  at: number;
  category: SoakCategory;
  value: number | string;
}

export interface SoakSnapshot {
  version: 1;
  startedAt: number;
  seq: number;
  samples: SoakSample[];
}

/** 脱敏：仅允许白名单枚举/数字；自由文本（正文/URL/标题）一律不进入快照 */
export function sanitizeSoakValue(category: SoakCategory, raw: unknown): number | string | null {
  if (typeof raw === "number" && Number.isFinite(raw)) return Math.round(raw * 1000) / 1000;
  if (typeof raw === "boolean") return raw ? 1 : 0;
  if (typeof raw === "string") {
    if (category === "display_fingerprint" && /^[a-f0-9]{64}$/.test(raw)) return raw;
    // 允许的枚举类文本（不携带用户内容）
    const allowed = new Set([
      "display_changed", "hidden", "visible", "click_through_on", "click_through_off",
      "gpu_present", "gpu_crashed", "suspended", "resumed",
    ]);
    return allowed.has(raw) ? raw : null;
  }
  return null;
}

export class SoakSampler {
  private seq = 0;
  private readonly samples: SoakSample[] = [];

  constructor(private readonly startedAt: number = Date.now()) {}

  /** 记录一个采样点；脱敏失败（null）则丢弃 */
  record(category: SoakCategory, raw: unknown): SoakSample | null {
    const value = sanitizeSoakValue(category, raw);
    if (value === null) return null;
    const sample: SoakSample = { at: Date.now(), category, value };
    this.samples.push(sample);
    return sample;
  }

  /** 产出快照（不清理样本——供持续累计） */
  snapshot(): SoakSnapshot {
    this.seq += 1;
    return {
      version: 1,
      startedAt: this.startedAt,
      seq: this.seq,
      samples: this.samples.map((s) => ({ ...s })),
    };
  }

  /**
   * Return only samples added since the previous delta snapshot.  The full
   * snapshot API remains available for diagnostics; the runner uses this
   * bounded form so a long soak does not rewrite every historical sample on
   * every 30-minute tick.
   */
  snapshotSinceLast(): SoakSnapshot {
    this.seq += 1;
    // 只保留上次以来的增量：samples 只含未消费样本（每次都被清空），因此
    // 整体即为 delta。清空数组并重置游标，防止 samples 随进程生命周期无限
    // 增长（长 soak 每 30 分钟 tick 都会触发）。
    const samples = this.samples.map((sample) => ({ ...sample }));
    this.samples.length = 0;
    return { version: 1, startedAt: this.startedAt, seq: this.seq, samples };
  }

  get sampleCount(): number {
    return this.samples.length;
  }

  /** 默认采样间隔：30 分钟（§10.4 最低采样） */
  static readonly DEFAULT_INTERVAL_MS = 30 * 60 * 1000;
}
