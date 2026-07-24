#!/usr/bin/env -S node --import tsx

import { runDoctor } from "../../../../harness/src/commands.js";

process.exitCode = await runDoctor(process.argv.slice(2));
