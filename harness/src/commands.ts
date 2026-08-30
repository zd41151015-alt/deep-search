import { type DoctorReport, inspectRepository } from "./repository-contract.js";

const HELP = `Startup Opportunity Research Harness (G4.1)

Usage:
  npm run harness -- help
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
  npm run harness -- record-evidence --run-id ID --unit-id ID [--unit-attempt N] (--source-url URL | --source-uri URN) --acquisition-goal GOAL --content-file FILE
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

The optional --observe flag on long deterministic operations writes phase/count/timing JSONL to stderr without changing stdout results or formal Run state. Terminal report sources are accepted only by the atomic terminal apply-plan-revision closeout; build-report cannot publish them independently. Validation, publication, recovery, comparison/sensitivity summaries, and report materialization success are mechanical only. Caller-supplied Artifacts use the generic validation/publication surface. The Harness does not dispatch agents, execute lanes, synthesize thesis or evaluation semantics, perform network research, infer research judgments, or claim Evidence/market validation success.
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
