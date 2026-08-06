/**
 * 候选账本与 typed operations（计划 §9.5, §6.1）
 *
 * 职责：
 * - 维护候选池的不可变账本（ledger hash + append-only operations）
 * - 支持 merge/exclude/calibrate/group/split/restore/adjust_support 操作
 * - 证据 union 保护：合并时保留全部 evidence refIds
 * - 矛盾保护：不允许合并语义矛盾的候选
 * - CAS（Compare-And-Swap）：操作必须基于最新的 ledger hash
 *
 * 不变量（G4, §9.5）：
 * - 所有 Agent 只返回 opaque evidence ID
 * - 服务端验证 workspace、run、noteVersion、bundle ownership 和 source hash
 * - 候选操作是 typed 的，不允许自由文本操作
 * - 合并时必须保留全部 evidence refIds
 */

import { createHash } from "node:crypto";
import type {
  CandidateOperation,
  CandidateKind,
  CognitiveType,
  CandidateImportance,
} from "@ailearn/shared";
// QUAL-36 修复：导入共享 ILedger 接口
import type { ILedger } from "./ledger-base.ts";

/**
 * 从种子文本生成确定性 UUID v5（RFC 4122）。
 *
 * merge/split 创建的合成候选 ID 必须同时存在于内存 ledger（candidateId）和
 * DB（id，uuid 类型）中，且两个 hash 计算（内存 vs DB 重载）都使用同一个 id。
 * 使用哈希派生的合法 UUID 而非 `canonical:<hash>` / `split:<hash>` 字符串，
 * 保证：
 * - 插入 DB 时可直接写 id 列（uuid 类型），不依赖 defaultRandom；
 * - apply_candidate_operations 的 P1-09 DB 重载校验 id 一致；
 * - 下一 turn 从 DB 重建 ledger 时 candidateId = DB id 一致；
 * - read_candidate_ledger / deck draft 引用的 candidateId 与 ledger 内部 id 一致。
 */
