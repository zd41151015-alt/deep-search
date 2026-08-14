import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  type CurrentContractIssue,
  collectSchemaReferences,
  inspectCurrentContract,
} from "./current-contract.js";
import {
  type ContractOwnershipFamily,
  type ContractRecoveryBoundaries,
  type ContractResearchImpact,
  CURRENT_OWNERSHIP_REGISTRY_PATH,
  loadContractOwnershipRegistry,
  selectorMatchesSchemaFile,
} from "./ownership-registry.js";
import { loadSchemaBundle } from "./schema-bundle.js";

const execFileAsync = promisify(execFile);

const FULL_ACCEPTANCE_COMMANDS = [
  "npm run lint",
  "npm run typecheck",
  "npm test",
  "npm run validate:schemas",
  "npm run validate:current-contract",
  "npm run validate:fixtures",
  "npm run verify:skeleton",
  "git diff --check",
] as const;

const TOPOLOGY_INFRASTRUCTURE_PATHS = new Set([
  CURRENT_OWNERSHIP_REGISTRY_PATH,
  "docs/contract-change-impact-governance.md",
  "docs/current-contract-maintenance.md",
  "harness/src/validators/contract-impact.ts",
  "harness/src/validators/current-contract.ts",
  "harness/src/validators/ownership-registry.ts",
  "harness/schemas/current.json",
  "scripts/contract-impact.ts",
]);

export type ContractFileStatus =
  | "added"
  | "copied"
  | "deleted"
  | "modified"
  | "renamed"
  | "type_changed"
  | "unknown";

export interface ContractFileChange {
  readonly status: ContractFileStatus;
  readonly path: string;
  readonly previousPath?: string;
  readonly changedJsonPointers: readonly string[];
  readonly structuralComparison: "compared" | "not_json" | "unavailable";
}

export interface ContractSchemaImpact {
  readonly file: string;
  readonly changedJsonPointers: readonly string[];
  readonly forwardReferences: readonly string[];
  readonly reverseReferences: readonly string[];
  readonly transitiveReverseReferences: readonly string[];
}

export interface ContractModuleImpact {
  readonly path: string;
  readonly families: readonly string[];
  readonly roles: readonly string[];
}

export interface AffectedContractFamily {
  readonly id: string;
  readonly domain: string;
  readonly reasons: readonly string[];
  readonly artifactTypes: readonly string[];
  readonly directRuntimeRoots: readonly string[];
  readonly owners: readonly string[];
  readonly producers: readonly string[];
  readonly consumers: readonly string[];
  readonly validators: readonly string[];
  readonly policies: readonly string[];
  readonly reportProjections: readonly string[];
  readonly userVisibleOutputs: readonly string[];
  readonly researchImpact: ContractResearchImpact;
  readonly recoveryBoundaries: ContractRecoveryBoundaries;
  readonly focusedTests: readonly string[];
  readonly testCommands: readonly string[];
}

export interface UnknownContractImpact {
  readonly path: string;
  readonly reason: string;
  readonly disposition: "all_families_and_full_acceptance" | "topology_validation_failed";
}

export interface ContractImpactResult {
  readonly schemaVersion: "startup_opportunity.contract_impact.current";
  readonly topologyValid: boolean;
  readonly baseRef: string;
  readonly baseRevision: string;
  readonly currentRevision: string;
  readonly changedFiles: readonly ContractFileChange[];
  readonly changedSchemas: readonly ContractSchemaImpact[];
  readonly changedPolicies: readonly string[];
  readonly changedModules: readonly ContractModuleImpact[];
  readonly affectedFamilies: readonly AffectedContractFamily[];
  readonly researchImpactDimensions: readonly {
    readonly familyId: string;
    readonly impact: ContractResearchImpact;
  }[];
  readonly recoveryBoundaries: readonly {
    readonly familyId: string;
    readonly boundaries: ContractRecoveryBoundaries;
  }[];
  readonly recommendedFocusedTests: readonly string[];
  readonly unknownImpact: readonly UnknownContractImpact[];
  readonly topologyIssues: readonly CurrentContractIssue[];
}

