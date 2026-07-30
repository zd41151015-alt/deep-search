#!/usr/bin/env node

import { runStatusRun } from "../../../../harness/src/index.js";

process.exitCode = await runStatusRun(process.argv.slice(2));
