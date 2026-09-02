#!/usr/bin/env -S node --import tsx

import { runConfirmPreCandidates } from "../../../../harness/src/run-store/store-commands.js";

process.exitCode = await runConfirmPreCandidates(process.argv.slice(2));
