import { readFile } from "node:fs/promises";
import path from "node:path";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import addFormatsImport from "ajv-formats";

export const SCHEMA_BUNDLE_VERSION = "18.0.0" as const;
export const SCHEMA_BUNDLE_MANIFEST_PATH = "harness/schemas/bundle.v18.json" as const;

export interface ValidationIssue {
  readonly code: string;
  readonly keyword: string;
  readonly instancePath: string;
  readonly schemaPath: string;
  readonly message: string;
  readonly details: Readonly<Record<string, unknown>>;
}

interface SchemaManifestEntry {
  readonly id: string;
  readonly file: string;
  readonly document_schema_version: string | null;
}

interface SchemaBundleManifest {
  readonly schema_version:
    | "startup_opportunity.schema_bundle.v2"
    | "startup_opportunity.schema_bundle.v3";
  readonly schema_bundle_version: string;
  readonly json_schema_dialect: "https://json-schema.org/draft/2020-12/schema";
  readonly base_bundle?: string;
  readonly schemas: readonly SchemaManifestEntry[];
}

interface LoadedSchema {
  readonly entry: SchemaManifestEntry;
  readonly document: Record<string, unknown>;
}

export interface LoadedSchemaBundle {
  readonly version: string;
  readonly manifest: SchemaBundleManifest;
  readonly schemas: ReadonlyMap<string, LoadedSchema>;
  readonly validators: ReadonlyMap<string, ValidateFunction>;
}

export interface SchemaBundleInspectionResult {
  readonly schemaVersion: "startup_opportunity.schema_bundle_validation_result.v1";
  readonly schemaBundleVersion: string | null;
  readonly valid: boolean;
  readonly schemaCount: number;
  readonly documentSchemaCount: number;
  readonly errors: readonly ValidationIssue[];
}

class SchemaBundleError extends Error {
  constructor(readonly issues: readonly ValidationIssue[]) {
    super("schema bundle is invalid");
  }
}

