#!/usr/bin/env -S node --import tsx

import { runReadResearchHandoff } from "../../../../harness/src/run-store/store-commands.js";

process.exitCode = await runReadResearchHandoff(process.argv.slice(2));
