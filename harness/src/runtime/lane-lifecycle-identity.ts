import { operationKey, sha256Hex } from "../artifact-store/canonical.js";

type LifecycleIdentitySource = Readonly<Record<string, unknown>>;

export function laneLifecycleIdentity(document: LifecycleIdentitySource): Readonly<{
  run_id: unknown;
  dispatch_batch_ref: unknown;
  dispatch_batch_hash: unknown;
  task_ref: unknown;
  task_id: unknown;
  unit_id: unknown;
  attempt: unknown;
  execution_attempt_id: unknown;
}> {
  return {
    run_id: document.run_id,
    dispatch_batch_ref: document.dispatch_batch_ref,
    dispatch_batch_hash: document.dispatch_batch_hash,
    task_ref: document.task_ref,
    task_id: document.task_id,
    unit_id: document.unit_id,
    attempt: document.attempt,
    execution_attempt_id: document.execution_attempt_id,
  };
}

export function canonicalLaneLifecycleId(document: LifecycleIdentitySource): string {
  return `lifecycle_${sha256Hex(operationKey("lane_lifecycle_identity", laneLifecycleIdentity(document))).slice(0, 32)}`;
}

export function canonicalLaneLifecyclePath(
  document: LifecycleIdentitySource,
  revision = Number(document.revision),
): string {
  return `artifacts/runtime/lane-lifecycle/${canonicalLaneLifecycleId(document)}.r${revision}.json`;
}

export function dispatchLaunchRegistrationPath(registrationId: string): string {
  return `artifacts/runtime/dispatch-launch-registrations/${registrationId}.json`;
}

export function dispatchLaunchRequestFromRegistration(
  registration: LifecycleIdentitySource,
): Readonly<Record<string, unknown>> {
  const registrations = Array.isArray(registration.registrations)
    ? registration.registrations.filter(
        (item): item is Record<string, unknown> =>
          typeof item === "object" && item !== null && !Array.isArray(item),
      )
    : [];
  return {
    schema_version: "startup_opportunity.dispatch_launch_registration_request.v1",
    request_id: registration.registration_id,
    run_id: registration.run_id,
    dispatch_ref: registration.dispatch_ref,
    dispatch_hash: registration.dispatch_hash,
    registered_at: registration.registered_at,
    registrations: registrations.map((item) => ({
      unit_id: item.unit_id,
      task_ref: item.task_ref,
      task_id: item.task_id,
      attempt: item.attempt,
      execution_attempt_id: item.execution_attempt_id,
    })),
  };
}
