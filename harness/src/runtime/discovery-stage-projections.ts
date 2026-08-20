import { canonicalContentHash, canonicalJson } from "../artifact-store/canonical.js";
import { StoreError } from "../artifact-store/store-error.js";

export interface CompilerReadyArtifact {
  readonly artifact_type: string;
  readonly artifact_path: string;
  readonly producer_role: "main_agent" | "lane_researcher" | "harness";
  readonly input_refs?: readonly string[];
  readonly document: Record<string, unknown>;
}

export interface DiscoveryStageProjectionContext {
  readonly runId: string;
  readonly currentPlanRef: string;
  readonly currentPlan: Record<string, unknown>;
  readonly currentScopeRef: string;
  readonly currentScope: Record<string, unknown>;
  readonly documentsByPath: ReadonlyMap<string, Record<string, unknown>>;
}

export type ExplicitRelationTarget = string | readonly string[];

export interface DiscoveryObjectDeclaration {
  readonly artifact_type?: string;
  readonly artifact_path?: string;
  readonly producer_role?: "main_agent" | "lane_researcher" | "harness";
  readonly document: Record<string, unknown>;
  readonly local_key?: string;
  readonly object_id?: string;
  readonly action?: "create" | "revise";
  readonly local_refs?: Readonly<Record<string, ExplicitRelationTarget>>;
}

export interface DiscoveryMapsPolicyAuthority {
  readonly policyRef: string;
  readonly document: Record<string, unknown>;
}

export type FanInLaneStatus =
  | "completed"
  | "partial"
  | "insufficient_evidence"
  | "failed"
  | "ignored_late"
  | "superseded"
  | "cancelled"
  | "skipped"
  | "missing";

export interface FanInLaneDeclaration {
  readonly unit_id: string;
  readonly status: FanInLaneStatus;
  readonly lane_result_ref?: string;
  readonly delivery_receipt_ref?: string;
  readonly adopted_artifact_refs: readonly string[];
  readonly decision_impact?: string;
}

export interface CandidateFanInAuthority {
  readonly dispatch_ref: string;
  readonly lanes: readonly FanInLaneDeclaration[];
}

interface DraftedArtifact {
  readonly declaration: DiscoveryObjectDeclaration;
  readonly localKey: string;
  readonly id: string;
  readonly type: string;
  readonly path: string;
  readonly document: Record<string, unknown>;
}

const SETUP_TYPES = new Set([
  "startup_opportunity.seed_probe.v1",
  "startup_opportunity.opportunity_space_map.v1",
  "startup_opportunity.solution_space_map.v1",
  "startup_opportunity.discovery_candidate.v1",
]);

const SYNTHESIS_TYPES = new Set([
  "startup_opportunity.discovery_candidate_conversion.v2",
  "startup_opportunity.demand_thesis.v1",
  "startup_opportunity.baseline_option.v1",
  "startup_opportunity.solution_hypothesis.v1",
  "startup_opportunity.solution_evaluation.v1",
  "startup_opportunity.opportunity_thesis.v1",
  "startup_opportunity.thesis_evaluation_snapshot.v1",
  "startup_opportunity.merge.v1",
]);

const IDENTITY_FIELDS: Readonly<Record<string, string>> = {
  "startup_opportunity.seed_probe.v1": "seed_probe_id",
  "startup_opportunity.opportunity_space_map.v1": "map_id",
  "startup_opportunity.solution_space_map.v1": "map_id",
  "startup_opportunity.discovery_candidate.v1": "candidate_id",
  "startup_opportunity.discovery_fan_in.v2": "fan_in_id",
  "startup_opportunity.discovery_candidate_conversion.v2": "conversion_id",
  "startup_opportunity.demand_thesis.v1": "demand_id",
  "startup_opportunity.baseline_option.v1": "baseline_id",
  "startup_opportunity.solution_hypothesis.v1": "solution_id",
  "startup_opportunity.solution_evaluation.v1": "evaluation_id",
  "startup_opportunity.opportunity_thesis.v1": "opportunity_id",
  "startup_opportunity.thesis_evaluation_snapshot.v1": "snapshot_id",
  "startup_opportunity.merge.v1": "merge_id",
};

const PARENT_FIELDS: Readonly<Record<string, string>> = {
  "startup_opportunity.seed_probe.v1": "parent_seed_probe_ref",
  "startup_opportunity.opportunity_space_map.v1": "parent_map_ref",
  "startup_opportunity.solution_space_map.v1": "parent_map_ref",
  "startup_opportunity.discovery_candidate.v1": "parent_candidate_ref",
  "startup_opportunity.discovery_fan_in.v2": "parent_fan_in_ref",
  "startup_opportunity.discovery_candidate_conversion.v2": "parent_conversion_ref",
  "startup_opportunity.demand_thesis.v1": "parent_demand_ref",
  "startup_opportunity.baseline_option.v1": "parent_baseline_ref",
  "startup_opportunity.solution_hypothesis.v1": "parent_solution_ref",
  "startup_opportunity.solution_evaluation.v1": "parent_evaluation_ref",
  "startup_opportunity.opportunity_thesis.v1": "parent_opportunity_ref",
  "startup_opportunity.thesis_evaluation_snapshot.v1": "parent_snapshot_ref",
  "startup_opportunity.merge.v1": "parent_merge_ref",
};