export interface InspectContractImpactOptions {
  readonly root?: string;
  readonly baseRef: string;
  readonly changes?: readonly ContractFileChange[];
  readonly baseRevision?: string;
  readonly currentRevision?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonPointerSegment(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

export function changedJsonPointers(
  before: unknown,
  after: unknown,
  pointer = "",
): readonly string[] {
  if (Object.is(before, after)) {
    return [];
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    const pointers: string[] = [];
    const length = Math.max(before.length, after.length);
    for (let index = 0; index < length; index += 1) {
      const childPointer = `${pointer}/${index}`;
      if (index >= before.length || index >= after.length) {
        pointers.push(childPointer);
      } else {
        pointers.push(...changedJsonPointers(before[index], after[index], childPointer));
      }
    }
    return pointers;
  }
  if (isRecord(before) && isRecord(after)) {
    const pointers: string[] = [];
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    for (const key of keys) {
      const childPointer = `${pointer}/${jsonPointerSegment(key)}`;
      if (!(key in before) || !(key in after)) {
        pointers.push(childPointer);
      } else {
        pointers.push(...changedJsonPointers(before[key], after[key], childPointer));
      }
    }
    return pointers;
  }
  return [pointer];
}

async function gitOutput(root: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  return stdout;
}

function statusFromGit(value: string): ContractFileStatus {
  switch (value[0]) {
    case "A":
      return "added";
    case "C":
      return "copied";
    case "D":
      return "deleted";
    case "M":
      return "modified";
    case "R":
      return "renamed";
    case "T":
      return "type_changed";
    default:
      return "unknown";
  }
}

async function readGitFile(
  root: string,
  revision: string,
  file: string,
): Promise<string | undefined> {
  return gitOutput(root, ["show", `${revision}:${file}`]).catch(() => undefined);
}

async function structuralChange(
  root: string,
  baseRevision: string,
  status: ContractFileStatus,
  file: string,
  previousPath?: string,
): Promise<Pick<ContractFileChange, "changedJsonPointers" | "structuralComparison">> {
  if (!file.endsWith(".json")) {
    return { changedJsonPointers: [], structuralComparison: "not_json" };
  }
  const beforeContents =
    status === "added" ? undefined : await readGitFile(root, baseRevision, previousPath ?? file);
  const afterContents =
    status === "deleted"
      ? undefined
      : await readFile(path.join(root, file), "utf8").catch(() => undefined);
  if (beforeContents === undefined || afterContents === undefined) {
    return { changedJsonPointers: [""], structuralComparison: "unavailable" };
  }
  try {
    const before = JSON.parse(beforeContents) as unknown;
    const after = JSON.parse(afterContents) as unknown;
    return {
      changedJsonPointers: [...changedJsonPointers(before, after)].sort(),
      structuralComparison: "compared",
    };
  } catch {
    return { changedJsonPointers: [""], structuralComparison: "unavailable" };
  }
}

async function collectGitChanges(
  root: string,
  baseRef: string,
): Promise<{
  readonly baseRevision: string;
  readonly currentRevision: string;
  readonly changes: readonly ContractFileChange[];
}> {
  const baseRevision = (
    await gitOutput(root, ["rev-parse", "--verify", `${baseRef}^{commit}`])
  ).trim();
  const currentRevision = (await gitOutput(root, ["rev-parse", "HEAD"])).trim();
  const nameStatus = await gitOutput(root, [
    "diff",
    "--name-status",
    "-z",
    "--find-renames",
    baseRevision,
    "--",
  ]);
  const tokens = nameStatus.split("\0").filter((token) => token !== "");
  const rawChanges: {
    readonly status: ContractFileStatus;
    readonly path: string;
    readonly previousPath?: string;
  }[] = [];
  for (let index = 0; index < tokens.length; ) {
    const statusToken = tokens[index] ?? "";
    index += 1;
    const status = statusFromGit(statusToken);
    if (status === "renamed" || status === "copied") {
      const previousPath = tokens[index] ?? "";
      const file = tokens[index + 1] ?? "";
      index += 2;
      rawChanges.push({ status, path: file, previousPath });
    } else {
      const file = tokens[index] ?? "";
      index += 1;
      rawChanges.push({ status, path: file });
    }
  }
  const untracked = (await gitOutput(root, ["ls-files", "--others", "--exclude-standard", "-z"]))
    .split("\0")
    .filter((file) => file !== "");
  const trackedPaths = new Set(rawChanges.map((change) => change.path));
  for (const file of untracked) {
    if (!trackedPaths.has(file)) {
      rawChanges.push({ status: "added", path: file });
    }
  }
  const changes = await Promise.all(
    rawChanges
      .sort((left, right) =>
        [left.path, left.previousPath ?? ""]
          .join("\0")
          .localeCompare([right.path, right.previousPath ?? ""].join("\0")),
      )
      .map(async (change) => ({
        ...change,
        ...(await structuralChange(
          root,
          baseRevision,
          change.status,
          change.path,
          change.previousPath,
        )),
      })),
  );
  return { baseRevision, currentRevision, changes };
}

function artifactRules(envelope: Record<string, unknown>): ReadonlyMap<string, string> {
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
    const type = ifProperties.artifact_type;
    const document = thenProperties.document;
    if (
      isRecord(type) &&
      typeof type.const === "string" &&
      isRecord(document) &&
      typeof document.$ref === "string"
    ) {
      rules.set(type.const, document.$ref);
    }
  }
  return rules;
}

function familiesForSchema(
  families: readonly ContractOwnershipFamily[],
  schemaFile: string,
): readonly ContractOwnershipFamily[] {
  return families.filter((family) =>
    family.schemaSelectors.some((selector) => selectorMatchesSchemaFile(selector, schemaFile)),
  );
}

function addFamilyReason(
  reasons: Map<string, Set<string>>,
  familyId: string,
  reason: string,
): void {
  const familyReasons = reasons.get(familyId) ?? new Set<string>();
  familyReasons.add(reason);
  reasons.set(familyId, familyReasons);
}

function moduleRoles(family: ContractOwnershipFamily, file: string): readonly string[] {
  const roles: string[] = [];
  for (const [role, paths] of [
    ["owner", family.ownerModules],
    ["producer", family.producerModules],
    ["consumer", family.consumerModules],
    ["validator", family.validatorModules],
    ["report_projection", family.reportProjectionModules],
    ["focused_test", family.focusedTests],
  ] as const) {
    if (paths.includes(file)) {
      roles.push(role);
    }
  }
  return roles;
}

function transitiveReverseReferences(
  start: string,
  reverse: ReadonlyMap<string, ReadonlySet<string>>,
): readonly string[] {
  const seen = new Set<string>();
  const pending = [...(reverse.get(start) ?? [])];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined || seen.has(current)) {
      continue;
    }
    seen.add(current);
    pending.push(...(reverse.get(current) ?? []));
  }
  return [...seen].sort();
}

