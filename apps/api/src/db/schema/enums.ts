import { pgEnum } from "drizzle-orm/pg-core";
import {
  ArtifactStatus,
  ArtifactType,
  CardStatus,
  EvidenceAlignment,
  JobStatus,
  ReviewStatus,
  SourceStatus,
  ValidationOutcome,
} from "@ailearn/shared";

export const sourceStatusEnum = pgEnum("source_status", Object.values(SourceStatus) as [string, ...string[]]);
export const evidenceAlignmentEnum = pgEnum("evidence_alignment", Object.values(EvidenceAlignment) as [string, ...string[]]);
export const validationOutcomeEnum = pgEnum("validation_outcome", Object.values(ValidationOutcome) as [string, ...string[]]);
export const cardStatusEnum = pgEnum("card_status", Object.values(CardStatus) as [string, ...string[]]);
export const jobStatusEnum = pgEnum("job_status", Object.values(JobStatus) as [string, ...string[]]);
export const artifactStatusEnum = pgEnum("artifact_status", Object.values(ArtifactStatus) as [string, ...string[]]);
export const artifactTypeEnum = pgEnum("artifact_type", Object.values(ArtifactType) as [string, ...string[]]);
export const reviewStatusEnum = pgEnum("review_status", Object.values(ReviewStatus) as [string, ...string[]]);
