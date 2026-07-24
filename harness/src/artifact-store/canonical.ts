import { createHash } from "node:crypto";
import { StoreError } from "./store-error.js";

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function serialize(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new StoreError("hash.non_json_value", "canonical JSON rejects non-finite numbers");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(serialize).join(",")}]`;
  }
  if (typeof value !== "object" || value === undefined) {
    throw new StoreError("hash.non_json_value", "canonical JSON accepts JSON values only");
  }

  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new StoreError("hash.non_json_value", "canonical JSON rejects non-plain objects");
  }
  const record = value as Record<string, unknown>;
  const fields = Object.keys(record)
    .sort(compareCodeUnits)
    .map((key) => `${JSON.stringify(key)}:${serialize(record[key])}`);
  return `{${fields.join(",")}}`;
}

export function canonicalJson(value: unknown): string {
  return serialize(value);
}

export function sha256Bytes(value: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function canonicalContentHash(document: unknown): string {
  return sha256Bytes(canonicalJson(document));
}

export function operationKey(kind: string, input: unknown): string {
  return sha256Bytes(canonicalJson({ kind, input }));
}

export function sha256Hex(value: string): string {
  const match = value.match(/^sha256:([a-f0-9]{64})$/);
  if (!match?.[1]) {
    throw new StoreError("operation.invalid_key", "operation key must be a sha256 value", {
      operationKey: value,
    });
  }
  return match[1];
}
