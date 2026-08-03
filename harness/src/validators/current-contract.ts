import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { loadSchemaBundle } from "./schema-bundle.js";

const CURRENT_ENVELOPE_VERSION = "startup_opportunity.artifact_envelope.current";

export const CURRENT_POLICY_PATHS = [
  "harness/policies/adaptation.v1.json",
  "harness/policies/ai-trigger-source-binding.current.json",
  "harness/policies/assessment-adaptation.v1.json",
  "harness/policies/assessment-execution.v1.json",
  "harness/policies/assessment-reporting.v1.json",
  "harness/policies/discovery-adaptation-binding.v1.json",
  "harness/policies/discovery-candidates.v1.json",
  "harness/policies/discovery-evaluation.v3.json",
  "harness/policies/discovery-maps.v1.json",
  "harness/policies/discovery-synthesis.v1.json",
  "harness/policies/plan-revision-apply.v1.json",
  "harness/policies/research-publication.current.json",
] as const;

const DIRECT_RUNTIME_SCHEMA_VERSIONS = [
  "startup_opportunity.artifact_envelope.current",
  "startup_opportunity.artifact_store_operation.current",
  "startup_opportunity.continuation_lineage_entry.v1",
  "startup_opportunity.document_bundle.current",
  "startup_opportunity.evidence_store_record.v2",
  "startup_opportunity.runtime_artifact_compilation_request.v1",
  "startup_opportunity.runtime_artifact_compilation_result.v1",
  "startup_opportunity.runtime_artifact_compilation_result.v2",
] as const;

const STATIC_PRODUCTION_SCAN_PATHS = [
  "harness/src",
  "harness/schemas/current",
  "harness/schemas/current.json",
  "harness/policies",
] as const;

