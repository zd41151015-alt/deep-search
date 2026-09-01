import { mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { EvidenceStore } from "../evidence-store/evidence-store.js";
import { assertRunIsCurrentContinuationLeaf } from "../run-store/continuation-guard.js";
import { JsonlStore } from "../run-store/jsonl-store.js";
import { assertScopeAllowsStorageMutationLocked } from "../run-store/scope-write-guard.js";
import {
  canonicalLaneLifecycleId,
  canonicalLaneLifecyclePath,
  dispatchLaunchRegistrationPath,
  dispatchLaunchRequestFromRegistration,
} from "../runtime/lane-lifecycle-identity.js";
import { storedArtifactFragmentExists } from "../validators/artifact-ref-resolver.js";
import {
  type ArtifactValidator,
  artifactRefsForDocument,
  type DocumentBundleEntry,
  type DocumentBundleReferenceContext,
} from "../validators/artifact-validator.js";
import { publishTemp, removeTemp, writeSyncedTemp } from "./atomic-file.js";
import {
  canonicalContentHash,
  canonicalJson,
  isSha256,
  operationKey,
  sha256Hex,
} from "./canonical.js";
import {
  isNodeError,
  openRunDirectory,
  resolveRunPath,
  validateArtifactRef,
  validateRelativePath,
  validateRunId,
} from "./path-policy.js";
import {
  ARTIFACT_ENVELOPE_SCHEMA_VERSION,
  ARTIFACT_PUBLICATION_COMMIT_SCHEMA_VERSION,
  ARTIFACT_RECEIPT_SCHEMA_VERSION,
  DOCUMENT_BUNDLE_SCHEMA_VERSION,
} from "./publication-policy.js";
import { withRunLock } from "./run-lock.js";
import {
  hasAuthenticatedRuntimeProjectionAuthority,
  publicationRuntimeProjectionReferenceContext,
  runtimeProjectionPublicationAuthorityPaths,
  withAuthenticatedRuntimeProjectionAuthority,
} from "./runtime-projection-authority.js";
import { StoreError } from "./store-error.js";

export type ArtifactFaultBoundary = "after_intent" | "after_temp_write" | "after_publish";

export interface FormalArtifactEnvelope extends Record<string, unknown> {
  readonly schema_version: typeof ARTIFACT_ENVELOPE_SCHEMA_VERSION;
  readonly artifact_type: string;
  readonly artifact_path: string;
  readonly run_id: string;
  readonly created_at: string;
  readonly producer_role: string;
  readonly input_refs: readonly string[];
  readonly content_hash: string;
  readonly document: Record<string, unknown>;
}

interface ArtifactOperationReceipt {
  readonly schema_version: typeof ARTIFACT_RECEIPT_SCHEMA_VERSION;
  readonly operation_key: string;
  readonly run_id: string;
  readonly artifact_path: string;
  readonly artifact_type: string;
  readonly content_hash: string;
  readonly envelope: FormalArtifactEnvelope;
}

interface ArtifactPublicationCommitIdentity {
  readonly schema_version: typeof ARTIFACT_PUBLICATION_COMMIT_SCHEMA_VERSION;
  readonly run_id: string;
  readonly publication_ordinal: number;
  readonly previous_commit_hash: string | null;
  readonly operation_key: string;
  readonly artifact_path: string;
  readonly artifact_type: string;
  readonly content_hash: string;
}

interface ArtifactPublicationCommit extends ArtifactPublicationCommitIdentity {
  readonly publication_commit_hash: string;
}

export interface ArtifactPublicationRecord {
  readonly publicationOrdinal: number;
  readonly contentHash: string;
  readonly publicationCommitHash: string;
}

export interface ArtifactPublicationLedgerEntry {
  readonly publicationOrdinal: number;
  readonly publicationCommitHash: string;
  readonly artifactPath: string;
  readonly artifactType: string;
  readonly contentHash: string;
  readonly envelope: FormalArtifactEnvelope;
}

interface ArtifactBundleOperationReceipt {
  readonly schema_version: "startup_opportunity.artifact_bundle_operation.current";
  readonly operation_key: string;
  readonly run_id: string;
  readonly envelopes: readonly FormalArtifactEnvelope[];
}

interface DispatchLaunchBundleShape {
  readonly registration: FormalArtifactEnvelope;
  readonly lifecycles: readonly FormalArtifactEnvelope[];
}

type ArtifactBundleRecoveryAuthorityKind =
  | "dispatch_launch_registration"
  | "formal_stage_runtime_projection";

interface ArtifactBundleAuthorityReceiptIdentity {
  readonly schema_version: "startup_opportunity.artifact_bundle_authority.current";
  readonly bundle_operation_key: string;
  readonly run_id: string;
  readonly authority_kind: ArtifactBundleRecoveryAuthorityKind;
  readonly previous_publication_commit_hash: string | null;
  readonly artifact_paths: readonly string[];
  readonly content_hashes: readonly {
    readonly artifact_path: string;
    readonly content_hash: string;
  }[];
  readonly trusted_prospective_runtime_authority_paths: readonly string[];
}

interface ArtifactBundleAuthorityReceipt extends ArtifactBundleAuthorityReceiptIdentity {
  readonly authority_operation_key: string;
}

interface ArtifactBundleTargetPreflight {
  readonly exactBundleReceiptExists: boolean;
  readonly allTargetsExist: boolean;
  readonly allTargetsCommitted: boolean;
}

export interface PublishArtifactInput {
  readonly runId: string;
  readonly envelope: FormalArtifactEnvelope;
  readonly operationKey?: string;
  readonly expectedManifestContentHash?: string;
  readonly faultAt?: ArtifactFaultBoundary;
}

export interface PublishArtifactResult {
  readonly schemaVersion: "startup_opportunity.artifact_publish_result.v1";
  readonly runId: string;
  readonly artifactPath: string;
  readonly contentHash: string;
  readonly operationKey: string;
  readonly status: "published" | "idempotent_replay";
}

export interface PublishArtifactBundleInput {
  readonly runId: string;
  readonly envelopes: readonly FormalArtifactEnvelope[];
  readonly expectedManifestContentHash?: string;
}

export interface PublishArtifactBundleResult {
  readonly schemaVersion: "startup_opportunity.artifact_bundle_publish_result.v1";
  readonly runId: string;
  readonly status: "published" | "idempotent_replay";
  readonly artifacts: readonly PublishArtifactResult[];
}

export interface ArtifactRecoveryResult {
  readonly recoveredArtifactPaths: readonly string[];
  readonly removedTemporaryPaths: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEnvelope(value: unknown): value is FormalArtifactEnvelope {
  return (
    isRecord(value) &&
    value.schema_version === ARTIFACT_ENVELOPE_SCHEMA_VERSION &&
    typeof value.artifact_path === "string" &&
    typeof value.run_id === "string" &&
    typeof value.artifact_type === "string" &&
    typeof value.content_hash === "string" &&
    isRecord(value.document)
  );
}

export function isPlanRuntimeOwnedCloseoutEnvelope(envelope: FormalArtifactEnvelope): boolean {
  if (envelope.artifact_type === "startup_opportunity.execution_stage_closeout.v1") {
    return true;
  }
  if (envelope.artifact_type !== "startup_opportunity.lane_lifecycle.v1") {
    return false;
  }
  const failure = isRecord(envelope.document.failure) ? envelope.document.failure : null;
  return (
    Number(envelope.document.revision) > 1 &&
    typeof envelope.document.parent_lifecycle_ref === "string" &&
    envelope.document.state === "failed" &&
    failure?.kind === "runtime_blocked"
  );
}

function assertGenericPublicationMayPublish(envelope: FormalArtifactEnvelope): void {
  if (isPlanRuntimeOwnedCloseoutEnvelope(envelope)) {
    throw new StoreError(
      "artifact.plan_runtime_closeout_entry_required",
      "runtime failure lifecycle and stage closeouts must use the PlanRuntime receipt-owned closeout entry",
      { artifactPath: envelope.artifact_path, artifactType: envelope.artifact_type },
    );
  }
}

function assertPlanRuntimeCloseoutPublication(envelope: FormalArtifactEnvelope): void {
  if (!isPlanRuntimeOwnedCloseoutEnvelope(envelope)) {
    throw new StoreError(
      "artifact.plan_runtime_closeout_type_mismatch",
      "the PlanRuntime closeout publisher accepts only runtime-failure closeout Artifacts",
      { artifactPath: envelope.artifact_path, artifactType: envelope.artifact_type },
    );
  }
}

function isPlanRuntimeCloseoutBundle(receipt: ArtifactBundleOperationReceipt): boolean {
  return (
    receipt.envelopes.length > 0 && receipt.envelopes.every(isPlanRuntimeOwnedCloseoutEnvelope)
  );
}

function hasExactlyKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

function expectedArtifactOperationKey(envelope: FormalArtifactEnvelope): string {
  if (
    envelope.artifact_type === "startup_opportunity.checkpoint.v1" &&
    typeof envelope.document.checkpoint_id === "string"
  ) {
    return operationKey("checkpoint_run", {
      run_id: envelope.run_id,
      checkpoint_id: envelope.document.checkpoint_id,
      content_hash: envelope.content_hash,
    });
  }
  return operationKey("publish_artifact", {
    run_id: envelope.run_id,
    artifact_path: envelope.artifact_path,
    artifact_type: envelope.artifact_type,
    content_hash: envelope.content_hash,
  });
}

function expectedArtifactBundleOperationKey(
  runId: string,
  envelopes: readonly FormalArtifactEnvelope[],
): string {
  return operationKey("publish_artifact_bundle", {
    run_id: runId,
    envelopes: [...envelopes].sort((left, right) =>
      left.artifact_path.localeCompare(right.artifact_path),
    ),
  });
}

const RUNTIME_PROJECTION_ARTIFACT_TYPES = new Set([
  "startup_opportunity.research_execution_plan.discovery.current",
  "startup_opportunity.research_execution_plan.assessment.current",
  "startup_opportunity.dispatch_batch.discovery.current",
  "startup_opportunity.dispatch_batch.assessment.current",
  "startup_opportunity.research_task.assessment.current",
  "startup_opportunity.research_task.discovery_candidate.current",
  "startup_opportunity.research_task.discovery_evaluation.current",
]);

const RUNTIME_PROJECTION_AUTHORITY_ARTIFACT_TYPES = new Set([
  "startup_opportunity.dispatch_batch.discovery.current",
  "startup_opportunity.dispatch_batch.assessment.current",
  "startup_opportunity.research_task.assessment.current",
  "startup_opportunity.research_task.discovery_candidate.current",
  "startup_opportunity.research_task.discovery_evaluation.current",
]);

function bundleRequiresRuntimeProjectionAuthority(
  envelopes: readonly FormalArtifactEnvelope[],
): boolean {
  return envelopes.some((envelope) =>
    RUNTIME_PROJECTION_AUTHORITY_ARTIFACT_TYPES.has(envelope.artifact_type),
  );
}

function requiredBundleRecoveryAuthorityKind(
  envelopes: readonly FormalArtifactEnvelope[],
  launchBundle: DispatchLaunchBundleShape | null,
): ArtifactBundleRecoveryAuthorityKind | null {
  if (launchBundle !== null) return "dispatch_launch_registration";
  return bundleRequiresRuntimeProjectionAuthority(envelopes)
    ? "formal_stage_runtime_projection"
    : null;
}

function artifactBundleAuthorityReceiptPath(bundleOperationKey: string): string {
  return `.store/operations/authority-bundle-${sha256Hex(bundleOperationKey)}.json`;
}

function artifactBundleAuthorityIdentity(input: {
  readonly runId: string;
  readonly bundleOperationKey: string;
  readonly authorityKind: ArtifactBundleRecoveryAuthorityKind;
  readonly previousPublicationCommitHash: string | null;
  readonly envelopes: readonly FormalArtifactEnvelope[];
  readonly trustedProspectiveRuntimeAuthorityPaths: Iterable<string>;
}): ArtifactBundleAuthorityReceiptIdentity {
  const artifactPaths = [
    ...new Set(input.envelopes.map((envelope) => envelope.artifact_path)),
  ].sort();
  return {
    schema_version: "startup_opportunity.artifact_bundle_authority.current",
    bundle_operation_key: input.bundleOperationKey,
    run_id: input.runId,
    authority_kind: input.authorityKind,
    previous_publication_commit_hash: input.previousPublicationCommitHash,
    artifact_paths: artifactPaths,
    content_hashes: artifactPaths.map((artifactPath) => {
      const envelope = input.envelopes.find(
        (candidate) => candidate.artifact_path === artifactPath,
      );
      return {
        artifact_path: artifactPath,
        content_hash: String(envelope?.content_hash ?? ""),
      };
    }),
    trusted_prospective_runtime_authority_paths: [
      ...new Set(input.trustedProspectiveRuntimeAuthorityPaths),
    ].sort(),
  };
}

function artifactBundleAuthorityReceipt(input: {
  readonly runId: string;
  readonly bundleOperationKey: string;
  readonly authorityKind: ArtifactBundleRecoveryAuthorityKind;
  readonly previousPublicationCommitHash: string | null;
  readonly envelopes: readonly FormalArtifactEnvelope[];
  readonly trustedProspectiveRuntimeAuthorityPaths: Iterable<string>;
}): ArtifactBundleAuthorityReceipt {
  const identity = artifactBundleAuthorityIdentity(input);
  return {
    ...identity,
    authority_operation_key: operationKey("artifact_bundle_recovery_authority", identity),
  };
}

function validateArtifactBundleAuthorityReceipt(
  value: unknown,
  filename: string,
  expected: ArtifactBundleAuthorityReceipt,
): ArtifactBundleAuthorityReceipt {
  if (
    !isRecord(value) ||
    !hasExactlyKeys(value, [
      "schema_version",
      "bundle_operation_key",
      "run_id",
      "authority_kind",
      "previous_publication_commit_hash",
      "artifact_paths",
      "content_hashes",
      "trusted_prospective_runtime_authority_paths",
      "authority_operation_key",
    ]) ||
    canonicalJson(value) !== canonicalJson(expected) ||
    filename !== artifactBundleAuthorityReceiptPath(expected.bundle_operation_key).split("/").at(-1)
  ) {
    throw new StoreError(
      "recovery.invalid_bundle_authority",
      "Artifact bundle authority receipt does not match the Store-owned bundle publication fact",
      { path: `.store/operations/${filename}` },
    );
  }
  return value as unknown as ArtifactBundleAuthorityReceipt;
}

function validateArtifactBundleReceipt(
  value: unknown,
  filename: string,
  runId: string,
): ArtifactBundleOperationReceipt {
  if (
    !isRecord(value) ||
    !hasExactlyKeys(value, ["schema_version", "operation_key", "run_id", "envelopes"]) ||
    value.schema_version !== "startup_opportunity.artifact_bundle_operation.current" ||
    !isSha256(value.operation_key) ||
    value.run_id !== runId ||
    !Array.isArray(value.envelopes) ||
    value.envelopes.length < 2 ||
    !value.envelopes.every(isEnvelope)
  ) {
    throw new StoreError(
      "recovery.invalid_bundle_operation",
      "Artifact bundle receipt is invalid",
      {
        path: `.store/operations/${filename}`,
      },
    );
  }
  const receipt = value as unknown as ArtifactBundleOperationReceipt;
  const paths = receipt.envelopes.map((envelope) => envelope.artifact_path);
  if (
    new Set(paths).size !== paths.length ||
    receipt.envelopes.some((envelope) => envelope.run_id !== runId) ||
    receipt.operation_key !== expectedArtifactBundleOperationKey(runId, receipt.envelopes) ||
    filename !== `bundle-${sha256Hex(receipt.operation_key)}.json`
  ) {
    throw new StoreError(
      "recovery.invalid_bundle_operation",
      "Artifact bundle receipt identity differs from its filename or envelopes",
      { path: `.store/operations/${filename}` },
    );
  }
  return receipt;
}

function sameArtifactBundleIntent(
  left: ArtifactBundleOperationReceipt,
  right: ArtifactBundleOperationReceipt,
): boolean {
  return (
    left.schema_version === right.schema_version &&
    left.operation_key === right.operation_key &&
    left.run_id === right.run_id &&
    canonicalJson(left.envelopes) === canonicalJson(right.envelopes)
  );
}

function dispatchLaunchBundleShape(
  envelopes: readonly FormalArtifactEnvelope[],
): DispatchLaunchBundleShape | null {
  const registrations = envelopes.filter(
    (envelope) => envelope.artifact_type === "startup_opportunity.dispatch_launch_registration.v1",
  );
  const lifecycles = envelopes.filter(
    (envelope) => envelope.artifact_type === "startup_opportunity.lane_lifecycle.v1",
  );
  const registration = registrations[0];
  if (
    registration === undefined ||
    registrations.length !== 1 ||
    lifecycles.length < 1 ||
    envelopes.length !== lifecycles.length + 1 ||
    !Array.isArray(registration.document.registrations) ||
    registration.document.registrations.length !== lifecycles.length ||
    registration.artifact_path !==
      dispatchLaunchRegistrationPath(String(registration.document.registration_id ?? "")) ||
    registration.document.request_hash !==
      canonicalContentHash(dispatchLaunchRequestFromRegistration(registration.document))
  ) {
    return null;
  }
  const lifecycleByPath = new Map(
    lifecycles.map((lifecycle) => [lifecycle.artifact_path, lifecycle]),
  );
  for (const item of registration.document.registrations) {
    if (!isRecord(item)) return null;
    const lifecycle = lifecycleByPath.get(String(item.lifecycle_ref ?? ""));
    if (
      lifecycle === undefined ||
      lifecycle.content_hash !== item.lifecycle_hash ||
      lifecycle.document.revision !== 1 ||
      lifecycle.document.parent_lifecycle_ref !== null ||
      lifecycle.document.launch_registration_ref !== registration.artifact_path ||
      lifecycle.document.launch_registration_id !== registration.document.registration_id ||
      lifecycle.document.launch_registration_hash !== registration.document.request_hash ||
      lifecycle.document.run_id !== registration.document.run_id ||
      lifecycle.document.dispatch_batch_ref !==
        `${String(registration.document.dispatch_ref)}#${String(item.task_id ?? "")}` ||
      lifecycle.document.dispatch_batch_hash !== registration.document.dispatch_hash ||
      lifecycle.document.unit_id !== item.unit_id ||
      lifecycle.document.task_ref !== item.task_ref ||
      lifecycle.document.task_id !== item.task_id ||
      lifecycle.document.attempt !== item.attempt ||
      lifecycle.document.execution_attempt_id !== item.execution_attempt_id ||
      lifecycle.document.lifecycle_id !== canonicalLaneLifecycleId(lifecycle.document) ||
      lifecycle.artifact_path !== canonicalLaneLifecyclePath(lifecycle.document, 1)
    ) {
      return null;
    }
    lifecycleByPath.delete(lifecycle.artifact_path);
  }
  return lifecycleByPath.size === 0 ? { registration, lifecycles } : null;
}

function validateArtifactReceipt(
  value: unknown,
  filename: string,
  runId: string,
): ArtifactOperationReceipt {
  if (
    !isRecord(value) ||
    !hasExactlyKeys(value, [
      "schema_version",
      "operation_key",
      "run_id",
      "artifact_path",
      "artifact_type",
      "content_hash",
      "envelope",
    ]) ||
    value.schema_version !== ARTIFACT_RECEIPT_SCHEMA_VERSION ||
    !isSha256(value.operation_key) ||
    value.run_id !== runId ||
    !isEnvelope(value.envelope)
  ) {
    throw new StoreError("recovery.invalid_operation", "artifact operation receipt is invalid", {
      path: `.store/operations/${filename}`,
    });
  }
  const receipt = value as unknown as ArtifactOperationReceipt;
  const expectedFilename = `artifact-${sha256Hex(receipt.operation_key)}.json`;
  if (
    filename !== expectedFilename ||
    receipt.schema_version !== ARTIFACT_RECEIPT_SCHEMA_VERSION ||
    receipt.operation_key !== expectedArtifactOperationKey(receipt.envelope) ||
    receipt.artifact_path !== receipt.envelope.artifact_path ||
    receipt.artifact_type !== receipt.envelope.artifact_type ||
    receipt.content_hash !== receipt.envelope.content_hash ||
    receipt.run_id !== receipt.envelope.run_id
  ) {
    throw new StoreError(
      "recovery.invalid_operation",
      "artifact receipt identity differs from its filename or envelope",
      { path: `.store/operations/${filename}` },
    );
  }
  return receipt;
}

function isMissingRunPath(error: unknown): boolean {
  return (
    isNodeError(error, "ENOENT") ||
    (error instanceof StoreError && error.code === "path.parent_missing")
  );
}

const PUBLICATION_ORDINAL_WIDTH = 12;

function publicationCommitIdentity(
  value: ArtifactPublicationCommit,
): ArtifactPublicationCommitIdentity {
  return {
    schema_version: value.schema_version,
    run_id: value.run_id,
    publication_ordinal: value.publication_ordinal,
    previous_commit_hash: value.previous_commit_hash,
    operation_key: value.operation_key,
    artifact_path: value.artifact_path,
    artifact_type: value.artifact_type,
    content_hash: value.content_hash,
  };
}

function publicationCommitFilename(commit: ArtifactPublicationCommit): string {
  return `publication-${String(commit.publication_ordinal).padStart(
    PUBLICATION_ORDINAL_WIDTH,
    "0",
  )}-${sha256Hex(commit.publication_commit_hash)}.json`;
}

function validateArtifactPublicationCommit(
  value: unknown,
  filename: string,
  runId: string,
): ArtifactPublicationCommit {
  if (
    !isRecord(value) ||
    !hasExactlyKeys(value, [
      "schema_version",
      "run_id",
      "publication_ordinal",
      "previous_commit_hash",
      "operation_key",
      "artifact_path",
      "artifact_type",
      "content_hash",
      "publication_commit_hash",
    ]) ||
    value.schema_version !== ARTIFACT_PUBLICATION_COMMIT_SCHEMA_VERSION ||
    value.run_id !== runId ||
    !Number.isInteger(value.publication_ordinal) ||
    Number(value.publication_ordinal) < 1 ||
    (value.previous_commit_hash !== null && !isSha256(value.previous_commit_hash)) ||
    !isSha256(value.operation_key) ||
    typeof value.artifact_path !== "string" ||
    typeof value.artifact_type !== "string" ||
    !isSha256(value.content_hash) ||
    !isSha256(value.publication_commit_hash)
  ) {
    throw new StoreError(
      "recovery.invalid_publication_commit",
      "Artifact publication commit is invalid",
      { path: `.store/publications/${filename}` },
    );
  }
  const commit = value as unknown as ArtifactPublicationCommit;
  if (
    commit.publication_commit_hash !== canonicalContentHash(publicationCommitIdentity(commit)) ||
    filename !== publicationCommitFilename(commit)
  ) {
    throw new StoreError(
      "recovery.invalid_publication_commit",
      "Artifact publication commit hash or filename differs from its identity",
      { path: `.store/publications/${filename}` },
    );
  }
  return commit;
}

function assertFault(boundary: ArtifactFaultBoundary, requested?: ArtifactFaultBoundary): void {
  if (boundary === requested) {
    throw new StoreError("fault.injected", `injected failure at ${boundary}`, { boundary });
  }
}

function isFormalTargetAllowed(relativePath: string): boolean {
  return !(
    relativePath === "manifest.json" ||
    relativePath === "events.jsonl" ||
    relativePath === "decisions.jsonl" ||
    relativePath.startsWith(".store/") ||
    relativePath === "evidence/manifest.jsonl" ||
    relativePath.startsWith("evidence/raw/")
  );
}

function pathLikeRef(ref: string): boolean {
  const target = ref.split("#", 1)[0] ?? "";
  return target.includes("/") || target.endsWith(".json") || target.endsWith(".jsonl");
}

function collectPathRefs(envelope: FormalArtifactEnvelope): readonly string[] {
  const refs = new Set<string>();
  for (const ref of envelope.input_refs) {
    if (pathLikeRef(ref)) {
      refs.add(ref);
    }
  }
  const visit = (value: unknown, key = ""): void => {
    if (Array.isArray(value)) {
      if (key.endsWith("_refs") || key === "artifact_refs" || key === "input_refs") {
        for (const item of value) {
          if (typeof item === "string" && pathLikeRef(item)) {
            refs.add(item);
          }
        }
      } else {
        for (const item of value) {
          visit(item);
        }
      }
      return;
    }
    if (
      typeof value === "string" &&
      (key === "trigger_event_ref" || key === "user_decision_ref") &&
      pathLikeRef(value)
    ) {
      refs.add(value);
      return;
    }
    if (!isRecord(value)) {
      return;
    }
    for (const [childKey, child] of Object.entries(value)) {
      visit(child, childKey);
    }
  };
  visit(envelope.document);
  return [...refs].sort();
}

async function listFiles(directory: string, prefix = ""): Promise<readonly string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (
      relative === ".store" ||
      relative === "evidence/raw" ||
      relative === "staging" ||
      relative === "report.json" ||
      relative === "decision-brief.md" ||
      relative === "report.md" ||
      relative === "audit-appendix.md"
    ) {
      continue;
    }
    if (entry.isSymbolicLink()) {
      throw new StoreError("path.symlink_escape", "Run contains a symlink", { path: relative });
    }
    if (entry.isDirectory()) {
      files.push(...(await listFiles(path.join(directory, entry.name), relative)));
    } else if (entry.isFile()) {
      files.push(relative);
    }
  }
  return files;
}

