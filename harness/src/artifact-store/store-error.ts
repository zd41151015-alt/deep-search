export class StoreError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "StoreError";
  }
}

export function storeErrorResult(error: unknown): {
  readonly code: string;
  readonly message: string;
  readonly details: Readonly<Record<string, unknown>>;
} {
  if (error instanceof StoreError) {
    return { code: error.code, message: error.message, details: error.details };
  }
  return {
    code: "store.unexpected",
    message: error instanceof Error ? error.message : "unexpected store failure",
    details: {},
  };
}
