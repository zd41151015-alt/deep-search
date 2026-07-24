#!/usr/bin/env -S node --import tsx

import { runCreateRun } from "../../../../harness/src/run-store/store-commands.js";

process.exitCode = await runCreateRun(process.argv.slice(2));
