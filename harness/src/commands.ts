import { type DoctorReport, inspectRepository } from "./repository-contract.js";

const HELP = `Startup Opportunity Research Harness (G4.4)

Usage:
  ./scripts/activate-frozen-toolchain.sh npm run harness -- help
  ./scripts/activate-frozen-toolchain.sh npm run harness -- doctor --json
  npm run harness -- help
  npm run harness -- <command> --help
  npm run harness -- doctor [--json]
  npm run harness -- validate-artifact (--file FILE | --bundle FILE | --schema-bundle) [--json]
  npm run harness -- create-run --run-id ID --mode MODE --geography GEO --customer-model MODEL --target-user USER --decision-goal GOAL --research-language LANG [--created-at TIME]
  npm run harness -- propose-scope --run-id ID --expected-scope-revision N --geography GEO --customer-model MODEL --target-user USER --decision-goal GOAL --research-language LANG --reason REASON
  npm run harness -- confirm-scope --run-id ID --expected-scope-proposal-revision N --expected-scope-proposal-ref REF --expected-scope-proposal-hash HASH --user-confirmation-attestation TEXT
  npm run harness -- load-run --run-id ID [--observe]
  npm run harness -- status-run --run-id ID
  npm run harness -- admit-prior-input --run-id ID --prior-input-id ID --source-run-id ID --source-artifact-path PATH --target-artifact-path PATH --consumer CONSUMER --reason REASON
  npm run harness -- read-prior-input --run-id ID --admission-ref REF
  npm run harness -- create-research-handoff --file FILE [--runs-root DIR]
  npm run harness -- read-research-handoff --run-id ID --handoff-ref REF --item-id ID [--item-id ID]
  npm run harness -- reform-decision-subject --run-id ID --terminal-snapshot-ref REF --terminal-subject-id ID --reformed-subject-ref REF --reformation-input-ref REF --reason REASON
  npm run harness -- record-evidence --run-id ID --unit-id ID (--source-url URL | --source-uri URN) --research-goal GOAL --content-file FILE
  npm run harness -- publish-artifact --file FILE [--runs-root DIR]
  npm run harness -- compile-artifacts --file FILE [--runs-root DIR] [--observe]
  npm run harness -- materialize-formal-stage --file FILE [--runs-root DIR] [--observe]
  npm run harness -- register-dispatch-launches --file FILE [--runs-root DIR]
  npm run harness -- check-dispatch-launches --run-id ID --dispatch-ref REF --dispatch-hash HASH [--runs-root DIR]
  npm run harness -- materialize-lane-result --file FILE [--runs-root DIR] [--observe]
  npm run harness -- scaffold-lane-submission --run-id ID --task-ref REF [--runs-root DIR]
  npm run harness -- scaffold-artifact --file FILE
  npm run harness -- checkpoint-run --file FILE
  npm run harness -- validate-plan --bundle FILE [--run-id ID] [--runs-root DIR] [--json]
  npm run harness -- analyze-gaps --file FILE [--run-id ID] [--runs-root DIR] [--json]
  npm run harness -- validate-adaptation --bundle FILE [--run-id ID] [--runs-root DIR] [--json]
  npm run harness -- apply-plan-revision --file FILE [--runs-root DIR] [--json]
  npm run harness -- author-plan-adaptation --file FILE [--runs-root DIR] [--json]
  npm run harness -- calculate-comparison --bundle FILE [--json]
  npm run harness -- calculate-sensitivity --bundle FILE [--json]
  npm run harness -- audit-traceability --bundle FILE [--json]
  npm run harness -- build-report --file FILE [--runs-root DIR] [--json] [--observe]

Commands:
  help               Show the implemented deterministic Harness command surface.
  doctor             Validate repository, toolchain, Skill, agent, Harness, and test contracts.
  validate-artifact  Validate one document, a typed document bundle, or the schema bundle itself.
  create-run         Persist a confined Run and exact Scope proposal awaiting confirmation.
  propose-scope      Append a corrected Scope proposal without claiming user confirmation.
  confirm-scope      Bind caller-attested confirmation to the exact proposal revision/ref/hash.
  load-run           Validate, reconcile, and reopen a persisted Run.
  status-run         Read and validate current Run manifest state without recovery or mutation.
  admit-prior-input  Hash one explicitly named prior-Run artifact and append its hypothesis-only admission receipt.
  read-prior-input   Read exact admitted bytes through a provenance-tainting controlled boundary.
  create-research-handoff Capture user-authorized current-contract prior research into one target-Run handoff.
  read-research-handoff Read selected exact payloads only from a same-Run formal handoff.
  reform-decision-subject Append an exact causal Decision for a post-terminal immutable subject revision.
  record-evidence    Persist raw evidence with canonical hashes and deterministic deduplication.
  publish-artifact   Validate and publish one formal envelope or an explicit envelope bundle.
  compile-artifacts  Compile semantic JSON into an immutable publication plan, Run closure, and optional publication.
  materialize-formal-stage Project one declared Wave or explicit setup/fan-in/synthesis object batch through the current compiler.
  register-dispatch-launches Atomically record caller-declared starts for exact Dispatch tasks as Lane Lifecycle revisions.
  check-dispatch-launches Read the exact Dispatch launch checklist and started/not-started set difference.
  materialize-lane-result Materialize a caller-supplied lane staging document through the same compiler.
  scaffold-lane-submission Derive an unfilled minimum coverage checklist from one exact current Task.
  scaffold-artifact  Produce a schema-valid structural scaffold without research judgment.
  checkpoint-run     Publish an immutable checkpoint from a JSON input document.
  validate-plan      Validate Planning Context v2 and full Research Plan semantics; --run-id assembles persisted authority.
  analyze-gaps       Build a deterministic Gap draft; --run-id assembles persisted current/history authority.
  validate-adaptation Validate closed actions; --run-id assembles persisted current/history authority.
  apply-plan-revision Apply validated actions through CAS and immutable Plan Revision receipts.
  author-plan-adaptation Build, validate, publish, or atomically apply a current Gap/Adaptation author request.
  calculate-comparison Validate and summarize caller-supplied G2.4 comparison Artifacts.
  calculate-sensitivity Validate and summarize the caller-supplied G2.4 sensitivity Artifact.
  audit-traceability Validate a closed G1.4 assessment or G2.4 discovery traceability/report chain.
  build-report       Publish a non-terminal assessment/discovery report and materialize its views.

Bootstrap:
  Use ./scripts/activate-frozen-toolchain.sh for the first npm command and any later command launched from an unactivated parent shell. The bootstrap selects an installed Node.js 24.18.0/npm 11.16.0 pair for the child command and fails closed with installation/activation diagnostics when unavailable.

The optional --observe flag on long deterministic operations writes phase/count/timing JSONL to stderr without changing stdout results or formal Run state. Terminal report sources are accepted only by the atomic terminal apply-plan-revision closeout or author-plan-adaptation apply; build-report cannot publish them independently. Validation, publication, recovery, comparison/sensitivity summaries, and report materialization success are mechanical only. Caller-supplied Artifacts use the generic validation/publication surface. The Harness does not dispatch agents, execute lanes, synthesize thesis or evaluation semantics, perform network research, infer research judgments, or claim Evidence/market validation success.
`;

