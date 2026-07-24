#!/usr/bin/env node

import { printHelp, runDoctor } from "./commands.js";
import {
  runCheckpointRun,
  runCreateRun,
  runLoadRun,
  runRecordEvidence,
} from "./run-store/store-commands.js";
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
  case "load-run":
    process.exitCode = await runLoadRun(args);
    break;
  case "record-evidence":
    process.exitCode = await runRecordEvidence(args);
    break;
  case "checkpoint-run":
    process.exitCode = await runCheckpointRun(args);
    break;
  default:
    process.stderr.write(`Unknown command: ${command}\n`);
    printHelp(process.stderr.write.bind(process.stderr));
    process.exitCode = 64;
}
