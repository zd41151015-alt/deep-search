#!/usr/bin/env -S node --import tsx

import { runValidateAdaptation } from "../../../../harness/src/adaptation/adaptation-commands.js";

process.exitCode = await runValidateAdaptation(process.argv.slice(2));
