#!/usr/bin/env -S node --import tsx

import { runValidatePlan } from "../../../../harness/src/adaptation/adaptation-commands.js";

process.exitCode = await runValidatePlan(process.argv.slice(2));
