import { readFile } from "node:fs/promises";
import path from "node:path";

export const SKELETON_VERSION = "g4.3" as const;

export const IMPLEMENTATION_STACK = {
  language: "TypeScript 7.0.2",
  runtime: "Node.js 24.18.x LTS",
  packageManager: "npm 11.16.x",
  lockfile: "package-lock.json v3",
} as const;

export const SKILL_REFERENCE_PATHS = [
  ".agents/skills/startup-opportunity/references/opportunity-discovery.md",
  ".agents/skills/startup-opportunity/references/concept-evidence-assessment.md",
  ".agents/skills/startup-opportunity/references/research-kernel.md",
  ".agents/skills/startup-opportunity/references/lane-catalog.md",
  ".agents/skills/startup-opportunity/references/artifact-contracts.md",
  ".agents/skills/startup-opportunity/references/comparison-policy.md",
  ".agents/skills/startup-opportunity/references/report-contract.md",
] as const;

export const CUSTOM_AGENT_PATHS = [
  ".codex/agents/lane-researcher.toml",
  ".codex/agents/evidence-auditor.toml",
  ".codex/agents/adversarial-reviewer.toml",
] as const;

export const CODEX_INTEGRATION_PATHS = [
  ".codex/config.toml",
  ".codex/hooks.json",
  ".codex/hooks/research-guard.ts",
  "docs/operations.md",
  "docs/sample-runs.md",
  "docs/current-contract-maintenance.md",
  "docs/plugin-decision.md",
  "harness/src/mcp/evidence-server.ts",
  "tests/g4-integration.test.ts",
  "tests/g4-operational.test.ts",
  "tests/g4-clean-checkout.test.ts",
  "tests/fixtures/g4/README.md",
  "tests/fixtures/g4/synthetic-evidence.txt",
] as const;

export const IMPLEMENTED_SKILL_COMMANDS = [
  "doctor",
  "validate-artifact",
  "create-run",
  "status-run",
  "load-run",
  "record-evidence",
  "publish-artifact",
  "checkpoint-run",
  "validate-plan",
  "analyze-gaps",
  "validate-adaptation",
  "apply-plan-revision",
  "calculate-comparison",
  "calculate-sensitivity",
  "audit-traceability",
  "build-report",
] as const;

export const CURRENT_SCHEMA_PATHS = [
  "harness/schemas/current.json",
  "harness/schemas/current/artifact-envelope.schema.json",
  "harness/schemas/current/artifact-store-operation.schema.json",
  "harness/schemas/current/document-bundle.schema.json",
  "harness/schemas/current/research-publication-policy.schema.json",
  "harness/policies/research-publication.current.json",
] as const;

export const VALIDATOR_SOURCE_PATHS = [
  "harness/src/validators/schema-bundle.ts",
  "harness/src/validators/current-contract.ts",
  "harness/src/validators/artifact-validator.ts",
  "harness/src/validators/declarative-runtime-validator.ts",
  "harness/src/validators/assessment-execution-policy.ts",
  "harness/src/validators/assessment-execution-validator.ts",
  "harness/src/validators/ai-bundle-validator.ts",
  "harness/src/validators/assess-domain-validator.ts",
  "harness/src/validators/research-branch-validator.ts",
  "harness/src/validators/assessment-adaptation-identities.ts",
  "harness/src/validators/assessment-adaptation-validator.ts",
  "harness/src/validators/assessment-reporting-policy.ts",
  "harness/src/validators/g1.4-validator.ts",
  "harness/src/validators/discovery-maps-policy.ts",
  "harness/src/validators/discovery-maps-validator.ts",
  "harness/src/validators/discovery-candidate-policy.ts",
  "harness/src/validators/discovery-candidate-validator.ts",
  "harness/src/validators/discovery-synthesis-policy.ts",
  "harness/src/validators/discovery-synthesis-validator.ts",
  "harness/src/validators/discovery-evaluation-policy.ts",
  "harness/src/validators/discovery-evaluation-validator.ts",
  "harness/src/reporting/report-consistency.ts",
  "harness/src/validators/terminal-reporting-validator.ts",
  "harness/src/adaptation/discovery-adaptation-policy.ts",
  "harness/src/validators/planning-contract-identities.ts",
  "harness/src/validators/planning-contract-validator.ts",
  "harness/src/validators/validate-artifact-command.ts",
  "harness/src/adaptation/contracts.ts",
  "harness/src/adaptation/plan-validator.ts",
  "harness/src/adaptation/gap-analyzer.ts",
  "harness/src/adaptation/assessment-gap-analyzer.ts",
  "harness/src/adaptation/assessment-policy.ts",
  "harness/src/adaptation/adaptation-validator.ts",
  "harness/src/adaptation/apply-policy.ts",
  "harness/src/adaptation/plan-transformer.ts",
  "harness/src/adaptation/plan-runtime.ts",
  "harness/src/adaptation/adaptation-commands.ts",
] as const;

