#!/usr/bin/env -S node --import tsx

import { runCalculateComparison } from "../../../../harness/src/comparison/comparison-commands.js";

process.exitCode = await runCalculateComparison(process.argv.slice(2));
