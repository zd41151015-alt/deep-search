#!/usr/bin/env -S node --import tsx

import { runProposeScope } from "../../../../harness/src/run-store/store-commands.js";

process.exitCode = await runProposeScope(process.argv.slice(2));
