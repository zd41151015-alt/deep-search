#!/usr/bin/env -S node --import tsx

import { runCheckpointRun } from "../../../../harness/src/run-store/store-commands.js";

process.exitCode = await runCheckpointRun(process.argv.slice(2));
