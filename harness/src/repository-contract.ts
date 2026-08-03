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

export const SCHEMA_BUNDLE_PATHS = [
  "harness/schemas/bundle.v18.json",
  "harness/schemas/bundle.v17.json",
  "harness/schemas/bundle.v16.json",
  "harness/schemas/bundle.v15.json",
  "harness/schemas/bundle.v14.json",
  "harness/schemas/bundle.v13.json",
  "harness/schemas/bundle.v12.json",
  "harness/schemas/bundle.v11.json",
  "harness/schemas/bundle.v10.json",
  "harness/schemas/bundle.v9.json",
  "harness/schemas/bundle.v8.json",
  "harness/schemas/bundle.v7.json",
  "harness/schemas/bundle.v6.json",
  "harness/schemas/bundle.v5.json",
  "harness/schemas/bundle.v4.json",
  "harness/schemas/bundle.v3.json",
  "harness/schemas/bundle.v2.2.json",
  "harness/schemas/bundle.v2.1.json",
  "harness/schemas/bundle.v2.json",
  "harness/schemas/v1/bundle.json",
  "harness/schemas/v1/definitions.schema.json",
  "harness/schemas/v1/artifact-envelope.schema.json",
  "harness/schemas/v1/run-manifest.schema.json",
  "harness/schemas/v1/research-plan.schema.json",
  "harness/schemas/v1/gap-snapshot.schema.json",
  "harness/schemas/v1/adaptation-decision.schema.json",
  "harness/schemas/v1/event.schema.json",
  "harness/schemas/v1/decision.schema.json",
  "harness/schemas/v1/checkpoint.schema.json",
  "harness/schemas/v1/document-bundle.schema.json",
  "harness/schemas/v2/planning-context.schema.json",
  "harness/schemas/v2/coverage-attestation.schema.json",
  "harness/schemas/v2/adaptation-policy.schema.json",
  "harness/schemas/v2/adaptation-decision.schema.json",
  "harness/schemas/v2/artifact-envelope.schema.json",
  "harness/schemas/v2/document-bundle.schema.json",
  "harness/schemas/v2/planning-context-v2.schema.json",
  "harness/schemas/v2/ai-trigger-source-attestation.schema.json",
  "harness/schemas/v2/ai-trigger-source-binding-policy.schema.json",
  "harness/schemas/v3/artifact-envelope.schema.json",
  "harness/schemas/v3/document-bundle.schema.json",
  "harness/schemas/v3/plan-revision-apply-policy.schema.json",
  "harness/schemas/v4/definitions.schema.json",
  "harness/schemas/v4/intake.schema.json",
  "harness/schemas/v4/decision-context.schema.json",
  "harness/schemas/v4/scope-frame.schema.json",
  "harness/schemas/v4/concept-hypothesis.schema.json",
  "harness/schemas/v4/judgment-assessment.schema.json",
  "harness/schemas/v4/concept-evidence-assessment-plan.schema.json",
  "harness/schemas/v4/concept-evidence-assessment-branch-result.schema.json",
  "harness/schemas/v4/concept-evidence-assessment-fan-in.schema.json",
  "harness/schemas/v4/hypothesis-evidence-matrix.schema.json",
  "harness/schemas/v4/business-engine-thesis.schema.json",
  "harness/schemas/v4/concept-evidence-assessment.schema.json",
  "harness/schemas/v4/artifact-envelope.schema.json",
  "harness/schemas/v4/document-bundle.schema.json",
  "harness/schemas/v5/definitions.schema.json",
  "harness/schemas/v5/evidence-substrate-record.schema.json",
  "harness/schemas/v5/research-task.schema.json",
  "harness/schemas/v5/evidence.schema.json",
  "harness/schemas/v5/claim.schema.json",
  "harness/schemas/v5/finding.schema.json",
  "harness/schemas/v5/insight.schema.json",
  "harness/schemas/v5/source-manifest.schema.json",
  "harness/schemas/v5/research-publication-policy.schema.json",
  "harness/schemas/v5/artifact-envelope.schema.json",
  "harness/schemas/v5/document-bundle.schema.json",
  "harness/schemas/v6/gap-snapshot-v2.schema.json",
  "harness/schemas/v6/adaptation-decision-v3.schema.json",
  "harness/schemas/v6/assessment-adaptation-policy.schema.json",
  "harness/schemas/v6/ai-trigger-source-binding-policy-v2.schema.json",
  "harness/schemas/v6/research-publication-policy-v2.schema.json",
  "harness/schemas/v6/artifact-envelope.schema.json",
  "harness/schemas/v6/document-bundle.schema.json",
  "harness/schemas/v7/definitions.schema.json",
  "harness/schemas/v7/evidence-audit.schema.json",
  "harness/schemas/v7/adversarial-review.schema.json",
  "harness/schemas/v7/concept-evidence-assessment-v2.schema.json",
  "harness/schemas/v7/traceability.schema.json",
  "harness/schemas/v7/concept-evidence-report.schema.json",
  "harness/schemas/v7/decision-brief.schema.json",
  "harness/schemas/v7/concept-evidence-report-view.schema.json",
  "harness/schemas/v7/report-consistency-evaluation.schema.json",
  "harness/schemas/v7/assessment-reporting-policy.schema.json",
  "harness/schemas/v7/research-publication-policy-v3.schema.json",
  "harness/schemas/v7/artifact-envelope.schema.json",
  "harness/schemas/v7/document-bundle.schema.json",
  "harness/schemas/v8/definitions.schema.json",
  "harness/schemas/v8/scope-frame-v2.schema.json",
  "harness/schemas/v8/seed-probe.schema.json",
  "harness/schemas/v8/opportunity-space-map.schema.json",
  "harness/schemas/v8/solution-space-map.schema.json",
  "harness/schemas/v8/discovery-maps-policy.schema.json",
  "harness/schemas/v8/research-publication-policy-v4.schema.json",
  "harness/schemas/v8/artifact-envelope.schema.json",
  "harness/schemas/v8/document-bundle.schema.json",
  "harness/schemas/v9/definitions.schema.json",
  "harness/schemas/v9/discovery-candidate.schema.json",
  "harness/schemas/v9/research-task-v2.schema.json",
  "harness/schemas/v9/evidence-v2.schema.json",
  "harness/schemas/v9/claim-v2.schema.json",
  "harness/schemas/v9/finding-v2.schema.json",
  "harness/schemas/v9/insight-v2.schema.json",
  "harness/schemas/v9/judgment-assessment-v2.schema.json",
  "harness/schemas/v9/source-manifest-v2.schema.json",
  "harness/schemas/v9/discovery-lane-result.schema.json",
  "harness/schemas/v9/discovery-fan-in.schema.json",
  "harness/schemas/v9/discovery-candidate-conversion.schema.json",
  "harness/schemas/v9/discovery-candidate-policy.schema.json",
  "harness/schemas/v9/artifact-envelope.schema.json",
  "harness/schemas/v9/document-bundle.schema.json",
  "harness/schemas/v10/discovery-fan-in-v2.schema.json",
  "harness/schemas/v10/research-publication-policy-v5.schema.json",
  "harness/schemas/v10/artifact-envelope.schema.json",
  "harness/schemas/v10/document-bundle.schema.json",
  "harness/schemas/v11/definitions.schema.json",
  "harness/schemas/v11/discovery-candidate-conversion-v2.schema.json",
  "harness/schemas/v11/demand-thesis.schema.json",
  "harness/schemas/v11/baseline-option.schema.json",
  "harness/schemas/v11/solution-hypothesis.schema.json",
  "harness/schemas/v11/solution-evaluation.schema.json",
  "harness/schemas/v11/opportunity-thesis.schema.json",
  "harness/schemas/v11/thesis-evaluation-snapshot.schema.json",
  "harness/schemas/v11/merge.schema.json",
  "harness/schemas/v11/discovery-synthesis-policy.schema.json",
  "harness/schemas/v11/research-publication-policy-v6.schema.json",
  "harness/schemas/v11/artifact-envelope.schema.json",
  "harness/schemas/v11/document-bundle.schema.json",
  "harness/schemas/v12/definitions.schema.json",
  "harness/schemas/v12/research-task-v3.schema.json",
  "harness/schemas/v12/evidence-v3.schema.json",
  "harness/schemas/v12/claim-v3.schema.json",
  "harness/schemas/v12/finding-v3.schema.json",
  "harness/schemas/v12/insight-v3.schema.json",
  "harness/schemas/v12/judgment-assessment-v3.schema.json",
  "harness/schemas/v12/source-manifest-v3.schema.json",
  "harness/schemas/v12/enrichment-branch-result.schema.json",
  "harness/schemas/v12/enrichment-fan-in.schema.json",
  "harness/schemas/v12/value-layer-analysis.schema.json",
  "harness/schemas/v12/user-state-context-model.schema.json",
  "harness/schemas/v12/buyer-purchase-language.schema.json",
  "harness/schemas/v12/business-engine-thesis-v2.schema.json",
  "harness/schemas/v12/opportunity-comparison.schema.json",
  "harness/schemas/v12/sensitivity.schema.json",
  "harness/schemas/v12/portfolio-view.schema.json",
  "harness/schemas/v12/decision-recommendation.schema.json",
  "harness/schemas/v12/traceability-v2.schema.json",
  "harness/schemas/v12/discovery-report.schema.json",
  "harness/schemas/v12/decision-brief-v2.schema.json",
  "harness/schemas/v12/discovery-report-view.schema.json",
  "harness/schemas/v12/report-consistency-evaluation-v2.schema.json",
  "harness/schemas/v12/discovery-evaluation-policy.schema.json",
  "harness/schemas/v12/research-publication-policy-v7.schema.json",
  "harness/schemas/v12/artifact-envelope.schema.json",
  "harness/schemas/v12/document-bundle.schema.json",
  "harness/schemas/v13/discovery-evaluation-policy-v2.schema.json",
  "harness/schemas/v13/discovery-adaptation-binding-policy.schema.json",
  "harness/schemas/v13/report-consistency-evaluation-v3.schema.json",
  "harness/schemas/v13/research-publication-policy-v8.schema.json",
  "harness/schemas/v13/artifact-envelope.schema.json",
  "harness/schemas/v13/document-bundle.schema.json",
  "harness/schemas/v14/ai-contract-definitions.schema.json",
  "harness/schemas/v14/capability-evidence.schema.json",
  "harness/schemas/v14/ai-capability-benchmark.schema.json",
  "harness/schemas/v14/ai-evaluation-reliability.schema.json",
  "harness/schemas/v14/ai-data-dependency.schema.json",
  "harness/schemas/v14/research-publication-policy-v9.schema.json",
  "harness/schemas/v14/artifact-envelope.schema.json",
  "harness/schemas/v14/document-bundle.schema.json",
  "harness/schemas/v15/ai-inference-unit-economics.schema.json",
  "harness/schemas/v15/capability-commoditization-risk.schema.json",
  "harness/schemas/v15/ai-adoption-trust.schema.json",
  "harness/schemas/v15/research-publication-policy-v10.schema.json",
  "harness/schemas/v15/artifact-envelope.schema.json",
  "harness/schemas/v15/document-bundle.schema.json",
  "harness/schemas/v16/ai-bundle-definitions.schema.json",
  "harness/schemas/v16/ai-mandatory-bundle.schema.json",
  "harness/schemas/v16/discovery-evaluation-policy-v3.schema.json",
  "harness/schemas/v16/research-publication-policy-v11.schema.json",
  "harness/schemas/v16/artifact-envelope.schema.json",
  "harness/schemas/v16/document-bundle.schema.json",
  "harness/schemas/v17/terminal-report-source.schema.json",
  "harness/schemas/v17/decision-brief-v3.schema.json",
  "harness/schemas/v17/terminal-report-view.schema.json",
  "harness/schemas/v17/report-consistency-evaluation-v4.schema.json",
  "harness/schemas/v17/research-publication-policy-v12.schema.json",
  "harness/schemas/v17/artifact-envelope.schema.json",
  "harness/schemas/v17/document-bundle.schema.json",
  "harness/schemas/v18/runtime-artifact-compilation-request.schema.json",
  "harness/schemas/v18/runtime-artifact-compilation-result.schema.json",
  "harness/schemas/v18/research-execution-plan.schema.json",
  "harness/schemas/v18/dispatch-batch.schema.json",
  "harness/schemas/v18/lane-lifecycle.schema.json",
  "harness/schemas/v18/discovery-generation-result.schema.json",
  "harness/schemas/v18/candidate-neutral-evidence.schema.json",
  "harness/schemas/v18/discovery-stage-readiness.schema.json",
  "harness/schemas/v18/source-manifest-v4.schema.json",
  "harness/schemas/v18/gap-snapshot-v3.schema.json",
  "harness/schemas/v18/continuation-lineage-entry.schema.json",
  "harness/schemas/v18/research-publication-policy-v13.schema.json",
  "harness/schemas/v18/artifact-envelope.schema.json",
  "harness/schemas/v18/document-bundle.schema.json",
  "harness/schemas/v19/concept-hypothesis-v2.schema.json",
  "harness/schemas/v19/research-execution-plan-v2.schema.json",
  "harness/schemas/v19/dispatch-batch-v2.schema.json",
  "harness/schemas/v19/assessment-lane-result.schema.json",
  "harness/schemas/v19/assessment-stage-gate.schema.json",
  "harness/schemas/v19/assessment-followup-decision.schema.json",
  "harness/schemas/v19/assessment-execution-policy.schema.json",
  "harness/schemas/v19/research-publication-policy-v14.schema.json",
  "harness/schemas/v19/runtime-artifact-compilation-result-v2.schema.json",
  "harness/schemas/v19/artifact-envelope.schema.json",
  "harness/schemas/v19/document-bundle.schema.json",
] as const;

