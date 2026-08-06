/**
 * Provider 默认上下文窗口大小（token 数）。
 *
 * 此前在 ai-provider.ts 中定义，但 ai-provider.ts 导入 providers/*.ts，
 * 而 providers/*.ts 又导入 ai-provider.ts 的 DEFAULT_CONTEXT_WINDOW_TOKENS，
 * 形成循环依赖。将常量提取到独立文件打破循环。
 */
export const DEFAULT_CONTEXT_WINDOW_TOKENS = 128_000;