async function assertReferenceExists(
  runRoot: string,
  ref: string,
  pending: FormalArtifactEnvelope,
  logs: JsonlStore,
): Promise<void> {
  const parsed = validateArtifactRef(ref);
  if (parsed.path === pending.artifact_path) {
    if (parsed.fragment !== null && !storedArtifactFragmentExists(pending, parsed.fragment)) {
      throw new StoreError("reference.fragment_missing", "pending artifact fragment is missing", {
        ref,
      });
    }
    return;
  }
  if (parsed.path === "events.jsonl" || parsed.path === "decisions.jsonl") {
    await logs.readExactRecord(runRoot, pending.run_id, ref, parsed.path);
    return;
  }
  const filename = await resolveRunPath(runRoot, parsed.path);
  try {
    const metadata = await stat(filename);
    if (!metadata.isFile()) {
      throw new StoreError("reference.missing", "artifact ref target is not a file", { ref });
    }
  } catch (error) {
    if (
      isNodeError(error, "ENOENT") ||
      (error instanceof StoreError && error.code === "path.parent_missing")
    ) {
      throw new StoreError("reference.missing", "artifact ref target is missing", { ref });
    }
    throw error;
  }
  if (parsed.fragment === null) {
    return;
  }
  const exists = storedArtifactFragmentExists(
    JSON.parse(await readFile(filename, "utf8")) as unknown,
    parsed.fragment,
  );
  if (!exists) {
    throw new StoreError("reference.fragment_missing", "artifact ref fragment is missing", { ref });
  }
}