const RELATION_TYPES: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>> = {
  "startup_opportunity.opportunity_space_map.v1": {
    seed_probe_ref: ["startup_opportunity.seed_probe.v1"],
  },
  "startup_opportunity.solution_space_map.v1": {
    seed_probe_ref: ["startup_opportunity.seed_probe.v1"],
    opportunity_space_map_ref: ["startup_opportunity.opportunity_space_map.v1"],
  },
  "startup_opportunity.discovery_candidate.v1": {
    source_map_ref: [
      "startup_opportunity.opportunity_space_map.v1",
      "startup_opportunity.solution_space_map.v1",
    ],
  },
  "startup_opportunity.discovery_fan_in.v2": {
    candidate_ref: ["startup_opportunity.discovery_candidate.v1"],
    source_candidate_refs: ["startup_opportunity.discovery_candidate.v1"],
    diversity_retention_refs: ["startup_opportunity.discovery_candidate.v1"],
    counterfactual_candidate_refs: ["startup_opportunity.discovery_candidate.v1"],
  },
  "startup_opportunity.discovery_candidate_conversion.v2": {
    source_candidate_ref: ["startup_opportunity.discovery_candidate.v1"],
    target_artifact_ref: [
      "startup_opportunity.demand_thesis.v1",
      "startup_opportunity.baseline_option.v1",
      "startup_opportunity.solution_hypothesis.v1",
    ],
    discovery_fan_in_ref: ["startup_opportunity.discovery_fan_in.v2"],
  },
  "startup_opportunity.demand_thesis.v1": {
    source_conversion_ref: ["startup_opportunity.discovery_candidate_conversion.v2"],
    source_candidate_ref: ["startup_opportunity.discovery_candidate.v1"],
    discovery_fan_in_ref: ["startup_opportunity.discovery_fan_in.v2"],
  },
  "startup_opportunity.baseline_option.v1": {
    source_conversion_ref: ["startup_opportunity.discovery_candidate_conversion.v2"],
    source_candidate_ref: ["startup_opportunity.discovery_candidate.v1"],
    demand_thesis_ref: ["startup_opportunity.demand_thesis.v1"],
    discovery_fan_in_ref: ["startup_opportunity.discovery_fan_in.v2"],
  },
  "startup_opportunity.solution_hypothesis.v1": {
    source_conversion_ref: ["startup_opportunity.discovery_candidate_conversion.v2"],
    source_candidate_ref: ["startup_opportunity.discovery_candidate.v1"],
    demand_thesis_ref: ["startup_opportunity.demand_thesis.v1"],
    baseline_option_ref: ["startup_opportunity.baseline_option.v1"],
    discovery_fan_in_ref: ["startup_opportunity.discovery_fan_in.v2"],
  },
  "startup_opportunity.solution_evaluation.v1": {
    demand_thesis_ref: ["startup_opportunity.demand_thesis.v1"],
    baseline_option_ref: ["startup_opportunity.baseline_option.v1"],
    solution_hypothesis_refs: ["startup_opportunity.solution_hypothesis.v1"],
    selected_solution_ref: ["startup_opportunity.solution_hypothesis.v1"],
    alternative_solution_refs: ["startup_opportunity.solution_hypothesis.v1"],
    solution_ref: ["startup_opportunity.solution_hypothesis.v1"],
    discovery_fan_in_ref: ["startup_opportunity.discovery_fan_in.v2"],
  },
  "startup_opportunity.opportunity_thesis.v1": {
    demand_thesis_ref: ["startup_opportunity.demand_thesis.v1"],
    baseline_option_ref: ["startup_opportunity.baseline_option.v1"],
    selected_solution_ref: ["startup_opportunity.solution_hypothesis.v1"],
    alternative_solution_refs: ["startup_opportunity.solution_hypothesis.v1"],
    solution_evaluation_ref: ["startup_opportunity.solution_evaluation.v1"],
    discovery_fan_in_ref: ["startup_opportunity.discovery_fan_in.v2"],
  },
  "startup_opportunity.thesis_evaluation_snapshot.v1": {
    subject_refs: ["startup_opportunity.opportunity_thesis.v1"],
    demand_thesis_refs: ["startup_opportunity.demand_thesis.v1"],
    baseline_option_refs: ["startup_opportunity.baseline_option.v1"],
    solution_hypothesis_refs: ["startup_opportunity.solution_hypothesis.v1"],
    solution_evaluation_refs: ["startup_opportunity.solution_evaluation.v1"],
  },
  "startup_opportunity.merge.v1": {
    source_snapshot_ref: ["startup_opportunity.thesis_evaluation_snapshot.v1"],
    source_thesis_refs: ["startup_opportunity.opportunity_thesis.v1"],
    canonical_opportunity_ref: ["startup_opportunity.opportunity_thesis.v1"],
    member_thesis_refs: ["startup_opportunity.opportunity_thesis.v1"],
    preserved_variants: ["startup_opportunity.opportunity_thesis.v1"],
  },
};

