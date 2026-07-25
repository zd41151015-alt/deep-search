#!/usr/bin/env -S node --import tsx

import { runAuditTraceability } from "../../../../harness/src/reporting/report-commands.js";

process.exitCode = await runAuditTraceability(process.argv.slice(2));
