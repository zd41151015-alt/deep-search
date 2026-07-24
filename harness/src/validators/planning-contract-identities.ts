import { canonicalContentHash } from "../artifact-store/canonical.js";

export interface PlanningRunStateIdentity {
  readonly manifest_ref: string;
  readonly manifest_schema_version: string;
  readonly run_id: string;
  readonly mode: string;
  readonly current_plan_ref: string | null;
  readonly current_plan_revision: number;
}

export interface CoverageIdentity {
  readonly schema_version: string;
  readonly relation: string;
  readonly run_id: string;
  readonly based_on_plan_ref: string;
  readonly based_on_plan_revision: number;
  readonly based_on_plan_hash: string;
  readonly gap_ref: string;
  readonly subject_ref: string;
  readonly target_unit_ref: string;
  readonly gap_research_goal: string;
  readonly target_research_goal: string;
}

export function planningRunStateHash(identity: PlanningRunStateIdentity): string {
  return canonicalContentHash(identity);
}

export function coverageKey(identity: CoverageIdentity): string {
  return canonicalContentHash(identity);
}
