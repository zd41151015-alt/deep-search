#!/usr/bin/env -S node --import tsx

import { runConfirmScope } from "../../../../harness/src/run-store/store-commands.js";

process.exitCode = await runConfirmScope(process.argv.slice(2));
