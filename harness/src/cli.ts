#!/usr/bin/env node

import {
  runAnalyzeGaps,
  runApplyPlanRevision,
  runValidateAdaptation,
  runValidatePlan,
} from "./adaptation/adaptation-commands.js";
import { printHelp, runDoctor } from "./commands.js";
import {
  runCalculateComparison,
  runCalculateSensitivity,
} from "./comparison/comparison-commands.js";
import { runAuditTraceability, runBuildReport } from "./reporting/report-commands.js";
import {
  runCheckpointRun,
  runConfirmScope,
  runCreateRun,
  runLoadRun,
  runProposeScope,
  runPublishArtifact,
  runRecordEvidence,
  runStatusRun,
} from "./run-store/store-commands.js";
import {
  runCompileArtifacts,
  runMaterializeLaneResult,
  runScaffoldArtifact,
} from "./runtime/runtime-commands.js";
import { runValidateArtifact } from "./validators/validate-artifact-command.js";

const [command = "help", ...args] = process.argv.slice(2);

switch (command) {
  case "help":
    printHelp();
    break;
  case "doctor":
    process.exitCode = await runDoctor(args);
    break;
  case "validate-artifact":
    process.exitCode = await runValidateArtifact(args);
    break;
  case "create-run":
    process.exitCode = await runCreateRun(args);
    break;
  case "propose-scope":
    process.exitCode = await runProposeScope(args);
    break;
  case "confirm-scope":
    process.exitCode = await runConfirmScope(args);
    break;
  case "load-run":
    process.exitCode = await runLoadRun(args);
    break;
  case "status-run":
    process.exitCode = await runStatusRun(args);
    break;
  case "record-evidence":
    process.exitCode = await runRecordEvidence(args);
    break;
  case "publish-artifact":
    process.exitCode = await runPublishArtifact(args);
    break;
  case "compile-artifacts":
    process.exitCode = await runCompileArtifacts(args);
    break;
  case "materialize-lane-result":
    process.exitCode = await runMaterializeLaneResult(args);
    break;
  case "scaffold-artifact":
    process.exitCode = await runScaffoldArtifact(args);
    break;
  case "checkpoint-run":
    process.exitCode = await runCheckpointRun(args);
    break;
  case "validate-plan":
    process.exitCode = await runValidatePlan(args);
    break;
  case "analyze-gaps":
    process.exitCode = await runAnalyzeGaps(args);
    break;
  case "validate-adaptation":
    process.exitCode = await runValidateAdaptation(args);
    break;
  case "apply-plan-revision":
    process.exitCode = await runApplyPlanRevision(args);
    break;
  case "calculate-comparison":
    process.exitCode = await runCalculateComparison(args);
    break;
  case "calculate-sensitivity":
    process.exitCode = await runCalculateSensitivity(args);
    break;
  case "audit-traceability":
    process.exitCode = await runAuditTraceability(args);
    break;
  case "build-report":
    process.exitCode = await runBuildReport(args);
    break;
  default:
    process.stderr.write(`Unknown command: ${command}\n`);
    printHelp(process.stderr.write.bind(process.stderr));
    process.exitCode = 64;
}
