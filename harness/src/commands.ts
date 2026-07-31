import { type DoctorReport, inspectRepository } from "./repository-contract.js";

const HELP = `Startup Opportunity Research Harness (G4.1)

Usage:
  npm run harness -- help
  npm run harness -- doctor [--json]
  npm run harness -- validate-artifact (--file FILE | --bundle FILE | --schema-bundle) [--json]
  npm run harness -- create-run --run-id ID --mode MODE [--created-at TIME]
  npm run harness -- load-run --run-id ID
  npm run harness -- status-run --run-id ID
  npm run harness -- record-evidence --run-id ID --unit-id ID (--url URL | --source-url URL | --source-uri URN) --research-goal GOAL --content-file FILE
  npm run harness -- publish-artifact --file FILE [--runs-root DIR]
  npm run harness -- compile-artifacts --file FILE [--runs-root DIR]
  npm run harness -- checkpoint-run --file FILE
  npm run harness -- validate-plan --bundle FILE [--run-id ID] [--runs-root DIR] [--json]
  npm run harness -- analyze-gaps --file FILE [--json]
  npm run harness -- validate-adaptation --bundle FILE [--json]
  npm run harness -- apply-plan-revision --file FILE [--runs-root DIR] [--json]
  npm run harness -- calculate-comparison --bundle FILE [--json]
  npm run harness -- calculate-sensitivity --bundle FILE [--json]
  npm run harness -- audit-traceability --bundle FILE [--json]
  npm run harness -- build-report --file FILE [--runs-root DIR] [--json]

Commands:
  help               Show the implemented deterministic Harness command surface.
  doctor             Validate repository, toolchain, Skill, agent, Harness, and test contracts.
  validate-artifact  Validate one document, a typed document bundle, or the schema bundle itself.
  create-run         Create a confined Run and its initial checkpoint.
  load-run           Validate, reconcile, and reopen a persisted Run.
  status-run         Read and validate current Run manifest state without recovery or mutation.
  record-evidence    Persist raw evidence with canonical hashes and deterministic deduplication.
  publish-artifact   Validate and publish one formal envelope or an explicit envelope bundle.
  compile-artifacts  Compile semantic JSON into v18 envelopes, minimal Run closure, and optional publication.
  checkpoint-run     Publish an immutable checkpoint from a JSON input document.
  validate-plan      Validate Planning Context v2 and full Research Plan semantics; --run-id assembles persisted authority.
  analyze-gaps       Build a deterministic machine or assessment Gap Snapshot draft.
  validate-adaptation Validate G0 v2 or G1.3 v3 closed actions against current Run/Plan state.
  apply-plan-revision Apply validated actions through CAS and immutable Plan Revision receipts.
  calculate-comparison Validate and summarize caller-supplied G2.4 comparison Artifacts.
  calculate-sensitivity Validate and summarize the caller-supplied G2.4 sensitivity Artifact.
  audit-traceability Validate a closed G1.4 assessment or G2.4 discovery traceability/report chain.
  build-report       Publish a validated assessment/discovery report and materialize its views.

Validation, publication, recovery, comparison/sensitivity summaries, and report materialization success are mechanical only. Caller-supplied Artifacts use the generic validation/publication surface. The Harness does not dispatch agents, execute lanes, synthesize thesis or evaluation semantics, perform network research, infer research judgments, or claim Evidence/market validation success.
`;

export function printHelp(
  write: (text: string) => void = process.stdout.write.bind(process.stdout),
) {
  write(HELP);
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