function invalidTopologyResult(
  options: InspectContractImpactOptions,
  changes: readonly ContractFileChange[],
  baseRevision: string,
  currentRevision: string,
  topologyIssues: readonly CurrentContractIssue[],
): ContractImpactResult {
  return {
    schemaVersion: "startup_opportunity.contract_impact.current",
    topologyValid: false,
    baseRef: options.baseRef,
    baseRevision,
    currentRevision,
    changedFiles: changes,
    changedSchemas: [],
    changedPolicies: [],
    changedModules: [],
    affectedFamilies: [],
    researchImpactDimensions: [],
    recoveryBoundaries: [],
    recommendedFocusedTests: FULL_ACCEPTANCE_COMMANDS,
    unknownImpact: [
      {
        path: CURRENT_OWNERSHIP_REGISTRY_PATH,
        reason: "Current-contract topology validation failed; impact selection is unavailable.",
        disposition: "topology_validation_failed",
      },
    ],
    topologyIssues,
  };
}

export async function inspectContractImpact(
  options: InspectContractImpactOptions,
): Promise<ContractImpactResult> {
  const root = options.root ?? process.cwd();
  const gitState =
    options.changes === undefined
      ? await collectGitChanges(root, options.baseRef)
      : {
          baseRevision: options.baseRevision ?? options.baseRef,
          currentRevision: options.currentRevision ?? "WORKTREE",
          changes: [...options.changes].sort((left, right) => left.path.localeCompare(right.path)),
        };
  const topology = await inspectCurrentContract(root);
  if (!topology.valid) {
    return invalidTopologyResult(
      options,
      gitState.changes,
      gitState.baseRevision,
      gitState.currentRevision,
      topology.issues,
    );
  }

  const registry = await loadContractOwnershipRegistry(root);
  const bundle = await loadSchemaBundle(root);
  const manifestById = new Map(bundle.manifest.schemas.map((entry) => [entry.id, entry]));
  const repositoryPathToSchema = new Map(
    bundle.manifest.schemas.map((entry) => [path.posix.join("harness/schemas", entry.file), entry]),
  );
  const forward = new Map<string, Set<string>>();
  const reverse = new Map<string, Set<string>>();
  for (const [schemaId, loaded] of bundle.schemas) {
    const sourceFile = loaded.entry.file;
    const references = new Set<string>();
    for (const reference of collectSchemaReferences(loaded.document)) {
      const targetId = new URL(reference, schemaId).href.split("#", 1)[0] ?? "";
      const targetFile = manifestById.get(targetId)?.file;
      if (targetFile === undefined || targetFile === sourceFile) {
        continue;
      }
      references.add(targetFile);
      const dependents = reverse.get(targetFile) ?? new Set<string>();
      dependents.add(sourceFile);
      reverse.set(targetFile, dependents);
    }
    forward.set(sourceFile, references);
  }

  const byVersion = new Map(
    bundle.manifest.schemas.flatMap((entry) =>
      entry.document_schema_version === null ? [] : [[entry.document_schema_version, entry.id]],
    ),
  );
  const envelopeId = byVersion.get("startup_opportunity.artifact_envelope.current");
  const envelope = envelopeId === undefined ? undefined : bundle.schemas.get(envelopeId)?.document;
  const envelopeRules =
    envelope === undefined ? new Map<string, string>() : artifactRules(envelope);
  const artifactsByFamily = new Map<string, string[]>();
  for (const [artifactType, reference] of envelopeRules) {
    if (envelopeId === undefined) {
      continue;
    }
    const targetId = new URL(reference, envelopeId).href.split("#", 1)[0] ?? "";
    const targetFile = manifestById.get(targetId)?.file;
    if (targetFile === undefined) {
      continue;
    }
    for (const family of registry.families.filter((candidate) =>
      candidate.artifactTypeSelectors.some((selector) =>
        selectorMatchesSchemaFile(selector, targetFile),
      ),
    )) {
      const types = artifactsByFamily.get(family.id) ?? [];
      types.push(artifactType);
      artifactsByFamily.set(family.id, types);
    }
  }

  const familyReasons = new Map<string, Set<string>>();
  const unknownImpact: UnknownContractImpact[] = [];
  const changedSchemas: ContractSchemaImpact[] = [];
  const changedPolicies = new Set<string>();
  const changedModuleMap = new Map<string, { families: Set<string>; roles: Set<string> }>();
  const sharedByFile = new Map(registry.sharedSchemas.map((shared) => [shared.schemaFile, shared]));

  const addAllFamilies = (reason: string): void => {
    for (const family of registry.families) {
      addFamilyReason(familyReasons, family.id, reason);
    }
  };

  for (const change of gitState.changes) {
    const candidatePaths = [
      change.path,
      ...(change.previousPath === undefined ? [] : [change.previousPath]),
    ];
    let recognized = false;
    for (const candidatePath of candidatePaths) {
      const schemaEntry = repositoryPathToSchema.get(candidatePath);
      if (schemaEntry !== undefined) {
        recognized = true;
        const forwardReferences = [...(forward.get(schemaEntry.file) ?? [])].sort();
        const reverseReferences = [...(reverse.get(schemaEntry.file) ?? [])].sort();
        const transitiveReverse = transitiveReverseReferences(schemaEntry.file, reverse);
        changedSchemas.push({
          file: candidatePath,
          changedJsonPointers: change.changedJsonPointers,
          forwardReferences: forwardReferences.map((file) =>
            path.posix.join("harness/schemas", file),
          ),
          reverseReferences: reverseReferences.map((file) =>
            path.posix.join("harness/schemas", file),
          ),
          transitiveReverseReferences: transitiveReverse.map((file) =>
            path.posix.join("harness/schemas", file),
          ),
        });
        for (const family of familiesForSchema(registry.families, schemaEntry.file)) {
          addFamilyReason(familyReasons, family.id, `changed_schema:${candidatePath}`);
        }
        for (const relatedFile of [...forwardReferences, ...transitiveReverse]) {
          for (const family of familiesForSchema(registry.families, relatedFile)) {
            addFamilyReason(familyReasons, family.id, `schema_reference:${candidatePath}`);
          }
        }
        const shared = sharedByFile.get(schemaEntry.file);
        if (shared !== undefined) {
          for (const familyId of shared.impactFamilies) {
            addFamilyReason(familyReasons, familyId, `shared_schema:${candidatePath}`);
          }
        }
        if (
          schemaEntry.document_schema_version === "startup_opportunity.artifact_envelope.current"
        ) {
          addAllFamilies(`envelope_dispatch:${candidatePath}`);
        }
      }

      for (const family of registry.families) {
        if (family.policyPaths.includes(candidatePath)) {
          recognized = true;
          changedPolicies.add(candidatePath);
          addFamilyReason(familyReasons, family.id, `changed_policy:${candidatePath}`);
        }
        const roles = moduleRoles(family, candidatePath);
        if (roles.length > 0) {
          recognized = true;
          addFamilyReason(familyReasons, family.id, `changed_${roles.join("_")}:${candidatePath}`);
          const moduleImpact = changedModuleMap.get(candidatePath) ?? {
            families: new Set<string>(),
            roles: new Set<string>(),
          };
          moduleImpact.families.add(family.id);
          for (const role of roles) {
            moduleImpact.roles.add(role);
          }
          changedModuleMap.set(candidatePath, moduleImpact);
        }
      }

      if (TOPOLOGY_INFRASTRUCTURE_PATHS.has(candidatePath)) {
        recognized = true;
        addAllFamilies(`changed_topology:${candidatePath}`);
      }
      if (candidatePath === "package.json") {
        const scriptPointers = change.changedJsonPointers.filter((pointer) =>
          pointer.startsWith("/scripts/"),
        );
        for (const family of registry.families) {
          if (
            family.testScripts.some((script) =>
              scriptPointers.includes(`/scripts/${jsonPointerSegment(script)}`),
            )
          ) {
            recognized = true;
            addFamilyReason(familyReasons, family.id, "changed_test_script:package.json");
          }
        }
      }
    }
    if (!recognized) {
      unknownImpact.push({
        path: change.path,
        reason: "Changed file is not registered in the current contract topology.",
        disposition: "all_families_and_full_acceptance",
      });
      addAllFamilies(`conservative_unknown:${change.path}`);
    }
    if (change.structuralComparison === "unavailable" && change.path.endsWith(".json")) {
      unknownImpact.push({
        path: change.path,
        reason: "Structural JSON comparison was unavailable; field-level impact is unknown.",
        disposition: "all_families_and_full_acceptance",
      });
      addAllFamilies(`conservative_structural_unknown:${change.path}`);
    }
  }

  const affectedFamilies = registry.families
    .filter((family) => familyReasons.has(family.id))
    .sort((left, right) => left.id.localeCompare(right.id))
    .map(
      (family): AffectedContractFamily => ({
        id: family.id,
        domain: family.domain,
        reasons: [...(familyReasons.get(family.id) ?? [])].sort(),
        artifactTypes: [...(artifactsByFamily.get(family.id) ?? [])].sort(),
        directRuntimeRoots: [...family.directRuntimeRoots].sort(),
        owners: [...family.ownerModules].sort(),
        producers: [...family.producerModules].sort(),
        consumers: [...family.consumerModules].sort(),
        validators: [...family.validatorModules].sort(),
        policies: [...family.policyPaths].sort(),
        reportProjections: [...family.reportProjectionModules].sort(),
        userVisibleOutputs: [...family.userVisibleOutputs].sort(),
        researchImpact: family.researchImpact,
        recoveryBoundaries: family.recoveryBoundaries,
        focusedTests: [...family.focusedTests].sort(),
        testCommands: family.testScripts.map((script) => `npm run ${script}`).sort(),
      }),
    );
  const recommendedFocusedTests =
    unknownImpact.length > 0
      ? FULL_ACCEPTANCE_COMMANDS
      : [
          ...new Set([
            "npm run validate:current-contract",
            ...affectedFamilies.flatMap((family) => family.testCommands),
          ]),
        ].sort();

  return {
    schemaVersion: "startup_opportunity.contract_impact.current",
    topologyValid: true,
    baseRef: options.baseRef,
    baseRevision: gitState.baseRevision,
    currentRevision: gitState.currentRevision,
    changedFiles: gitState.changes,
    changedSchemas: changedSchemas.sort((left, right) => left.file.localeCompare(right.file)),
    changedPolicies: [...changedPolicies].sort(),
    changedModules: [...changedModuleMap]
      .map(([modulePath, impact]) => ({
        path: modulePath,
        families: [...impact.families].sort(),
        roles: [...impact.roles].sort(),
      }))
      .sort((left, right) => left.path.localeCompare(right.path)),
    affectedFamilies,
    researchImpactDimensions: affectedFamilies.map((family) => ({
      familyId: family.id,
      impact: family.researchImpact,
    })),
    recoveryBoundaries: affectedFamilies.map((family) => ({
      familyId: family.id,
      boundaries: family.recoveryBoundaries,
    })),
    recommendedFocusedTests,
    unknownImpact: unknownImpact.sort((left, right) =>
      [left.path, left.reason].join("\0").localeCompare([right.path, right.reason].join("\0")),
    ),
    topologyIssues: [],
  };
}