function issue(
  code: string,
  instancePath: string,
  message: string,
  details: Readonly<Record<string, unknown>> = {},
): ValidationIssue {
  return {
    code,
    keyword: "bundle",
    instancePath,
    schemaPath: "",
    message,
    details,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactlyKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function parseManifest(value: unknown, expectedVersion: string): SchemaBundleManifest {
  const errors: ValidationIssue[] = [];
  if (!isRecord(value)) {
    throw new SchemaBundleError([
      issue("bundle.invalid_manifest", "", "manifest must be an object"),
    ]);
  }

  const schemaVersion = value.schema_version;
  const rootKeys = [
    ...(schemaVersion === "startup_opportunity.schema_bundle.v3" ? ["base_bundle"] : []),
    "json_schema_dialect",
    "schema_bundle_version",
    "schema_version",
    "schemas",
  ].sort();
  if (!hasExactlyKeys(value, rootKeys)) {
    errors.push(
      issue("bundle.invalid_manifest", "", "manifest has missing or unknown fields", {
        expected: rootKeys,
        actual: Object.keys(value).sort(),
      }),
    );
  }
  if (
    schemaVersion !== "startup_opportunity.schema_bundle.v2" &&
    schemaVersion !== "startup_opportunity.schema_bundle.v3"
  ) {
    errors.push(
      issue("bundle.invalid_version", "/schema_version", "unexpected bundle schema version"),
    );
  }
  if (value.schema_bundle_version !== expectedVersion) {
    errors.push(
      issue("bundle.invalid_version", "/schema_bundle_version", "unexpected bundle version"),
    );
  }
  if (value.json_schema_dialect !== "https://json-schema.org/draft/2020-12/schema") {
    errors.push(issue("bundle.invalid_dialect", "/json_schema_dialect", "unsupported dialect"));
  }
  if (
    schemaVersion === "startup_opportunity.schema_bundle.v3" &&
    (typeof value.base_bundle !== "string" ||
      !/^bundle\.v[1-9][0-9]*\.json$/.test(value.base_bundle))
  ) {
    errors.push(
      issue(
        "bundle.invalid_base",
        "/base_bundle",
        "composed bundle must name one local base bundle",
      ),
    );
  }

  if (!Array.isArray(value.schemas) || value.schemas.length === 0) {
    errors.push(issue("bundle.invalid_manifest", "/schemas", "schemas must be a non-empty array"));
  } else {
    for (const [index, entry] of value.schemas.entries()) {
      const instancePath = `/schemas/${index}`;
      if (!isRecord(entry)) {
        errors.push(
          issue("bundle.invalid_manifest", instancePath, "schema entry must be an object"),
        );
        continue;
      }
      const entryKeys = ["document_schema_version", "file", "id"].sort();
      if (!hasExactlyKeys(entry, entryKeys)) {
        errors.push(
          issue("bundle.invalid_manifest", instancePath, "schema entry has unknown fields"),
        );
      }
      if (
        typeof entry.id !== "string" ||
        !entry.id.startsWith("https://startup-opportunity.local/")
      ) {
        errors.push(issue("bundle.invalid_id", `${instancePath}/id`, "schema id is not local"));
      }
      if (
        typeof entry.file !== "string" ||
        !/^v[1-9][0-9]*\/[a-z][a-z0-9-]*\.schema\.json$/.test(entry.file)
      ) {
        errors.push(
          issue("bundle.invalid_path", `${instancePath}/file`, "invalid schema filename"),
        );
      }
      if (
        entry.document_schema_version !== null &&
        (typeof entry.document_schema_version !== "string" ||
          !/^startup_opportunity\.[a-z][a-z0-9_]*\.v[1-9][0-9]*$/.test(
            entry.document_schema_version,
          ))
      ) {
        errors.push(
          issue(
            "bundle.invalid_version",
            `${instancePath}/document_schema_version`,
            "invalid document schema version",
          ),
        );
      }
    }
  }

  if (errors.length > 0) {
    throw new SchemaBundleError(sortIssues(errors));
  }
  return value as unknown as SchemaBundleManifest;
}

function collectReferences(
  value: unknown,
  instancePath = "",
): readonly { readonly ref: string; readonly instancePath: string }[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => collectReferences(item, `${instancePath}/${index}`));
  }
  if (!isRecord(value)) {
    return [];
  }

  const references: { ref: string; instancePath: string }[] = [];
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${instancePath}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`;
    if (key === "$ref" && typeof child === "string") {
      references.push({ ref: child, instancePath: childPath });
    } else {
      references.push(...collectReferences(child, childPath));
    }
  }
  return references;
}

function resolveJsonPointer(document: unknown, fragment: string): boolean {
  if (fragment === "") {
    return true;
  }
  if (!fragment.startsWith("/")) {
    return false;
  }

  let current: unknown = document;
  for (const encodedSegment of fragment.slice(1).split("/")) {
    const segment = decodeURIComponent(encodedSegment).replaceAll("~1", "/").replaceAll("~0", "~");
    if (!isRecord(current) || !(segment in current)) {
      return false;
    }
    current = current[segment];
  }
  return true;
}

function inspectReferences(schemas: ReadonlyMap<string, LoadedSchema>): readonly ValidationIssue[] {
  const errors: ValidationIssue[] = [];
  for (const { entry, document } of schemas.values()) {
    for (const reference of collectReferences(document)) {
      let resolved: URL;
      try {
        resolved = new URL(reference.ref, entry.id);
      } catch {
        errors.push(
          issue("bundle.invalid_ref", reference.instancePath, "reference is not a valid URI", {
            schemaId: entry.id,
            ref: reference.ref,
          }),
        );
        continue;
      }
      const targetId = resolved.href.split("#", 1)[0] ?? "";
      const target = schemas.get(targetId);
      if (!target) {
        errors.push(
          issue("bundle.missing_ref", reference.instancePath, "reference target is not in bundle", {
            schemaId: entry.id,
            ref: reference.ref,
            targetId,
          }),
        );
        continue;
      }
      const fragment = resolved.hash.startsWith("#") ? resolved.hash.slice(1) : resolved.hash;
      if (!resolveJsonPointer(target.document, fragment)) {
        errors.push(
          issue(
            "bundle.missing_pointer",
            reference.instancePath,
            "JSON Pointer target is missing",
            {
              schemaId: entry.id,
              ref: reference.ref,
            },
          ),
        );
      }
    }
  }
  return sortIssues(errors);
}

export function sortIssues(issues: readonly ValidationIssue[]): readonly ValidationIssue[] {
  return [...issues].sort((left, right) =>
    [left.instancePath, left.code, left.schemaPath, left.message]
      .join("\0")
      .localeCompare([right.instancePath, right.code, right.schemaPath, right.message].join("\0")),
  );
}

async function loadManifestChain(
  root: string,
  manifestRelativePath: string,
  expectedVersion: string,
  ancestors: readonly string[] = [],
): Promise<{
  readonly manifest: SchemaBundleManifest;
  readonly schemaDirectory: string;
  readonly entries: readonly {
    readonly entry: SchemaManifestEntry;
    readonly schemaDirectory: string;
  }[];
}> {
  if (ancestors.includes(manifestRelativePath)) {
    throw new SchemaBundleError([
      issue("bundle.base_cycle", "/base_bundle", "schema bundle base chain contains a cycle", {
        chain: [...ancestors, manifestRelativePath],
      }),
    ]);
  }
  const manifestPath = path.join(root, manifestRelativePath);
  const manifest = parseManifest(
    JSON.parse(await readFile(manifestPath, "utf8")) as unknown,
    expectedVersion,
  );
  const schemaDirectory = path.dirname(manifestPath);
  const ownEntries = manifest.schemas.map((entry) => ({ entry, schemaDirectory }));
  if (manifest.schema_version !== "startup_opportunity.schema_bundle.v3") {
    return { manifest, schemaDirectory, entries: ownEntries };
  }
  const baseRelativePath = path.join(
    path.dirname(manifestRelativePath),
    manifest.base_bundle as string,
  );
  const baseValue = JSON.parse(
    await readFile(path.join(root, baseRelativePath), "utf8"),
  ) as unknown;
  if (!isRecord(baseValue) || typeof baseValue.schema_bundle_version !== "string") {
    throw new SchemaBundleError([
      issue("bundle.invalid_base", "/base_bundle", "base bundle manifest is invalid"),
    ]);
  }
  const base = await loadManifestChain(root, baseRelativePath, baseValue.schema_bundle_version, [
    ...ancestors,
    manifestRelativePath,
  ]);
  return { manifest, schemaDirectory, entries: [...base.entries, ...ownEntries] };
}

export async function loadSchemaBundle(
  root = process.cwd(),
  manifestRelativePath: string = SCHEMA_BUNDLE_MANIFEST_PATH,
  expectedVersion: string = SCHEMA_BUNDLE_VERSION,
): Promise<LoadedSchemaBundle> {
  const { manifest, entries } = await loadManifestChain(
    root,
    manifestRelativePath,
    expectedVersion,
  );
  const loadedSchemas = await Promise.all(
    entries.map(async ({ entry, schemaDirectory }) => {
      const document = JSON.parse(
        await readFile(path.join(schemaDirectory, entry.file), "utf8"),
      ) as unknown;
      if (!isRecord(document)) {
        throw new SchemaBundleError([
          issue("bundle.invalid_schema", `/schemas/${entry.file}`, "schema must be an object"),
        ]);
      }
      if (document.$id !== entry.id) {
        throw new SchemaBundleError([
          issue(
            "bundle.id_mismatch",
            `/schemas/${entry.file}/$id`,
            "schema id differs from manifest",
            {
              expected: entry.id,
              actual: document.$id,
            },
          ),
        ]);
      }
      return { entry, document } satisfies LoadedSchema;
    }),
  );

  const ids = loadedSchemas.map(({ entry }) => entry.id);
  const files = loadedSchemas.map(({ entry }) => entry.file);
  const versions = loadedSchemas
    .map(({ entry }) => entry.document_schema_version)
    .filter((version): version is string => version !== null);
  const duplicateErrors: ValidationIssue[] = [];
  for (const [name, values] of [
    ["id", ids],
    ["file", files],
    ["document_schema_version", versions],
  ] as const) {
    if (new Set(values).size !== values.length) {
      duplicateErrors.push(issue("bundle.duplicate_entry", "/schemas", `duplicate ${name}`));
    }
  }
  if (duplicateErrors.length > 0) {
    throw new SchemaBundleError(duplicateErrors);
  }

  const schemas = new Map(loadedSchemas.map((schema) => [schema.entry.id, schema]));
  const referenceErrors = inspectReferences(schemas);
  if (referenceErrors.length > 0) {
    throw new SchemaBundleError(referenceErrors);
  }

  try {
    const ajv = new Ajv2020({
      allErrors: true,
      strict: true,
      strictRequired: false,
      validateFormats: true,
    });
    const addFormats = addFormatsImport as unknown as (instance: Ajv2020) => Ajv2020;
    addFormats(ajv);
    for (const { document } of loadedSchemas) {
      ajv.addSchema(document);
    }
    const validators = new Map<string, ValidateFunction>();
    for (const { entry } of loadedSchemas) {
      if (entry.document_schema_version === null) {
        continue;
      }
      const validator = ajv.getSchema(entry.id);
      if (!validator) {
        throw new Error(`validator was not compiled for ${entry.id}`);
      }
      validators.set(entry.document_schema_version, validator);
    }
    return {
      version: manifest.schema_bundle_version,
      manifest: { ...manifest, schemas: entries.map(({ entry }) => entry) },
      schemas,
      validators,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "schema compilation failed";
    throw new SchemaBundleError([issue("bundle.compile_failed", "/schemas", message)]);
  }
}

export async function inspectSchemaBundle(
  root = process.cwd(),
  manifestRelativePath: string = SCHEMA_BUNDLE_MANIFEST_PATH,
  expectedVersion: string = SCHEMA_BUNDLE_VERSION,
): Promise<SchemaBundleInspectionResult> {
  try {
    const bundle = await loadSchemaBundle(root, manifestRelativePath, expectedVersion);
    return {
      schemaVersion: "startup_opportunity.schema_bundle_validation_result.v1",
      schemaBundleVersion: bundle.version,
      valid: true,
      schemaCount: bundle.manifest.schemas.length,
      documentSchemaCount: bundle.validators.size,
      errors: [],
    };
  } catch (error) {
    const errors =
      error instanceof SchemaBundleError
        ? error.issues
        : [
            issue(
              "bundle.load_failed",
              "",
              error instanceof Error ? error.message : "schema bundle could not be loaded",
            ),
          ];
    return {
      schemaVersion: "startup_opportunity.schema_bundle_validation_result.v1",
      schemaBundleVersion: null,
      valid: false,
      schemaCount: 0,
      documentSchemaCount: 0,
      errors: sortIssues(errors),
    };
  }
}