export const STORE_SOURCE_PATHS = [
  "harness/src/artifact-store/atomic-file.ts",
  "harness/src/artifact-store/canonical.ts",
  "harness/src/artifact-store/path-policy.ts",
  "harness/src/artifact-store/run-lock.ts",
  "harness/src/artifact-store/store-error.ts",
  "harness/src/artifact-store/artifact-store.ts",
  "harness/src/artifact-store/publication-policy.ts",
  "harness/src/run-store/jsonl-store.ts",
  "harness/src/run-store/run-store.ts",
  "harness/src/run-store/store-commands.ts",
  "harness/src/evidence-store/evidence-store.ts",
  "harness/src/reporting/report-runtime.ts",
  "harness/src/reporting/report-commands.ts",
  "harness/src/reporting/terminal-reporting.ts",
  "harness/src/runtime/declarative-runtime.ts",
  "harness/src/runtime/runtime-commands.ts",
  "harness/src/runtime/assessment-execution.ts",
] as const;

export const SKILL_SCRIPT_PATHS = [
  ...IMPLEMENTED_SKILL_COMMANDS.map(
    (command) => `.agents/skills/startup-opportunity/scripts/${command}.ts`,
  ),
] as const;

export const RESPONSIBILITY_PATHS = [
  "harness/README.md",
  "harness/schemas/README.md",
  "harness/policies/README.md",
  "harness/templates/README.md",
  "harness/evals/README.md",
  "harness/src/run-store/README.md",
  "harness/src/evidence-store/README.md",
  "harness/src/artifact-store/README.md",
  "harness/src/validators/README.md",
  "harness/src/adaptation/README.md",
  "harness/src/comparison/README.md",
  "harness/src/reporting/README.md",
  "harness/policies/adaptation.v1.json",
  "harness/policies/ai-trigger-source-binding.current.json",
  "harness/policies/plan-revision-apply.v1.json",
  "harness/policies/assessment-adaptation.v1.json",
  "harness/policies/assessment-reporting.v1.json",
  "harness/policies/discovery-maps.v1.json",
  "harness/policies/discovery-candidates.v1.json",
  "harness/policies/discovery-synthesis.v1.json",
  "harness/policies/discovery-adaptation-binding.v1.json",
  "harness/policies/discovery-evaluation.v3.json",
  "harness/policies/assessment-execution.v1.json",
  "tests/fixtures/README.md",
  "tests/fixtures/g1.2/README.md",
  "tests/fixtures/g1.3/README.md",
  "tests/fixtures/g1.3/assessment-adaptation-cases.json",
  "tests/fixtures/g1.4/README.md",
  "tests/fixtures/g1.4/assessment-report-cases.json",
  "tests/fixtures/g2.1/README.md",
  "tests/fixtures/g2.1/discovery-map-cases.json",
  "tests/fixtures/g2.1/discovery-maps-fixture.ts",
  "tests/g2.1-discovery-maps.test.ts",
  "tests/fixtures/g2.2/README.md",
  "tests/fixtures/g2.2/discovery-candidate-cases.json",
  "tests/fixtures/g2.2/discovery-candidate-fixture.ts",
  "tests/fixtures/g2.2/discovery-runtime-fixture.ts",
  "tests/g2.2-discovery-runtime.test.ts",
  "tests/fixtures/g2.3/README.md",
  "tests/fixtures/g2.3/discovery-synthesis-fixture.ts",
  "tests/g2.3-discovery-synthesis.test.ts",
  "tests/fixtures/g2.4/README.md",
  "tests/fixtures/g2.4/discovery-evaluation-fixture.ts",
  "tests/g2.4-discovery-evaluation.test.ts",
  "tests/fixtures/g3/README.md",
  "tests/fixtures/g3/ai-bundle-fixture.ts",
  "tests/g3.1-ai-contracts.test.ts",
  "tests/g3.2-ai-economics.test.ts",
  "tests/g3.3-ai-mandatory-bundle.test.ts",
  "tests/evals/README.md",
  "runs/.gitkeep",
] as const;

