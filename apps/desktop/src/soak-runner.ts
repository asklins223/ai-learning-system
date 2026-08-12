import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { SoakSampler, type SoakCategory, type SoakSnapshot } from "./soak-sampler.ts";

export type SoakMetricMap = Partial<Record<SoakCategory, unknown>>;

export interface SoakRunnerOptionsV1 {
  intervalMs?: number;
  sampler?: SoakSampler;
  collect(): SoakMetricMap | Promise<SoakMetricMap>;
  write(snapshot: SoakSnapshot): void | Promise<void>;
}

/**
 * Long-running sampler used by the real Electron soak.  It does not retain a
 * second copy of raw metrics: every value passes through SoakSampler's
 * allowlist before the redacted snapshot is handed to the sink.
 */
export class SoakRunner {
  private readonly sampler: SoakSampler;
  private readonly intervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private sampleInFlight: Promise<void> | null = null;

  constructor(private readonly options: SoakRunnerOptionsV1) {
    this.sampler = options.sampler ?? new SoakSampler();
    this.intervalMs = Math.max(1_000, Math.floor(options.intervalMs ?? SoakSampler.DEFAULT_INTERVAL_MS));
  }

  start(): void {
    if (this.timer) return;
    void this.sampleNow();
    this.timer = setInterval(() => void this.sampleNow(), this.intervalMs);
    this.timer.unref?.();
  }

  async sampleNow(): Promise<void> {
    if (this.sampleInFlight) return this.sampleInFlight;
    this.sampleInFlight = (async () => {
      const metrics = await this.options.collect();
      for (const [category, value] of Object.entries(metrics) as Array<[SoakCategory, unknown]>) {
        this.sampler.record(category, value);
      }
      await this.options.write(this.sampler.snapshotSinceLast());
    })().finally(() => {
      this.sampleInFlight = null;
    });
    return this.sampleInFlight;
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.sampleInFlight;
  }
}

export function createSoakJsonlWriter(filePath: string): (snapshot: SoakSnapshot) => Promise<void> {
  const absolutePath = path.resolve(filePath);
  let directoryReady: Promise<void> | null = null;
  return async (snapshot) => {
    directoryReady ??= mkdir(path.dirname(absolutePath), { recursive: true }).then(() => undefined);
    await directoryReady;
    await appendFile(absolutePath, `${JSON.stringify(snapshot)}\n`, "utf8");
  };
}
