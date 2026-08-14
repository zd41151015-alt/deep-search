import {
  formatContractImpact,
  inspectContractImpact,
} from "../harness/src/validators/contract-impact.js";

function usage(): string {
  return [
    "Usage: npm run contract:impact -- --base <git-ref> [--json]",
    "",
    "Reports deterministic engineering impact for current-contract changes.",
  ].join("\n");
}

const args = process.argv.slice(2);
let baseRef: string | undefined;
let json = false;
for (let index = 0; index < args.length; index += 1) {
  const argument = args[index];
  if (argument === "--base") {
    baseRef = args[index + 1];
    index += 1;
  } else if (argument === "--json") {
    json = true;
  } else if (argument === "--help" || argument === "-h") {
    process.stdout.write(`${usage()}\n`);
    process.exit(0);
  } else {
    process.stderr.write(`Unknown argument: ${argument}\n${usage()}\n`);
    process.exit(64);
  }
}

if (baseRef === undefined || baseRef === "") {
  process.stderr.write(`--base is required\n${usage()}\n`);
  process.exit(64);
}

try {
  const result = await inspectContractImpact({ baseRef });
  process.stdout.write(
    json ? `${JSON.stringify(result, null, 2)}\n` : formatContractImpact(result),
  );
  if (!result.topologyValid) {
    process.exitCode = 1;
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "impact inspection failed"}\n`);
  process.exitCode = 1;
}
