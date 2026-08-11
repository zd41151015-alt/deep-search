#!/usr/bin/env -S node --import tsx

import { runReformDecisionSubject } from "../../../../harness/src/run-store/store-commands.js";

process.exitCode = await runReformDecisionSubject(process.argv.slice(2));