const STATUS_CLASSIFICATION_FIELDS: Readonly<Record<string, string>> = {
  completed: "completed_refs",
  partial: "partial_refs",
  insufficient_evidence: "insufficient_evidence_refs",
  failed: "failed_refs",
  ignored_late: "ignored_late_refs",
  superseded: "superseded_refs",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function records(value: unknown): readonly Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function strings(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function uniqueSorted(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}

function cleanId(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/gu, "-");
}

function objectType(declaration: DiscoveryObjectDeclaration): string {
  const documentType = String(declaration.document.schema_version ?? "");
  if (declaration.artifact_type !== undefined && declaration.artifact_type !== documentType) {
    throw new StoreError(
      "formal_materialization.artifact_type_mismatch",
      "declared artifact_type must match the authored formal schema_version",
      { artifactType: declaration.artifact_type, documentType },
    );
  }
  return declaration.artifact_type ?? documentType;
}

function objectIdentity(type: string, declaration: DiscoveryObjectDeclaration): string {
  const field = IDENTITY_FIELDS[type];
  const authored = field === undefined ? undefined : declaration.document[field];
  const id = declaration.object_id ?? (typeof authored === "string" ? authored : "");
  if (id === "" || field === undefined) {
    throw new StoreError(
      "formal_materialization.semantic_identity_missing",
      "formal object requires an explicit stable object identifier",
      { artifactType: type, identityField: field ?? null },
    );
  }
  if (typeof authored === "string" && authored !== id) {
    throw new StoreError(
      "formal_materialization.semantic_identity_mismatch",
      "object_id must equal the authored formal object identity",
      { artifactType: type, objectId: id, authoredIdentity: authored },
    );
  }
  return id;
}

function defaultPath(type: string, id: string, revision: number): string {
  const clean = cleanId(
    type === "startup_opportunity.discovery_candidate_conversion.v2"
      ? id.replace(/^conversion_/u, "")
      : id,
  );
  const base: Readonly<Record<string, string>> = {
    "startup_opportunity.discovery_candidate.v1": `artifacts/discovery/candidates/${clean}`,
    "startup_opportunity.discovery_fan_in.v2": "artifacts/discovery/fan-in",
    "startup_opportunity.discovery_candidate_conversion.v2": `artifacts/discovery/conversions/${clean}`,
    "startup_opportunity.demand_thesis.v1": `artifacts/discovery/demands/${clean}`,
    "startup_opportunity.baseline_option.v1": `artifacts/discovery/baselines/${clean}`,
    "startup_opportunity.solution_hypothesis.v1": `artifacts/discovery/solutions/${clean}`,
    "startup_opportunity.solution_evaluation.v1": `artifacts/discovery/solution-evaluations/${clean}`,
    "startup_opportunity.opportunity_thesis.v1": `artifacts/discovery/opportunities/${clean}`,
    "startup_opportunity.thesis_evaluation_snapshot.v1": `artifacts/discovery/thesis-snapshots/${clean}`,
    "startup_opportunity.merge.v1": `artifacts/discovery/merges/${clean}`,
  };
  const prefix = base[type];
  if (prefix === undefined) {
    throw new StoreError(
      "formal_materialization.artifact_type_unsupported",
      "unsupported formal object type",
      {
        artifactType: type,
      },
    );
  }
  return `${prefix}.r${String(revision)}.json`;
}

function targetDocument(
  target: string,
  local: ReadonlyMap<string, DraftedArtifact>,
  context: DiscoveryStageProjectionContext,
): { readonly path: string; readonly type: string; readonly document: Record<string, unknown> } {
  const localTarget = local.get(target);
  if (localTarget !== undefined) {
    return { path: localTarget.path, type: localTarget.type, document: localTarget.document };
  }
  const stored = context.documentsByPath.get(target.split("#", 1)[0] ?? target);
  if (stored === undefined) {
    throw new StoreError(
      "formal_materialization.local_ref_dangling",
      "explicit relationship points to no request-local or selected same-Run formal object",
      { target },
    );
  }
  if (stored.run_id !== context.runId) {
    throw new StoreError(
      "formal_materialization.cross_run_ref",
      "formal object relationships must remain within the current Run",
      { target, expectedRunId: context.runId, actualRunId: stored.run_id },
    );
  }
  return { path: target, type: String(stored.schema_version ?? ""), document: stored };
}

function pointerTokens(pointer: string): readonly string[] {
  const normalized = pointer.startsWith("/") ? pointer : `/${pointer}`;
  return normalized
    .slice(1)
    .split("/")
    .map((token) => token.replaceAll("~1", "/").replaceAll("~0", "~"));
}

function setPointer(document: Record<string, unknown>, pointer: string, value: unknown): void {
  const tokens = pointerTokens(pointer);
  if (tokens.length === 0) {
    throw new StoreError(
      "formal_materialization.local_ref_pointer_invalid",
      "explicit relationship requires a non-root JSON Pointer",
      { pointer },
    );
  }
  let current: Record<string, unknown> | unknown[] = document;
  for (const token of tokens.slice(0, -1)) {
    const next: unknown = Array.isArray(current) ? current[Number(token)] : current[token];
    if (!isRecord(next) && !Array.isArray(next)) {
      throw new StoreError(
        "formal_materialization.local_ref_pointer_invalid",
        "explicit relationship JSON Pointer must address an existing object or array",
        { pointer, missingToken: token },
      );
    }
    current = next;
  }
  const leaf = tokens.at(-1) as string;
  if (Array.isArray(current)) {
    const index = Number(leaf);
    if (!Number.isInteger(index) || index < 0 || index >= current.length) {
      throw new StoreError(
        "formal_materialization.local_ref_pointer_invalid",
        "explicit relationship array pointer must address an existing element",
        { pointer },
      );
    }
    current[index] = value;
  } else {
    current[leaf] = value;
  }
}

function pointerLeaf(pointer: string): string {
  return pointerTokens(pointer).at(-1) ?? "";
}

function validateRelationType(sourceType: string, pointer: string, targetType: string): void {
  const leaf = pointerLeaf(pointer);
  const expected = RELATION_TYPES[sourceType]?.[leaf];
  if (expected === undefined) {
    throw new StoreError(
      "formal_materialization.local_ref_relation_unknown",
      "explicit object relationship is not a current-contract relation for this object type",
      { sourceType, pointer, targetType },
    );
  }
  if (!expected.includes(targetType)) {
    throw new StoreError(
      "formal_materialization.local_ref_type_mismatch",
      "explicit object relationship targets an incompatible formal object type",
      { sourceType, pointer, targetType, expectedTypes: expected },
    );
  }
}

function resolvePointerValue(document: Record<string, unknown>, pointer: string): unknown {
  let current: unknown = document;
  for (const token of pointerTokens(pointer)) {
    if (Array.isArray(current)) {
      const index = Number(token);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) return undefined;
      current = current[index];
    } else if (isRecord(current)) {
      current = current[token];
    } else {
      return undefined;
    }
  }
  return current;
}