function publicationRank(envelope: FormalArtifactEnvelope): number {
  if (envelope.artifact_type === "startup_opportunity.discovery_candidate_conversion.v2") {
    switch (envelope.document.source_candidate_kind) {
      case "demand_seed":
        return 10;
      case "baseline_seed":
        return 20;
      case "solution_seed":
        return 30;
      default:
        return 99;
    }
  }
  const ranks: Readonly<Record<string, number>> = {
    "startup_opportunity.research_task.discovery_evaluation.current": 10,
    "startup_opportunity.evidence.discovery_evaluation.current": 20,
    "startup_opportunity.claim.discovery_evaluation.current": 21,
    "startup_opportunity.finding.discovery_evaluation.current": 22,
    "startup_opportunity.insight.discovery_evaluation.current": 23,
    "startup_opportunity.judgment_assessment.discovery_evaluation.current": 24,
    "startup_opportunity.source_manifest.discovery_evaluation.current": 25,
    "startup_opportunity.ai_capability_benchmark.v1": 26,
    "startup_opportunity.ai_evaluation_reliability.v1": 27,
    "startup_opportunity.ai_data_dependency.v1": 28,
    "startup_opportunity.capability_evidence.v1": 29,
    "startup_opportunity.ai_inference_unit_economics.v1": 30,
    "startup_opportunity.capability_commoditization_risk.v1": 31,
    "startup_opportunity.ai_adoption_trust.v1": 32,
    "startup_opportunity.ai_mandatory_bundle.v1": 59,
    "startup_opportunity.enrichment_branch_result.v1": 30,
    "startup_opportunity.enrichment_fan_in.v1": 40,
    "startup_opportunity.value_layer_analysis.v1": 50,
    "startup_opportunity.user_state_context_model.v1": 51,
    "startup_opportunity.buyer_purchase_language.v1": 52,
    "startup_opportunity.business_engine_thesis.discovery_evaluation.current": 53,
    "startup_opportunity.opportunity_comparison.v1": 60,
    "startup_opportunity.sensitivity.v1": 70,
    "startup_opportunity.portfolio_view.v1": 80,
    "startup_opportunity.decision_recommendation.v1": 81,
    "startup_opportunity.traceability.discovery.current": 90,
    "startup_opportunity.decision_subject_snapshot.current": 91,
    "startup_opportunity.report.v1": 100,
    "startup_opportunity.decision_brief.discovery.current": 101,
    "startup_opportunity.discovery_report_view.v1": 102,
    "startup_opportunity.report_consistency_evaluation.discovery.current": 103,
    "startup_opportunity.terminal_report_source.v1": 100,
    "startup_opportunity.decision_brief.terminal.current": 101,
    "startup_opportunity.terminal_report_view.v1": 102,
    "startup_opportunity.report_consistency_evaluation.terminal.current": 103,
    "startup_opportunity.research_execution_plan.discovery.current": 1,
    "startup_opportunity.dispatch_batch.discovery.current": 2,
    "startup_opportunity.dispatch_launch_registration.v1": 3,
    "startup_opportunity.lane_lifecycle.v1": 4,
    "startup_opportunity.candidate_neutral_evidence.v1": 20,
    "startup_opportunity.source_manifest.discovery_runtime.current": 25,
    "startup_opportunity.discovery_generation_result.v1": 30,
    "startup_opportunity.discovery_stage_readiness.v1": 40,
    "startup_opportunity.gap_snapshot.discovery.readiness.current": 50,
    "startup_opportunity.adaptation_decision.discovery.current": 60,
    "startup_opportunity.research_execution_plan.assessment.current": 1,
    "startup_opportunity.dispatch_batch.assessment.current": 2,
    "startup_opportunity.assessment_lane_result.v1": 30,
    "startup_opportunity.assessment_stage_gate.v1": 40,
    "startup_opportunity.assessment_followup_decision.v1": 50,
    "startup_opportunity.demand_thesis.v1": 11,
    "startup_opportunity.baseline_option.v1": 21,
    "startup_opportunity.solution_hypothesis.v1": 31,
    "startup_opportunity.solution_evaluation.v1": 40,
    "startup_opportunity.opportunity_thesis.v1": 50,
    "startup_opportunity.thesis_evaluation_snapshot.v1": 60,
    "startup_opportunity.merge.v1": 70,
  };
  return ranks[envelope.artifact_type] ?? 199;
}

const PLANNING_PUBLICATION_TYPES = new Set([
  "startup_opportunity.research_plan.v1",
  "startup_opportunity.concept_evidence_assessment_plan.v1",
  "startup_opportunity.planning_context.general.current",
  "startup_opportunity.planning_context.ai_source_bound.current",
  "startup_opportunity.ai_trigger_source_attestation.v1",
]);

export class ArtifactStore {
  private readonly logs: JsonlStore;
  private readonly evidence: EvidenceStore;

  constructor(
    private readonly runsRoot: string,
    private readonly validator: ArtifactValidator,
  ) {
    this.logs = new JsonlStore(validator);
    this.evidence = new EvidenceStore(runsRoot);
  }

  async publish(input: PublishArtifactInput): Promise<PublishArtifactResult> {
    await assertRunIsCurrentContinuationLeaf(this.runsRoot, input.runId);
    this.validateEnvelopeVersionBoundary(input.envelope.schema_version);
    if (PLANNING_PUBLICATION_TYPES.has(input.envelope.artifact_type)) {
      throw new StoreError(
        "artifact.planning_entry_required",
        "Plan and planning authority must publish through RunStore or PlanRevisionRuntime",
      );
    }
    if (input.envelope.artifact_type === "startup_opportunity.research_handoff.current") {
      throw new StoreError(
        "research_handoff.dedicated_entry_required",
        "research handoffs must use the target-owned exact capture operation",
      );
    }
    if (input.envelope.artifact_type === "startup_opportunity.terminal_report_source.v1") {
      throw new StoreError(
        "report.terminal_dedicated_entry_required",
        "terminal report sources must use the atomic terminal Plan closeout entry",
      );
    }
    assertGenericPublicationMayPublish(input.envelope);
    const runRoot = await openRunDirectory(this.runsRoot, input.runId);
    return withRunLock(runRoot, async () => {
      await assertRunIsCurrentContinuationLeaf(this.runsRoot, input.runId);
      return this.publishLocked(runRoot, input);
    });
  }

  async publishBundle(input: PublishArtifactBundleInput): Promise<PublishArtifactBundleResult> {
    await assertRunIsCurrentContinuationLeaf(this.runsRoot, input.runId);
    if (
      input.envelopes.some((envelope) => PLANNING_PUBLICATION_TYPES.has(envelope.artifact_type))
    ) {
      throw new StoreError(
        "artifact.planning_entry_required",
        "Plan and planning authority must publish through RunStore or PlanRevisionRuntime",
      );
    }
    if (
      input.envelopes.some(
        (envelope) => envelope.artifact_type === "startup_opportunity.research_handoff.current",
      )
    ) {
      throw new StoreError(
        "research_handoff.dedicated_entry_required",
        "research handoffs must use the target-owned exact capture operation",
      );
    }
    if (
      input.envelopes.some(
        (envelope) => envelope.artifact_type === "startup_opportunity.terminal_report_source.v1",
      )
    ) {
      throw new StoreError(
        "report.terminal_dedicated_entry_required",
        "terminal report sources must use the atomic terminal Plan closeout entry",
      );
    }
    for (const envelope of input.envelopes) {
      assertGenericPublicationMayPublish(envelope);
    }
    const runRoot = await openRunDirectory(this.runsRoot, input.runId);
    return withRunLock(runRoot, async () => {
      await assertRunIsCurrentContinuationLeaf(this.runsRoot, input.runId);
      return this.publishBundleLocked(runRoot, input);
    });
  }

