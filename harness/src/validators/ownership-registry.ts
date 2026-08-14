import { readFile } from "node:fs/promises";
import path from "node:path";

export const CURRENT_OWNERSHIP_REGISTRY_PATH = "harness/contracts/current-ownership.json" as const;

export const FIELD_OWNERSHIP_CATEGORIES = [
  "agent_authored",
  "harness_derived",
  "policy_derived",
  "store_identity",
  "report_projected",
] as const;

export const RECOVERY_BOUNDARY_KEYS = [
  "storeIdentity",
  "atomicPublication",
  "exactReplay",
  "checkpointReopen",
  "crashRecovery",
] as const;

export interface ContractSchemaSelector {
  readonly prefix: string;
}

export interface ContractRecoveryBoundaries {
  readonly storeIdentity: boolean;
  readonly atomicPublication: boolean;
  readonly exactReplay: boolean;
  readonly checkpointReopen: boolean;
  readonly crashRecovery: boolean;
}

export interface ContractResearchImpact {
  readonly preservedInputsAndRoles: readonly string[];
  readonly distinctSemanticStates: readonly string[];
  readonly possibleDecisionEffects: readonly string[];
}

export interface ContractOwnershipFamily {
  readonly id: string;
  readonly domain: string;
  readonly schemaSelectors: readonly ContractSchemaSelector[];
  readonly artifactTypeSelectors: readonly ContractSchemaSelector[];
  readonly directRuntimeRoots: readonly string[];
  readonly ownerModules: readonly string[];
  readonly producerModules: readonly string[];
  readonly consumerModules: readonly string[];
  readonly validatorModules: readonly string[];
  readonly policyPaths: readonly string[];
  readonly reportProjectionModules: readonly string[];
  readonly userVisibleOutputs: readonly string[];
  readonly focusedTests: readonly string[];
  readonly testScripts: readonly string[];
  readonly recoveryBoundaries: ContractRecoveryBoundaries;
  readonly fieldOwnership: {
    readonly scope: "family_level_phase_1";
    readonly categories: readonly (typeof FIELD_OWNERSHIP_CATEGORIES)[number][];
  };
  readonly researchImpact: ContractResearchImpact;
}

export interface SharedContractSchema {
  readonly schemaFile: string;
  readonly structuralOwner: string;
  readonly impactFamilies: readonly string[];
}

export interface ContractOwnershipRegistry {
  readonly schemaVersion: "startup_opportunity.engineering_contract_ownership.current";
  readonly authority: "engineering_topology_metadata_only";
  readonly families: readonly ContractOwnershipFamily[];
  readonly sharedSchemas: readonly SharedContractSchema[];
}

export interface OwnershipRegistryFormatIssue {
  readonly path: string;
  readonly message: string;
}