function parentFor(
  declaration: DiscoveryObjectDeclaration,
  type: string,
  id: string,
  context: DiscoveryStageProjectionContext,
): { readonly path: string; readonly document: Record<string, unknown> } | null {
  if (declaration.action !== "revise") return null;
  const parentTarget = declaration.local_refs?.parent;
  if (typeof parentTarget !== "string") {
    throw new StoreError(
      "formal_materialization.parent_missing",
      "revise requires one explicit current same-Run parent ref",
      { artifactType: type, objectId: id },
    );
  }
  const parentPath = parentTarget.split("#", 1)[0] ?? parentTarget;
  const parent = context.documentsByPath.get(parentPath);
  const identityField = IDENTITY_FIELDS[type];
  if (
    parent === undefined ||
    parent.schema_version !== type ||
    parent.run_id !== context.runId ||
    identityField === undefined ||
    parent[identityField] !== id ||
    !Number.isInteger(parent.revision) ||
    Number(parent.revision) < 1
  ) {
    throw new StoreError(
      "formal_materialization.parent_invalid",
      "revise parent must be the exact same-Run revision of the same typed stable object",
      { artifactType: type, objectId: id, parentRef: parentTarget },
    );
  }
  const newerSelectedRevision = [...context.documentsByPath.entries()].find(
    ([candidatePath, candidate]) =>
      candidatePath !== parentPath &&
      candidate.schema_version === type &&
      candidate.run_id === context.runId &&
      candidate[identityField] === id &&
      Number(candidate.revision) > Number(parent.revision),
  );
  if (
    newerSelectedRevision !== undefined ||
    parentPath !== defaultPath(type, id, Number(parent.revision))
  ) {
    throw new StoreError(
      "formal_materialization.parent_not_current",
      "revise parent must be the current selected immutable revision at its canonical path",
      {
        artifactType: type,
        objectId: id,
        parentRef: parentPath,
        newerSelectedRef: newerSelectedRevision?.[0] ?? null,
      },
    );
  }
  return { path: parentPath, document: parent };
}

function draftObjects(
  declarations: readonly DiscoveryObjectDeclaration[],
  context: DiscoveryStageProjectionContext,
  allowedTypes: ReadonlySet<string>,
  pathOverrides: Readonly<Record<string, string>> = {},
  requireAction = false,
): readonly DraftedArtifact[] {
  const drafted = declarations.map((declaration) => {
    const type = objectType(declaration);
    if (!allowedTypes.has(type)) {
      throw new StoreError(
        "formal_materialization.artifact_type_unsupported",
        "stage declaration contains an unsupported formal object type",
        { artifactType: type },
      );
    }
    if (declaration.producer_role !== undefined && declaration.producer_role !== "main_agent") {
      throw new StoreError(
        "formal_materialization.producer_role_invalid",
        "setup, fan-in, and synthesis research semantics must retain Main Agent authorship",
        { artifactType: type, producerRole: declaration.producer_role },
      );
    }
    if (requireAction && declaration.action === undefined) {
      throw new StoreError(
        "formal_materialization.action_missing",
        "synthesis objects require an explicit create or revise action",
        { artifactType: type },
      );
    }
    if (
      requireAction &&
      (typeof declaration.local_key !== "string" ||
        declaration.local_key.length === 0 ||
        typeof declaration.object_id !== "string" ||
        declaration.object_id.length === 0)
    ) {
      throw new StoreError(
        "formal_materialization.local_identity_missing",
        "synthesis declarations require distinct explicit local_key and stable object_id fields",
        { artifactType: type },
      );
    }
    const id = objectIdentity(type, declaration);
    const localKey = declaration.local_key ?? id;
    const parent = parentFor(declaration, type, id, context);
    if (declaration.action !== "revise" && declaration.local_refs?.parent !== undefined) {
      throw new StoreError(
        "formal_materialization.parent_unexpected",
        "create must not declare a parent revision",
        { artifactType: type, objectId: id },
      );
    }
    const revision = parent === null ? 1 : Number(parent.document.revision) + 1;
    const document = structuredClone(declaration.document);
    const identityField = IDENTITY_FIELDS[type] as string;
    document.schema_version = type;
    document[identityField] = id;
    document.revision = revision;
    document.run_id = context.runId;
    document.research_plan_ref = context.currentPlanRef;
    if (
      "scope_frame_ref" in document ||
      SYNTHESIS_TYPES.has(type) ||
      type === "startup_opportunity.discovery_candidate.v1"
    ) {
      document.scope_frame_ref = context.currentScopeRef;
    }
    const parentField = PARENT_FIELDS[type];
    if (parentField !== undefined) document[parentField] = parent?.path ?? null;
    if ("parent_content_hash" in document || SYNTHESIS_TYPES.has(type)) {
      document.parent_content_hash = parent === null ? null : canonicalContentHash(parent.document);
    }
    const override = pathOverrides[type];
    const basePath = override ?? defaultPath(type, id, revision);
    const artifactPath = basePath.replace(/\.r[1-9][0-9]*\.json$/u, `.r${String(revision)}.json`);
    if (declaration.artifact_path !== undefined && declaration.artifact_path !== artifactPath) {
      throw new StoreError(
        "formal_materialization.artifact_path_mismatch",
        "formal object path is Harness-owned and must equal the deterministic current-contract path",
        {
          artifactType: type,
          objectId: id,
          actual: declaration.artifact_path,
          expected: artifactPath,
        },
      );
    }
    return { declaration, localKey, id, type, path: artifactPath, document };
  });
  const local = new Map<string, DraftedArtifact>();
  for (const entry of drafted) {
    if (local.has(entry.localKey)) {
      throw new StoreError(
        "formal_materialization.local_identity_duplicate",
        "request-local keys must be unique",
        { localKey: entry.localKey },
      );
    }
    local.set(entry.localKey, entry);
  }
  resolveRelations(drafted, local, context);
  return drafted;
}

