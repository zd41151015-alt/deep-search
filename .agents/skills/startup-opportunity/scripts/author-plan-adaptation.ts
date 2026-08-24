#!/usr/bin/env -S node --import tsx

import { runAuthorPlanAdaptation } from "../../../../harness/src/adaptation/adaptation-commands.js";

process.exitCode = await runAuthorPlanAdaptation(process.argv.slice(2));