function formatList(values: readonly string[]): string {
  return values.length === 0 ? "none" : values.join(", ");
}

export function formatContractImpact(result: ContractImpactResult): string {
  const lines = [
    `Contract impact from ${result.baseRef} (${result.baseRevision}) to ${result.currentRevision}`,
    `Topology: ${result.topologyValid ? "valid" : "invalid"}`,
    `Changed files: ${result.changedFiles.length}`,
    `Changed schemas: ${formatList(result.changedSchemas.map((schema) => schema.file))}`,
    `Changed policies: ${formatList(result.changedPolicies)}`,
    `Changed modules: ${formatList(result.changedModules.map((module) => module.path))}`,
    "",
    "Structural schema changes:",
  ];
  if (result.changedSchemas.length === 0) {
    lines.push("  none");
  }
  for (const schema of result.changedSchemas) {
    lines.push(`  ${schema.file}: ${formatList(schema.changedJsonPointers)}`);
    lines.push(`    forward refs: ${formatList(schema.forwardReferences)}`);
    lines.push(`    reverse refs: ${formatList(schema.reverseReferences)}`);
  }
  lines.push("", "Affected contract families:");
  if (result.affectedFamilies.length === 0) {
    lines.push("  none");
  }
  for (const family of result.affectedFamilies) {
    lines.push(`  ${family.id}: ${family.domain}`);
    lines.push(`    owners: ${formatList(family.owners)}`);
    lines.push(`    consumers: ${formatList(family.consumers)}`);
    lines.push(`    projections: ${formatList(family.reportProjections)}`);
    lines.push(
      `    preserved inputs/roles: ${formatList(family.researchImpact.preservedInputsAndRoles)}`,
    );
    lines.push(`    distinct states: ${formatList(family.researchImpact.distinctSemanticStates)}`);
    lines.push(
      `    possible decision effects: ${formatList(family.researchImpact.possibleDecisionEffects)}`,
    );
    const activeRecovery = Object.entries(family.recoveryBoundaries)
      .filter(([, affected]) => affected)
      .map(([boundary]) => boundary);
    lines.push(`    recovery: ${formatList(activeRecovery)}`);
  }
  lines.push("", "Recommended focused tests:");
  for (const command of result.recommendedFocusedTests) {
    lines.push(`  ${command}`);
  }
  lines.push("", "Unknown impact:");
  if (result.unknownImpact.length === 0) {
    lines.push("  none");
  }
  for (const unknown of result.unknownImpact) {
    lines.push(`  ${unknown.path}: ${unknown.reason}`);
  }
  if (result.topologyIssues.length > 0) {
    lines.push("", "Topology diagnostics:");
    for (const topologyIssue of result.topologyIssues) {
      lines.push(`  ${topologyIssue.code}: ${topologyIssue.message}`);
    }
  }
  return `${lines.join("\n")}\n`;
}
