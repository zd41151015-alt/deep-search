#!/usr/bin/env -S node --import tsx

import { runRecordEvidence } from "../../../../harness/src/run-store/store-commands.js";

process.exitCode = await runRecordEvidence(process.argv.slice(2));
