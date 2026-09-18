/**
 * R2: Provider 工厂注册表 — 仅 worker 进程内有效。
 *
 * 将 createProvider() 的 if-else 链替换为注册表模式。
 * worker 启动时由各 provider 文件调用 registerFactory() 填充。
 *
 * 进程边界约束：
 * - packages/shared 持静态 PROVIDER_METADATA const（两端直接 import，无副作用）
 * - 本模块绑 create() 工厂，仅 worker 进程可用
 *
 * @see docs/plans/provider-registry-refactor.md §3.2 第二层
 */

import type { Capability, CapabilityImpl } from "@ailearn/shared";
import { getProviderById, type ProviderRuntimeConfig } from "@ailearn/shared";

/**
 * 工厂注册表 — 仅 worker 进程内有效。
 * key = `${providerId}:${capability}`，value = 工厂函数。
 * worker 启动时由各 provider 文件调用 registerFactory() 填充。
 */
const FACTORIES = new Map<string, (config: ProviderRuntimeConfig) => CapabilityImpl | null>();

/** worker 侧各 provider 文件调用此函数注册工厂 */
export function registerFactory(
  providerId: string,
  capability: Capability,
  factory: (config: ProviderRuntimeConfig) => CapabilityImpl | null,
): void {
  FACTORIES.set(`${providerId}:${capability}`, factory);
}

/**
 * 每种能力**必须**在实例上暴露的方法名（形状校验用）。
 *
 * AI P0-2（2026-09-15 审计）：工厂以 `as unknown as CapabilityImpl` 强转返回实例，
 * 编译期不校验形状。三个 provider 声明了 `vision` 且注册了 vision 工厂，但全仓
 * **没有任何** provider 实现 `analyzeImage`（只有 provider-capabilities.ts 的接口
 * 声明）——能力闸在 :51 只校验"元数据声明支持"，因此会放行一个"看起来是
 * VisionCapability、一调用就 TypeError: analyzeImage is not a function"的对象。
 * 在工厂出口做一次形状校验，把它变成明确的配置错误。
 */
const REQUIRED_CAPABILITY_METHOD: Partial<Record<Capability, string>> = {
  text_generation: "chatCompletion",
  vision: "analyzeImage",
  agent_turn: "executeAgentTurn",
  embedding: "embed",
  rerank: "rerank",
};

/**
 * 按 (providerId, capability) 创建能力实例 — 仅 worker 可调用。
 *
 * 返回 null 的情况：
 * - provider 元数据声明不支持该 capability
 * - 工厂函数返回 null（如缺少 API Key）
 *
 * 抛错的情况：
 * - providerId 在元数据中不存在
 * - providerId 声明了该 capability 但未注册工厂（配置错误）
 * - 工厂返回的实例未实现该能力要求的方法（声明/实现不一致）
 */
export function createCapabilityProvider(
  providerId: string,
  capability: Capability,
  config: ProviderRuntimeConfig,
): CapabilityImpl | null {
  const desc = getProviderById(providerId);
  if (!desc) throw new Error(`unknown provider: ${providerId}`);
  if (!desc.capabilities.includes(capability)) return null;
  const factory = FACTORIES.get(`${providerId}:${capability}`);
  if (!factory) throw new Error(`provider ${providerId} 未注册 ${capability} 工厂`);
  const instance = factory(config);
  if (!instance) return null;
  const requiredMethod = REQUIRED_CAPABILITY_METHOD[capability];
  if (
    requiredMethod
    && typeof (instance as unknown as Record<string, unknown>)[requiredMethod] !== "function"
  ) {
    throw new Error(
      `provider ${providerId} 声明并注册了 ${capability}，但返回的实例未实现 ${requiredMethod}()`
      + "（能力声明与实现不一致：实现该方法，或从 provider-registry 的 capabilities 中移除该能力）",
    );
  }
  return instance;
}
