import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  ARTIFACT_VALIDATION_RESULT_VERSION,
  type ArtifactValidationResult,
  createArtifactValidator,
} from "./artifact-validator.js";
import {
  inspectSchemaBundle,
  SCHEMA_BUNDLE_VERSION,
  type ValidationIssue,
} from "./schema-bundle.js";

interface ParsedArguments {
  readonly mode: "file" | "bundle" | "schema-bundle";
  readonly inputPath: string | null;
}

function commandIssue(
  message: string,
  details: Readonly<Record<string, unknown>>,
): ValidationIssue {
  return {
    code: "command.invalid_arguments",
    keyword: "command",
    instancePath: "",
    schemaPath: "",
    message,
    details,
  };
}

function parseArguments(args: readonly string[]): ParsedArguments | ValidationIssue {
  const meaningful = args.filter((arg) => arg !== "--json");
  if (meaningful.length === 1 && meaningful[0] === "--schema-bundle") {
    return { mode: "schema-bundle", inputPath: null };
  }
  if (
    meaningful.length === 2 &&
    (meaningful[0] === "--file" || meaningful[0] === "--bundle") &&
    meaningful[1] !== undefined &&
    meaningful[1].length > 0
  ) {
    return {
      mode: meaningful[0] === "--file" ? "file" : "bundle",
      inputPath: meaningful[1],
    };
  }
  return commandIssue(
    "usage: validate-artifact (--file FILE | --bundle FILE | --schema-bundle) [--json]",
    { args },
  );
}

function invalidJsonResult(inputPath: string, error: unknown): ArtifactValidationResult {
  return {
    schemaVersion: ARTIFACT_VALIDATION_RESULT_VERSION,
    schemaBundleVersion: SCHEMA_BUNDLE_VERSION,
    valid: false,
    documentPath: inputPath,
    artifactSchemaVersion: null,
    errors: [
      {
        code: "document.invalid_json",
        keyword: "parse",
        instancePath: "",
        schemaPath: "",
        message: error instanceof Error ? error.message : "input is not valid JSON",
        details: {},
      },
    ],
  };
}

export async function runValidateArtifact(
  args: readonly string[],
  root = process.cwd(),
): Promise<number> {
  const parsed = parseArguments(args);
  if ("code" in parsed) {
    process.stderr.write(
      `${JSON.stringify({
        schemaVersion: "startup_opportunity.command_error.v1",
        command: "validate-artifact",
        status: "invalid_arguments",
        error: parsed,
      })}\n`,
    );
    return 64;
  }

  if (parsed.mode === "schema-bundle") {
    const result = await inspectSchemaBundle(root);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result.valid ? 0 : 1;
  }

  const inputPath = parsed.inputPath ?? "";
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path.resolve(root, inputPath), "utf8")) as unknown;
  } catch (error) {
    const result = invalidJsonResult(inputPath, error);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 1;
  }

  const validator = await createArtifactValidator(root);
  const result =
    parsed.mode === "bundle"
      ? validator.validateDocumentBundle(value)
      : validator.validateDocument(value, inputPath);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result.valid ? 0 : 1;
}
