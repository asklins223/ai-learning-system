/**
 * Coalesces pointer deltas to one IPC call per animation frame and guarantees
 * that drag-end is emitted only after the final movement has reached the host.
 */
export interface DragFrameSchedulerV1 {
  request(callback: () => void): number;
  cancel(id: number): void;
}

export interface DragTransportOptionsV1 {
  send(deltaX: number, deltaY: number): Promise<void>;
  onSettled(): void;
  scheduler: DragFrameSchedulerV1;
}

export class DragTransportV1 {
  private pendingX = 0;
  private pendingY = 0;
  private frameId: number | null = null;
  private inFlight = false;
  private ending = false;
  private settled = false;

  constructor(private readonly options: DragTransportOptionsV1) {}

  push(deltaX: number, deltaY: number): void {
    if (this.ending || !Number.isFinite(deltaX) || !Number.isFinite(deltaY)) return;
    this.pendingX += deltaX;
    this.pendingY += deltaY;
    if (!this.inFlight) this.schedule();
  }

  end(): void {
    if (this.ending) return;
    this.ending = true;
    if (this.frameId !== null) {
      this.options.scheduler.cancel(this.frameId);
      this.frameId = null;
    }
    void this.flush();
  }

  private schedule(): void {
    if (this.frameId !== null || this.ending || this.inFlight) return;
    this.frameId = this.options.scheduler.request(() => {
      this.frameId = null;
      void this.flush();
    });
  }

  private async flush(): Promise<void> {
    if (this.inFlight) return;
    const deltaX = this.pendingX;
    const deltaY = this.pendingY;
    this.pendingX = 0;
    this.pendingY = 0;

    if (deltaX === 0 && deltaY === 0) {
      this.settleIfReady();
      return;
    }

    this.inFlight = true;
    try {
      await this.options.send(deltaX, deltaY);
    } catch {
      // A renderer-side drag failure must still release dragging interaction mode.
    } finally {
      this.inFlight = false;
      if (this.pendingX !== 0 || this.pendingY !== 0) {
        if (this.ending) void this.flush();
        else this.schedule();
      } else {
        this.settleIfReady();
      }
    }
  }

  private settleIfReady(): void {
    if (!this.ending || this.inFlight || this.frameId !== null || this.settled) return;
    if (this.pendingX !== 0 || this.pendingY !== 0) return;
    this.settled = true;
    this.options.onSettled();
  }
}

export const browserDragFrameSchedulerV1: DragFrameSchedulerV1 = {
  request: (callback) => window.requestAnimationFrame(callback),
  cancel: (id) => window.cancelAnimationFrame(id),
};