export const REQUIRED_REPOSITORY_PATHS = [
  ".node-version",
  ".npmrc",
  "AGENTS.md",
  "README.md",
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  ".agents/skills/startup-opportunity/SKILL.md",
  ...SKILL_REFERENCE_PATHS,
  ...SKILL_SCRIPT_PATHS,
  ...CUSTOM_AGENT_PATHS,
  ...CODEX_INTEGRATION_PATHS,
  ...RESPONSIBILITY_PATHS,
  ...CURRENT_SCHEMA_PATHS,
  ...VALIDATOR_SOURCE_PATHS,
  ...STORE_SOURCE_PATHS,
  "harness/src/comparison/comparison-commands.ts",
  "scripts/validate-current-contract.ts",
  "tests/current-contract-architecture.test.ts",
] as const;

const FORBIDDEN_LOCKFILES = [
  "bun.lock",
  "bun.lockb",
  "deno.lock",
  "pnpm-lock.yaml",
  "uv.lock",
  "yarn.lock",
] as const;

export interface DoctorCheck {
  readonly id: string;
  readonly status: "pass" | "fail";
  readonly detail: string;
}

export interface DoctorReport {
  readonly schemaVersion: "startup_opportunity.repository_doctor.v1";
  readonly skeletonVersion: typeof SKELETON_VERSION;
  readonly ok: boolean;
  readonly stack: typeof IMPLEMENTATION_STACK;
  readonly checks: readonly DoctorCheck[];
}

async function readNonEmptyFile(root: string, relativePath: string): Promise<DoctorCheck> {
  try {
    const contents = await readFile(path.join(root, relativePath), "utf8");
    return contents.trim().length > 0
      ? { id: `path:${relativePath}`, status: "pass", detail: "present and non-empty" }
      : { id: `path:${relativePath}`, status: "fail", detail: "file is empty" };
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unreadable file";
    return { id: `path:${relativePath}`, status: "fail", detail };
  }
}

async function checkForbiddenLockfile(root: string, filename: string): Promise<DoctorCheck> {
  try {
    await readFile(path.join(root, filename));
    return {
      id: `single-lockfile:${filename}`,
      status: "fail",
      detail: `${filename} introduces a second package-management stack`,
    };
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
    return code === "ENOENT"
      ? { id: `single-lockfile:${filename}`, status: "pass", detail: "absent" }
      : { id: `single-lockfile:${filename}`, status: "fail", detail: "could not inspect path" };
  }
}

async function checkPackageMetadata(root: string): Promise<DoctorCheck> {
  try {
    const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")) as {
      engines?: { node?: string; npm?: string };
      packageManager?: string;
    };
    const valid =
      packageJson.engines?.node === "24.18.x" &&
      packageJson.engines.npm === "11.16.x" &&
      packageJson.packageManager === "npm@11.16.0";
    return {
      id: "toolchain:package-metadata",
      status: valid ? "pass" : "fail",
      detail: valid ? "Node/npm metadata is frozen" : "package metadata drifted from G0.1",
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : "invalid package metadata";
    return { id: "toolchain:package-metadata", status: "fail", detail };
  }
}

function checkRuntime(): DoctorCheck {
  const valid = process.versions.node === "24.18.0";
  return {
    id: "toolchain:runtime",
    status: valid ? "pass" : "fail",
    detail: valid
      ? `running Node.js ${process.versions.node}`
      : `expected Node.js 24.18.0, received ${process.versions.node}`,
  };
}

export async function inspectRepository(root: string): Promise<DoctorReport> {
  const checks = await Promise.all([
    ...REQUIRED_REPOSITORY_PATHS.map((relativePath) => readNonEmptyFile(root, relativePath)),
    ...FORBIDDEN_LOCKFILES.map((filename) => checkForbiddenLockfile(root, filename)),
    checkPackageMetadata(root),
  ]);
  const allChecks = [...checks, checkRuntime()];

  return {
    schemaVersion: "startup_opportunity.repository_doctor.v1",
    skeletonVersion: SKELETON_VERSION,
    ok: allChecks.every((check) => check.status === "pass"),
    stack: IMPLEMENTATION_STACK,
    checks: allChecks,
  };
}
