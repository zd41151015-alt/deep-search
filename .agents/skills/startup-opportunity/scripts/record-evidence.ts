#!/usr/bin/env -S node --import tsx

import { rejectReservedCommand } from "../../../../harness/src/reserved-command.js";

rejectReservedCommand("record-evidence");
