#!/usr/bin/env -S node --import tsx

import { runLoadRun } from "../../../../harness/src/run-store/store-commands.js";

process.exitCode = await runLoadRun(process.argv.slice(2));
