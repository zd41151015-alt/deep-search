#!/usr/bin/env -S node --import tsx

import { runPublishArtifact } from "../../../../harness/src/run-store/store-commands.js";

process.exitCode = await runPublishArtifact(process.argv.slice(2));