  async publishBundleLocked(
    runRoot: string,
    input: PublishArtifactBundleInput,
    referenceContext: DocumentBundleReferenceContext = {},
    dedicatedPlanRuntimeCloseout = false,
  ): Promise<PublishArtifactBundleResult> {
    if (
      input.envelopes.some(
        (envelope) =>
          envelope.artifact_type === "startup_opportunity.dispatch_launch_registration.v1",
      )
    ) {
      throw new StoreError(
        "artifact.dispatch_launch_registration_entry_required",
        "Dispatch launch registration must use the dedicated atomic registry publisher",
      );
    }
    for (const envelope of input.envelopes) {
      if (dedicatedPlanRuntimeCloseout) assertPlanRuntimeCloseoutPublication(envelope);
      else assertGenericPublicationMayPublish(envelope);
    }
    return this.publishBundlePreparedLocked(
      runRoot,
      input,
      referenceContext,
      false,
      dedicatedPlanRuntimeCloseout,
    );
  }

  async publishPlanRuntimeCloseoutBundleLocked(
    runRoot: string,
    input: PublishArtifactBundleInput,
    referenceContext: DocumentBundleReferenceContext = {},
  ): Promise<PublishArtifactBundleResult> {
    return this.publishBundleLocked(runRoot, input, referenceContext, true);
  }

  async publishDispatchLaunchBundleLocked(
    runRoot: string,
    input: PublishArtifactBundleInput,
    referenceContext: DocumentBundleReferenceContext = {},
  ): Promise<PublishArtifactBundleResult> {
    if (dispatchLaunchBundleShape(input.envelopes) === null) {
      throw new StoreError(
        "artifact.dispatch_launch_registration_bundle_invalid",
        "dedicated launch publication requires one registration and all of its lifecycle roots",
      );
    }
    return this.publishBundlePreparedLocked(runRoot, input, referenceContext, true);
  }

  async preflightDispatchLaunchBundleLocked(
    runRoot: string,
    input: PublishArtifactBundleInput,
  ): Promise<"publish" | "idempotent_replay"> {
    if (dispatchLaunchBundleShape(input.envelopes) === null) {
      throw new StoreError(
        "artifact.dispatch_launch_registration_bundle_invalid",
        "dedicated launch publication requires one registration and all of its lifecycle roots",
      );
    }
    for (const envelope of input.envelopes) this.validateEnvelopeBoundary(input.runId, envelope);
    const preflight = await this.preflightBundleTargetsLocked(runRoot, input, true);
    return preflight.exactBundleReceiptExists &&
      preflight.allTargetsExist &&
      preflight.allTargetsCommitted
      ? "idempotent_replay"
      : "publish";
  }