export const VALIDATOR_SOURCE_PATHS = [
  "harness/src/validators/schema-bundle.ts",
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
  "harness/policies/ai-trigger-source-binding.v1.json",
  "harness/policies/plan-revision-apply.v1.json",
  "harness/policies/research-publication.v1.json",
  "harness/policies/ai-trigger-source-binding.v2.json",
  "harness/policies/assessment-adaptation.v1.json",
  "harness/policies/research-publication.v2.json",
  "harness/policies/assessment-reporting.v1.json",
  "harness/policies/research-publication.v3.json",
  "harness/policies/discovery-maps.v1.json",
  "harness/policies/research-publication.v4.json",
  "harness/policies/discovery-candidates.v1.json",
  "harness/policies/research-publication.v5.json",
  "harness/policies/discovery-synthesis.v1.json",
  "harness/policies/research-publication.v6.json",
  "harness/policies/discovery-evaluation.v1.json",
  "harness/policies/research-publication.v7.json",
  "harness/policies/discovery-evaluation.v2.json",
  "harness/policies/discovery-adaptation-binding.v1.json",
  "harness/policies/research-publication.v8.json",
  "harness/policies/research-publication.v9.json",
  "harness/policies/research-publication.v10.json",
  "harness/policies/discovery-evaluation.v3.json",
  "harness/policies/research-publication.v11.json",
  "harness/policies/research-publication.v12.json",
  "harness/policies/research-publication.v13.json",
  "harness/policies/assessment-execution.v1.json",
  "harness/policies/research-publication.v14.json",
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
  ...SCHEMA_BUNDLE_PATHS,
  ...VALIDATOR_SOURCE_PATHS,
  ...STORE_SOURCE_PATHS,
  "harness/src/comparison/comparison-commands.ts",
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
