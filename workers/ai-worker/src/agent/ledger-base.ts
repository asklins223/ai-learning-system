/**
 * Ledger 共享接口（QUAL-36 修复）
 *
 * CoverageLedger 和 CandidateLedger 有相似的 init/getSnapshot 模式但无共享接口。
 * 此模块提取通用的 ILedger 接口，使两个 Ledger 的 API 设计保持一致，
 * 减少认知负担，并为未来新增 Ledger 类型提供规范。
 */

/**
 * Ledger 共享接口。
 *
 * 所有 Ledger 实现都应遵循以下约定：
 * - init 方法带重复初始化保护（调用两次抛出异常）
 * - isInitialized 可检查是否已初始化
 * - getHash 可选：只有需要 CAS（Compare-And-Swap）的 Ledger 才实现
 */
export interface ILedger {
  /** 是否已初始化 */
  isInitialized(): boolean;

  /** 获取当前 ledger hash（可选，只有需要 CAS 的 Ledger 实现） */
  getHash?(): string;
}

/**
 * Ledger 初始化保护基类。
 *
 * 提供 `initialized` 标志管理和重复初始化检测。
 * 子类在 init 方法中应先调用 `checkNotInitialized()` 再执行初始化逻辑。
 */
export abstract class LedgerBase implements ILedger {
  protected _initialized = false;

  isInitialized(): boolean {
    return this._initialized;
  }

  /** 检查是否已初始化，如已初始化则抛出异常 */
  protected checkNotInitialized(name: string): void {
    if (this._initialized) {
      throw new Error(`${name} 已初始化，不能重复设置`);
    }
  }

  /** 标记为已初始化 */
  protected markInitialized(): void {
    this._initialized = true;
  }

  abstract getHash?(): string;
}
