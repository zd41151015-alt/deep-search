#!/usr/bin/env -S node --import tsx

import { runAdmitPriorInput } from "../../../../harness/src/run-store/store-commands.js";

process.exitCode = await runAdmitPriorInput(process.argv.slice(2));
