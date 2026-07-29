/**
 * Table-driven tests for rubric-reducer-v1.
 * Covers all 25 verdict combinations for 2-item rubrics,
 * weight effects, coverage boundary, error cases, and helpers.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  reduceRubric,
  toReviewOutcome,
  unableAssessments,
  RUBRIC_REDUCER_VERSION,
  RUBRIC_COVERAGE_THRESHOLD,
  RubricReducerError,
  type RubricItemInput,
} from "./rubric-reducer.ts";
import { RubricVerdict, ValidationOutcome } from "./enums.ts";

const C = RubricVerdict.COVERED;
const P = RubricVerdict.PARTIAL;
const M = RubricVerdict.MISSING;
const X = RubricVerdict.CONTRADICTED;
const N = RubricVerdict.NOT_ASSESSABLE;

const PRE = ValidationOutcome.PRELIMINARY_UNDERSTANDING;
const UNC = ValidationOutcome.UNCLEAR_EXPRESSION;
const MIS = ValidationOutcome.MISUNDERSTANDING;
const UNK = ValidationOutcome.UNKNOWN;

function req(key: string, verdict: RubricVerdict, weight = 1): RubricItemInput {
  return { key, verdict, weight, required: true };
}

function opt(key: string, verdict: RubricVerdict, weight = 1): RubricItemInput {
  return { key, verdict, weight, required: false };
}

// ─── Tests ───────────────────────────────────────────────────────────────

describe("rubric-reducer-v1", () => {
  describe("constants and version", () => {
    it("exports the correct reducer version", () => {
      assert.equal(RUBRIC_REDUCER_VERSION, "rubric-reducer-v1");
    });

    it("uses 0.70 as the coverage threshold", () => {
      assert.equal(RUBRIC_COVERAGE_THRESHOLD, 0.70);
    });
  });

  // ── Rule 1: Any contradiction → misunderstanding ────────────────────

  describe("rule 1: contradiction → misunderstanding", () => {
    it("single required contradicted", () => {
      const r = reduceRubric([req("a", X)]);
      assert.equal(r.outcome, MIS);
      assert.equal(r.hasContradiction, true);
      assert.equal(r.invariantViolation, false);
    });

    it("optional contradicted with required covered", () => {
      const r = reduceRubric([req("a", C), opt("b", X)]);
      assert.equal(r.outcome, MIS);
      assert.equal(r.hasContradiction, true);
      assert.equal(r.allRequiredCovered, true);
    });

    it("contradiction takes priority over all-missing", () => {
      const r = reduceRubric([req("a", M), opt("b", X)]);
      assert.equal(r.outcome, MIS);
    });

    it("multiple contradictions", () => {
      const r = reduceRubric([req("a", X), opt("b", X), opt("c", C)]);
      assert.equal(r.outcome, MIS);
    });

    it("contradiction takes priority over high coverage", () => {
      const r = reduceRubric([req("a", C, 3), req("b", C, 3), opt("c", X)]);
      assert.equal(r.outcome, MIS);
    });
  });

  // ── Rule 2: All missing/not_assessable → unknown ────────────────────

  describe("rule 2: all missing/not_assessable → unknown", () => {
    it("all missing", () => {
      const r = reduceRubric([req("a", M), opt("b", M)]);
      assert.equal(r.outcome, UNK);
      assert.equal(r.hasContradiction, false);
    });

    it("all not_assessable", () => {
      const r = reduceRubric([req("a", N), opt("b", N)]);
      assert.equal(r.outcome, UNK);
    });

    it("mixed missing and not_assessable", () => {
      const r = reduceRubric([req("a", M), opt("b", N), opt("c", M)]);
      assert.equal(r.outcome, UNK);
    });

    it("single required missing", () => {
      const r = reduceRubric([req("a", M)]);
      assert.equal(r.outcome, UNK);
    });
  });

  // ── Rule 3: Required not covered → unclear_expression ───────────────

  describe("rule 3: required not covered → unclear_expression", () => {
    it("required missing with optional covered", () => {
      const r = reduceRubric([req("a", M), opt("b", C)]);
      assert.equal(r.outcome, UNC);
    });

    it("required partial", () => {
      const r = reduceRubric([req("a", P), opt("b", C)]);
      assert.equal(r.outcome, UNC);
    });

    it("required not_assessable", () => {
      const r = reduceRubric([req("a", N), opt("b", C)]);
      assert.equal(r.outcome, UNC);
    });

    it("required partial even with full optional coverage", () => {
      const r = reduceRubric([req("a", P, 3), opt("b", C, 3)]);
      assert.equal(r.outcome, UNC);
    });
  });

  // ── Rule 4: All required covered + coverage ≥ 0.70 → preliminary ───

  describe("rule 4: all required covered + sufficient coverage → preliminary", () => {
    it("single required covered", () => {
      const r = reduceRubric([req("a", C)]);
      assert.equal(r.outcome, PRE);
      assert.equal(r.allRequiredCovered, true);
      assert.equal(r.weightedCoverage, 1.0);
    });

    it("all items covered", () => {
      const r = reduceRubric([req("a", C), opt("b", C)]);
      assert.equal(r.outcome, PRE);
      assert.equal(r.weightedCoverage, 1.0);
    });

    it("required covered + optional partial (coverage 0.75)", () => {
      const r = reduceRubric([req("a", C), opt("b", P)]);
      assert.equal(r.outcome, PRE);
      assert.equal(r.weightedCoverage, 0.75);
    });

    it("high-weight required covered compensates for optional missing", () => {
      const r = reduceRubric([req("a", C, 3), opt("b", M, 1)]);
      assert.equal(r.outcome, PRE);
      assert.equal(r.weightedCoverage, 0.75);
    });
  });

  // ── Rule 5: Has covered/partial but insufficient → unclear ─────────

  describe("rule 5: covered/partial exists but insufficient → unclear", () => {
    it("required covered + optional missing (coverage 0.5)", () => {
      const r = reduceRubric([req("a", C), opt("b", M)]);
      assert.equal(r.outcome, UNC);
      assert.equal(r.weightedCoverage, 0.5);
    });

    it("required covered + optional not_assessable (coverage 0.5)", () => {
      const r = reduceRubric([req("a", C), opt("b", N)]);
      assert.equal(r.outcome, UNC);
    });

    it("low-weight required covered with high-weight optional missing", () => {
      const r = reduceRubric([req("a", C, 1), opt("b", M, 3)]);
      assert.equal(r.outcome, UNC);
      assert.equal(r.weightedCoverage, 0.25);
    });

    it("allRequiredCovered is true in Rule 5 path (required covered, coverage < 0.70)", () => {
      const r = reduceRubric([req("a", C), opt("b", M)]);
      assert.equal(r.outcome, UNC);
      assert.equal(r.allRequiredCovered, true);
      assert.equal(r.hasContradiction, false);
      assert.equal(r.invariantViolation, false);
    });
  });

  // ── Exhaustive 2-item table (both required, weight 1 each) ─────────

  describe("exhaustive 2-item table (both required, weight 1)", () => {
    const verdicts: [string, RubricVerdict][] = [
      ["C", C], ["P", P], ["M", M], ["X", X], ["N", N],
    ];

    // Expected outcomes for (v1, v2) where both are required, weight 1 each
    const expected: Record<string, Record<string, ValidationOutcome>> = {
      C: { C: PRE, P: UNC, M: UNC, X: MIS, N: UNC },
      P: { C: UNC, P: UNC, M: UNC, X: MIS, N: UNC },
      M: { C: UNC, P: UNC, M: UNK, X: MIS, N: UNK },
      X: { C: MIS, P: MIS, M: MIS, X: MIS, N: MIS },
      N: { C: UNC, P: UNC, M: UNK, X: MIS, N: UNK },
    };

    for (const [l1, v1] of verdicts) {
      for (const [l2, v2] of verdicts) {
        const exp = expected[l1][l2];
        it(`(${l1},${l2}) → ${exp}`, () => {
          const r = reduceRubric([req("a", v1), req("b", v2)]);
          assert.equal(r.outcome, exp, `expected ${exp} for (${l1},${l2})`);
          assert.equal(r.reducerVersion, "rubric-reducer-v1");
          assert.equal(r.invariantViolation, false);
        });
      }
    }
  });

  // ── Exhaustive 2-item table (1 required + 1 optional, weight 1 each) ─

  describe("exhaustive 2-item table (required + optional, weight 1)", () => {
    const verdicts: [string, RubricVerdict][] = [
      ["C", C], ["P", P], ["M", M], ["X", X], ["N", N],
    ];

    // When required is covered (C), coverage = 0.5 for opt M/N, 0.75 for opt P, 1.0 for opt C
    // 0.5 < 0.70 → unclear, 0.75 ≥ 0.70 → preliminary
    const expected: Record<string, Record<string, ValidationOutcome>> = {
      C: { C: PRE, P: PRE, M: UNC, X: MIS, N: UNC }, // opt P → 0.75 ≥ 0.70 → preliminary
      P: { C: UNC, P: UNC, M: UNC, X: MIS, N: UNC }, // req P → rule 3
      M: { C: UNC, P: UNC, M: UNK, X: MIS, N: UNK }, // req M → rule 2 or 3
      X: { C: MIS, P: MIS, M: MIS, X: MIS, N: MIS }, // any X → rule 1
      N: { C: UNC, P: UNC, M: UNK, X: MIS, N: UNK }, // req N → rule 2 or 3
    };

    for (const [l1, v1] of verdicts) {
      for (const [l2, v2] of verdicts) {
        const exp = expected[l1][l2];
        it(`req(${l1})+opt(${l2}) → ${exp}`, () => {
          const r = reduceRubric([req("a", v1), opt("b", v2)]);
          assert.equal(r.outcome, exp, `expected ${exp} for req(${l1})+opt(${l2})`);
        });
      }
    }
  });

  // ── Weight effects on coverage threshold ───────────────────────────

  describe("weight effects on coverage threshold", () => {
    it("w3 required covered + w1 optional missing → 0.75 → preliminary", () => {
      const r = reduceRubric([req("a", C, 3), opt("b", M, 1)]);
      assert.equal(r.outcome, PRE);
      assert.equal(r.weightedCoverage, 0.75);
    });

    it("w1 required covered + w3 optional missing → 0.25 → unclear", () => {
      const r = reduceRubric([req("a", C, 1), opt("b", M, 3)]);
      assert.equal(r.outcome, UNC);
      assert.equal(r.weightedCoverage, 0.25);
    });

    it("w2 required covered + w2 optional partial → 0.75 → preliminary", () => {
      const r = reduceRubric([req("a", C, 2), opt("b", P, 2)]);
      assert.equal(r.outcome, PRE);
      assert.equal(r.weightedCoverage, 0.75);
    });

    it("w1 required covered + w3 optional partial → 0.625 → unclear", () => {
      const r = reduceRubric([req("a", C, 1), opt("b", P, 3)]);
      assert.equal(r.outcome, UNC);
      assert.equal(r.weightedCoverage, 0.625);
    });

    it("w3 required covered + w1 optional partial → 0.875 → preliminary", () => {
      const r = reduceRubric([req("a", C, 3), opt("b", P, 1)]);
      assert.equal(r.outcome, PRE);
      assert.equal(r.weightedCoverage, 0.875);
    });
  });

  // ── Coverage boundary at exactly 0.70 ──────────────────────────────

  describe("coverage boundary at exactly 0.70", () => {
    it("coverage = 0.70 (3 covered w3+w2+w2 + 1 missing w3) → preliminary", () => {
      // total = 3+2+2+3 = 10, covered = 3+2+2 = 7, 7/10 = 0.70
      const r = reduceRubric([
        req("a", C, 3), req("b", C, 2), req("c", C, 2), opt("d", M, 3),
      ]);
      assert.equal(r.weightedCoverage, 0.70);
      assert.equal(r.outcome, PRE);
    });

    it("coverage just below 0.70 (covered w3+w2+w2 + partial w1 + missing w3) → unclear", () => {
      // total = 3+2+2+1+3 = 11, covered = 7, partial = 0.5, (7+0.5)/11 ≈ 0.6818
      const r = reduceRubric([
        req("a", C, 3), req("b", C, 2), req("c", C, 2), opt("d", P, 1), opt("e", M, 3),
      ]);
      assert.ok(r.weightedCoverage < 0.70);
      assert.equal(r.outcome, UNC);
    });

    it("coverage = 0.70 with partial (covered w3+w3 + partial w2 + missing w2) → preliminary", () => {
      // total = 3+3+2+2 = 10, covered = 6, partial = 1, (6+1)/10 = 0.70
      const r = reduceRubric([
        req("a", C, 3), req("b", C, 3), opt("c", P, 2), opt("d", M, 2),
      ]);
      assert.equal(r.weightedCoverage, 0.70);
      assert.equal(r.outcome, PRE);
    });
  });

  // ── Multi-item scenarios (3-5 items) ───────────────────────────────

  describe("multi-item scenarios", () => {
    it("3 required covered + 2 optional (1 covered, 1 missing) → preliminary", () => {
      const r = reduceRubric([
        req("a", C), req("b", C), req("c", C), opt("d", C), opt("e", M),
      ]);
      assert.equal(r.outcome, PRE);
      assert.equal(r.weightedCoverage, 0.8);
    });

    it("2 required covered + 1 required partial → unclear (rule 3)", () => {
      const r = reduceRubric([
        req("a", C), req("b", C), req("c", P),
      ]);
      assert.equal(r.outcome, UNC);
    });

    it("5 items: 2 required covered, 3 optional (2 covered, 1 contradicted) → misunderstanding", () => {
      const r = reduceRubric([
        req("a", C), req("b", C), opt("c", C), opt("d", C), opt("e", X),
      ]);
      assert.equal(r.outcome, MIS);
    });

    it("deterministic fallback items should never trigger invariant violation", () => {
      // All reasonable combinations should be covered by rules 1-5
      const r = reduceRubric([req("a", C), opt("b", C), opt("c", P), opt("d", M), opt("e", N)]);
      assert.equal(r.invariantViolation, false);
    });
  });

  // ── Error cases ────────────────────────────────────────────────────

  describe("error cases", () => {
    it("empty rubric throws", () => {
      assert.throws(() => reduceRubric([]), (e: unknown) => {
        return e instanceof RubricReducerError && e.code === "empty_rubric";
      });
    });

    it("no required item throws", () => {
      assert.throws(() => reduceRubric([opt("a", C)]), (e: unknown) => {
        return e instanceof RubricReducerError && e.code === "no_required_item";
      });
    });

    it("invalid verdict throws", () => {
      assert.throws(
        () => reduceRubric([{ key: "a", verdict: "invalid" as RubricVerdict, weight: 1, required: true }]),
        (e: unknown) => e instanceof RubricReducerError && e.code === "invalid_verdict",
      );
    });

    it("weight 0 throws", () => {
      assert.throws(
        () => reduceRubric([req("a", C, 0)]),
        (e: unknown) => e instanceof RubricReducerError && e.code === "invalid_weight",
      );
    });

    it("weight 4 throws", () => {
      assert.throws(
        () => reduceRubric([req("a", C, 4)]),
        (e: unknown) => e instanceof RubricReducerError && e.code === "invalid_weight",
      );
    });

    it("non-integer weight throws", () => {
      assert.throws(
        () => reduceRubric([req("a", C, 1.5)]),
        (e: unknown) => e instanceof RubricReducerError && e.code === "invalid_weight",
      );
    });
  });

  // ── Review outcome mapping ─────────────────────────────────────────

  describe("review outcome mapping", () => {
    it("preliminary_understanding → correct", () => {
      assert.equal(toReviewOutcome(ValidationOutcome.PRELIMINARY_UNDERSTANDING), "correct");
    });

    it("unclear_expression → partial", () => {
      assert.equal(toReviewOutcome(ValidationOutcome.UNCLEAR_EXPRESSION), "partial");
    });

    it("misunderstanding → incorrect", () => {
      assert.equal(toReviewOutcome(ValidationOutcome.MISUNDERSTANDING), "incorrect");
    });

    it("unknown → unable", () => {
      assert.equal(toReviewOutcome(ValidationOutcome.UNKNOWN), "unable");
    });
  });

  // ── Unable assessments helper ──────────────────────────────────────

  describe("unableAssessments helper", () => {
    it("generates missing verdict for all items", () => {
      const items = [
        { key: "a", weight: 1, required: true },
        { key: "b", weight: 2, required: false },
      ];
      const assessments = unableAssessments(items);
      assert.equal(assessments.length, 2);
      assert.equal(assessments[0].verdict, RubricVerdict.MISSING);
      assert.equal(assessments[1].verdict, RubricVerdict.MISSING);
    });

    it("preserves key, weight, and required", () => {
      const items = [
        { key: "x", weight: 3, required: true },
        { key: "y", weight: 1, required: false },
      ];
      const assessments = unableAssessments(items);
      assert.equal(assessments[0].key, "x");
      assert.equal(assessments[0].weight, 3);
      assert.equal(assessments[0].required, true);
      assert.equal(assessments[1].key, "y");
      assert.equal(assessments[1].weight, 1);
      assert.equal(assessments[1].required, false);
    });

    it("unable path through reducer produces unknown", () => {
      const items = [
        { key: "a", weight: 2, required: true },
        { key: "b", weight: 1, required: false },
      ];
      const assessments = unableAssessments(items);
      const r = reduceRubric(assessments);
      assert.equal(r.outcome, ValidationOutcome.UNKNOWN);
      assert.equal(toReviewOutcome(r.outcome), "unable");
    });

    it("empty input produces empty output", () => {
      assert.deepEqual(unableAssessments([]), []);
    });
  });

  // ── Result structure invariants ────────────────────────────────────

  describe("result structure invariants", () => {
    it("always returns the correct reducer version", () => {
      const r1 = reduceRubric([req("a", C)]);
      const r2 = reduceRubric([req("a", X)]);
      const r3 = reduceRubric([req("a", M)]);
      assert.equal(r1.reducerVersion, "rubric-reducer-v1");
      assert.equal(r2.reducerVersion, "rubric-reducer-v1");
      assert.equal(r3.reducerVersion, "rubric-reducer-v1");
    });

    it("weightedCoverage is always in [0, 1]", () => {
      const cases: RubricItemInput[][] = [
        [req("a", C)],
        [req("a", P)],
        [req("a", M)],
        [req("a", C, 3), opt("b", P, 2), opt("c", M, 1)],
      ];
      for (const items of cases) {
        const r = reduceRubric(items);
        assert.ok(r.weightedCoverage >= 0 && r.weightedCoverage <= 1);
      }
    });

    it("hasContradiction is true iff any item is contradicted", () => {
      assert.equal(reduceRubric([req("a", X)]).hasContradiction, true);
      assert.equal(reduceRubric([req("a", C), opt("b", X)]).hasContradiction, true);
      assert.equal(reduceRubric([req("a", C)]).hasContradiction, false);
      assert.equal(reduceRubric([req("a", M), opt("b", P)]).hasContradiction, false);
    });
  });
});
