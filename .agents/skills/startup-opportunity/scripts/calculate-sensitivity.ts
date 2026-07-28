#!/usr/bin/env -S node --import tsx

import { runCalculateSensitivity } from "../../../../harness/src/comparison/comparison-commands.js";

process.exitCode = await runCalculateSensitivity(process.argv.slice(2));