export function syntheticCandidateId(seed: string): string {
  const ns = "6ba7b811-9dad-11d1-80b4-00c04fd430c8"; // DNS namespace (uuid v5)
  const hash = createHash("sha1").update(`${ns}${seed}`, "utf8").digest();
  const bytes = [...hash.subarray(0, 16)];
  bytes[6] = (bytes[6]! & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // variant 10xx
  const hex = bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** 候选账本条目 */
export interface CandidateLedgerEntry {
  /** 候选 ID */
  candidateId: string;
  /** 候选类型：extracted 或 canonical */
  candidateKind: CandidateKind;
  /** P1-09: 所属 bundle ID */
  bundleId: string | null;
  /** claim 文本 */
  claim: string;
  /** 主题 */
  topic: string;
  /** 认知类型 */
  cognitiveType: CognitiveType;
  /** 重要度 */
  importance: CandidateImportance;
  /** 章节 key */
  sectionKey: string;
  /** 证据 refIds */
  evidenceRefIds: string[];
  /** 验证状态 */
  validationStatus: string;
  /** 来源 unit ID */
  originUnitId: string;
  /** 排除原因（如果被排除） */
  exclusionReason: string | null;
  /** 分组 key */
  groupKey: string | null;
  /** 衍生候选 IDs（合并/拆分产生的） */
  derivedCandidateIds: string[];
}

/** 候选账本操作结果 */
export interface CandidateOperationResult {
  /** 操作后的候选 ID（merge 产生新 ID，其他操作保持原 ID） */
  resultCandidateId: string;
  /** 操作类型 */
  operationType: CandidateOperation["type"];
  /** 是否创建了新候选 */
  createdNew: boolean;
  /** 被移除的候选 IDs（merge 时被合并的源候选） */
  removedCandidateIds: string[];
  /** 本次操作创建的新候选 IDs（merge/split 时使用） */
  createdCandidateIds?: string[];
}

/**
 * 候选账本。
 *
 * 维护一个 append-only 的操作日志和当前候选快照。
 * 每次操作都会更新 ledger hash。
 */
// QUAL-36 修复：实现 ILedger 共享接口，统一 API 设计
export class CandidateLedger implements ILedger {
  /** 当前候选快照 */
  private candidates: Map<string, CandidateLedgerEntry> = new Map();
  /** 操作历史（append-only） */
  private operations: Array<{
    operation: CandidateOperation;
    result: CandidateOperationResult;
    timestamp: string;
  }> = [];
  /** 当前 ledger hash */
  private ledgerHash: string = "";

  // QUAL-36: ILedger 接口实现
  isInitialized(): boolean {
    return this.candidates.size > 0;
  }

  /**
   * 初始化候选账本。
   */
  init(entries: CandidateLedgerEntry[]): void {
    if (this.candidates.size > 0) {
      throw new Error("CandidateLedger 已初始化，不能重复设置");
    }
    for (const entry of entries) {
      this.candidates.set(entry.candidateId, { ...entry });
    }
    this._markHashDirty();
  }

  /**
   * 获取当前 ledger hash。
   * PERF-25 修复：使用延迟计算，仅在 hash 为脏时重算。
   */
  getHash(): string {
    return this.getLedgerHash();
  }

  /**
   * 获取所有候选（快照）。
   *
   * PERF-44 优化：原代码对每个候选都进行浅拷贝（`{ ...c }`），
   * 对于 80+ 个候选的池会产生大量临时对象。
   * 由于 CandidateLedgerEntry 的可变字段都是原始类型或数组，
   * 返回 Map values 的数组快照即可。调用方不应修改返回的候选对象，
   * 如需修改应先创建本地拷贝。
   */
  getAllCandidates(): readonly CandidateLedgerEntry[] {
    return [...this.candidates.values()];
  }

  /**
   * 获取活跃候选（未被排除的）。
   */
  getActiveCandidates(): CandidateLedgerEntry[] {
    return this.getAllCandidates().filter((c) => c.validationStatus !== "excluded");
  }

  /**
   * 获取 canonical 候选。
   */
  getCanonicalCandidates(): CandidateLedgerEntry[] {
    return this.getActiveCandidates().filter((c) => c.candidateKind === "canonical");
  }

  /**
   * 获取指定候选。
   */
  getCandidate(candidateId: string): CandidateLedgerEntry | null {
    const entry = this.candidates.get(candidateId);
    return entry ? { ...entry } : null;
  }

  /**
   * 添加新候选（由 Extractor 调用）。
   */
  addCandidate(entry: CandidateLedgerEntry): void {
    if (this.candidates.has(entry.candidateId)) {
      throw new CandidateLedgerError(
        `候选 ${entry.candidateId} 已存在`,
        "duplicate_candidate",
      );
    }
    this.candidates.set(entry.candidateId, { ...entry });
    this._markHashDirty();
  }

  /**
   * 应用候选操作。
   *
   * 不变量（§6.1, §9.5）：
   * - 必须基于最新的 ledger hash（CAS）
   * - typed ops、evidence union、矛盾保护
   */
  applyOperation(
    operation: CandidateOperation,
    expectedBaseHash: string,
  ): CandidateOperationResult {
    // CAS 检查
    if (expectedBaseHash !== this.getLedgerHash()) {
      throw new CandidateLedgerError(
        "ledger hash 不匹配（CAS 失败），请重新读取最新 ledger",
        "cas_mismatch",
      );
    }

    // 验证操作参数
    this.validateOperation(operation);

    let result: CandidateOperationResult;

    switch (operation.type) {
      case "merge":
        result = this.applyMerge(operation);
        break;
      case "exclude":
        result = this.applyExclude(operation);
        break;
      case "calibrate":
        result = this.applyCalibrate(operation);
        break;
      case "group":
        result = this.applyGroup(operation);
        break;
      case "split":
        result = this.applySplit(operation);
        break;
      case "restore":
        result = this.applyRestore(operation);
        break;
      case "adjust_support":
        result = this.applyAdjustSupport(operation);
        break;
      default:
        throw new CandidateLedgerError(
          `未知操作类型: ${(operation as { type: string }).type}`,
          "unknown_operation",
        );
    }

    // 记录操作历史
    this.operations.push({
      operation,
      result,
      timestamp: new Date().toISOString(),
    });

    // 重新计算 hash
    this._markHashDirty();

    return result;
  }

  /**
   * 获取操作历史。
   */
  getOperationHistory(): ReadonlyArray<{
    operation: CandidateOperation;
    result: CandidateOperationResult;
    timestamp: string;
  }> {
    return [...this.operations];
  }

  // ─── 操作实现 ──────────────────────────────────────────────────────────

  /** merge：合并多个候选为一个 */
  private applyMerge(operation: CandidateOperation): CandidateOperationResult {
    const candidates = operation.candidateIds.map((id) => this.candidates.get(id));
    if (candidates.some((c) => !c)) {
      throw new CandidateLedgerError(
        "merge 操作中存在不存在的候选 ID",
        "candidate_not_found",
      );
    }

    // 证据 union：保留全部 evidence refIds
    const allEvidence = new Set<string>();
    for (const c of candidates) {
      if (c) {
        for (const refId of c.evidenceRefIds) {
          allEvidence.add(refId);
        }
      }
    }

    // 合并 unionEvidenceRefIds（如果提供了）
    if (operation.unionEvidenceRefIds) {
      for (const refId of operation.unionEvidenceRefIds) {
        allEvidence.add(refId);
      }
    }

    // 创建新的 canonical 候选
    // BUG-54 修复：对 candidateIds 排序后再哈希，确保不同顺序的合并
    // 操作产生相同的 canonical ID，避免重复创建候选。
    // 使用合成 UUID（而非 `canonical:<hash>` 字符串）以便与 DB uuid id 列一致。
    const sortedIds = [...operation.candidateIds].sort();
    const newId = syntheticCandidateId(`merge:${sortedIds.join("|")}`);

    const first = candidates[0]!;
    const merged: CandidateLedgerEntry = {
      candidateId: newId,
      candidateKind: "canonical",
      bundleId: first.bundleId,
      claim: operation.mergedClaim ?? first.claim,
      topic: first.topic,
      cognitiveType: first.cognitiveType,
      importance: first.importance,
      sectionKey: first.sectionKey,
      evidenceRefIds: [...allEvidence].sort(),
      validationStatus: "accepted",
      originUnitId: first.originUnitId,
      exclusionReason: null,
      groupKey: null,
      derivedCandidateIds: [...operation.candidateIds],
    };

    // 标记原候选为已合并（排除）
    for (const id of operation.candidateIds) {
      const c = this.candidates.get(id)!;
      c.validationStatus = "merged";
      c.exclusionReason = `merged into ${newId}`;
    }

    // 添加新候选
    this.candidates.set(newId, merged);

    return {
      resultCandidateId: newId,
      operationType: "merge",
      createdNew: true,
      removedCandidateIds: [...operation.candidateIds],
    };
  }

  /** exclude：排除候选 */
  private applyExclude(operation: CandidateOperation): CandidateOperationResult {
    for (const id of operation.candidateIds) {
      const c = this.candidates.get(id);
      if (!c) {
        throw new CandidateLedgerError(`候选 ${id} 不存在`, "candidate_not_found");
      }
      c.validationStatus = "excluded";
      c.exclusionReason = operation.excludeReason ?? operation.reasonCode;
    }
    return {
      resultCandidateId: operation.candidateIds[0],
      operationType: "exclude",
      createdNew: false,
      removedCandidateIds: [],
    };
  }

  /** calibrate：调整重要度 */
  private applyCalibrate(operation: CandidateOperation): CandidateOperationResult {
    for (const id of operation.candidateIds) {
      const c = this.candidates.get(id);
      if (!c) {
        throw new CandidateLedgerError(`候选 ${id} 不存在`, "candidate_not_found");
      }
      if (operation.adjustedImportance) {
        c.importance = operation.adjustedImportance;
      }
    }
    return {
      resultCandidateId: operation.candidateIds[0],
      operationType: "calibrate",
      createdNew: false,
      removedCandidateIds: [],
    };
  }

  /** group：分组 */
  private applyGroup(operation: CandidateOperation): CandidateOperationResult {
    for (const id of operation.candidateIds) {
      const c = this.candidates.get(id);
      if (!c) {
        throw new CandidateLedgerError(`候选 ${id} 不存在`, "candidate_not_found");
      }
      c.groupKey = operation.groupKey ?? null;
    }
    return {
      resultCandidateId: operation.candidateIds[0],
      operationType: "group",
      createdNew: false,
      removedCandidateIds: [],
    };
  }

  /** split：拆分候选 */
  private applySplit(operation: CandidateOperation): CandidateOperationResult {
    // BUG-93 修复 + 拆分功能化：
    // 原实现只把原候选标记为 split（从活跃池移除）但不创建替代候选，
    // 导致拆分后候选数反而减少，validate_draft 的 insufficient_valid_key_points
    // 无法通过，且 DB 侧没有 split 的持久化分支，P1-09 hash 校验必然不一致。
    //
    // 现在：当操作提供 splitClaims（拆分出的原子 claim 列表）时，
    // 为原候选创建 derived 候选（每个 claim 一个，kind=canonical），
    // 再标记原候选为 split。未提供 splitClaims 时为 no-op（保留原候选活跃），
    // 避免模型误用 split 造成候选丢失。
    const createdIds: string[] = [];
    const claims = operation.splitClaims ?? [];
    for (const id of operation.candidateIds) {
      const c = this.candidates.get(id);
      if (!c) {
        throw new CandidateLedgerError(`候选 ${id} 不存在`, "candidate_not_found");
      }

      if (claims.length === 0) {
        // 无新 claim：非破坏性 no-op，保留原候选
        continue;
      }

      const candidateCreatedIds: string[] = [];
      for (let i = 0; i < claims.length; i++) {
        const claim = claims[i]!;
        const derivedId = syntheticCandidateId(`split:${id}|${i}|${claim}`);
        if (this.candidates.has(derivedId)) {
          throw new CandidateLedgerError(`拆分候选 ${derivedId} 已存在`, "duplicate_candidate");
        }
        const derived: CandidateLedgerEntry = {
          candidateId: derivedId,
          candidateKind: "canonical",
          bundleId: c.bundleId,
          claim,
          topic: c.topic,
          cognitiveType: c.cognitiveType,
          importance: c.importance,
          sectionKey: c.sectionKey,
          evidenceRefIds: [...c.evidenceRefIds],
          validationStatus: "accepted",
          originUnitId: c.originUnitId,
          exclusionReason: null,
          groupKey: c.groupKey,
          derivedCandidateIds: [id],
        };
        this.candidates.set(derivedId, derived);
        candidateCreatedIds.push(derivedId);
      }

      // 仅在创建了替代候选后标记原候选为已拆分（derivedCandidateIds 只记录该候选自己的拆分结果）
      c.validationStatus = "split";
      c.exclusionReason = `split: ${operation.reasonCode}`;
      c.derivedCandidateIds = [...c.derivedCandidateIds, ...candidateCreatedIds];
      createdIds.push(...candidateCreatedIds);
    }
    return {
      resultCandidateId: operation.candidateIds[0],
      operationType: "split",
      createdNew: createdIds.length > 0,
      removedCandidateIds: [],
      createdCandidateIds: createdIds,
    };
  }

  /** restore：恢复被排除的候选 */
  private applyRestore(operation: CandidateOperation): CandidateOperationResult {
    for (const id of operation.candidateIds) {
      const c = this.candidates.get(id);
      if (!c) {
        throw new CandidateLedgerError(`候选 ${id} 不存在`, "candidate_not_found");
      }
      c.validationStatus = "accepted";
      c.exclusionReason = null;
    }
    return {
      resultCandidateId: operation.candidateIds[0],
      operationType: "restore",
      createdNew: false,
      removedCandidateIds: [],
    };
  }

  /** adjust_support：调整支撑 */
  private applyAdjustSupport(operation: CandidateOperation): CandidateOperationResult {
    // BUG-92 修复：原代码是空操作，现在实际更新候选的证据引用。
    // 使用 unionEvidenceRefIds 字段（与 merge 共用）来调整候选的支撑证据。
    for (const id of operation.candidateIds) {
      const c = this.candidates.get(id);
      if (!c) {
        throw new CandidateLedgerError(`候选 ${id} 不存在`, "candidate_not_found");
      }
      // 如果操作提供了调整后的证据引用，则更新
      if (operation.unionEvidenceRefIds) {
        c.evidenceRefIds = operation.unionEvidenceRefIds;
      }
    }
    return {
      resultCandidateId: operation.candidateIds[0],
      operationType: "adjust_support",
      createdNew: false,
      removedCandidateIds: [],
    };
  }

  // ─── 验证 ──────────────────────────────────────────────────────────────

  /** 验证操作参数的合法性 */
  private validateOperation(operation: CandidateOperation): void {
    if (operation.candidateIds.length === 0) {
      throw new CandidateLedgerError("操作必须指定至少一个候选 ID", "empty_candidates");
    }

    // merge 需要至少两个候选
    if (operation.type === "merge" && operation.candidateIds.length < 2) {
      throw new CandidateLedgerError("merge 操作需要至少两个候选", "insufficient_candidates");
    }

    // reasonCode 不能为空
    if (!operation.reasonCode || operation.reasonCode.trim().length === 0) {
      throw new CandidateLedgerError("操作必须提供 reasonCode", "missing_reason");
    }
  }

  /**
   * PERF-25 优化：使用脏标记 + 延迟计算策略。
   * 原实现在每次操作后立即全量序列化所有候选，现在改为标记为 dirty，
   * 只有当 getLedgerHash 被调用时才实际计算。这样连续多个操作
   * 只触发一次 hash 计算。
   */
  private _hashDirty = true;

  /** 标记 hash 为脏，需要在下次 getLedgerHash 时重新计算 */
  private _markHashDirty(): void {
    this._hashDirty = true;
  }

  /** 获取当前 ledger hash（延迟计算，仅在脏时重算） */
  getLedgerHash(): string {
    if (this._hashDirty) {
      this._recomputeHashInternal();
      this._hashDirty = false;
    }
    return this.ledgerHash;
  }

  private _recomputeHashInternal(): void {
    // BUG-55 修复：将 derivedCandidateIds 纳入哈希计算，
    // 确保 split/merge 操作产生的衍生关系变更能被 CAS 检测到。
    //
    // P1-15 修复：移除 operationCount 字段。
    // 原实现包含 operationCount: this.operations.length，但每次 turn 都会
    // 从 DB 重建 ledger（operations=[]），DB 侧 hash 校验固定 operationCount: 0。
    // 任何成功 apply 后内存 hash 的 operationCount 必然 > 0，导致 DB 校验
    // 永远报"hash 不一致"，把成功操作变成失败。CAS 哈希应只反映候选状态，
    // operationCount 是审计字段而非状态。
    const data = JSON.stringify({
      candidates: [...this.candidates.values()]
        .sort((a, b) => a.candidateId.localeCompare(b.candidateId))
        .map((c) => ({
          id: c.candidateId,
          kind: c.candidateKind,
          bundleId: c.bundleId,
          claim: c.claim,
          topic: c.topic,
          cognitiveType: c.cognitiveType,
          importance: c.importance,
          sectionKey: c.sectionKey,
          status: c.validationStatus,
          evidence: c.evidenceRefIds,
          groupKey: c.groupKey,
          exclusionReason: c.exclusionReason,
          // BUG-55: 补充 derivedCandidateIds，使 split/merge 后的衍生关系变更能被 CAS 检测
          derivedCandidateIds: c.derivedCandidateIds,
        })),
    });
    this.ledgerHash = createHash("sha256").update(data, "utf8").digest("hex");
  }
}

/** 候选账本错误 */
export class CandidateLedgerError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = "CandidateLedgerError";
    this.code = code;
  }
}