export function printHelp(
  write: (text: string) => void = process.stdout.write.bind(process.stdout),
) {
  write(HELP);
}

const COMMAND_HELP: Readonly<Record<string, string>> = {
  help: `Usage:
  npm run harness -- help

Show the deterministic Harness command surface.
`,
  doctor: `Usage:
  npm run harness -- doctor [--json]

Validates repository, toolchain, Skill, agent, Harness, and test contracts.
`,
  "validate-artifact": `Usage:
  npm run harness -- validate-artifact (--file FILE | --bundle FILE | --schema-bundle) [--json]

Validates one document, a typed document bundle, or the current schema bundle.
`,
  "create-run": `Usage:
  npm run harness -- create-run --run-id ID --mode MODE --geography GEO --customer-model MODEL --target-user USER --decision-goal GOAL --research-language LANG [--created-at TIME] [--runs-root DIR]

Creates a confined Run and exact Scope proposal. Repeat --target-user to provide multiple explicit user groups.
`,
  "propose-scope": `Usage:
  npm run harness -- propose-scope --run-id ID --expected-scope-revision N --geography GEO --customer-model MODEL --target-user USER --decision-goal GOAL --research-language LANG --reason REASON [--proposed-at TIME] [--runs-root DIR]

Appends a corrected Scope proposal without claiming user confirmation.
`,
  "confirm-scope": `Usage:
  npm run harness -- confirm-scope --run-id ID --expected-scope-proposal-revision N --expected-scope-proposal-ref REF --expected-scope-proposal-hash HASH --user-confirmation-attestation TEXT [--confirmed-at TIME] [--runs-root DIR]

Binds caller-attested user confirmation to the exact Scope proposal revision/ref/hash.
`,
  "load-run": `Usage:
  npm run harness -- load-run --run-id ID [--runs-root DIR] [--observe]

Validates, reconciles, and reopens a persisted Run.
`,
  "status-run": `Usage:
  npm run harness -- status-run --run-id ID [--runs-root DIR]

Reads current Run manifest state and startup diagnostics without recovery or mutation.
`,
  "admit-prior-input": `Usage:
  npm run harness -- admit-prior-input --run-id ID --prior-input-id ID --source-run-id ID --source-artifact-path PATH --target-artifact-path PATH --consumer CONSUMER --reason REASON [--admitted-at TIME] [--runs-root DIR]

Hashes one explicitly named prior-Run artifact and appends its hypothesis-only admission receipt.
`,
  "read-prior-input": `Usage:
  npm run harness -- read-prior-input --run-id ID --admission-ref REF [--consumed-at TIME] [--runs-root DIR]

Reads exact admitted bytes through the provenance-tainting controlled boundary.
`,
  "create-research-handoff": `Usage:
  npm run harness -- create-research-handoff --file FILE [--runs-root DIR]

Reads a JSON handoff request and captures user-authorized current-contract prior research into one target-Run handoff.
`,
  "read-research-handoff": `Usage:
  npm run harness -- read-research-handoff --run-id ID --handoff-ref REF --item-id ID [--item-id ID] [--consumed-at TIME] [--runs-root DIR]

Reads selected exact payloads only from a same-Run formal handoff.
`,
  "reform-decision-subject": `Usage:
  npm run harness -- reform-decision-subject --run-id ID --terminal-snapshot-ref REF --terminal-subject-id ID --reformed-subject-ref REF --reformation-input-ref REF --reason REASON [--reformed-at TIME] [--runs-root DIR]

Appends an exact causal Decision for a post-terminal immutable subject revision.
`,
  "record-evidence": `Usage:
  npm run harness -- record-evidence --run-id ID --unit-id ID (--source-url URL | --source-uri URN) --research-goal GOAL --content-file FILE [--recorded-at TIME] [--operation-key KEY] [--runs-root DIR]

Stores caller-supplied raw bytes with canonical hashes. It never fetches URLs and does not make Evidence true or sufficient.
`,
  "publish-artifact": `Usage:
  npm run harness -- publish-artifact --file FILE [--runs-root DIR]

Publishes one formal envelope or a document bundle of formal envelopes. Initial Plan publication runs zero-write preflight before any artifact write.
`,
  "compile-artifacts": `Usage:
  npm run harness -- compile-artifacts --file FILE [--runs-root DIR] [--observe]

Request entry:
  schema_version=startup_opportunity.runtime_artifact_compilation_request.v1
  operation=validate_only returns an immutable publication_plan without Run writes.
  operation=publish requires the exact prior publication_plan.

Use this for caller-supplied formal Artifacts outside the higher-level formal-stage interface.
`,
  "materialize-formal-stage": `Usage:
  npm run harness -- materialize-formal-stage --file FILE [--runs-root DIR] [--observe]

Request entry:
  schema_version=startup_opportunity.formal_stage_materialization_request.current
  operation=validate_only returns the exact publication_plan with zero Run writes.
  operation=publish requires the exact prior publication_plan.
  stage_kind is one of discovery_wave, discovery_setup, candidate_fan_in, g2_3_synthesis.

Minimal discovery_wave scaffold:
{
  "schema_version": "startup_opportunity.formal_stage_materialization_request.current",
  "request_id": "request_id",
  "run_id": "run_id",
  "operation": "validate_only",
  "created_at": "2026-01-01T00:00:00Z",
  "stage_kind": "discovery_wave",
  "wave": {
    "wave_id": "current_plan_wave_id",
    "stage_id": "stage_id",
    "stage_kind": "discovery_generation",
    "unit_ids": ["unit_id"],
    "lanes": [{
      "unit_id": "unit_id",
      "lane_role": "opportunity",
      "candidate_scope": { "kind": "none", "candidate_refs": [] },
      "incumbent_response_assignment": { "analysis_depth": "not_assigned", "assignment_role": "none", "subject_refs": [], "rationale": "Agent-authored rationale." },
      "reporting_dimensions": ["dimension_id"],
      "time_budget_minutes": 10,
      "max_sources": 5,
      "straggler_policy": { "on_timeout": "publish_partial", "grace_minutes": 2, "blocks_stage": true },
      "commercial_research_semantics": {
        "research_stage": "solution_neutral_scan",
        "planned_queries": [{ "query": "Agent-authored query.", "commercial_dimensions": ["user_language"] }],
        "quantitative_competitive_scope": {
          "scan_mode": "broad_scan",
          "required_metric_families": ["demand_scale", "usage_behavior", "commercial_behavior", "growth_change", "competitive_intensity", "distribution", "retention_outcomes", "unit_economics"],
          "required_competitor_types": ["direct_product", "adjacent_product", "service", "platform", "manual_workaround", "status_quo", "non_consumption"],
          "api_is_optional": true,
          "provider_allowlist_enforced": false,
          "acquisition_execution_owner": "research_agent_or_caller",
          "harness_hidden_network_calls": false,
          "prohibited_access_methods": ["bypass_access_control", "circumvent_login", "circumvent_paywall", "circumvent_captcha", "store_credentials"]
        },
        "required_commercial_dimensions": ["recent_user_language"],
        "commercial_audit_output_path": "artifacts/research-audits/audit_id.json"
      },
      "task_semantics": {
        "target_candidate_refs": [],
        "source_phase": "candidate_generation",
        "required_source_group_ids": ["source_group_id"],
        "required_stances": ["support", "oppose"],
        "stop_conditions": ["Agent-authored stop condition."],
        "execution_contract": {
          "chat_is_artifact": false,
          "task_completion_is_artifact": false,
          "hidden_llm_calls": false,
          "harness_dispatches_agent": false,
          "external_validation_supported": false,
          "publication_implies_validation": false
        }
      }
    }],
    "research_depth": "quick",
    "total_time_budget_minutes": 10,
    "resource_allocation": { "customer_commercial_percent": 65, "market_structure_percent": 17, "academic_percent": 18 },
    "gate_before": null,
    "gate_after": "required",
    "limitations": ["Agent-authored limitation."]
  }
}

Harness derives refs, hashes, Task/Dispatch/Execution paths, and launch-readiness diagnostics; Agent still authors queries, research dimensions, budgets, source strategy, candidate semantics, and topology.
`,
  "register-dispatch-launches": `Usage:
  npm run harness -- register-dispatch-launches --file FILE [--runs-root DIR]

Reads a dispatch_launch_registration_request and records caller-declared starts for exact Dispatch tasks.
`,
  "check-dispatch-launches": `Usage:
  npm run harness -- check-dispatch-launches --run-id ID --dispatch-ref REF --dispatch-hash HASH [--runs-root DIR]

Reads the exact Dispatch launch checklist and started/not-started set difference.
`,
  "materialize-lane-result": `Usage:
  npm run harness -- materialize-lane-result --file FILE [--runs-root DIR] [--observe]

Reads a lane_staging_document, validates authored lane material against the exact Task, and materializes a publication plan or publishes it.
`,
  "scaffold-lane-submission": `Usage:
  npm run harness -- scaffold-lane-submission --run-id ID --task-ref REF [--runs-root DIR]

Derives an unfilled minimum coverage checklist from one exact current Task.
`,
  "scaffold-artifact": `Usage:
  npm run harness -- scaffold-artifact --file FILE

Reads a scaffold_request and produces a schema-valid structural scaffold without research judgment.
`,
  "checkpoint-run": `Usage:
  npm run harness -- checkpoint-run --file FILE

Publishes an immutable checkpoint from a JSON input document.
`,
  "validate-plan": `Usage:
  npm run harness -- validate-plan --bundle FILE [--run-id ID] [--runs-root DIR] [--json]

Validates Planning Context and full Research Plan semantics. With --run-id, assembles persisted current authority.
`,
  "analyze-gaps": `Usage:
  npm run harness -- analyze-gaps --file FILE [--run-id ID] [--runs-root DIR] [--json]

Builds a deterministic Gap draft while preserving explicit Agent-declared semantic gaps.
`,
  "validate-adaptation": `Usage:
  npm run harness -- validate-adaptation --bundle FILE [--run-id ID] [--runs-root DIR] [--json]

Validates closed Adaptation actions against current policy and Run authority.
`,
  "apply-plan-revision": `Usage:
  npm run harness -- apply-plan-revision --file FILE [--runs-root DIR] [--json]

Applies validated actions through CAS, immutable Plan Revision receipts, and checkpoint publication.
`,
  "author-plan-adaptation": `Usage:
  npm run harness -- author-plan-adaptation --file FILE [--runs-root DIR] [--json]

Builds, validates, publishes, or atomically applies a current Gap/Adaptation author request.
`,
  "calculate-comparison": `Usage:
  npm run harness -- calculate-comparison --bundle FILE [--json]

Validates and summarizes caller-supplied G2.4 comparison Artifacts.
`,
  "calculate-sensitivity": `Usage:
  npm run harness -- calculate-sensitivity --bundle FILE [--json]

Validates and summarizes the caller-supplied G2.4 sensitivity Artifact.
`,
  "audit-traceability": `Usage:
  npm run harness -- audit-traceability --bundle FILE [--json]

Validates a closed G1.4 assessment or G2.4 discovery traceability/report chain.
`,
  "build-report": `Usage:
  npm run harness -- build-report --file FILE [--runs-root DIR] [--json] [--observe]

Publishes a non-terminal assessment/discovery report and materializes its user-facing views.
`,
};

export function printCommandHelp(
  command: string,
  write: (text: string) => void = process.stdout.write.bind(process.stdout),
): boolean {
  const text = COMMAND_HELP[command];
  if (text === undefined) return false;
  write(text.endsWith("\n") ? text : `${text}\n`);
  return true;
}

function formatHumanReport(report: DoctorReport): string {
  const lines = report.checks.map(
    (check) => `${check.status === "pass" ? "PASS" : "FAIL"} ${check.id}: ${check.detail}`,
  );
  return [`repository doctor: ${report.ok ? "PASS" : "FAIL"}`, ...lines, ""].join("\n");
}

export async function runDoctor(args: readonly string[], root = process.cwd()): Promise<number> {
  const unsupported = args.filter((arg) => arg !== "--json");
  if (unsupported.length > 0) {
    process.stderr.write(`doctor: unsupported argument(s): ${unsupported.join(", ")}\n`);
    return 64;
  }

  const report = await inspectRepository(root);
  process.stdout.write(
    args.includes("--json") ? `${JSON.stringify(report, null, 2)}\n` : formatHumanReport(report),
  );
  return report.ok ? 0 : 1;
}
