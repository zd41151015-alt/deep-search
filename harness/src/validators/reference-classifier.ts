import { readFile } from "node:fs/promises";
import path from "node:path";
import { canonicalContentHash } from "../artifact-store/canonical.js";
import { StoreError } from "../artifact-store/store-error.js";
import { formalArtifactFragmentExists } from "./artifact-ref-resolver.js";
import type { DocumentBundle, DocumentBundleReferenceContext } from "./artifact-validator.js";

export type ReferenceKind =
  | "run_artifact"
  | "run_artifact_fragment"
  | "json_pointer"
  | "evidence_exact_record"
  | "run_exact_record"
  | "repository_policy"
  | "external_url";

export interface ClassifiedReference {
  readonly ref: string;
  readonly kind: ReferenceKind;
  readonly targetPath: string;
  readonly fragment: string | null;
}

export interface ResolvedReference extends ClassifiedReference {
  readonly contentHash: string | null;
}

function splitReference(ref: string): {
  readonly targetPath: string;
  readonly fragment: string | null;
} {
  const hashIndex = ref.indexOf("#");
  return hashIndex < 0
    ? { targetPath: ref, fragment: null }
    : { targetPath: ref.slice(0, hashIndex), fragment: ref.slice(hashIndex + 1) };
}

export function classifyReference(ref: string): ClassifiedReference {
  if (/^https?:\/\//u.test(ref)) {
    const url = new URL(ref);
    const fragment = url.hash.slice(1) || null;
    url.hash = "";
    return { ref, kind: "external_url", targetPath: url.href, fragment };
  }
  const { targetPath, fragment } = splitReference(ref);
  if (/^harness\/policies\/[A-Za-z0-9][A-Za-z0-9._/-]*\.json$/u.test(targetPath)) {
    return { ref, kind: "repository_policy", targetPath, fragment };
  }
  if (targetPath === "evidence/manifest.jsonl") {
    return { ref, kind: "evidence_exact_record", targetPath, fragment };
  }
  if (targetPath === "events.jsonl" || targetPath === "decisions.jsonl") {
    return { ref, kind: "run_exact_record", targetPath, fragment };
  }
  if (fragment?.startsWith("/")) {
    return { ref, kind: "json_pointer", targetPath, fragment };
  }
  return {
    ref,
    kind: fragment === null ? "run_artifact" : "run_artifact_fragment",
    targetPath,
    fragment,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function effectiveDocument(value: Record<string, unknown>): {
  readonly schemaVersion: string;
  readonly document: Record<string, unknown>;
} {
  return value.schema_version === "startup_opportunity.artifact_envelope.current" &&
    typeof value.artifact_type === "string" &&
    isRecord(value.document)
    ? { schemaVersion: value.artifact_type, document: value.document }
    : { schemaVersion: String(value.schema_version ?? ""), document: value };
}

function jsonPointerExists(value: unknown, pointer: string): boolean {
  if (!pointer.startsWith("/")) return false;
  let cursor = value;
  for (const encoded of pointer.slice(1).split("/")) {
    const segment = encoded.replaceAll("~1", "/").replaceAll("~0", "~");
    if (Array.isArray(cursor)) {
      if (!/^(?:0|[1-9][0-9]*)$/u.test(segment) || Number(segment) >= cursor.length) return false;
      cursor = cursor[Number(segment)];
      continue;
    }
    if (!isRecord(cursor) || !Object.hasOwn(cursor, segment)) return false;
    cursor = cursor[segment];
  }
  return true;
}

export async function resolveReferences(input: {
  readonly refs: readonly string[];
  readonly repositoryRoot: string;
  readonly bundle: DocumentBundle;
  readonly referenceContext: DocumentBundleReferenceContext;
}): Promise<readonly ResolvedReference[]> {
  const byPath = new Map(input.bundle.documents.map((entry) => [entry.path, entry.document]));
  const resolved: ResolvedReference[] = [];
  for (const ref of [...new Set(input.refs)].sort()) {
    const classified = classifyReference(ref);
    if (classified.kind === "external_url") {
      resolved.push({ ...classified, contentHash: null });
      continue;
    }
    if (classified.kind === "repository_policy") {
      let value: unknown;
      try {
        value = JSON.parse(
          await readFile(path.join(input.repositoryRoot, classified.targetPath), "utf8"),
        );
      } catch (error) {
        throw new StoreError(
          "reference.repository_policy_missing",
          "repository policy ref is missing or invalid",
          {
            ref,
            cause: error instanceof Error ? error.message : String(error),
          },
        );
      }
      if (classified.fragment !== null && !jsonPointerExists(value, classified.fragment)) {
        throw new StoreError(
          "reference.json_pointer_missing",
          "repository policy JSON pointer is missing",
          { ref },
        );
      }
      resolved.push({ ...classified, contentHash: canonicalContentHash(value) });
      continue;
    }
    if (classified.kind === "evidence_exact_record" || classified.kind === "run_exact_record") {
      const exact = input.referenceContext.exactJsonlRecords?.get(ref);
      if (classified.fragment === null || exact === undefined) {
        throw new StoreError(
          "reference.exact_record_missing",
          "exact record ref is missing from the Run closure",
          {
            ref,
            kind: classified.kind,
          },
        );
      }
      resolved.push({ ...classified, contentHash: canonicalContentHash(exact) });
      continue;
    }
    const target = byPath.get(classified.targetPath);
    if (target === undefined) {
      throw new StoreError(
        "reference.run_artifact_missing",
        "Run Artifact ref is missing from the Run closure",
        {
          ref,
        },
      );
    }
    const effective = effectiveDocument(target);
    if (
      classified.kind === "run_artifact_fragment" &&
      classified.fragment !== null &&
      !formalArtifactFragmentExists(effective, classified.fragment)
    ) {
      throw new StoreError(
        "reference.artifact_fragment_missing",
        "Run Artifact fragment is missing",
        { ref },
      );
    }
    if (
      classified.kind === "json_pointer" &&
      classified.fragment !== null &&
      !jsonPointerExists(effective.document, classified.fragment)
    ) {
      throw new StoreError(
        "reference.json_pointer_missing",
        "Run Artifact JSON pointer is missing",
        { ref },
      );
    }
    resolved.push({ ...classified, contentHash: canonicalContentHash(target) });
  }
  return resolved;
}
