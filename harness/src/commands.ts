import { type DoctorReport, inspectRepository } from "./repository-contract.js";

const HELP = `Startup Opportunity Research Harness (G2.2)

Usage:
  npm run harness -- help
  npm run harness -- doctor [--json]
  npm run harness -- validate-artifact (--file FILE | --bundle FILE | --schema-bundle) [--json]
  npm run harness -- create-run --run-id ID --mode MODE [--created-at TIME]
  npm run harness -- load-run --run-id ID
  npm run harness -- record-evidence --run-id ID --unit-id ID (--url URL | --source-url URL | --source-uri URN) --research-goal GOAL --content-file FILE
  npm run harness -- publish-artifact --file FILE [--runs-root DIR]
  npm run harness -- checkpoint-run --file FILE
  npm run harness -- validate-plan --bundle FILE [--json]
  npm run harness -- analyze-gaps --file FILE [--json]
  npm run harness -- validate-adaptation --bundle FILE [--json]
  npm run harness -- apply-plan-revision --file FILE [--runs-root DIR] [--json]
  npm run harness -- audit-traceability --bundle FILE [--json]
  npm run harness -- build-report --file FILE [--runs-root DIR] [--json]

Commands:
  help               Show the implemented G2.2 command surface.
  doctor             Validate repository, toolchain, Skill, agent, Harness, and test contracts.
  validate-artifact  Validate one document, a typed document bundle, or the schema bundle itself.
  create-run         Create a confined Run and its initial checkpoint.
  load-run           Validate, reconcile, and reopen a persisted Run.
  record-evidence    Persist raw evidence with canonical hashes and deterministic deduplication.
  publish-artifact   Validate and publish one formal envelope or an explicit envelope bundle.
  checkpoint-run     Publish an immutable checkpoint from a JSON input document.
  validate-plan      Validate Planning Context v2 and full Research Plan semantics.
  analyze-gaps       Build a deterministic machine or assessment Gap Snapshot draft.
  validate-adaptation Validate G0 v2 or G1.3 v3 closed actions against current Run/Plan state.
  apply-plan-revision Apply validated actions through CAS and immutable Plan Revision receipts.
  audit-traceability Validate the closed G1.4 audit/review/Assessment/Traceability/report chain.
  build-report       Publish a validated report source and deterministically materialize its views.

Validation, publication, recovery, and report materialization success are mechanical only. G2.1 maps and G2.2 pre-thesis candidates, explicit Research Tasks, typed lane material/results, and reference-only fan-in may use the generic validation/publication surface. The Harness does not dispatch agents, execute lanes, perform network research, or infer pre-kill decisions. Discover orchestration, thesis synthesis, comparison, and portfolio commands remain unavailable.
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
