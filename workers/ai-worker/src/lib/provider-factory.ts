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
 * 按 (providerId, capability) 创建能力实例 — 仅 worker 可调用。
 *
 * 返回 null 的情况：
 * - provider 元数据声明不支持该 capability
 * - 工厂函数返回 null（如缺少 API Key）
 *
 * 抛错的情况：
 * - providerId 在元数据中不存在
 * - providerId 声明了该 capability 但未注册工厂（配置错误）
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
  return factory(config);
}

/**
 * 检查某 provider 是否已注册某能力的工厂。
 * 主要用于测试和诊断。
 */
export function hasFactory(providerId: string, capability: Capability): boolean {
  return FACTORIES.has(`${providerId}:${capability}`);
}