function resolveRelations(
  drafted: readonly DraftedArtifact[],
  local: ReadonlyMap<string, DraftedArtifact>,
  context: DiscoveryStageProjectionContext,
): void {
  for (const entry of drafted) {
    for (const [pointer, targetValue] of Object.entries(entry.declaration.local_refs ?? {})) {
      if (pointer === "parent" || pointer === "scope_frame") continue;
      const targets = typeof targetValue === "string" ? [targetValue] : targetValue;
      const resolved = targets.map((target) => targetDocument(target, local, context));
      for (const target of resolved) validateRelationType(entry.type, pointer, target.type);
      setPointer(
        entry.document,
        pointer,
        typeof targetValue === "string" ? resolved[0]?.path : resolved.map((target) => target.path),
      );
    }
  }
  for (const entry of drafted) {
    for (const [pointer, targetValue] of Object.entries(entry.declaration.local_refs ?? {})) {
      if (pointer === "parent" || pointer === "scope_frame") continue;
      const targets = typeof targetValue === "string" ? [targetValue] : targetValue;
      const resolved = targets.map((target) => targetDocument(target, local, context));
      const leaf = pointerLeaf(pointer);
      if (typeof targetValue === "string") {
        const target = resolved[0];
        if (target === undefined) continue;
        const hashField = leaf.replace(/_ref$/u, "_content_hash");
        if (hashField in entry.document)
          entry.document[hashField] = canonicalContentHash(target.document);
        if (
          leaf === "source_candidate_ref" &&
          "source_candidate_schema_version" in entry.document
        ) {
          entry.document.source_candidate_schema_version = target.type;
          entry.document.source_candidate_kind = target.document.candidate_kind;
          entry.document.source_candidate_revision = target.document.revision;
          entry.document.source_candidate_content_hash = canonicalContentHash(target.document);
        }
        if (leaf === "target_artifact_ref") {
          entry.document.target_schema_version = target.type;
          entry.document.target_content_hash = canonicalContentHash(target.document);
        }
      }
    }
  }
}

function compilerReady(entries: readonly DraftedArtifact[]): readonly CompilerReadyArtifact[] {
  return entries.map((entry) => ({
    artifact_type: entry.type,
    artifact_path: entry.path,
    producer_role: "main_agent",
    document: entry.document,
  }));
}

function exactInputHashes(
  refs: readonly string[],
  localByPath: ReadonlyMap<string, DraftedArtifact>,
  context: DiscoveryStageProjectionContext,
): readonly Record<string, unknown>[] {
  return uniqueSorted(refs).map((ref) => {
    const targetPath = ref.split("#", 1)[0] ?? ref;
    const local = localByPath.get(targetPath);
    const stored = context.documentsByPath.get(targetPath);
    const document = local?.document ?? stored;
    if (document === undefined) {
      throw new StoreError(
        "formal_materialization.input_ref_dangling",
        "mechanical input hash target is not present in the selected formal closure",
        { ref },
      );
    }
    return { ref, content_hash: canonicalContentHash(document) };
  });
}

export function projectDiscoverySetup(
  declarations: readonly DiscoveryObjectDeclaration[],
  context: DiscoveryStageProjectionContext,
  policy: DiscoveryMapsPolicyAuthority,
): readonly CompilerReadyArtifact[] {
  const artifactPaths = isRecord(policy.document.artifact_paths)
    ? policy.document.artifact_paths
    : {};
  const pathOverrides: Readonly<Record<string, string>> = {
    "startup_opportunity.seed_probe.v1": String(artifactPaths.seed_probe ?? ""),
    "startup_opportunity.opportunity_space_map.v1": String(
      artifactPaths.opportunity_space_map ?? "",
    ),
    "startup_opportunity.solution_space_map.v1": String(artifactPaths.solution_space_map ?? ""),
  };
  if (Object.values(pathOverrides).some((value) => value === "")) {
    throw new StoreError(
      "formal_materialization.discovery_policy_invalid",
      "current Discovery Maps policy does not provide all formal setup paths",
    );
  }
  const counts = new Map<string, number>();
  for (const declaration of declarations) {
    const type = objectType(declaration);
    counts.set(type, (counts.get(type) ?? 0) + 1);
  }
  for (const type of [
    "startup_opportunity.seed_probe.v1",
    "startup_opportunity.opportunity_space_map.v1",
    "startup_opportunity.solution_space_map.v1",
  ]) {
    if (counts.get(type) !== 1) {
      throw new StoreError(
        "formal_materialization.setup_cardinality_invalid",
        "Discovery setup requires exactly one Seed Probe, Opportunity Space Map, and Solution Space Map",
        { artifactType: type, actual: counts.get(type) ?? 0 },
      );
    }
  }
  if ((counts.get("startup_opportunity.discovery_candidate.v1") ?? 0) < 1) {
    throw new StoreError(
      "formal_materialization.setup_cardinality_invalid",
      "Discovery setup requires at least one explicitly authored initial candidate",
    );
  }
  const drafted = draftObjects(declarations, context, SETUP_TYPES, pathOverrides);
  const localByPath = new Map(drafted.map((entry) => [entry.path, entry]));
  const policyBinding = {
    policy_ref: policy.policyRef,
    policy_schema_version: policy.document.schema_version,
    policy_version: policy.document.policy_version,
    content_hash: canonicalContentHash(policy.document),
  };
  for (const entry of drafted) {
    entry.document.mode = context.currentPlan.mode;
    entry.document.scope_frame_ref = context.currentScopeRef;
    entry.document.research_plan_ref = context.currentPlanRef;
    if (entry.type === "startup_opportunity.discovery_candidate.v1") {
      entry.document.phase = "discovery";
      entry.document.owner_slice = "G2.2";
      entry.document.discovery_profile = context.currentScope.discovery_profile;
      entry.document.market = context.currentScope.market;
      entry.document.language = context.currentScope.language;
      continue;
    }
    entry.document.policy_binding = policyBinding;
  }
  for (const type of [
    "startup_opportunity.seed_probe.v1",
    "startup_opportunity.opportunity_space_map.v1",
    "startup_opportunity.solution_space_map.v1",
  ]) {
    const entry = drafted.find((candidate) => candidate.type === type) as DraftedArtifact;
    const refs =
      entry.type === "startup_opportunity.seed_probe.v1"
        ? [context.currentScopeRef, context.currentPlanRef]
        : entry.type === "startup_opportunity.opportunity_space_map.v1"
          ? [context.currentScopeRef, String(entry.document.seed_probe_ref), context.currentPlanRef]
          : [
              context.currentScopeRef,
              String(entry.document.seed_probe_ref),
              String(entry.document.opportunity_space_map_ref),
              context.currentPlanRef,
            ];
    entry.document.input_artifact_hashes = exactInputHashes(refs, localByPath, context);
  }
  for (const entry of drafted.filter(
    (candidate) => candidate.type === "startup_opportunity.discovery_candidate.v1",
  )) {
    const lineage = isRecord(entry.document.map_lineage) ? entry.document.map_lineage : null;
    const sourceMapRef =
      typeof lineage?.source_map_ref === "string" ? lineage.source_map_ref : null;
    const sourceMap = sourceMapRef === null ? undefined : localByPath.get(sourceMapRef)?.document;
    const fragmentPointer =
      typeof lineage?.fragment_pointer === "string" ? lineage.fragment_pointer : null;
    const fragment =
      sourceMap === undefined || fragmentPointer === null
        ? undefined
        : resolvePointerValue(sourceMap, fragmentPointer);
    const idField =
      entry.document.candidate_kind === "solution_seed" ? "candidate_id" : "hypothesis_id";
    if (
      lineage === null ||
      sourceMapRef === null ||
      sourceMap === undefined ||
      fragmentPointer === null ||
      !isRecord(fragment) ||
      typeof fragment[idField] !== "string"
    ) {
      continue;
    }
    lineage.source_map_schema_version = sourceMap.schema_version;
    lineage.source_map_id = sourceMap.map_id;
    lineage.source_map_revision = sourceMap.revision;
    lineage.source_map_content_hash = canonicalContentHash(sourceMap);
    lineage.fragment_ref = `${sourceMapRef}#${String(fragment[idField])}`;
    lineage.fragment_id = fragment[idField];
    lineage.fragment_content_hash = canonicalContentHash(fragment);
    lineage.fragment_status = fragment.status;
    const formation = isRecord(entry.document.formation) ? entry.document.formation : null;
    if (formation === null) continue;
    formation.current_run_scope_and_plan_used = true;
    formation.scope_frame_hash = canonicalContentHash(context.currentScope);
    formation.research_plan_hash = canonicalContentHash(context.currentPlan);
    const declaredInputs = records(formation.synthesis_input_hashes)
      .map((binding) => binding.ref)
      .filter((ref): ref is string => typeof ref === "string");
    formation.synthesis_input_hashes = exactInputHashes(
      declaredInputs.length === 0 ? [sourceMapRef] : declaredInputs,
      localByPath,
      context,
    );
  }
  return compilerReady(drafted);
}

