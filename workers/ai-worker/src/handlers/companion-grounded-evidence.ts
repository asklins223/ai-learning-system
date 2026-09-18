import { hashCanonicalV2 } from "@ailearn/shared/hash-canonical-v2";

export interface GroundedTutorEvidenceRow {
  evidence_snapshot_id: string;
  evidence_snapshot_hash: string;
  /** Run target snapshot 中冻结的 hash；存在时必须精确相等。 */
  expected_evidence_snapshot_hash?: string;
  quote_hash: string | null;
  block_content_hash: string | null;
  start_offset: number;
  end_offset: number;
  block_content: string;
}

/**
 * The tutor sees only the sealed [startOffset, endOffset) quote. Hash checks
 * make source edits or an invalid evidence row fail closed before model input.
 */
export function materializeGroundedTutorEvidence(
  rows: GroundedTutorEvidenceRow[],
): string[] {
  const evidence: string[] = [];
  const seenSnapshotIds = new Set<string>();
  for (const row of rows) {
    if (seenSnapshotIds.has(row.evidence_snapshot_id)) continue;
    seenSnapshotIds.add(row.evidence_snapshot_id);
    if (
      row.expected_evidence_snapshot_hash !== undefined
      && row.evidence_snapshot_hash !== row.expected_evidence_snapshot_hash
    ) {
      throw new Error(`grounded tutor evidence snapshot changed: ${row.evidence_snapshot_id}`);
    }
    if (
      typeof row.quote_hash !== "string"
      || typeof row.block_content_hash !== "string"
      || !Number.isInteger(row.start_offset)
      || !Number.isInteger(row.end_offset)
      || row.start_offset < 0
      || row.end_offset <= row.start_offset
      || row.end_offset > row.block_content.length
    ) {
      throw new Error(`invalid grounded tutor evidence span: ${row.evidence_snapshot_id}`);
    }
    if (hashCanonicalV2("block", { content: row.block_content }) !== row.block_content_hash) {
      throw new Error(`grounded tutor evidence block changed: ${row.evidence_snapshot_id}`);
    }
    const quote = row.block_content.slice(row.start_offset, row.end_offset);
    if (hashCanonicalV2("evidence-quote", { quote }) !== row.quote_hash) {
      throw new Error(`grounded tutor evidence quote changed: ${row.evidence_snapshot_id}`);
    }
    const normalized = quote
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!normalized) {
      throw new Error(`empty grounded tutor evidence quote: ${row.evidence_snapshot_id}`);
    }
    evidence.push(normalized.slice(0, 1_200));
  }
  return evidence;
}
