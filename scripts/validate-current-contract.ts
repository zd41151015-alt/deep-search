import { inspectCurrentContract } from "../harness/src/validators/current-contract.js";

const result = await inspectCurrentContract();
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (!result.valid) {
  process.exitCode = 1;
}