function oneDocument(
  context: DiscoveryStageProjectionContext,
  path: string,
  type: string,
  code: string,
): Record<string, unknown> {
  const document = context.documentsByPath.get(path.split("#", 1)[0] ?? path);
  if (document?.schema_version !== type || document.run_id !== context.runId) {
    throw new StoreError(
      code,
      "formal authority ref does not resolve to the expected same-Run type",
      {
        ref: path,
        expectedType: type,
        actualType: document?.schema_version ?? null,
      },
    );
  }
  return document;
}

function verifyDeliveredArtifact(
  receipt: Record<string, unknown>,
  artifactRef: string,
  context: DiscoveryStageProjectionContext,
): Record<string, unknown> {
  const delivered = records(receipt.delivered_artifacts).filter(
    (entry) => entry.artifact_ref === artifactRef,
  );
  const target = context.documentsByPath.get(artifactRef.split("#", 1)[0] ?? artifactRef);
  if (
    delivered.length !== 1 ||
    target === undefined ||
    delivered[0]?.artifact_type !== target.schema_version ||
    delivered[0]?.content_hash !== canonicalContentHash(target)
  ) {
    throw new StoreError(
      "formal_materialization.fan_in_delivery_mismatch",
      "adopted formal material must be an exact Artifact delivered by that Lane receipt",
      { artifactRef },
    );
  }
  return target;
}

export function projectFanInLaneClassification(
  lanes: readonly FanInLaneDeclaration[],
): Record<string, readonly unknown[]> {
  const classification: Record<string, readonly unknown[]> = {
    completed_refs: [],
    partial_refs: [],
    insufficient_evidence_refs: [],
    failed_refs: [],
    ignored_late_refs: [],
    superseded_refs: [],
    cancelled_units: [],
    skipped_units: [],
    missing_units: [],
  };
  for (const lane of lanes) {
    const resultField = STATUS_CLASSIFICATION_FIELDS[lane.status];
    if (resultField !== undefined) {
      classification[resultField] = [
        ...(classification[resultField] ?? []),
        lane.lane_result_ref as string,
      ];
      continue;
    }
    classification[`${lane.status}_units`] = [
      ...(classification[`${lane.status}_units`] ?? []),
      { unit_id: lane.unit_id, decision_impact: lane.decision_impact },
    ];
  }
  return classification;
}

