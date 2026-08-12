// P6 §13：ASR 双路径采集 AudioWorklet 处理器（供 addModule 以 http URL 加载）。
// 2026-08-12：blob: URL 在 Electron 内 addModule 报 AbortError，改静态文件 + 'self' 加载。
class CompanionAsrCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.suspended = false;
    this.port.onmessage = (e) => { this.suspended = e.data.suspended === true; };
  }
  process(inputs) {
    const input = inputs[0];
    if (this.suspended || !input || input.length === 0) return true;
    const channel = input[0];
    if (!channel) return true;
    this.port.postMessage({ pcm: channel });
    return true;
  }
}
registerProcessor("companion-asr-capture", CompanionAsrCaptureProcessor);