const FORBIDDEN_STRUCTURES = [
  {
    name: "numbered Artifact Envelope",
    pattern: /startup_opportunity\.artifact_envelope\.v[1-9][0-9]*/u,
  },
  {
    name: "numbered Document Bundle",
    pattern: /startup_opportunity\.document_bundle\.v[1-9][0-9]*/u,
  },
  {
    name: "numbered Artifact Store operation receipt",
    pattern: /startup_opportunity\.artifact_store_operation\.v[1-9][0-9]*/u,
  },
  {
    name: "numbered research publication policy",
    pattern: /startup_opportunity\.research_publication_policy\.v[1-9][0-9]*/u,
  },
  { name: "versioned schema bundle manifest", pattern: /bundle\.v[1-9][0-9.]*\.json/u },
  { name: "base schema bundle chain", pattern: /\bbase_bundle\b/u },
  { name: "Run schema bundle selector", pattern: /\bschema_bundle_version\b/u },
  {
    name: "Store publication adapter",
    pattern:
      /(?:["']adapters["']\s*:|\b(?:StorePublicationAdapter|EXPECTED_ADAPTERS|adaptersByEnvelope|adapterForEnvelope|publicationAdapter|publication_adapters|storePublicationAdapters|versioned_owning_schema_adapter)\b|\b(?:document|policy|publicationPolicy)\.adapters\b)/u,
  },
  {
    name: "publication policy base chain",
    pattern:
      /(?:["']base_policy["']\s*:|\b(?:base_policy_binding|base_policy_path|base_policy_ref|basePolicy|basePublicationPolicy|loadBasePolicy)\b)/u,
  },
  {
    name: "Store compatibility fallback",
    pattern:
      /(?:["']compatibility["']\s*:|\bpublish_requires_compatible_envelope\b|\b(?:compatibility|legacy)(?:Fallback|Adapter|Policy|Mode|Version)\b|\b(?:compatibility|legacy)_(?:fallback|adapter|policy|mode|version)\b|\b(?:fallback_(?:adapter|policy|version)|(?:schema|bundle|envelope|receipt|publication|store)(?:Version)?Fallback)\b)/u,
  },
  {
    name: "highest Store contract version selection",
    pattern:
      /\b(?:highestBundleForEnvelopes|highestSchemaBundleVersion|highest(?:DocumentBundle|Envelope|Receipt|PublicationPolicy|StoreContract)Version)\b/u,
  },
  {
    name: "Store contract version registry or selector",
    pattern:
      /\b(?:StoreEnvelopeVersion|StoreDocumentBundleVersion|ArtifactReceiptVersion|STORE_ENVELOPE_VERSIONS|(?:envelope|documentBundle|receipt|publicationPolicy|schemaBundle)Versions|(?:ENVELOPE|DOCUMENT_BUNDLE|RECEIPT|PUBLICATION_POLICY|SCHEMA_BUNDLE)_VERSIONS|SUPPORTED_(?:STORE_|ENVELOPE_|DOCUMENT_BUNDLE_|RECEIPT_|SCHEMA_BUNDLE_)?VERSIONS|(?:select|resolve|choose|pick)(?:Store|Publication|Envelope|DocumentBundle|Receipt|SchemaBundle)Version|(?:compare|sort)(?:Store|Publication|Envelope|DocumentBundle|Receipt|SchemaBundle)Versions?)\b/u,
  },
  { name: "old Run version protocol", pattern: /run\.unsupported_run_version/u },
  {
    name: "numbered Plan operation receipt",
    pattern: /startup_opportunity\.plan_revision_operation\.v[1-9][0-9]*/u,
  },
] as const;

export interface CurrentContractIssue {
  readonly code: string;
  readonly message: string;
  readonly details: Readonly<Record<string, unknown>>;
}

export interface CurrentContractInspectionResult {
  readonly schemaVersion: "startup_opportunity.current_contract_inspection.v1";
  readonly valid: boolean;
  readonly manifestSchemaCount: number;
  readonly schemaRootCount: number;
  readonly artifactTypeCount: number;
  readonly activePolicyCount: number;
  readonly schemaReferenceClosureCount: number;
  readonly issues: readonly CurrentContractIssue[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function issue(
  code: string,
  message: string,
  details: Readonly<Record<string, unknown>> = {},
): CurrentContractIssue {
  return { code, message, details };
}

function collectReferences(value: unknown): readonly string[] {
  if (Array.isArray(value)) {
    return value.flatMap(collectReferences);
  }
  if (!isRecord(value)) {
    return [];
  }
  return Object.entries(value).flatMap(([key, child]) =>
    key === "$ref" && typeof child === "string" ? [child] : collectReferences(child),
  );
}

function envelopeArtifactRules(envelope: Record<string, unknown>): ReadonlyMap<string, string> {
  const rules = new Map<string, string>();
  if (!Array.isArray(envelope.allOf)) {
    return rules;
  }
  for (const candidate of envelope.allOf) {
    if (!isRecord(candidate) || !isRecord(candidate.if) || !isRecord(candidate.then)) {
      continue;
    }
    const ifProperties = candidate.if.properties;
    const thenProperties = candidate.then.properties;
    if (!isRecord(ifProperties) || !isRecord(thenProperties)) {
      continue;
    }
    const artifactType = ifProperties.artifact_type;
    const document = thenProperties.document;
    if (
      isRecord(artifactType) &&
      typeof artifactType.const === "string" &&
      isRecord(document) &&
      typeof document.$ref === "string"
    ) {
      rules.set(artifactType.const, document.$ref);
    }
  }
  return rules;
}

async function filesUnder(root: string, relativePath: string): Promise<readonly string[]> {
  const absolutePath = path.join(root, relativePath);
  const entries = await readdir(absolutePath, { withFileTypes: true }).catch(() => null);
  if (entries === null) {
    return [relativePath];
  }
  const files: string[] = [];
  for (const entry of entries) {
    const child = path.posix.join(relativePath, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await filesUnder(root, child)));
    } else if (entry.isFile()) {
      files.push(child);
    }
  }
  return files;
}

export function inspectCurrentContractSource(
  file: string,
  contents: string,
): readonly CurrentContractIssue[] {
  const issues: CurrentContractIssue[] = [];
  for (const forbidden of FORBIDDEN_STRUCTURES) {
    if (forbidden.pattern.test(contents)) {
      issues.push(
        issue("current_contract.forbidden_structure", forbidden.name, {
          file,
          structure: forbidden.name,
        }),
      );
    }
  }
  return issues;
}

async function inspectForbiddenStructures(
  root: string,
  manifestSchemaPaths: readonly string[],
): Promise<readonly CurrentContractIssue[]> {
  const files = (
    await Promise.all(
      [...STATIC_PRODUCTION_SCAN_PATHS, ...manifestSchemaPaths].map((relativePath) =>
        filesUnder(root, relativePath),
      ),
    )
  )
    .flat()
    .filter((file) => /\.(?:json|ts)$/u.test(file))
    .filter((file) => file !== "harness/src/validators/current-contract.ts")
    .filter((file, index, candidates) => candidates.indexOf(file) === index)
    .sort();
  const issues: CurrentContractIssue[] = [];
  for (const file of files) {
    const contents = await readFile(path.join(root, file), "utf8");
    issues.push(...inspectCurrentContractSource(file, contents));
  }
  return issues;
}

export async function inspectCurrentContract(
  root = process.cwd(),
): Promise<CurrentContractInspectionResult> {
  const issues: CurrentContractIssue[] = [];
  const bundle = await loadSchemaBundle(root);
  const byVersion = new Map(
    bundle.manifest.schemas.flatMap((entry) =>
      entry.document_schema_version === null ? [] : [[entry.document_schema_version, entry.id]],
    ),
  );
  const envelopeId = byVersion.get(CURRENT_ENVELOPE_VERSION);
  const envelope = envelopeId === undefined ? undefined : bundle.schemas.get(envelopeId)?.document;
  const artifactTypeValue = envelope?.properties;
  const artifactTypeProperty = isRecord(artifactTypeValue)
    ? artifactTypeValue.artifact_type
    : undefined;
  const artifactTypes =
    isRecord(artifactTypeProperty) && Array.isArray(artifactTypeProperty.enum)
      ? artifactTypeProperty.enum.filter((value): value is string => typeof value === "string")
      : [];
  const rules =
    envelope === undefined ? new Map<string, string>() : envelopeArtifactRules(envelope);
  const enumSet = new Set(artifactTypes);
  const ruleSet = new Set(rules.keys());
  if (
    enumSet.size !== artifactTypes.length ||
    enumSet.size !== ruleSet.size ||
    [...enumSet].some((artifactType) => !ruleSet.has(artifactType))
  ) {
    issues.push(
      issue(
        "current_contract.envelope_dispatch_incomplete",
        "current Envelope artifact_type enum and document dispatch rules differ",
        {
          enumOnly: [...enumSet].filter((value) => !ruleSet.has(value)).sort(),
          ruleOnly: [...ruleSet].filter((value) => !enumSet.has(value)).sort(),
        },
      ),
    );
  }

  const rootIds = new Set<string>();
  for (const version of DIRECT_RUNTIME_SCHEMA_VERSIONS) {
    const id = byVersion.get(version);
    if (id === undefined) {
      issues.push(
        issue("current_contract.runtime_schema_missing", "direct Runtime schema is not installed", {
          schemaVersion: version,
        }),
      );
    } else {
      rootIds.add(id);
    }
  }

  for (const policyPath of CURRENT_POLICY_PATHS) {
    const policy = JSON.parse(await readFile(path.join(root, policyPath), "utf8")) as unknown;
    const version = isRecord(policy) ? policy.schema_version : undefined;
    const id = typeof version === "string" ? byVersion.get(version) : undefined;
    if (id === undefined) {
      issues.push(
        issue("current_contract.policy_schema_missing", "active policy schema is not installed", {
          policyPath,
          schemaVersion: version ?? null,
        }),
      );
    } else {
      rootIds.add(id);
    }
  }

  if (envelopeId !== undefined) {
    for (const [artifactType, reference] of rules) {
      const targetId = new URL(reference, envelopeId).href.split("#", 1)[0] ?? "";
      if (!bundle.schemas.has(targetId)) {
        issues.push(
          issue(
            "current_contract.envelope_schema_missing",
            "current Envelope dispatch points outside the manifest",
            { artifactType, reference, targetId },
          ),
        );
      }
    }
  }

  const schemaReferenceClosure = new Set<string>();
  const pending = [...rootIds];
  while (pending.length > 0) {
    const currentId = pending.pop();
    if (currentId === undefined || schemaReferenceClosure.has(currentId)) {
      continue;
    }
    schemaReferenceClosure.add(currentId);
    const schema = bundle.schemas.get(currentId)?.document;
    if (schema === undefined) {
      continue;
    }
    for (const reference of collectReferences(schema)) {
      const targetId = new URL(reference, currentId).href.split("#", 1)[0] ?? "";
      if (!schemaReferenceClosure.has(targetId)) {
        pending.push(targetId);
      }
    }
  }
  const unreachable = bundle.manifest.schemas
    .filter((entry) => !schemaReferenceClosure.has(entry.id))
    .map((entry) => ({ id: entry.id, file: entry.file }))
    .sort((left, right) => left.file.localeCompare(right.file));
  if (unreachable.length > 0) {
    issues.push(
      issue(
        "current_contract.schema_unreachable",
        "manifest contains schemas outside the current Runtime root $ref closure",
        { schemas: unreachable },
      ),
    );
  }

  issues.push(
    ...(await inspectForbiddenStructures(
      root,
      bundle.manifest.schemas.map((entry) => path.posix.join("harness/schemas", entry.file)),
    )),
  );
  const sortedIssues = issues.sort((left, right) =>
    [left.code, JSON.stringify(left.details)]
      .join("\0")
      .localeCompare([right.code, JSON.stringify(right.details)].join("\0")),
  );
  return {
    schemaVersion: "startup_opportunity.current_contract_inspection.v1",
    valid: sortedIssues.length === 0,
    manifestSchemaCount: bundle.manifest.schemas.length,
    schemaRootCount: rootIds.size,
    artifactTypeCount: artifactTypes.length,
    activePolicyCount: CURRENT_POLICY_PATHS.length,
    schemaReferenceClosureCount: schemaReferenceClosure.size,
    issues: sortedIssues,
  };
}