export function projectedLocalRefsMatch(
  declarations: readonly DiscoveryObjectDeclaration[],
  plannedArtifacts: readonly Pick<
    CompilerReadyArtifact,
    "artifact_type" | "artifact_path" | "document"
  >[],
): boolean {
  const plannedByDeclaration = new Map<
    DiscoveryObjectDeclaration,
    Pick<CompilerReadyArtifact, "artifact_type" | "artifact_path" | "document">
  >();
  const localPaths = new Map<string, string>();
  for (const declaration of declarations) {
    const type = objectType(declaration);
    const id = objectIdentity(type, declaration);
    const identityField = IDENTITY_FIELDS[type];
    const matches = plannedArtifacts.filter(
      (artifact) =>
        artifact.artifact_type === type &&
        identityField !== undefined &&
        artifact.document[identityField] === id,
    );
    if (matches.length !== 1) return false;
    const planned = matches[0] as (typeof matches)[number];
    plannedByDeclaration.set(declaration, planned);
    localPaths.set(declaration.local_key ?? id, planned.artifact_path);
  }

  const resolvedTarget = (target: string): string => localPaths.get(target) ?? target;
  for (const declaration of declarations) {
    const planned = plannedByDeclaration.get(declaration);
    if (planned === undefined) return false;
    const type = objectType(declaration);
    for (const [pointer, targetValue] of Object.entries(declaration.local_refs ?? {})) {
      const expected =
        typeof targetValue === "string"
          ? resolvedTarget(targetValue)
          : targetValue.map(resolvedTarget);
      const actual =
        pointer === "parent"
          ? planned.document[PARENT_FIELDS[type] ?? ""]
          : pointer === "scope_frame"
            ? planned.document.scope_frame_ref
            : resolvePointerValue(planned.document, pointer);
      if (canonicalJson(actual) !== canonicalJson(expected)) return false;
    }
  }
  return true;
}

function dispositionRefs(
  fanIn: Record<string, unknown>,
  disposition: "retained" | "watchlist" | "rejected",
): readonly string[] {
  return uniqueSorted(
    records(fanIn.candidate_dispositions).flatMap((entry) =>
      entry.disposition === disposition && typeof entry.candidate_ref === "string"
        ? [entry.candidate_ref]
        : [],
    ),
  );
}

