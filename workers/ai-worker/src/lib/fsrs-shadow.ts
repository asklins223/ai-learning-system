/**
 * Worker-side re-export of FSRS shadow adapter.
 *
 * The actual implementation lives in @ailearn/shared so that both the
 * API app and the worker can use the same pinned FSRS adapter.
 */

export {
  FSRS_ALGORITHM,
  FSRS_ALGORITHM_VERSION,
  FSRS_PARAMETERS_VERSION,
  computeFSRSShadowDecision,
  outcomeToFSRSRating,
  isFSRSShadowEnabled,
  verifyGoldenVectors,
  generateGoldenVectors,
  type FSRSRating,
  type FSRSShadowInput,
  type FSRSShadowDecision,
  type FSRSGoldenVector,
} from "@ailearn/shared";
