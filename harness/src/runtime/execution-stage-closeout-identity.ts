import { operationKey, sha256Hex } from "../artifact-store/canonical.js";

type StageCloseoutIdentitySource = Readonly<Record<string, unknown>>;

export function executionStageCloseoutIdentity(document: StageCloseoutIdentitySource): Readonly<{
  run_id: unknown;
  research_plan_ref: unknown;
  execution_plan_ref: unknown;
  execution_plan_hash: unknown;
  dispatch_ref: unknown;
  dispatch_hash: unknown;
  stage_id: unknown;
  stage_kind: unknown;
}> {
  return {
    run_id: document.run_id,
    research_plan_ref: document.research_plan_ref,
    execution_plan_ref: document.execution_plan_ref,
    execution_plan_hash: document.execution_plan_hash,
    dispatch_ref: document.dispatch_ref,
    dispatch_hash: document.dispatch_hash,
    stage_id: document.stage_id,
    stage_kind: document.stage_kind,
  };
}

export function canonicalExecutionStageCloseoutId(document: StageCloseoutIdentitySource): string {
  return `stage_closeout_${sha256Hex(
    operationKey("execution_stage_closeout_identity", executionStageCloseoutIdentity(document)),
  ).slice(0, 32)}`;
}

export function canonicalExecutionStageCloseoutPath(document: StageCloseoutIdentitySource): string {
  return `artifacts/runtime/stage-closeouts/${canonicalExecutionStageCloseoutId(document)}.r1.json`;
}