export function projectCandidateFanIn(
  declarations: readonly DiscoveryObjectDeclaration[],
  authority: CandidateFanInAuthority,
  context: DiscoveryStageProjectionContext,
): readonly CompilerReadyArtifact[] {
  const dispatch = oneDocument(
    context,
    authority.dispatch_ref,
    "startup_opportunity.dispatch_batch.discovery.current",
    "formal_materialization.fan_in_dispatch_invalid",
  );
  if (
    dispatch.research_plan_ref !== context.currentPlanRef ||
    dispatch.mode !== context.currentPlan.mode
  ) {
    throw new StoreError(
      "formal_materialization.fan_in_dispatch_stale",
      "fan-in Dispatch must bind the current Plan and mode",
      { dispatchRef: authority.dispatch_ref },
    );
  }
  const dispatchTasks = records(dispatch.tasks);
  const dispatchUnits = dispatchTasks.map((task) => String(task.unit_id));
  const declaredUnits = authority.lanes.map((lane) => lane.unit_id);
  if (
    new Set(dispatchUnits).size !== dispatchUnits.length ||
    new Set(declaredUnits).size !== declaredUnits.length ||
    canonicalJson([...dispatchUnits].sort()) !== canonicalJson([...declaredUnits].sort())
  ) {
    throw new StoreError(
      "formal_materialization.fan_in_lane_set_mismatch",
      "caller Lane dispositions must cover the exact authoritative Dispatch Lane set once",
      { dispatchUnits: [...dispatchUnits].sort(), declaredUnits: [...declaredUnits].sort() },
    );
  }
  const orderedLanes = dispatchUnits.map(
    (unitId) => authority.lanes.find((lane) => lane.unit_id === unitId) as FanInLaneDeclaration,
  );
  const seenResultRefs = new Set<string>();
  const seenReceiptRefs = new Set<string>();
  for (const lane of orderedLanes) {
    const dispatchTask = dispatchTasks.find((task) => task.unit_id === lane.unit_id);
    if (dispatchTask === undefined) continue;
    const resultStatus = STATUS_CLASSIFICATION_FIELDS[lane.status] !== undefined;
    if (!resultStatus) {
      if (
        lane.lane_result_ref !== undefined ||
        lane.delivery_receipt_ref !== undefined ||
        lane.adopted_artifact_refs.length > 0 ||
        typeof lane.decision_impact !== "string" ||
        lane.decision_impact.length === 0 ||
        (lane.status === "missing" &&
          isRecord(dispatchTask.straggler_policy) &&
          dispatchTask.straggler_policy.blocks_stage === true)
      ) {
        throw new StoreError(
          "formal_materialization.fan_in_straggler_invalid",
          "non-delivery disposition must be explicit, carry decision impact, and obey the Dispatch straggler policy",
          { unitId: lane.unit_id, status: lane.status },
        );
      }
      continue;
    }
    if (
      lane.lane_result_ref === undefined ||
      lane.delivery_receipt_ref === undefined ||
      seenResultRefs.has(lane.lane_result_ref) ||
      seenReceiptRefs.has(lane.delivery_receipt_ref)
    ) {
      throw new StoreError(
        "formal_materialization.fan_in_lane_authority_invalid",
        "each delivered Dispatch Lane requires one unique canonical Lane Result and delivery receipt ref",
        { unitId: lane.unit_id },
      );
    }
    seenResultRefs.add(lane.lane_result_ref);
    seenReceiptRefs.add(lane.delivery_receipt_ref);
    const laneResult = oneDocument(
      context,
      lane.lane_result_ref,
      "startup_opportunity.discovery_lane_result.v1",
      "formal_materialization.fan_in_lane_result_invalid",
    );
    const receipt = oneDocument(
      context,
      lane.delivery_receipt_ref,
      "startup_opportunity.lane_delivery_receipt.current",
      "formal_materialization.fan_in_receipt_invalid",
    );
    const taskRef = String(receipt.task_ref ?? "");
    const task = oneDocument(
      context,
      taskRef,
      "startup_opportunity.research_task.discovery_candidate.current",
      "formal_materialization.fan_in_task_invalid",
    );
    const expectedDispatchTaskRef = `${authority.dispatch_ref}#${String(dispatchTask.task_id)}`;
    if (
      task.task_id !== dispatchTask.task_id ||
      task.unit_id !== lane.unit_id ||
      task.run_id !== context.runId ||
      task.research_plan_ref !== context.currentPlanRef ||
      task.allowed_output_path !== lane.lane_result_ref ||
      task.required_artifact_schema !== "startup_opportunity.discovery_lane_result.v1" ||
      laneResult.task_ref !== taskRef ||
      laneResult.unit_id !== lane.unit_id ||
      laneResult.attempt !== task.attempt ||
      laneResult.status !== lane.status ||
      receipt.dispatch_task_ref !== expectedDispatchTaskRef ||
      receipt.research_plan_ref !== context.currentPlanRef ||
      receipt.execution_plan_ref !== dispatch.execution_plan_ref
    ) {
      throw new StoreError(
        "formal_materialization.fan_in_lane_binding_mismatch",
        "Dispatch, Task, Lane Result, and delivery receipt bindings must agree exactly",
        { unitId: lane.unit_id, taskRef, expectedDispatchTaskRef },
      );
    }
    verifyDeliveredArtifact(receipt, lane.lane_result_ref, context);
    for (const adoptedRef of lane.adopted_artifact_refs) {
      verifyDeliveredArtifact(receipt, adoptedRef, context);
    }
  }

  const fanInDeclarations = declarations.filter(
    (entry) => objectType(entry) === "startup_opportunity.discovery_fan_in.v2",
  );
  const candidateDeclarations = declarations.filter(
    (entry) => objectType(entry) === "startup_opportunity.discovery_candidate.v1",
  );
  if (
    fanInDeclarations.length !== 1 ||
    declarations.length !== fanInDeclarations.length + candidateDeclarations.length
  ) {
    throw new StoreError(
      "formal_materialization.fan_in_artifact_set_invalid",
      "candidate fan-in accepts one authored Fan-in and zero or more explicit Candidate revisions",
    );
  }
  const allowed = new Set([
    "startup_opportunity.discovery_candidate.v1",
    "startup_opportunity.discovery_fan_in.v2",
  ]);
  const drafted = draftObjects(declarations, context, allowed, {}, true);
  const fanIn = drafted.find((entry) => entry.type === "startup_opportunity.discovery_fan_in.v2");
  if (fanIn === undefined || fanIn.document.revision !== 1) {
    throw new StoreError(
      "formal_materialization.fan_in_revision_invalid",
      "current Discovery Fan-in contract accepts one initial immutable Fan-in revision",
    );
  }
  fanIn.document.mode = context.currentPlan.mode;
  fanIn.document.phase = "discovery";
  fanIn.document.owner_role = "main_agent";
  fanIn.document.scope_frame_ref = context.currentScopeRef;
  fanIn.document.research_plan_ref = context.currentPlanRef;
  fanIn.document.lane_result_classification = projectFanInLaneClassification(orderedLanes);
  fanIn.document.retained_candidate_refs = dispositionRefs(fanIn.document, "retained");
  fanIn.document.watchlist_candidate_refs = dispositionRefs(fanIn.document, "watchlist");
  fanIn.document.rejected_candidate_refs = dispositionRefs(fanIn.document, "rejected");
  fanIn.document.judgment_assessment_refs = uniqueSorted(
    records(fanIn.document.candidate_dispositions).flatMap((entry) =>
      strings(entry.judgment_assessment_refs),
    ),
  );
  fanIn.document.reference_only = true;
  fanIn.document.solution_evaluation_required = true;
  fanIn.document.manifest_projection = {
    status_projection_required: true,
    late_or_superseded_can_enter_current_refs: false,
  };
  const laneResultRefs = new Set(
    orderedLanes.flatMap((lane) =>
      lane.lane_result_ref === undefined ? [] : [lane.lane_result_ref],
    ),
  );
  const adoptedRefs = new Set(orderedLanes.flatMap((lane) => lane.adopted_artifact_refs));
  const requestLocalPaths = new Set(drafted.map((entry) => entry.path));
  for (const disposition of records(fanIn.document.candidate_dispositions)) {
    const invalidLaneRefs = strings(disposition.supporting_lane_result_refs).filter(
      (ref) => !laneResultRefs.has(ref),
    );
    const sourceCandidateRefs = strings(disposition.source_candidate_refs);
    const laneCandidateRefs = strings(disposition.supporting_lane_result_refs).flatMap((ref) =>
      records(context.documentsByPath.get(ref.split("#", 1)[0] ?? ref)?.pre_kill_decisions).flatMap(
        (decision) => (typeof decision.candidate_ref === "string" ? [decision.candidate_ref] : []),
      ),
    );
    const invalidSourceCandidateRefs = sourceCandidateRefs.filter((ref) => {
      const candidate = context.documentsByPath.get(ref.split("#", 1)[0] ?? ref);
      return (
        candidate?.schema_version !== "startup_opportunity.discovery_candidate.v1" ||
        candidate.run_id !== context.runId ||
        !laneCandidateRefs.includes(ref)
      );
    });
    const unadoptedArtifactRefs = strings(disposition.judgment_assessment_refs).filter(
      (ref) => !requestLocalPaths.has(ref) && !adoptedRefs.has(ref),
    );
    if (
      invalidLaneRefs.length > 0 ||
      invalidSourceCandidateRefs.length > 0 ||
      unadoptedArtifactRefs.length > 0
    ) {
      throw new StoreError(
        "formal_materialization.fan_in_adoption_mismatch",
        "candidate sources must be current same-Run formal Candidates named by an adopted Lane decision, while Lane-authored disposition material must be delivered by that Lane",
        { invalidLaneRefs, invalidSourceCandidateRefs, unadoptedArtifactRefs },
      );
    }
  }
  return compilerReady(drafted);
}

export function projectDiscoverySynthesis(
  declarations: readonly DiscoveryObjectDeclaration[],
  context: DiscoveryStageProjectionContext,
): readonly CompilerReadyArtifact[] {
  if (declarations.length === 0) {
    throw new StoreError(
      "formal_materialization.artifacts_missing",
      "G2.3 synthesis requires at least one explicitly authored formal object",
    );
  }
  return compilerReady(draftObjects(declarations, context, SYNTHESIS_TYPES, {}, true));
}
