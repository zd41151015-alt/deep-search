import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { CURRENT_POLICY_PATHS } from "../current-policy-paths.js";
import {
  type ContractOwnershipFamily,
  type ContractOwnershipRegistry,
  CURRENT_OWNERSHIP_REGISTRY_PATH,
  loadContractOwnershipRegistry,
  OwnershipRegistryFormatError,
  selectorMatchesSchemaFile,
} from "./ownership-registry.js";
import { loadSchemaBundle } from "./schema-bundle.js";

const CURRENT_ENVELOPE_VERSION = "startup_opportunity.artifact_envelope.current";

export { CURRENT_POLICY_PATHS };

export const DIRECT_RUNTIME_SCHEMA_VERSIONS = [
  "startup_opportunity.artifact_envelope.current",
  "startup_opportunity.artifact_publication_commit.current",
  "startup_opportunity.artifact_store_operation.current",
  "startup_opportunity.adaptation_author_request.current",
  "startup_opportunity.adaptation_author_result.current",
  "startup_opportunity.continuation_lineage_entry.v1",
  "startup_opportunity.document_bundle.current",
  "startup_opportunity.dispatch_launch_check_result.v1",
  "startup_opportunity.dispatch_launch_registration_request.v1",
  "startup_opportunity.evidence_store_record.v2",
  "startup_opportunity.formal_stage_materialization_request.current",
  "startup_opportunity.formal_stage_materialization_result.current",
  "startup_opportunity.lane_submission_contract.current",
  "startup_opportunity.lane_staging_document.current",
  "startup_opportunity.lane_submission_checklist_result.current",
  "startup_opportunity.lane_delivery_result.current",
  "startup_opportunity.runtime_artifact_compilation_request.v1",
  "startup_opportunity.runtime_artifact_compilation_result.discovery.current",
  "startup_opportunity.runtime_artifact_compilation_result.assessment.current",
  "startup_opportunity.scaffold_request.current",
  "startup_opportunity.scaffold_result.current",
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
      /(?:\bpublish_requires_compatible_envelope\b|\b(?:compatibility|legacy)(?:Fallback|Adapter|Policy|Mode|Version)\b|\b(?:compatibility|legacy)_(?:fallback|adapter|policy|mode|version)\b|\b(?:fallback_(?:adapter|policy|version)|(?:schema|bundle|envelope|receipt|publication|store)(?:Version)?Fallback)\b)/u,
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
  readonly registryFamilyCount: number;
  readonly registeredArtifactTypeCount: number;
  readonly registeredDirectRuntimeRootCount: number;
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

export function collectSchemaReferences(value: unknown): readonly string[] {
  if (Array.isArray(value)) {
    return value.flatMap(collectSchemaReferences);
  }
  if (!isRecord(value)) {
    return [];
  }
  return Object.entries(value).flatMap(([key, child]) =>
    key === "$ref" && typeof child === "string" ? [child] : collectSchemaReferences(child),
  );
}

interface ManifestSchemaEntry {
  readonly id: string;
  readonly file: string;
  readonly document_schema_version: string | null;
}

interface RegistryInspectionContext {
  readonly root: string;
  readonly registry: ContractOwnershipRegistry;
  readonly manifestSchemas: readonly ManifestSchemaEntry[];
  readonly schemaDocuments: ReadonlyMap<string, Record<string, unknown>>;
  readonly artifactRules: ReadonlyMap<string, string>;
}

interface RegistryInspectionResult {
  readonly issues: readonly CurrentContractIssue[];
  readonly registeredArtifactTypeCount: number;
  readonly registeredDirectRuntimeRootCount: number;
}

function ownersForSchemaFile(
  families: readonly ContractOwnershipFamily[],
  schemaFile: string,
  selectorKey: "schemaSelectors" | "artifactTypeSelectors",
): readonly string[] {
  return families
    .filter((family) =>
      family[selectorKey].some((selector) => selectorMatchesSchemaFile(selector, schemaFile)),
    )
    .map((family) => family.id)
    .sort();
}

function isRepositoryRelativePath(value: string): boolean {
  return (
    value !== "" &&
    !path.posix.isAbsolute(value) &&
    path.posix.normalize(value) === value &&
    value !== ".." &&
    !value.startsWith("../")
  );
}

async function pathIsFile(root: string, relativePath: string): Promise<boolean> {
  if (!isRepositoryRelativePath(relativePath)) {
    return false;
  }
  return (await stat(path.join(root, relativePath)).catch(() => null))?.isFile() === true;
}

async function inspectOwnershipRegistry({
  root,
  registry,
  manifestSchemas,
  schemaDocuments,
  artifactRules,
}: RegistryInspectionContext): Promise<RegistryInspectionResult> {
  const issues: CurrentContractIssue[] = [];
  const familyIds = registry.families.map((family) => family.id);
  const familyIdSet = new Set(familyIds);
  if (familyIdSet.size !== familyIds.length) {
    issues.push(
      issue("current_contract.registry_duplicate_family", "ownership registry family IDs overlap", {
        familyIds: familyIds.filter((id, index) => familyIds.indexOf(id) !== index).sort(),
      }),
    );
  }
  const manifestById = new Map(manifestSchemas.map((entry) => [entry.id, entry]));
  const manifestByVersion = new Map(
    manifestSchemas.flatMap((entry) =>
      entry.document_schema_version === null
        ? []
        : [[entry.document_schema_version, entry] as const],
    ),
  );
  const manifestFiles = manifestSchemas.map((entry) => entry.file);
  const artifactSchemaFiles = [...artifactRules.values()].flatMap((targetId) => {
    const target = manifestById.get(targetId.split("#", 1)[0] ?? "");
    return target === undefined ? [] : [target.file];
  });

  for (const family of registry.families) {
    for (const [selectorKey, selectors] of [
      ["schemaSelectors", family.schemaSelectors],
      ["artifactTypeSelectors", family.artifactTypeSelectors],
    ] as const) {
      for (const selector of selectors) {
        const selectableFiles =
          selectorKey === "artifactTypeSelectors" ? artifactSchemaFiles : manifestFiles;
        if (!selectableFiles.some((file) => selectorMatchesSchemaFile(selector, file))) {
          issues.push(
            issue(
              "current_contract.registry_selector_stale",
              selectorKey === "artifactTypeSelectors"
                ? "registry Artifact selector matches no formal Artifact document schema"
                : "registry selector matches no schema",
              {
                familyId: family.id,
                selectorKey,
                prefix: selector.prefix,
              },
            ),
          );
        }
      }
    }
    if (family.ownerModules.length === 0) {
      issues.push(
        issue(
          "current_contract.registry_owner_missing",
          "contract family has no production owner",
          {
            familyId: family.id,
          },
        ),
      );
    }
  }

  for (const entry of manifestSchemas) {
    const owners = ownersForSchemaFile(registry.families, entry.file, "schemaSelectors");
    if (owners.length === 0) {
      issues.push(
        issue(
          "current_contract.registry_schema_unowned",
          "manifest schema has no structural owner",
          {
            schemaFile: entry.file,
          },
        ),
      );
    } else if (owners.length > 1) {
      issues.push(
        issue("current_contract.registry_schema_overlap", "manifest schema has multiple owners", {
          schemaFile: entry.file,
          owners,
        }),
      );
    }
  }

  let registeredArtifactTypeCount = 0;
  for (const [artifactType, targetId] of artifactRules) {
    const target = manifestById.get(targetId.split("#", 1)[0] ?? "");
    if (target === undefined) {
      continue;
    }
    const owners = ownersForSchemaFile(registry.families, target.file, "artifactTypeSelectors");
    if (owners.length === 0) {
      issues.push(
        issue(
          "current_contract.registry_artifact_type_unowned",
          "formal Artifact type has no owning family",
          { artifactType, documentSchemaFile: target.file },
        ),
      );
    } else if (owners.length > 1) {
      issues.push(
        issue(
          "current_contract.registry_artifact_type_overlap",
          "formal Artifact type has multiple owning families",
          { artifactType, documentSchemaFile: target.file, owners },
        ),
      );
    } else {
      registeredArtifactTypeCount += 1;
      const structuralOwners = ownersForSchemaFile(
        registry.families,
        target.file,
        "schemaSelectors",
      );
      if (structuralOwners.length === 1 && structuralOwners[0] !== owners[0]) {
        issues.push(
          issue(
            "current_contract.registry_artifact_schema_disagreement",
            "Artifact owner differs from its document schema structural owner",
            {
              artifactType,
              documentSchemaFile: target.file,
              artifactOwner: owners[0],
              structuralOwners,
            },
          ),
        );
      }
    }
  }

  const expectedRuntimeRoots = new Set<string>(DIRECT_RUNTIME_SCHEMA_VERSIONS);
  const registeredRuntimeRoots = new Map<string, string[]>();
  for (const family of registry.families) {
    for (const schemaVersion of family.directRuntimeRoots) {
      const owners = registeredRuntimeRoots.get(schemaVersion) ?? [];
      owners.push(family.id);
      registeredRuntimeRoots.set(schemaVersion, owners);
      if (!expectedRuntimeRoots.has(schemaVersion)) {
        issues.push(
          issue(
            "current_contract.registry_runtime_root_stale",
            "registry direct Runtime root is not an active current root",
            { schemaVersion, familyId: family.id },
          ),
        );
      }
    }
  }
  let registeredDirectRuntimeRootCount = 0;
  for (const schemaVersion of DIRECT_RUNTIME_SCHEMA_VERSIONS) {
    const owners = (registeredRuntimeRoots.get(schemaVersion) ?? []).sort();
    if (owners.length === 0) {
      issues.push(
        issue(
          "current_contract.registry_runtime_root_unowned",
          "direct Runtime root has no owning family",
          { schemaVersion },
        ),
      );
    } else if (owners.length > 1) {
      issues.push(
        issue(
          "current_contract.registry_runtime_root_overlap",
          "direct Runtime root has multiple owning families",
          { schemaVersion, owners },
        ),
      );
    } else {
      registeredDirectRuntimeRootCount += 1;
      const entry = manifestByVersion.get(schemaVersion);
      if (entry !== undefined) {
        const structuralOwners = ownersForSchemaFile(
          registry.families,
          entry.file,
          "schemaSelectors",
        );
        if (structuralOwners.length === 1 && structuralOwners[0] !== owners[0]) {
          issues.push(
            issue(
              "current_contract.registry_runtime_schema_disagreement",
              "direct Runtime root owner differs from its schema structural owner",
              { schemaVersion, schemaFile: entry.file, runtimeOwner: owners[0], structuralOwners },
            ),
          );
        }
      }
    }
  }

  const registeredPolicies = new Map<string, string[]>();
  for (const family of registry.families) {
    for (const policyPath of family.policyPaths) {
      const owners = registeredPolicies.get(policyPath) ?? [];
      owners.push(family.id);
      registeredPolicies.set(policyPath, owners);
    }
  }
  for (const policyPath of CURRENT_POLICY_PATHS) {
    const owners = (registeredPolicies.get(policyPath) ?? []).sort();
    if (owners.length !== 1) {
      issues.push(
        issue(
          owners.length === 0
            ? "current_contract.registry_policy_unowned"
            : "current_contract.registry_policy_overlap",
          owners.length === 0
            ? "active current policy has no owning family"
            : "active current policy has multiple owning families",
          { policyPath, owners },
        ),
      );
    }
  }
  for (const [policyPath, owners] of registeredPolicies) {
    if (!(CURRENT_POLICY_PATHS as readonly string[]).includes(policyPath)) {
      issues.push(
        issue("current_contract.registry_policy_stale", "registered policy is not active", {
          policyPath,
          owners: owners.sort(),
        }),
      );
    }
  }

  const sharedByFile = new Map<string, typeof registry.sharedSchemas>();
  for (const shared of registry.sharedSchemas) {
    const entries = sharedByFile.get(shared.schemaFile) ?? [];
    sharedByFile.set(shared.schemaFile, [...entries, shared]);
  }
  for (const entry of manifestSchemas.filter((candidate) =>
    candidate.file.endsWith("/definitions.schema.json"),
  )) {
    const sharedEntries = sharedByFile.get(entry.file) ?? [];
    if (sharedEntries.length !== 1) {
      issues.push(
        issue(
          sharedEntries.length === 0
            ? "current_contract.registry_shared_schema_unowned"
            : "current_contract.registry_shared_schema_overlap",
          sharedEntries.length === 0
            ? "shared definitions schema has no structural owner entry"
            : "shared definitions schema has multiple structural owner entries",
          { schemaFile: entry.file },
        ),
      );
    }
  }
  for (const [schemaFile, sharedEntries] of sharedByFile) {
    if (!manifestFiles.includes(schemaFile)) {
      issues.push(
        issue("current_contract.registry_shared_schema_stale", "shared schema is not installed", {
          schemaFile,
        }),
      );
      continue;
    }
    for (const shared of sharedEntries) {
      const owners = ownersForSchemaFile(registry.families, schemaFile, "schemaSelectors");
      if (owners.length === 1 && owners[0] !== shared.structuralOwner) {
        issues.push(
          issue(
            "current_contract.registry_shared_owner_disagreement",
            "shared schema structural owner differs from its family selector owner",
            { schemaFile, declaredOwner: shared.structuralOwner, selectorOwners: owners },
          ),
        );
      }
      for (const familyId of [shared.structuralOwner, ...shared.impactFamilies]) {
        if (!familyIdSet.has(familyId)) {
          issues.push(
            issue(
              "current_contract.registry_shared_family_stale",
              "shared schema names a stale family",
              {
                schemaFile,
                familyId,
              },
            ),
          );
        }
      }
      if (!shared.impactFamilies.includes(shared.structuralOwner)) {
        issues.push(
          issue(
            "current_contract.registry_shared_owner_not_impacted",
            "shared schema impact set must include its structural owner",
            { schemaFile, structuralOwner: shared.structuralOwner },
          ),
        );
      }
    }
  }

  const directReferenceFamilies = new Map<string, Set<string>>();
  for (const source of manifestSchemas) {
    const document = schemaDocuments.get(source.id);
    if (document === undefined) {
      continue;
    }
    const sourceOwners = ownersForSchemaFile(registry.families, source.file, "schemaSelectors");
    for (const reference of collectSchemaReferences(document)) {
      const targetId = new URL(reference, source.id).href.split("#", 1)[0] ?? "";
      const target = manifestById.get(targetId);
      if (target === undefined || !sharedByFile.has(target.file)) {
        continue;
      }
      const families = directReferenceFamilies.get(target.file) ?? new Set<string>();
      for (const sourceOwner of sourceOwners) {
        families.add(sourceOwner);
      }
      directReferenceFamilies.set(target.file, families);
    }
  }
  for (const shared of registry.sharedSchemas) {
    const missingImpactFamilies = [...(directReferenceFamilies.get(shared.schemaFile) ?? [])]
      .filter((familyId) => !shared.impactFamilies.includes(familyId))
      .sort();
    if (missingImpactFamilies.length > 0) {
      issues.push(
        issue(
          "current_contract.registry_shared_impact_incomplete",
          "shared schema omits a directly referencing family",
          { schemaFile: shared.schemaFile, missingImpactFamilies },
        ),
      );
    }
  }

  const pathCategories = [
    "ownerModules",
    "producerModules",
    "consumerModules",
    "validatorModules",
    "reportProjectionModules",
    "focusedTests",
  ] as const;
  const modulePathCategories = [
    "ownerModules",
    "producerModules",
    "consumerModules",
    "validatorModules",
    "reportProjectionModules",
  ] as const;
  const registeredModuleFamilies = new Map<string, Set<string>>();
  for (const family of registry.families) {
    for (const category of pathCategories) {
      for (const registeredPath of family[category]) {
        if (!(await pathIsFile(root, registeredPath))) {
          issues.push(
            issue("current_contract.registry_path_stale", "registered repository path is missing", {
              familyId: family.id,
              category,
              path: registeredPath,
            }),
          );
        }
        if ((modulePathCategories as readonly string[]).includes(category)) {
          const families = registeredModuleFamilies.get(registeredPath) ?? new Set<string>();
          families.add(family.id);
          registeredModuleFamilies.set(registeredPath, families);
        }
      }
    }
  }

  const crossFamilyModulePaths = registry.crossFamilyModules.map((entry) => entry.modulePath);
  const duplicateCrossFamilyModulePaths = crossFamilyModulePaths
    .filter((modulePath, index) => crossFamilyModulePaths.indexOf(modulePath) !== index)
    .sort();
  if (duplicateCrossFamilyModulePaths.length > 0) {
    issues.push(
      issue(
        "current_contract.registry_cross_family_module_overlap",
        "cross-family module audit paths overlap",
        { modulePaths: [...new Set(duplicateCrossFamilyModulePaths)] },
      ),
    );
  }
  const crossFamilyModules = new Map(
    registry.crossFamilyModules.map((entry) => [entry.modulePath, entry] as const),
  );
  for (const entry of registry.crossFamilyModules) {
    if (!(await pathIsFile(root, entry.modulePath))) {
      issues.push(
        issue("current_contract.registry_path_stale", "registered repository path is missing", {
          category: "crossFamilyModules",
          path: entry.modulePath,
        }),
      );
    }
    const unknownFamilies = entry.impactFamilies
      .filter((familyId) => !familyIdSet.has(familyId))
      .sort();
    const registeredFamilies = [...(registeredModuleFamilies.get(entry.modulePath) ?? [])].sort();
    const missingFamilies = registeredFamilies
      .filter((familyId) => !entry.impactFamilies.includes(familyId))
      .sort();
    const extraFamilies = entry.impactFamilies
      .filter((familyId) => !registeredFamilies.includes(familyId))
      .sort();
    if (unknownFamilies.length > 0 || missingFamilies.length > 0 || extraFamilies.length > 0) {
      issues.push(
        issue(
          "current_contract.registry_cross_family_module_mismatch",
          "cross-family module audit must exactly match family role registration",
          {
            modulePath: entry.modulePath,
            registeredFamilies,
            impactFamilies: [...entry.impactFamilies].sort(),
            unknownFamilies,
            missingFamilies,
            extraFamilies,
          },
        ),
      );
    }
  }
  for (const [modulePath, families] of registeredModuleFamilies) {
    if (families.size > 1 && !crossFamilyModules.has(modulePath)) {
      issues.push(
        issue(
          "current_contract.registry_cross_family_module_unregistered",
          "module registered in multiple families requires an explicit cross-family audit",
          { modulePath, registeredFamilies: [...families].sort() },
        ),
      );
    }
  }

  const packageJsonContents = await readFile(path.join(root, "package.json"), "utf8").catch(
    () => null,
  );
  let packageJson: unknown;
  if (packageJsonContents !== null) {
    try {
      packageJson = JSON.parse(packageJsonContents) as unknown;
    } catch (error) {
      issues.push(
        issue("current_contract.registry_package_invalid", "package.json could not be parsed", {
          reason: error instanceof Error ? error.message : "invalid JSON",
        }),
      );
    }
  }
  const packageScripts =
    isRecord(packageJson) && isRecord(packageJson.scripts) ? packageJson.scripts : {};
  if (packageJsonContents === null) {
    issues.push(
      issue(
        "current_contract.registry_package_missing",
        "package.json is required to verify scripts",
      ),
    );
  }
  for (const family of registry.families) {
    for (const script of family.testScripts) {
      if (typeof packageScripts[script] !== "string") {
        issues.push(
          issue(
            "current_contract.registry_test_command_stale",
            "registered npm script is missing",
            {
              familyId: family.id,
              script,
            },
          ),
        );
      }
    }
    for (const focusedTest of family.focusedTests) {
      const coveringScripts = family.testScripts.filter((script) => {
        const command = packageScripts[script];
        return typeof command === "string" && command.split(/\s+/u).includes(focusedTest);
      });
      if (coveringScripts.length === 0) {
        issues.push(
          issue(
            "current_contract.registry_focused_test_uncovered",
            "focused test is not an exact token in any registered npm script",
            { familyId: family.id, focusedTest, testScripts: [...family.testScripts].sort() },
          ),
        );
      }
    }
    for (const script of family.testScripts) {
      const command = packageScripts[script];
      if (
        typeof command === "string" &&
        !family.focusedTests.some((focusedTest) => command.split(/\s+/u).includes(focusedTest))
      ) {
        issues.push(
          issue(
            "current_contract.registry_test_command_unfocused",
            "registered npm script executes none of the family focused tests",
            { familyId: family.id, script },
          ),
        );
      }
    }
  }

  return { issues, registeredArtifactTypeCount, registeredDirectRuntimeRootCount };
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
  let registry: ContractOwnershipRegistry | undefined;
  try {
    registry = await loadContractOwnershipRegistry(root);
  } catch (error) {
    const registryIssues =
      error instanceof OwnershipRegistryFormatError
        ? error.issues
        : [
            {
              path: "",
              message: error instanceof Error ? error.message : "registry could not be loaded",
            },
          ];
    for (const registryIssue of registryIssues) {
      issues.push(
        issue("current_contract.registry_invalid", "engineering ownership registry is invalid", {
          registryPath: CURRENT_OWNERSHIP_REGISTRY_PATH,
          instancePath: registryIssue.path,
          reason: registryIssue.message,
        }),
      );
    }
  }
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

  const expectedPolicyPaths = new Set<string>(CURRENT_POLICY_PATHS);
  const actualPolicyPaths = (
    await readdir(path.join(root, "harness/policies"), {
      withFileTypes: true,
    })
  )
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => path.posix.join("harness/policies", entry.name))
    .sort();
  const actualPolicyPathSet = new Set(actualPolicyPaths);
  const missingPolicies = [...expectedPolicyPaths]
    .filter((policyPath) => !actualPolicyPathSet.has(policyPath))
    .sort();
  const unlistedPolicies = actualPolicyPaths
    .filter((policyPath) => !expectedPolicyPaths.has(policyPath))
    .sort();
  if (missingPolicies.length > 0 || unlistedPolicies.length > 0) {
    issues.push(
      issue(
        "current_contract.policy_set_mismatch",
        "policy directory and current policy registry differ",
        { missingPolicies, unlistedPolicies },
      ),
    );
  }

  for (const policyPath of CURRENT_POLICY_PATHS) {
    if (!actualPolicyPathSet.has(policyPath)) {
      continue;
    }
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
    for (const reference of collectSchemaReferences(schema)) {
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

  let registeredArtifactTypeCount = 0;
  let registeredDirectRuntimeRootCount = 0;
  if (registry !== undefined) {
    const resolvedArtifactRules = new Map(
      [...rules].map(([artifactType, reference]) => [
        artifactType,
        envelopeId === undefined
          ? reference
          : (new URL(reference, envelopeId).href.split("#", 1)[0] ?? ""),
      ]),
    );
    const registryInspection = await inspectOwnershipRegistry({
      root,
      registry,
      manifestSchemas: bundle.manifest.schemas,
      schemaDocuments: new Map([...bundle.schemas].map(([id, schema]) => [id, schema.document])),
      artifactRules: resolvedArtifactRules,
    });
    issues.push(...registryInspection.issues);
    registeredArtifactTypeCount = registryInspection.registeredArtifactTypeCount;
    registeredDirectRuntimeRootCount = registryInspection.registeredDirectRuntimeRootCount;
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
    registryFamilyCount: registry?.families.length ?? 0,
    registeredArtifactTypeCount,
    registeredDirectRuntimeRootCount,
    issues: sortedIssues,
  };
}
