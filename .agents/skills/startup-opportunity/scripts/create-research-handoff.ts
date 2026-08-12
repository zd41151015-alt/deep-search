#!/usr/bin/env -S node --import tsx

import { runCreateResearchHandoff } from "../../../../harness/src/run-store/store-commands.js";

process.exitCode = await runCreateResearchHandoff(process.argv.slice(2));
