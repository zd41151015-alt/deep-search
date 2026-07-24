#!/usr/bin/env -S node --import tsx

import { runValidateArtifact } from "../../../../harness/src/validators/validate-artifact-command.js";

process.exitCode = await runValidateArtifact(process.argv.slice(2));