export class OwnershipRegistryFormatError extends Error {
  constructor(readonly issues: readonly OwnershipRegistryFormatIssue[]) {
    super("contract ownership registry is invalid");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactlyKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

function readStringArray(
  value: unknown,
  instancePath: string,
  issues: OwnershipRegistryFormatIssue[],
  requireNonEmpty = false,
): readonly string[] {
  if (
    !Array.isArray(value) ||
    (requireNonEmpty && value.length === 0) ||
    value.some((entry) => typeof entry !== "string" || entry === "")
  ) {
    issues.push({
      path: instancePath,
      message: requireNonEmpty
        ? "must be a non-empty array of non-empty strings"
        : "must be an array of non-empty strings",
    });
    return [];
  }
  if (new Set(value).size !== value.length) {
    issues.push({ path: instancePath, message: "must not contain duplicate values" });
  }
  return value as readonly string[];
}

function readSelectors(
  value: unknown,
  instancePath: string,
  issues: OwnershipRegistryFormatIssue[],
  allowEmpty = false,
): readonly ContractSchemaSelector[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    issues.push({
      path: instancePath,
      message: allowEmpty ? "must be a selector array" : "must be a non-empty selector array",
    });
    return [];
  }
  return value.flatMap((selector, index) => {
    const selectorPath = `${instancePath}/${index}`;
    if (
      !isRecord(selector) ||
      !hasExactlyKeys(selector, ["prefix"]) ||
      typeof selector.prefix !== "string" ||
      !/^current\/(?:[a-z][a-z0-9-]*\/)+$/u.test(selector.prefix)
    ) {
      issues.push({
        path: selectorPath,
        message: "must contain one deterministic current schema directory prefix",
      });
      return [];
    }
    return [{ prefix: selector.prefix }];
  });
}

function readRecoveryBoundaries(
  value: unknown,
  instancePath: string,
  issues: OwnershipRegistryFormatIssue[],
): ContractRecoveryBoundaries {
  if (!isRecord(value) || !hasExactlyKeys(value, RECOVERY_BOUNDARY_KEYS)) {
    issues.push({
      path: instancePath,
      message: "must declare every recovery boundary exactly once",
    });
  }
  const record = isRecord(value) ? value : {};
  for (const key of RECOVERY_BOUNDARY_KEYS) {
    if (typeof record[key] !== "boolean") {
      issues.push({ path: `${instancePath}/${key}`, message: "must be a boolean" });
    }
  }
  return {
    storeIdentity: record.storeIdentity === true,
    atomicPublication: record.atomicPublication === true,
    exactReplay: record.exactReplay === true,
    checkpointReopen: record.checkpointReopen === true,
    crashRecovery: record.crashRecovery === true,
  };
}

function readFamily(
  value: unknown,
  index: number,
  issues: OwnershipRegistryFormatIssue[],
): ContractOwnershipFamily | undefined {
  const instancePath = `/families/${index}`;
  const keys = [
    "artifactTypeSelectors",
    "consumerModules",
    "directRuntimeRoots",
    "domain",
    "fieldOwnership",
    "focusedTests",
    "id",
    "ownerModules",
    "policyPaths",
    "producerModules",
    "recoveryBoundaries",
    "reportProjectionModules",
    "researchImpact",
    "schemaSelectors",
    "testScripts",
    "userVisibleOutputs",
    "validatorModules",
  ];
  if (!isRecord(value) || !hasExactlyKeys(value, keys)) {
    issues.push({ path: instancePath, message: "has missing or unknown fields" });
    return undefined;
  }
  if (typeof value.id !== "string" || !/^[a-z][a-z0-9_]*$/u.test(value.id)) {
    issues.push({ path: `${instancePath}/id`, message: "must be a stable snake-case identifier" });
  }
  if (typeof value.domain !== "string" || value.domain === "") {
    issues.push({ path: `${instancePath}/domain`, message: "must be a non-empty string" });
  }

  const fieldOwnership = value.fieldOwnership;
  if (
    !isRecord(fieldOwnership) ||
    !hasExactlyKeys(fieldOwnership, ["categories", "scope"]) ||
    fieldOwnership.scope !== "family_level_phase_1"
  ) {
    issues.push({
      path: `${instancePath}/fieldOwnership`,
      message: "must declare Phase 1 family-level ownership",
    });
  }
  const categories = readStringArray(
    isRecord(fieldOwnership) ? fieldOwnership.categories : undefined,
    `${instancePath}/fieldOwnership/categories`,
    issues,
    true,
  );
  for (const category of categories) {
    if (!(FIELD_OWNERSHIP_CATEGORIES as readonly string[]).includes(category)) {
      issues.push({
        path: `${instancePath}/fieldOwnership/categories`,
        message: `unknown field ownership category: ${category}`,
      });
    }
  }

  const researchImpact = value.researchImpact;
  if (
    !isRecord(researchImpact) ||
    !hasExactlyKeys(researchImpact, [
      "distinctSemanticStates",
      "possibleDecisionEffects",
      "preservedInputsAndRoles",
    ])
  ) {
    issues.push({
      path: `${instancePath}/researchImpact`,
      message: "has missing or unknown fields",
    });
  }
  const impactRecord = isRecord(researchImpact) ? researchImpact : {};

  return {
    id: typeof value.id === "string" ? value.id : "invalid",
    domain: typeof value.domain === "string" ? value.domain : "invalid",
    schemaSelectors: readSelectors(
      value.schemaSelectors,
      `${instancePath}/schemaSelectors`,
      issues,
    ),
    artifactTypeSelectors: readSelectors(
      value.artifactTypeSelectors,
      `${instancePath}/artifactTypeSelectors`,
      issues,
      true,
    ),
    directRuntimeRoots: readStringArray(
      value.directRuntimeRoots,
      `${instancePath}/directRuntimeRoots`,
      issues,
    ),
    ownerModules: readStringArray(value.ownerModules, `${instancePath}/ownerModules`, issues, true),
    producerModules: readStringArray(
      value.producerModules,
      `${instancePath}/producerModules`,
      issues,
      true,
    ),
    consumerModules: readStringArray(
      value.consumerModules,
      `${instancePath}/consumerModules`,
      issues,
      true,
    ),
    validatorModules: readStringArray(
      value.validatorModules,
      `${instancePath}/validatorModules`,
      issues,
      true,
    ),
    policyPaths: readStringArray(value.policyPaths, `${instancePath}/policyPaths`, issues),
    reportProjectionModules: readStringArray(
      value.reportProjectionModules,
      `${instancePath}/reportProjectionModules`,
      issues,
      true,
    ),
    userVisibleOutputs: readStringArray(
      value.userVisibleOutputs,
      `${instancePath}/userVisibleOutputs`,
      issues,
      true,
    ),
    focusedTests: readStringArray(value.focusedTests, `${instancePath}/focusedTests`, issues, true),
    testScripts: readStringArray(value.testScripts, `${instancePath}/testScripts`, issues, true),
    recoveryBoundaries: readRecoveryBoundaries(
      value.recoveryBoundaries,
      `${instancePath}/recoveryBoundaries`,
      issues,
    ),
    fieldOwnership: {
      scope: "family_level_phase_1",
      categories: categories.filter((category) =>
        (FIELD_OWNERSHIP_CATEGORIES as readonly string[]).includes(category),
      ) as readonly (typeof FIELD_OWNERSHIP_CATEGORIES)[number][],
    },
    researchImpact: {
      preservedInputsAndRoles: readStringArray(
        impactRecord.preservedInputsAndRoles,
        `${instancePath}/researchImpact/preservedInputsAndRoles`,
        issues,
        true,
      ),
      distinctSemanticStates: readStringArray(
        impactRecord.distinctSemanticStates,
        `${instancePath}/researchImpact/distinctSemanticStates`,
        issues,
        true,
      ),
      possibleDecisionEffects: readStringArray(
        impactRecord.possibleDecisionEffects,
        `${instancePath}/researchImpact/possibleDecisionEffects`,
        issues,
        true,
      ),
    },
  };
}

function readSharedSchema(
  value: unknown,
  index: number,
  issues: OwnershipRegistryFormatIssue[],
): SharedContractSchema | undefined {
  const instancePath = `/sharedSchemas/${index}`;
  if (
    !isRecord(value) ||
    !hasExactlyKeys(value, ["impactFamilies", "schemaFile", "structuralOwner"])
  ) {
    issues.push({ path: instancePath, message: "has missing or unknown fields" });
    return undefined;
  }
  if (
    typeof value.schemaFile !== "string" ||
    !/^current\/.+\.schema\.json$/u.test(value.schemaFile)
  ) {
    issues.push({ path: `${instancePath}/schemaFile`, message: "must be a current schema file" });
  }
  if (typeof value.structuralOwner !== "string" || value.structuralOwner === "") {
    issues.push({ path: `${instancePath}/structuralOwner`, message: "must name one family" });
  }
  return {
    schemaFile: typeof value.schemaFile === "string" ? value.schemaFile : "invalid",
    structuralOwner: typeof value.structuralOwner === "string" ? value.structuralOwner : "invalid",
    impactFamilies: readStringArray(value.impactFamilies, `${instancePath}/impactFamilies`, issues),
  };
}

export async function loadContractOwnershipRegistry(
  root = process.cwd(),
): Promise<ContractOwnershipRegistry> {
  const absolutePath = path.join(root, CURRENT_OWNERSHIP_REGISTRY_PATH);
  let value: unknown;
  try {
    value = JSON.parse(await readFile(absolutePath, "utf8")) as unknown;
  } catch (error) {
    throw new OwnershipRegistryFormatError([
      {
        path: "",
        message: error instanceof Error ? error.message : "registry could not be read",
      },
    ]);
  }
  const issues: OwnershipRegistryFormatIssue[] = [];
  if (
    !isRecord(value) ||
    !hasExactlyKeys(value, ["authority", "families", "schema_version", "shared_schemas"])
  ) {
    throw new OwnershipRegistryFormatError([
      { path: "", message: "registry root has missing or unknown fields" },
    ]);
  }
  if (value.schema_version !== "startup_opportunity.engineering_contract_ownership.current") {
    issues.push({ path: "/schema_version", message: "unexpected engineering registry version" });
  }
  if (value.authority !== "engineering_topology_metadata_only") {
    issues.push({
      path: "/authority",
      message: "registry must identify itself as topology metadata",
    });
  }
  if (!Array.isArray(value.families) || value.families.length === 0) {
    issues.push({ path: "/families", message: "must be a non-empty array" });
  }
  if (!Array.isArray(value.shared_schemas)) {
    issues.push({ path: "/shared_schemas", message: "must be an array" });
  }
  const families = Array.isArray(value.families)
    ? value.families.flatMap((family, index) => {
        const parsed = readFamily(family, index, issues);
        return parsed === undefined ? [] : [parsed];
      })
    : [];
  const sharedSchemas = Array.isArray(value.shared_schemas)
    ? value.shared_schemas.flatMap((schema, index) => {
        const parsed = readSharedSchema(schema, index, issues);
        return parsed === undefined ? [] : [parsed];
      })
    : [];
  if (issues.length > 0) {
    throw new OwnershipRegistryFormatError(
      issues.sort((left, right) =>
        [left.path, left.message].join("\0").localeCompare([right.path, right.message].join("\0")),
      ),
    );
  }
  return {
    schemaVersion: "startup_opportunity.engineering_contract_ownership.current",
    authority: "engineering_topology_metadata_only",
    families,
    sharedSchemas,
  };
}

export function selectorMatchesSchemaFile(
  selector: ContractSchemaSelector,
  schemaFile: string,
): boolean {
  return schemaFile.startsWith(selector.prefix);
}
