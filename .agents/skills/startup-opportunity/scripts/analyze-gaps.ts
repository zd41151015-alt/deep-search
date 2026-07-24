#!/usr/bin/env -S node --import tsx

import { runAnalyzeGaps } from "../../../../harness/src/adaptation/adaptation-commands.js";

process.exitCode = await runAnalyzeGaps(process.argv.slice(2));
