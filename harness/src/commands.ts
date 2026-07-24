import { type DoctorReport, inspectRepository } from "./repository-contract.js";

const HELP = `Startup Opportunity Research Harness (G0.4)

Usage:
  npm run harness -- help
  npm run harness -- doctor [--json]
  npm run harness -- validate-artifact (--file FILE | --bundle FILE | --schema-bundle) [--json]
  npm run harness -- create-run --run-id ID --mode MODE [--created-at TIME]
  npm run harness -- load-run --run-id ID
  npm run harness -- record-evidence --run-id ID --unit-id ID --url URL --research-goal GOAL --content-file FILE
  npm run harness -- checkpoint-run --file FILE
  npm run harness -- validate-plan --bundle FILE [--json]
  npm run harness -- analyze-gaps --file FILE [--json]
  npm run harness -- validate-adaptation --bundle FILE [--json]
  npm run harness -- apply-plan-revision --file FILE [--runs-root DIR] [--json]

Commands:
  help               Show the implemented G0.4 command surface.
  doctor             Validate repository, toolchain, Skill, agent, Harness, and test contracts.
  validate-artifact  Validate one document, a typed document bundle, or the schema bundle itself.
  create-run         Create a confined Run and its initial checkpoint.
  load-run           Validate, reconcile, and reopen a persisted Run.
  record-evidence    Persist raw evidence with canonical hashes and deterministic deduplication.
  checkpoint-run     Publish an immutable checkpoint from a JSON input document.
  validate-plan      Validate Planning Context v2 and full Research Plan semantics.
  analyze-gaps       Build a deterministic machine-observable Gap Snapshot draft.
  validate-adaptation Validate v2 closed actions against current Run/Plan state.
  apply-plan-revision Apply validated actions through CAS and immutable Plan Revision receipts.

Validation and Store success are mechanical only. Research and reporting commands remain unavailable.
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