  private async publishBundlePreparedLocked(
    runRoot: string,
    input: PublishArtifactBundleInput,
    referenceContext: DocumentBundleReferenceContext = {},
    dedicatedDispatchLaunch = false,
    dedicatedPlanRuntimeCloseout = false,
  ): Promise<PublishArtifactBundleResult> {
    validateRunId(input.runId);
    await assertRunIsCurrentContinuationLeaf(this.runsRoot, input.runId);
    await assertScopeAllowsStorageMutationLocked(this.runsRoot, runRoot, input.runId, {
      kind: "artifact",
      artifactTypes: input.envelopes.map((envelope) => envelope.artifact_type),
    });
    if (input.envelopes.length < 2) {
      throw new StoreError(
        "artifact.bundle_too_small",
        "multi-envelope publication requires at least two envelopes",
      );
    }
    const paths = input.envelopes.map((envelope) => envelope.artifact_path);
    if (new Set(paths).size !== paths.length) {
      throw new StoreError("artifact.bundle_duplicate_path", "publication bundle paths overlap", {
        paths,
      });
    }
    for (const envelope of input.envelopes) {
      if (envelope.artifact_type === "startup_opportunity.checkpoint.v1") {
        throw new StoreError(
          "checkpoint.dedicated_entry_required",
          "checkpoints must use the monotonic checkpoint operation",
        );
      }
      if (envelope.artifact_type === "startup_opportunity.research_handoff.current") {
        throw new StoreError(
          "research_handoff.dedicated_entry_required",
          "research handoffs must use the target-owned exact capture operation",
        );
      }
      if (dedicatedPlanRuntimeCloseout) assertPlanRuntimeCloseoutPublication(envelope);
      else assertGenericPublicationMayPublish(envelope);
      this.validateEnvelopeBoundary(input.runId, envelope);
    }
    await this.validateEnvelopeSetReferences(runRoot, input.envelopes, referenceContext);
    const bundleOperationKey = expectedArtifactBundleOperationKey(input.runId, input.envelopes);
    const bundleOperationHex = sha256Hex(bundleOperationKey);
    const bundleReceipt: ArtifactBundleOperationReceipt = {
      schema_version: "startup_opportunity.artifact_bundle_operation.current",
      operation_key: bundleOperationKey,
      run_id: input.runId,
      envelopes: [...input.envelopes].sort((left, right) =>
        left.artifact_path.localeCompare(right.artifact_path),
      ),
    };
    await this.preflightBundleTargetsLocked(runRoot, input, dedicatedDispatchLaunch);
    await this.writeBundleAuthorityReceiptLocked(runRoot, {
      runId: input.runId,
      bundleOperationKey,
      envelopes: input.envelopes,
      launchBundle: dedicatedDispatchLaunch ? dispatchLaunchBundleShape(input.envelopes) : null,
      referenceContext,
    });
    const bundleReceiptPath = `.store/operations/bundle-${bundleOperationHex}.json`;
    const bundleReceiptFile = await resolveRunPath(runRoot, bundleReceiptPath, {
      createParents: true,
    });
    try {
      const existing = JSON.parse(await readFile(bundleReceiptFile, "utf8")) as unknown;
      if (canonicalJson(existing) !== canonicalJson(bundleReceipt)) {
        throw new StoreError(
          "write.bundle_operation_conflict",
          "bundle operation key was previously used with different content",
          { operationKey: bundleOperationKey },
        );
      }
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) throw error;
      const bundleReceiptTemp = `.store/temp/bundle-${bundleOperationHex}.receipt.tmp`;
      await writeSyncedTemp(runRoot, bundleReceiptTemp, `${canonicalJson(bundleReceipt)}\n`);
      await publishTemp(runRoot, bundleReceiptTemp, bundleReceiptPath);
    }
    const artifacts: PublishArtifactResult[] = [];
    for (const envelope of [...input.envelopes].sort((left, right) => {
      const rank = publicationRank(left) - publicationRank(right);
      return rank === 0 ? left.artifact_path.localeCompare(right.artifact_path) : rank;
    })) {
      artifacts.push(
        dedicatedDispatchLaunch
          ? await this.publishPreparedLocked(runRoot, { runId: input.runId, envelope }, true)
          : await this.publishLocked(
              runRoot,
              { runId: input.runId, envelope },
              true,
              {},
              dedicatedPlanRuntimeCloseout,
            ),
      );
    }
    return {
      schemaVersion: "startup_opportunity.artifact_bundle_publish_result.v1",
      runId: input.runId,
      status: artifacts.every((artifact) => artifact.status === "idempotent_replay")
        ? "idempotent_replay"
        : "published",
      artifacts,
    };
  }

  private async preflightBundleTargetsLocked(
    runRoot: string,
    input: PublishArtifactBundleInput,
    dedicatedDispatchLaunch: boolean,
  ): Promise<ArtifactBundleTargetPreflight> {
    const artifactReceipts = await this.artifactOperationReceiptsLocked(runRoot, input.runId);
    const receiptsByPath = new Map<string, ArtifactOperationReceipt[]>();
    for (const receipt of artifactReceipts) {
      const receipts = receiptsByPath.get(receipt.artifact_path) ?? [];
      receipts.push(receipt);
      receiptsByPath.set(receipt.artifact_path, receipts);
    }
    const publicationRecords = await this.publicationRecordsLocked(runRoot, input.runId);
    const bundleOperationKey = expectedArtifactBundleOperationKey(input.runId, input.envelopes);
    const bundleReceipt: ArtifactBundleOperationReceipt = {
      schema_version: "startup_opportunity.artifact_bundle_operation.current",
      operation_key: bundleOperationKey,
      run_id: input.runId,
      envelopes: [...input.envelopes].sort((left, right) =>
        left.artifact_path.localeCompare(right.artifact_path),
      ),
    };
    let exactBundleReceiptExists = false;
    const incomingByPath = new Map(
      input.envelopes.map((envelope) => [envelope.artifact_path, envelope]),
    );
    const operationDirectory = await resolveRunPath(runRoot, ".store/operations", {
      createParents: true,
    });
    const isDurablyCompleted = async (envelope: FormalArtifactEnvelope): Promise<boolean> => {
      if (publicationRecords.get(envelope.artifact_path)?.contentHash !== envelope.content_hash) {
        return false;
      }
      const expectedOperation = expectedArtifactOperationKey(envelope);
      const hasExactArtifactReceipt = (receiptsByPath.get(envelope.artifact_path) ?? []).some(
        (receipt) =>
          receipt.operation_key === expectedOperation &&
          canonicalJson(receipt.envelope) === canonicalJson(envelope),
      );
      if (!hasExactArtifactReceipt) return false;
      try {
        const existing = JSON.parse(
          await readFile(await resolveRunPath(runRoot, envelope.artifact_path), "utf8"),
        ) as unknown;
        if (canonicalJson(existing) !== canonicalJson(envelope)) {
          throw new StoreError("write.conflict", "formal artifact path is already occupied", {
            path: envelope.artifact_path,
          });
        }
        return true;
      } catch (error) {
        if (isMissingRunPath(error)) return false;
        throw error;
      }
    };
    for (const entry of (await readdir(operationDirectory)).sort()) {
      if (!entry.startsWith("bundle-") || !entry.endsWith(".json")) continue;
      const existingReceipt = validateArtifactBundleReceipt(
        JSON.parse(
          await readFile(await resolveRunPath(runRoot, `.store/operations/${entry}`), "utf8"),
        ) as unknown,
        entry,
        input.runId,
      );
      if (sameArtifactBundleIntent(existingReceipt, bundleReceipt)) {
        exactBundleReceiptExists = true;
        continue;
      }
      for (const existingEnvelope of existingReceipt.envelopes) {
        const incomingEnvelope = incomingByPath.get(existingEnvelope.artifact_path);
        if (incomingEnvelope === undefined) continue;
        if (
          canonicalJson(existingEnvelope) !== canonicalJson(incomingEnvelope) ||
          !(await isDurablyCompleted(existingEnvelope))
        ) {
          throw new StoreError(
            "write.bundle_operation_conflict",
            "bundle publication path overlaps another immutable bundle intent",
            {
              path: existingEnvelope.artifact_path,
              existingOperationKey: existingReceipt.operation_key,
              incomingOperationKey: bundleOperationKey,
            },
          );
        }
      }
    }

    let allTargetsExist = true;
    let anyTargetExists = false;
    for (const envelope of input.envelopes) {
      const expectedOperation = expectedArtifactOperationKey(envelope);
      const pathReceipts = receiptsByPath.get(envelope.artifact_path) ?? [];
      if (
        pathReceipts.some(
          (receipt) =>
            receipt.operation_key !== expectedOperation ||
            canonicalJson(receipt.envelope) !== canonicalJson(envelope),
        )
      ) {
        throw new StoreError(
          "write.operation_conflict",
          "formal artifact path has a conflicting immutable publication intent",
          { path: envelope.artifact_path },
        );
      }
      try {
        const existing = JSON.parse(
          await readFile(await resolveRunPath(runRoot, envelope.artifact_path), "utf8"),
        ) as unknown;
        anyTargetExists = true;
        if (canonicalJson(existing) !== canonicalJson(envelope)) {
          throw new StoreError("write.conflict", "formal artifact path is already occupied", {
            path: envelope.artifact_path,
          });
        }
        if (!pathReceipts.some((receipt) => receipt.operation_key === expectedOperation)) {
          throw new StoreError(
            "recovery.publication_receipt_missing",
            "published bundle target lacks its exact immutable Artifact receipt",
            { path: envelope.artifact_path },
          );
        }
      } catch (error) {
        if (!isMissingRunPath(error)) throw error;
        allTargetsExist = false;
      }
    }
    if (dedicatedDispatchLaunch && anyTargetExists && !exactBundleReceiptExists) {
      throw new StoreError(
        "artifact.dispatch_launch_registration_authority_missing",
        "an existing launch registration member requires its exact original bundle receipt",
        { artifactPaths: input.envelopes.map((envelope) => envelope.artifact_path).sort() },
      );
    }
    const allTargetsCommitted =
      allTargetsExist &&
      input.envelopes.every(
        (envelope) =>
          publicationRecords.get(envelope.artifact_path)?.contentHash === envelope.content_hash,
      );
    return { exactBundleReceiptExists, allTargetsExist, allTargetsCommitted };
  }

  async dispatchLaunchBundleAuthorityLocked(
    runRoot: string,
    runId: string,
    registrationRef: string,
    trackedArtifactRefs: ReadonlySet<string>,
  ): Promise<readonly FormalArtifactEnvelope[] | null> {
    const operationDirectory = await resolveRunPath(runRoot, ".store/operations", {
      createParents: false,
    });
    const publicationRecords = await this.publicationRecordsLocked(runRoot, runId);
    for (const filename of (await readdir(operationDirectory)).sort()) {
      if (!filename.startsWith("bundle-") || !filename.endsWith(".json")) continue;
      const receipt = validateArtifactBundleReceipt(
        JSON.parse(
          await readFile(await resolveRunPath(runRoot, `.store/operations/${filename}`), "utf8"),
        ) as unknown,
        filename,
        runId,
      );
      const registration = receipt.envelopes.find(
        (envelope) => envelope.artifact_path === registrationRef,
      );
      const launchBundle = dispatchLaunchBundleShape(receipt.envelopes);
      if (
        registration?.artifact_type !== "startup_opportunity.dispatch_launch_registration.v1" ||
        launchBundle?.registration.artifact_path !== registrationRef
      ) {
        continue;
      }
      let valid = true;
      for (const envelope of receipt.envelopes) {
        const publication = publicationRecords.get(envelope.artifact_path);
        if (
          !trackedArtifactRefs.has(envelope.artifact_path) ||
          publication?.contentHash !== envelope.content_hash
        ) {
          valid = false;
          break;
        }
        const stored = JSON.parse(
          await readFile(await resolveRunPath(runRoot, envelope.artifact_path), "utf8"),
        ) as unknown;
        if (canonicalJson(stored) !== canonicalJson(envelope)) {
          valid = false;
          break;
        }
      }
      if (valid) return receipt.envelopes;
    }
    return null;
  }

  async publishPrevalidatedTerminalReportBundleLocked(
    runRoot: string,
    input: PublishArtifactBundleInput,
    afterPublish?: (envelope: FormalArtifactEnvelope) => void,
  ): Promise<PublishArtifactBundleResult> {
    await assertScopeAllowsStorageMutationLocked(this.runsRoot, runRoot, input.runId, {
      kind: "artifact",
      artifactTypes: input.envelopes.map((envelope) => envelope.artifact_type),
    });
    const expectedTypes = new Set([
      "startup_opportunity.terminal_report_source.v1",
      "startup_opportunity.decision_brief.terminal.current",
      "startup_opportunity.terminal_report_view.v1",
      "startup_opportunity.report_consistency_evaluation.terminal.current",
    ]);
    if (
      input.envelopes.length !== expectedTypes.size ||
      input.envelopes.some((envelope) => !expectedTypes.delete(envelope.artifact_type)) ||
      expectedTypes.size !== 0
    ) {
      throw new StoreError(
        "artifact.prevalidated_bundle_invalid",
        "prevalidated terminal publication requires the exact report source and derived sidecars",
      );
    }
    const paths = input.envelopes.map((envelope) => envelope.artifact_path);
    if (new Set(paths).size !== paths.length) {
      throw new StoreError("artifact.bundle_duplicate_path", "publication bundle paths overlap", {
        paths,
      });
    }
    for (const envelope of input.envelopes) this.validateEnvelopeBoundary(input.runId, envelope);
    const artifacts: PublishArtifactResult[] = [];
    for (const envelope of [...input.envelopes].sort((left, right) => {
      const rank = publicationRank(left) - publicationRank(right);
      return rank === 0 ? left.artifact_path.localeCompare(right.artifact_path) : rank;
    })) {
      artifacts.push(
        await this.publishPreparedLocked(runRoot, { runId: input.runId, envelope }, true),
      );
      afterPublish?.(envelope);
    }
    return {
      schemaVersion: "startup_opportunity.artifact_bundle_publish_result.v1",
      runId: input.runId,
      status: artifacts.every((artifact) => artifact.status === "idempotent_replay")
        ? "idempotent_replay"
        : "published",
      artifacts,
    };
  }

  async publishLocked(
    runRoot: string,
    input: PublishArtifactInput,
    referencesPrevalidated = false,
    referenceContext: DocumentBundleReferenceContext = {},
    dedicatedPlanRuntimeCloseout = false,
  ): Promise<PublishArtifactResult> {
    if (input.envelope.artifact_type === "startup_opportunity.dispatch_launch_registration.v1") {
      throw new StoreError(
        "artifact.dispatch_launch_registration_entry_required",
        "Dispatch launch registration must use the dedicated atomic registry publisher",
      );
    }
    if (input.envelope.artifact_type === "startup_opportunity.research_handoff.current") {
      throw new StoreError(
        "research_handoff.dedicated_entry_required",
        "research handoffs must use the target-owned exact capture operation",
      );
    }
    if (dedicatedPlanRuntimeCloseout) assertPlanRuntimeCloseoutPublication(input.envelope);
    else assertGenericPublicationMayPublish(input.envelope);
    return this.publishPreparedLocked(runRoot, input, referencesPrevalidated, referenceContext);
  }

  async publishPlanRuntimeCloseoutLocked(
    runRoot: string,
    input: PublishArtifactInput,
    referencesPrevalidated = false,
    referenceContext: DocumentBundleReferenceContext = {},
  ): Promise<PublishArtifactResult> {
    return this.publishLocked(runRoot, input, referencesPrevalidated, referenceContext, true);
  }

  async publishResearchHandoffLocked(
    runRoot: string,
    input: PublishArtifactInput,
    referenceContext: DocumentBundleReferenceContext = {},
    continueCommittedHandoff = false,
  ): Promise<PublishArtifactResult> {
    if (input.envelope.artifact_type !== "startup_opportunity.research_handoff.current") {
      throw new StoreError(
        "research_handoff.type_mismatch",
        "the dedicated research handoff publisher accepts only research handoff Artifacts",
      );
    }
    return this.publishPreparedLocked(
      runRoot,
      input,
      false,
      referenceContext,
      continueCommittedHandoff,
    );
  }

  private async publishPreparedLocked(
    runRoot: string,
    input: PublishArtifactInput,
    referencesPrevalidated = false,
    referenceContext: DocumentBundleReferenceContext = {},
    scopeMutationPrevalidated = false,
  ): Promise<PublishArtifactResult> {
    validateRunId(input.runId);
    await assertRunIsCurrentContinuationLeaf(this.runsRoot, input.runId);
    if (!scopeMutationPrevalidated) {
      await assertScopeAllowsStorageMutationLocked(this.runsRoot, runRoot, input.runId, {
        kind: "artifact",
        artifactTypes: [input.envelope.artifact_type],
      });
    }
    this.validateEnvelopeBoundary(input.runId, input.envelope);
    const computedOperationKey = expectedArtifactOperationKey(input.envelope);
    if (input.operationKey !== undefined && input.operationKey !== computedOperationKey) {
      throw new StoreError(
        "operation.key_mismatch",
        "artifact operation key must match the canonical publication identity",
        { expected: computedOperationKey, actual: input.operationKey },
      );
    }
    const stableOperationKey = computedOperationKey;
    await this.assertNoUncommittedPublishedArtifactsLocked(
      runRoot,
      input.runId,
      stableOperationKey,
    );
    if (!referencesPrevalidated) {
      await this.validateEnvelopeReferences(runRoot, input.envelope, referenceContext);
    }

    const operationHex = sha256Hex(stableOperationKey);
    const receiptPath = `.store/operations/artifact-${operationHex}.json`;
    const receiptFilename = await resolveRunPath(runRoot, receiptPath, { createParents: true });
    let receiptExisted = false;
    let receipt: ArtifactOperationReceipt;
    try {
      const existing = JSON.parse(await readFile(receiptFilename, "utf8")) as unknown;
      receiptExisted = true;
      receipt = validateArtifactReceipt(existing, path.basename(receiptPath), input.runId);
      if (
        receipt.operation_key !== stableOperationKey ||
        canonicalJson(receipt.envelope) !== canonicalJson(input.envelope)
      ) {
        throw new StoreError(
          "write.operation_conflict",
          "operation key was previously used with different content",
          { operationKey: stableOperationKey },
        );
      }
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) {
        throw error;
      }
      receipt = {
        schema_version: ARTIFACT_RECEIPT_SCHEMA_VERSION,
        operation_key: stableOperationKey,
        run_id: input.runId,
        artifact_path: input.envelope.artifact_path,
        artifact_type: input.envelope.artifact_type,
        content_hash: input.envelope.content_hash,
        envelope: input.envelope,
      };
    }

    const target = await resolveRunPath(runRoot, input.envelope.artifact_path, {
      createParents: true,
    });
    try {
      const existing = JSON.parse(await readFile(target, "utf8")) as unknown;
      if (receiptExisted && canonicalJson(existing) === canonicalJson(input.envelope)) {
        await this.appendPublicationCommitLocked(runRoot, input.runId, receipt);
        return {
          schemaVersion: "startup_opportunity.artifact_publish_result.v1",
          runId: input.runId,
          artifactPath: input.envelope.artifact_path,
          contentHash: input.envelope.content_hash,
          operationKey: stableOperationKey,
          status: "idempotent_replay",
        };
      }
      throw new StoreError("write.conflict", "formal artifact path is already occupied", {
        path: input.envelope.artifact_path,
      });
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) {
        throw error;
      }
    }

    if (!receiptExisted) {
      const receiptTemp = `.store/temp/artifact-${operationHex}.receipt.tmp`;
      await writeSyncedTemp(runRoot, receiptTemp, `${canonicalJson(receipt)}\n`);
      await publishTemp(runRoot, receiptTemp, receiptPath);
    }
    assertFault("after_intent", input.faultAt);

    const temporaryPath = `.store/temp/artifact-${operationHex}.publish.tmp`;
    await writeSyncedTemp(runRoot, temporaryPath, `${canonicalJson(input.envelope)}\n`);
    assertFault("after_temp_write", input.faultAt);
    await publishTemp(runRoot, temporaryPath, input.envelope.artifact_path);
    assertFault("after_publish", input.faultAt);
    await this.appendPublicationCommitLocked(runRoot, input.runId, receipt);
    return {
      schemaVersion: "startup_opportunity.artifact_publish_result.v1",
      runId: input.runId,
      artifactPath: input.envelope.artifact_path,
      contentHash: input.envelope.content_hash,
      operationKey: stableOperationKey,
      status: "published",
    };
  }

  private async artifactOperationReceiptsLocked(
    runRoot: string,
    runId: string,
  ): Promise<readonly ArtifactOperationReceipt[]> {
    const operationDirectory = await resolveRunPath(runRoot, ".store/operations", {
      createParents: true,
    });
    const receipts: ArtifactOperationReceipt[] = [];
    for (const entry of (await readdir(operationDirectory)).sort()) {
      if (!entry.startsWith("artifact-") || !entry.endsWith(".json")) continue;
      receipts.push(
        validateArtifactReceipt(
          JSON.parse(
            await readFile(await resolveRunPath(runRoot, `.store/operations/${entry}`), "utf8"),
          ) as unknown,
          entry,
          runId,
        ),
      );
    }
    return receipts;
  }

  private async publicationCommitsLocked(
    runRoot: string,
    runId: string,
    options: { readonly createDirectory?: boolean } = {},
  ): Promise<readonly ArtifactPublicationCommit[]> {
    const createDirectory = options.createDirectory !== false;
    const publicationDirectory = await resolveRunPath(
      runRoot,
      ".store/publications",
      createDirectory ? { createParents: true } : {},
    );
    if (createDirectory) {
      await mkdir(publicationDirectory, { recursive: true });
    }
    const commits: ArtifactPublicationCommit[] = [];
    let entries: readonly string[];
    try {
      entries = (await readdir(publicationDirectory)).sort();
    } catch (error) {
      if (!createDirectory && isNodeError(error, "ENOENT")) {
        return [];
      }
      throw error;
    }
    for (const entry of entries) {
      if (!/^publication-[0-9]{12}-[a-f0-9]{64}\.json$/.test(entry)) {
        throw new StoreError(
          "recovery.invalid_publication_commit",
          "publication ledger contains an unrecognized entry",
          { path: `.store/publications/${entry}` },
        );
      }
      commits.push(
        validateArtifactPublicationCommit(
          JSON.parse(
            await readFile(await resolveRunPath(runRoot, `.store/publications/${entry}`), "utf8"),
          ) as unknown,
          entry,
          runId,
        ),
      );
    }
    commits.sort((left, right) => left.publication_ordinal - right.publication_ordinal);

    const receipts = await this.artifactOperationReceiptsLocked(runRoot, runId);
    const receiptsByOperation = new Map(
      receipts.map((receipt) => [receipt.operation_key, receipt]),
    );
    const seenOperations = new Set<string>();
    const seenPaths = new Set<string>();
    let previousCommitHash: string | null = null;
    for (const [index, commit] of commits.entries()) {
      const receipt = receiptsByOperation.get(commit.operation_key);
      if (
        commit.publication_ordinal !== index + 1 ||
        commit.previous_commit_hash !== previousCommitHash ||
        receipt === undefined ||
        receipt.artifact_path !== commit.artifact_path ||
        receipt.artifact_type !== commit.artifact_type ||
        receipt.content_hash !== commit.content_hash ||
        seenOperations.has(commit.operation_key) ||
        seenPaths.has(commit.artifact_path)
      ) {
        throw new StoreError(
          "recovery.publication_chain_invalid",
          "Artifact publication commits must form one continuous exact operation-bound chain",
          {
            publicationOrdinal: commit.publication_ordinal,
            artifactPath: commit.artifact_path,
          },
        );
      }
      seenOperations.add(commit.operation_key);
      seenPaths.add(commit.artifact_path);
      previousCommitHash = commit.publication_commit_hash;
    }
    return commits;
  }

  private async appendPublicationCommitLocked(
    runRoot: string,
    runId: string,
    receipt: ArtifactOperationReceipt,
  ): Promise<ArtifactPublicationCommit> {
    const commits = await this.publicationCommitsLocked(runRoot, runId);
    const existing = commits.find((commit) => commit.operation_key === receipt.operation_key);
    if (existing !== undefined) {
      if (
        existing.artifact_path !== receipt.artifact_path ||
        existing.artifact_type !== receipt.artifact_type ||
        existing.content_hash !== receipt.content_hash
      ) {
        throw new StoreError(
          "recovery.publication_commit_conflict",
          "Artifact operation is already bound to a different publication commit",
          { operationKey: receipt.operation_key },
        );
      }
      return existing;
    }
    const identity: ArtifactPublicationCommitIdentity = {
      schema_version: ARTIFACT_PUBLICATION_COMMIT_SCHEMA_VERSION,
      run_id: runId,
      publication_ordinal: commits.length + 1,
      previous_commit_hash: commits.at(-1)?.publication_commit_hash ?? null,
      operation_key: receipt.operation_key,
      artifact_path: receipt.artifact_path,
      artifact_type: receipt.artifact_type,
      content_hash: receipt.content_hash,
    };
    const commit: ArtifactPublicationCommit = {
      ...identity,
      publication_commit_hash: canonicalContentHash(identity),
    };
    const targetPath = `.store/publications/${publicationCommitFilename(commit)}`;
    const temporaryPath = `.store/temp/publication-${sha256Hex(
      commit.publication_commit_hash,
    )}.tmp`;
    await writeSyncedTemp(runRoot, temporaryPath, `${canonicalJson(commit)}\n`);
    await publishTemp(runRoot, temporaryPath, targetPath);
    return commit;
  }

  private async bundleAuthorityPreviousPublicationCommitHashLocked(
    runRoot: string,
    runId: string,
    artifactPaths: readonly string[],
  ): Promise<string | null> {
    const artifactPathSet = new Set(artifactPaths);
    const commits = await this.publicationCommitsLocked(runRoot, runId);
    const firstBundleCommit = commits.find((commit) => artifactPathSet.has(commit.artifact_path));
    return (
      firstBundleCommit?.previous_commit_hash ?? commits.at(-1)?.publication_commit_hash ?? null
    );
  }

  private async expectedBundleAuthorityReceiptLocked(
    runRoot: string,
    input: {
      readonly runId: string;
      readonly bundleOperationKey: string;
      readonly envelopes: readonly FormalArtifactEnvelope[];
      readonly authorityKind: ArtifactBundleRecoveryAuthorityKind;
      readonly trustedProspectiveRuntimeAuthorityPaths: Iterable<string>;
    },
  ): Promise<ArtifactBundleAuthorityReceipt> {
    return artifactBundleAuthorityReceipt({
      runId: input.runId,
      bundleOperationKey: input.bundleOperationKey,
      authorityKind: input.authorityKind,
      previousPublicationCommitHash: await this.bundleAuthorityPreviousPublicationCommitHashLocked(
        runRoot,
        input.runId,
        input.envelopes.map((envelope) => envelope.artifact_path),
      ),
      envelopes: input.envelopes,
      trustedProspectiveRuntimeAuthorityPaths: input.trustedProspectiveRuntimeAuthorityPaths,
    });
  }

  private async writeBundleAuthorityReceiptLocked(
    runRoot: string,
    input: {
      readonly runId: string;
      readonly bundleOperationKey: string;
      readonly envelopes: readonly FormalArtifactEnvelope[];
      readonly launchBundle: DispatchLaunchBundleShape | null;
      readonly referenceContext: DocumentBundleReferenceContext;
    },
  ): Promise<void> {
    const requiredAuthorityKind = requiredBundleRecoveryAuthorityKind(
      input.envelopes,
      input.launchBundle,
    );
    if (requiredAuthorityKind === null) return;
    if (
      requiredAuthorityKind === "formal_stage_runtime_projection" &&
      !hasAuthenticatedRuntimeProjectionAuthority(input.referenceContext)
    ) {
      return;
    }
    const authenticatedPaths = runtimeProjectionPublicationAuthorityPaths(input.referenceContext);
    const authority = await this.expectedBundleAuthorityReceiptLocked(runRoot, {
      runId: input.runId,
      bundleOperationKey: input.bundleOperationKey,
      envelopes: input.envelopes,
      authorityKind: requiredAuthorityKind,
      trustedProspectiveRuntimeAuthorityPaths:
        requiredAuthorityKind === "formal_stage_runtime_projection"
          ? input.envelopes
              .filter((envelope) => RUNTIME_PROJECTION_ARTIFACT_TYPES.has(envelope.artifact_type))
              .map((envelope) => envelope.artifact_path)
              .filter((artifactPath) => authenticatedPaths.has(artifactPath))
          : [],
    });
    const authorityPath = artifactBundleAuthorityReceiptPath(input.bundleOperationKey);
    const authorityFile = await resolveRunPath(runRoot, authorityPath, { createParents: true });
    try {
      const existing = JSON.parse(await readFile(authorityFile, "utf8")) as unknown;
      validateArtifactBundleAuthorityReceipt(existing, path.basename(authorityPath), authority);
      return;
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) throw error;
    }
    const authorityTempPath = `.store/temp/authority-bundle-${sha256Hex(
      authority.authority_operation_key,
    )}.tmp`;
    await writeSyncedTemp(runRoot, authorityTempPath, `${canonicalJson(authority)}\n`);
    await publishTemp(runRoot, authorityTempPath, authorityPath);
  }

  private async assertNoUncommittedPublishedArtifactsLocked(
    runRoot: string,
    runId: string,
    allowedOperationKey: string,
  ): Promise<void> {
    const commits = await this.publicationCommitsLocked(runRoot, runId);
    const committedOperations = new Set(commits.map((commit) => commit.operation_key));
    for (const receipt of await this.artifactOperationReceiptsLocked(runRoot, runId)) {
      if (
        committedOperations.has(receipt.operation_key) ||
        receipt.operation_key === allowedOperationKey
      ) {
        continue;
      }
      try {
        const target = JSON.parse(
          await readFile(await resolveRunPath(runRoot, receipt.artifact_path), "utf8"),
        ) as unknown;
        if (canonicalJson(target) !== canonicalJson(receipt.envelope)) {
          throw new StoreError(
            "write.conflict",
            "published artifact differs from its pending operation",
            { path: receipt.artifact_path },
          );
        }
        throw new StoreError(
          "recovery.publication_commit_required",
          "a formally published Artifact must be committed before another publication",
          { path: receipt.artifact_path },
        );
      } catch (error) {
        if (!isNodeError(error, "ENOENT")) throw error;
      }
    }
  }

  private async assertRecoverableBundleReceiptLocked(
    runRoot: string,
    receipt: ArtifactBundleOperationReceipt,
    launchBundle: DispatchLaunchBundleShape | null,
  ): Promise<void> {
    const requiredAuthorityKind = requiredBundleRecoveryAuthorityKind(
      receipt.envelopes,
      launchBundle,
    );
    if (requiredAuthorityKind === null) return;
    const trustedProspectiveRuntimeAuthorityPaths = new Set<string>();

    const authorityPath = artifactBundleAuthorityReceiptPath(receipt.operation_key);
    let authority: ArtifactBundleAuthorityReceipt;
    try {
      const authorityValue = JSON.parse(
        await readFile(await resolveRunPath(runRoot, authorityPath), "utf8"),
      ) as unknown;
      const authorityTrustedPaths =
        isRecord(authorityValue) &&
        Array.isArray(authorityValue.trusted_prospective_runtime_authority_paths)
          ? authorityValue.trusted_prospective_runtime_authority_paths.filter(
              (value): value is string => typeof value === "string",
            )
          : [];
      const expectedAuthority = await this.expectedBundleAuthorityReceiptLocked(runRoot, {
        runId: receipt.run_id,
        bundleOperationKey: receipt.operation_key,
        envelopes: receipt.envelopes,
        authorityKind: requiredAuthorityKind,
        trustedProspectiveRuntimeAuthorityPaths: authorityTrustedPaths,
      });
      authority = validateArtifactBundleAuthorityReceipt(
        authorityValue,
        path.basename(authorityPath),
        expectedAuthority,
      );
      const artifactTypesByPath = new Map(
        receipt.envelopes.map((envelope) => [envelope.artifact_path, envelope.artifact_type]),
      );
      if (
        authority.trusted_prospective_runtime_authority_paths.some((artifactPath) => {
          const artifactType = artifactTypesByPath.get(artifactPath);
          return artifactType === undefined || !RUNTIME_PROJECTION_ARTIFACT_TYPES.has(artifactType);
        })
      ) {
        throw new StoreError(
          "recovery.invalid_bundle_authority",
          "Artifact bundle authority trusted paths must name runtime projection members",
          { operationKey: receipt.operation_key },
        );
      }
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        throw new StoreError(
          "recovery.bundle_authority_missing",
          "pending Artifact bundle recovery requires Store-owned bundle authority",
          {
            operationKey: receipt.operation_key,
            requiredAuthorityKind,
            artifactPaths: receipt.envelopes.map((envelope) => envelope.artifact_path).sort(),
          },
        );
      }
      throw error;
    }
    for (const artifactPath of authority.trusted_prospective_runtime_authority_paths) {
      trustedProspectiveRuntimeAuthorityPaths.add(artifactPath);
    }
    const referenceContext =
      requiredAuthorityKind === "formal_stage_runtime_projection"
        ? withAuthenticatedRuntimeProjectionAuthority({}, trustedProspectiveRuntimeAuthorityPaths)
        : {};
    try {
      await this.validateEnvelopeSetReferences(runRoot, receipt.envelopes, referenceContext);
    } catch (error) {
      if (error instanceof StoreError && error.code === "artifact.reference_invalid") {
        const referenceErrors = Array.isArray(error.details.referenceErrors)
          ? error.details.referenceErrors
          : [];
        throw new StoreError(
          "recovery.reference_invalid",
          "pending Artifact bundle recovery references are invalid",
          {
            ...error.details,
            referenceErrorCodes: referenceErrors.flatMap((issue) =>
              isRecord(issue) && typeof issue.code === "string" ? [issue.code] : [],
            ),
          },
        );
      }
      throw error;
    }
  }

  async recoverLocked(runRoot: string, runId: string): Promise<ArtifactRecoveryResult> {
    const operationDirectory = await resolveRunPath(runRoot, ".store/operations", {
      createParents: true,
    });
    const tempDirectory = await resolveRunPath(runRoot, ".store/temp", { createParents: true });
    const recovered: string[] = [];
    const existingCommits = await this.publicationCommitsLocked(runRoot, runId);
    const committedOperations = new Set(existingCommits.map((commit) => commit.operation_key));
    const bundleReceipts: {
      readonly receipt: ArtifactBundleOperationReceipt;
      readonly launchBundle: DispatchLaunchBundleShape | null;
      readonly planRuntimeCloseoutBundle: boolean;
    }[] = [];
    for (const entry of (await readdir(operationDirectory)).sort()) {
      if (!entry.startsWith("bundle-") || !entry.endsWith(".json")) continue;
      const receipt = validateArtifactBundleReceipt(
        JSON.parse(
          await readFile(await resolveRunPath(runRoot, `.store/operations/${entry}`), "utf8"),
        ) as unknown,
        entry,
        runId,
      );
      for (const envelope of receipt.envelopes) this.validateEnvelopeBoundary(runId, envelope);
      const launchBundle = dispatchLaunchBundleShape(receipt.envelopes);
      const hasPlanRuntimeCloseout = receipt.envelopes.some(isPlanRuntimeOwnedCloseoutEnvelope);
      const planRuntimeCloseoutBundle = isPlanRuntimeCloseoutBundle(receipt);
      if (hasPlanRuntimeCloseout && !planRuntimeCloseoutBundle) {
        throw new StoreError(
          "recovery.plan_runtime_closeout_bundle_invalid",
          "PlanRuntime closeout bundle receipts must contain only PlanRuntime-owned closeout Artifacts",
          { path: `.store/operations/${entry}` },
        );
      }
      if (
        launchBundle === null &&
        receipt.envelopes.some(
          (envelope) =>
            envelope.artifact_type === "startup_opportunity.dispatch_launch_registration.v1",
        )
      ) {
        throw new StoreError(
          "recovery.invalid_dispatch_launch_bundle",
          "a launch registration receipt must contain its exact lifecycle-root bundle",
          { path: `.store/operations/${entry}` },
        );
      }
      bundleReceipts.push({ receipt, launchBundle, planRuntimeCloseoutBundle });
    }
    const operations: {
      readonly receiptPath: string;
      readonly receipt: ArtifactOperationReceipt;
      readonly tempPath: string;
      readonly action:
        | "complete"
        | "commit"
        | "recover"
        | "restore"
        | "discard"
        | "defer_plan_runtime_closeout"
        | "ignore_invalid_checkpoint";
    }[] = [];
    for (const entry of (await readdir(operationDirectory)).sort()) {
      if (!entry.startsWith("artifact-") || !entry.endsWith(".json")) {
        continue;
      }
      const receiptPath = `.store/operations/${entry}`;
      const receiptValue = JSON.parse(
        await readFile(await resolveRunPath(runRoot, receiptPath), "utf8"),
      ) as unknown;
      const receipt = validateArtifactReceipt(receiptValue, entry, runId);
      this.validateEnvelopeBoundary(runId, receipt.envelope);
      const planRuntimeCloseout = isPlanRuntimeOwnedCloseoutEnvelope(receipt.envelope);
      const hex = sha256Hex(receipt.operation_key);
      const tempPath = `.store/temp/artifact-${hex}.publish.tmp`;
      const target = await resolveRunPath(runRoot, receipt.artifact_path, { createParents: true });
      try {
        const current = JSON.parse(await readFile(target, "utf8")) as unknown;
        if (canonicalJson(current) !== canonicalJson(receipt.envelope)) {
          if (receipt.artifact_path.startsWith("checkpoints/")) {
            operations.push({
              receiptPath,
              receipt,
              tempPath,
              action: committedOperations.has(receipt.operation_key)
                ? "ignore_invalid_checkpoint"
                : "discard",
            });
            continue;
          }
          throw new StoreError("write.conflict", "published artifact differs from operation", {
            path: receipt.artifact_path,
          });
        }
        operations.push({
          receiptPath,
          receipt,
          tempPath,
          action: committedOperations.has(receipt.operation_key)
            ? "complete"
            : planRuntimeCloseout
              ? "defer_plan_runtime_closeout"
              : "commit",
        });
        continue;
      } catch (error) {
        if (!isNodeError(error, "ENOENT")) {
          throw error;
        }
      }
      try {
        const temporary = JSON.parse(
          await readFile(await resolveRunPath(runRoot, tempPath), "utf8"),
        ) as unknown;
        if (canonicalJson(temporary) !== canonicalJson(receipt.envelope)) {
          throw new StoreError("write.temp_conflict", "temporary artifact differs from operation", {
            path: tempPath,
          });
        }
        operations.push({
          receiptPath,
          receipt,
          tempPath,
          action: planRuntimeCloseout ? "defer_plan_runtime_closeout" : "recover",
        });
      } catch (error) {
        if (!isNodeError(error, "ENOENT")) {
          throw error;
        }
        operations.push({
          receiptPath,
          receipt,
          tempPath,
          action: committedOperations.has(receipt.operation_key)
            ? planRuntimeCloseout
              ? "defer_plan_runtime_closeout"
              : "restore"
            : planRuntimeCloseout
              ? "defer_plan_runtime_closeout"
              : "discard",
        });
      }
    }

    for (const { receipt, launchBundle, planRuntimeCloseoutBundle } of bundleReceipts) {
      if (planRuntimeCloseoutBundle) continue;
      const preflight = await this.preflightBundleTargetsLocked(
        runRoot,
        { runId, envelopes: receipt.envelopes },
        launchBundle !== null,
      );
      if (preflight.allTargetsExist && preflight.allTargetsCommitted) {
        continue;
      }
      await this.assertRecoverableBundleReceiptLocked(runRoot, receipt, launchBundle);
    }

    const uncommittedPublished = operations.filter((operation) => operation.action === "commit");
    if (uncommittedPublished.length > 1) {
      throw new StoreError(
        "recovery.publication_order_ambiguous",
        "multiple formally published Artifacts lack publication commits",
        { artifactPaths: uncommittedPublished.map((operation) => operation.receipt.artifact_path) },
      );
    }

    // A target that already exists was formally published before any temp-only
    // intent recovered below. Commit that observed order before creating targets.
    for (const operation of uncommittedPublished) {
      await this.appendPublicationCommitLocked(runRoot, runId, operation.receipt);
    }

    for (const operation of operations) {
      if (operation.action === "recover") {
        await publishTemp(runRoot, operation.tempPath, operation.receipt.artifact_path);
        await this.appendPublicationCommitLocked(runRoot, runId, operation.receipt);
        recovered.push(operation.receipt.artifact_path);
      } else if (operation.action === "restore") {
        await writeSyncedTemp(
          runRoot,
          operation.tempPath,
          `${canonicalJson(operation.receipt.envelope)}\n`,
        );
        await publishTemp(runRoot, operation.tempPath, operation.receipt.artifact_path);
        await this.appendPublicationCommitLocked(runRoot, runId, operation.receipt);
        recovered.push(operation.receipt.artifact_path);
      } else if (operation.action === "discard") {
        await rm(await resolveRunPath(runRoot, operation.receiptPath), { force: true });
      }
    }

    const committedRecords = await this.publicationRecordsLocked(runRoot, runId);
    for (const { receipt, launchBundle, planRuntimeCloseoutBundle } of bundleReceipts) {
      if (planRuntimeCloseoutBundle) continue;
      for (const envelope of receipt.envelopes) {
        this.validateEnvelopeBoundary(runId, envelope);
        const target = await resolveRunPath(runRoot, envelope.artifact_path, {
          createParents: true,
        });
        let missing = false;
        try {
          const existing = JSON.parse(await readFile(target, "utf8")) as unknown;
          if (canonicalJson(existing) !== canonicalJson(envelope)) {
            throw new StoreError(
              "write.conflict",
              "published bundle artifact differs from its operation",
              { path: envelope.artifact_path },
            );
          }
          if (committedRecords.get(envelope.artifact_path)?.contentHash !== envelope.content_hash) {
            throw new StoreError(
              "recovery.publication_commit_missing",
              "published bundle artifact lacks its exact publication commit",
              { path: envelope.artifact_path },
            );
          }
        } catch (error) {
          if (!isNodeError(error, "ENOENT")) throw error;
          missing = true;
        }
        if (missing) {
          if (launchBundle !== null) {
            await this.publishPreparedLocked(runRoot, { runId, envelope }, true);
          } else if (envelope.artifact_type === "startup_opportunity.research_handoff.current") {
            await this.publishResearchHandoffLocked(runRoot, { runId, envelope });
          } else {
            await this.publishLocked(runRoot, { runId, envelope }, true);
          }
          recovered.push(envelope.artifact_path);
        }
      }
    }

    const removedTemps: string[] = [];
    for (const entry of (await readdir(tempDirectory)).sort()) {
      if (entry.startsWith("artifact-") || entry.startsWith("publication-")) {
        await removeTemp(runRoot, `.store/temp/${entry}`);
        removedTemps.push(`.store/temp/${entry}`);
      }
    }
    return {
      recoveredArtifactPaths: [...new Set(recovered)].sort(),
      removedTemporaryPaths: removedTemps.sort(),
    };
  }

  async publicationRecordsLocked(
    runRoot: string,
    runId: string,
  ): Promise<ReadonlyMap<string, ArtifactPublicationRecord>> {
    return this.readPublicationRecordsLocked(runRoot, runId);
  }

  private async readPublicationRecordsLocked(
    runRoot: string,
    runId: string,
    options: { readonly createDirectory?: boolean } = {},
  ): Promise<ReadonlyMap<string, ArtifactPublicationRecord>> {
    const records = new Map<string, ArtifactPublicationRecord>();
    for (const commit of await this.publicationCommitsLocked(runRoot, runId, options)) {
      records.set(commit.artifact_path, {
        publicationOrdinal: commit.publication_ordinal,
        contentHash: commit.content_hash,
        publicationCommitHash: commit.publication_commit_hash,
      });
    }
    return new Map([...records.entries()].sort(([left], [right]) => left.localeCompare(right)));
  }

  async publicationLedgerLocked(
    runRoot: string,
    runId: string,
  ): Promise<readonly ArtifactPublicationLedgerEntry[]> {
    const receipts = await this.artifactOperationReceiptsLocked(runRoot, runId);
    const receiptsByOperation = new Map(
      receipts.map((receipt) => [receipt.operation_key, receipt]),
    );
    return (await this.publicationCommitsLocked(runRoot, runId)).map((commit) => {
      const receipt = receiptsByOperation.get(commit.operation_key);
      if (
        receipt === undefined ||
        receipt.artifact_path !== commit.artifact_path ||
        receipt.artifact_type !== commit.artifact_type ||
        receipt.content_hash !== commit.content_hash
      ) {
        throw new StoreError(
          "recovery.publication_chain_invalid",
          "Artifact publication commit must resolve its exact immutable operation receipt",
          {
            publicationOrdinal: commit.publication_ordinal,
            artifactPath: commit.artifact_path,
          },
        );
      }
      return {
        publicationOrdinal: commit.publication_ordinal,
        publicationCommitHash: commit.publication_commit_hash,
        artifactPath: commit.artifact_path,
        artifactType: commit.artifact_type,
        contentHash: commit.content_hash,
        envelope: receipt.envelope,
      };
    });
  }

  async listFormalDocuments(runRoot: string): Promise<readonly DocumentBundleEntry[]> {
    const documents: DocumentBundleEntry[] = [];
    for (const relativePath of await listFiles(runRoot)) {
      if (!relativePath.endsWith(".json") || relativePath === "manifest.json") {
        continue;
      }
      let value: unknown;
      try {
        value = JSON.parse(
          await readFile(await resolveRunPath(runRoot, relativePath), "utf8"),
        ) as unknown;
      } catch {
        documents.push({
          path: relativePath,
          document: { schema_version: "startup_opportunity.corrupt_stored_json.v1" },
        });
        continue;
      }
      if (isEnvelope(value)) {
        documents.push({ path: relativePath, document: value });
      } else if (isRecord(value)) {
        documents.push({ path: relativePath, document: value });
      }
    }
    return documents.sort((left, right) => left.path.localeCompare(right.path));
  }

  validateEnvelopeVersionBoundary(schemaVersion: unknown): void {
    this.validator.publicationPolicy.assertCurrentEnvelope(schemaVersion);
  }

  validateEnvelopeBoundary(runId: string, envelope: FormalArtifactEnvelope): void {
    this.validateEnvelopeVersionBoundary(envelope.schema_version);
    const computedHash = canonicalContentHash(envelope.document);
    if (computedHash !== envelope.content_hash) {
      throw new StoreError(
        "artifact.hash_mismatch",
        "content hash does not match canonical document",
        {
          expected: computedHash,
          actual: envelope.content_hash,
        },
      );
    }
    const result = this.validator.validateDocument(envelope, envelope.artifact_path);
    if (!result.valid) {
      throw new StoreError("artifact.schema_invalid", "formal artifact envelope is invalid", {
        errors: result.errors,
      });
    }
    validateRelativePath(envelope.artifact_path);
    if (!isFormalTargetAllowed(envelope.artifact_path)) {
      throw new StoreError("path.reserved", "formal artifact path is reserved for Store state", {
        path: envelope.artifact_path,
      });
    }
    if (envelope.run_id !== runId || envelope.document.run_id !== runId) {
      throw new StoreError("reference.run_mismatch", "artifact belongs to a different Run", {
        runId,
        envelopeRunId: envelope.run_id,
        documentRunId: envelope.document.run_id,
      });
    }
  }

  async validateStoredEnvelope(
    runRoot: string,
    runId: string,
    envelope: FormalArtifactEnvelope,
  ): Promise<void> {
    this.validateEnvelopeBoundary(runId, envelope);
    for (const ref of collectPathRefs(envelope)) {
      if (ref.startsWith("evidence/manifest.jsonl#")) {
        await this.evidence.readExactRecordLocked(runRoot, runId, ref);
      } else {
        await assertReferenceExists(runRoot, ref, envelope, this.logs);
      }
    }
  }

  private async validateEnvelopeReferences(
    runRoot: string,
    envelope: FormalArtifactEnvelope,
    referenceContext: DocumentBundleReferenceContext = {},
  ): Promise<void> {
    await this.validateEnvelopeSetReferences(runRoot, [envelope], referenceContext);
  }

  private async validateEnvelopeSetReferences(
    runRoot: string,
    envelopes: readonly FormalArtifactEnvelope[],
    referenceContext: DocumentBundleReferenceContext = {},
  ): Promise<void> {
    const artifactPublicationRecords = await this.readPublicationRecordsLocked(
      runRoot,
      envelopes[0]?.run_id ?? "",
      { createDirectory: false },
    );
    const publicationReferenceContext = publicationRuntimeProjectionReferenceContext({
      ...referenceContext,
      artifactPublicationRecords,
    });
    const pendingByPath = new Map(envelopes.map((envelope) => [envelope.artifact_path, envelope]));
    for (const envelope of envelopes) {
      for (const ref of collectPathRefs(envelope)) {
        const parsed = validateArtifactRef(ref);
        const pending = pendingByPath.get(parsed.path);
        if (pending === undefined) {
          if (parsed.path === "evidence/manifest.jsonl") {
            await this.evidence.readExactRecordLocked(runRoot, envelope.run_id, ref);
          } else {
            await assertReferenceExists(runRoot, ref, envelope, this.logs);
          }
        } else if (
          parsed.fragment !== null &&
          !storedArtifactFragmentExists(pending, parsed.fragment)
        ) {
          throw new StoreError(
            "reference.fragment_missing",
            "pending publication bundle fragment is missing",
            { ref },
          );
        }
      }
    }
    const storedDocuments = [...(await this.listFormalDocuments(runRoot))];
    let documents = storedDocuments;
    try {
      const manifest =
        referenceContext.prospectiveManifest ??
        (JSON.parse(
          await readFile(await resolveRunPath(runRoot, "manifest.json"), "utf8"),
        ) as Record<string, unknown>);
      const currentArtifactRefs = new Set(
        Array.isArray(manifest.artifact_refs)
          ? manifest.artifact_refs.filter((ref): ref is string => typeof ref === "string")
          : [],
      );
      for (const ref of artifactRefsForDocument({ path: "manifest.json", document: manifest })) {
        currentArtifactRefs.add(ref.split("#", 1)[0] ?? ref);
      }
      documents = storedDocuments.filter((entry) => currentArtifactRefs.has(entry.path));
      documents.push({ path: "manifest.json", document: manifest });
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) {
        throw error;
      }
    }
    for (const envelope of envelopes) {
      const existingIndex = documents.findIndex((entry) => entry.path === envelope.artifact_path);
      if (existingIndex >= 0) {
        documents.splice(existingIndex, 1);
      }
      documents.push({ path: envelope.artifact_path, document: envelope });
    }
    const typedJsonlRefs = documents
      .flatMap((entry) => artifactRefsForDocument(entry))
      .filter((ref) => {
        const target = ref.split("#", 1)[0];
        return target === "events.jsonl" || target === "decisions.jsonl";
      });
    const exactJsonlRecords = new Map<string, Record<string, unknown>>();
    for (const ref of [...new Set(typedJsonlRefs)].sort()) {
      const parsed = validateArtifactRef(ref);
      if (parsed.path !== "events.jsonl" && parsed.path !== "decisions.jsonl") {
        throw new StoreError("reference.type_mismatch", "typed JSONL ref targets another path", {
          ref,
        });
      }
      exactJsonlRecords.set(
        ref,
        await this.logs.readExactRecord(runRoot, envelopes[0]?.run_id ?? "", ref, parsed.path),
      );
    }
    for (const decision of await this.logs.listValidatedRecords(
      runRoot,
      envelopes[0]?.run_id ?? "",
      "decisions.jsonl",
    )) {
      if (
        decision.decision_type === "prior_input_admitted" ||
        decision.decision_type === "prior_input_consumed" ||
        decision.decision_type === "research_handoff_consumed" ||
        decision.decision_type === "subject_reformed"
      ) {
        exactJsonlRecords.set(`decisions.jsonl#${String(decision.decision_id)}`, decision);
      }
    }
    for (const record of await this.evidence.listRecordsLocked(
      runRoot,
      envelopes[0]?.run_id ?? "",
    )) {
      if (record.schema_version === "startup_opportunity.evidence_store_record.v2") {
        const handoffBinding = isRecord(record.handoff_binding) ? record.handoff_binding : null;
        if (
          typeof handoffBinding?.handoff_ref === "string" &&
          !documents.some((entry) => entry.path === handoffBinding.handoff_ref)
        ) {
          continue;
        }
        exactJsonlRecords.set(`evidence/manifest.jsonl#${record.evidence_id}`, record);
      }
    }
    const bundleResult = this.validator.validateDocumentBundle(
      {
        schema_version: DOCUMENT_BUNDLE_SCHEMA_VERSION,
        documents,
        exact_records: [],
      },
      {
        ...publicationReferenceContext,
        exactJsonlRecords,
        artifactPublicationRecords,
      },
    );
    if (!bundleResult.valid) {
      throw new StoreError("artifact.reference_invalid", "formal artifact references are invalid", {
        bundleErrors: bundleResult.bundleErrors,
        documentErrors: bundleResult.documents.flatMap((document) => document.errors),
        referenceErrors: bundleResult.referenceErrors,
      });
    }
  }
}
