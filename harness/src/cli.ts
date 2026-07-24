#!/usr/bin/env node

import { printHelp, runDoctor } from "./commands.js";
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
  default:
    process.stderr.write(`Unknown command: ${command}\n`);
    printHelp(process.stderr.write.bind(process.stderr));
    process.exitCode = 64;
}
