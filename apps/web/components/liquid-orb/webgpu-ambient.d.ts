/**
 * LiquidOrb 用到的 WebGPU 类型最小声明。
 *
 * 项目 TS lib（dom）只含部分 WebGPU 类型（GPUError 存在、GPUDevice 等缺失），
 * 这里补齐组件实际用到的表面。interface 声明与未来 lib.dom 同名类型通过
 * 声明合并兼容；若升级 TS 后 lib.dom 已含完整类型，本文件可整体删除。
 */
export {};

declare global {
  interface GPUDevice {
    createShaderModule(descriptor: { code: string }): GPUShaderModule;
    createRenderPipeline(descriptor: unknown): GPURenderPipeline;
    createBuffer(descriptor: { size: number; usage: number }): GPUBuffer;
    createBindGroup(descriptor: unknown): GPUBindGroup;
    createCommandEncoder(): GPUCommandEncoder;
    queue: GPUQueue;
    lost: Promise<GPUDeviceLostInfo>;
    destroy(): void;
    addEventListener(type: "uncapturederror", listener: (event: GPUUncapturedErrorEvent) => void): void;
  }

  interface GPUShaderModule {
    getCompilationInfo(): Promise<{
      messages: Array<{ type: "error" | "warning" | "info"; lineNum: number; linePos: number; message: string }>;
    }>;
  }

  interface GPURenderPipeline {
    getBindGroupLayout(index: number): GPUBindGroupLayout;
  }

  interface GPUBindGroupLayout {}
  interface GPUBindGroup {}
  interface GPUBuffer {}

  interface GPUQueue {
    writeBuffer(buffer: GPUBuffer, offset: number, data: ArrayBufferView): void;
    submit(commandBuffers: GPUCommandBuffer[]): void;
  }

  interface GPUCommandEncoder {
    beginRenderPass(descriptor: unknown): GPURenderPassEncoder;
    finish(): GPUCommandBuffer;
  }

  interface GPURenderPassEncoder {
    setPipeline(pipeline: GPURenderPipeline): void;
    setBindGroup(index: number, bindGroup: GPUBindGroup): void;
    draw(vertexCount: number): void;
    end(): void;
  }

  interface GPUCommandBuffer {}

  interface GPUCanvasContext {
    configure(descriptor: unknown): void;
    getCurrentTexture(): { createView(): unknown };
  }

  interface GPUDeviceLostInfo {
    message?: string;
    reason?: string;
  }

  interface GPUUncapturedErrorEvent {
    preventDefault(): void;
    error: { message: string };
  }

  interface GPUAdapter {
    requestDevice(): Promise<GPUDevice>;
  }

  interface Navigator {
    gpu?: {
      requestAdapter(options?: { powerPreference?: "low-power" | "high-performance" | "default" }): Promise<GPUAdapter | null>;
      getPreferredCanvasFormat(): string;
    };
  }
}
