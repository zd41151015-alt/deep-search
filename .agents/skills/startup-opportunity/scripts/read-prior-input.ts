#!/usr/bin/env -S node --import tsx

import { runReadPriorInput } from "../../../../harness/src/run-store/store-commands.js";

process.exitCode = await runReadPriorInput(process.argv.slice(2));
