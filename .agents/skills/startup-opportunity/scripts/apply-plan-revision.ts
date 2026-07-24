#!/usr/bin/env -S node --import tsx

import { runApplyPlanRevision } from "../../../../harness/src/adaptation/adaptation-commands.js";

process.exitCode = await runApplyPlanRevision(process.argv.slice(2));
