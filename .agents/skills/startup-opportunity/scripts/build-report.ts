#!/usr/bin/env -S node --import tsx

import { runBuildReport } from "../../../../harness/src/reporting/report-commands.js";

process.exitCode = await runBuildReport(process.argv.slice(2));
