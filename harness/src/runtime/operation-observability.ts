import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

export type ObservableOperation =
  | "runtime_compile"
  | "lane_materialization"
  | "report_build"
  | "run_recovery";

export interface OperationObservation {
  readonly schemaVersion: "startup_opportunity.operation_observation.current";
  readonly operationId: string;
  readonly operation: ObservableOperation;
  readonly phase: string;
  readonly state: "started" | "completed" | "failed";
  readonly sequence: number;
  readonly elapsedMs: number;
  readonly phaseDurationMs: number | null;
  readonly counts: Readonly<Record<string, number>>;
  readonly errorCode: string | null;
}

export type OperationObserver = (observation: OperationObservation) => void;

export function stderrOperationObserver(enabled: boolean): OperationObserver | undefined {
  return enabled
    ? (observation) => process.stderr.write(`${JSON.stringify(observation)}\n`)
    : undefined;
}

export interface OperationTrace {
  readonly start: (phase: string, counts?: Readonly<Record<string, number>>) => void;
  readonly complete: (phase: string, counts?: Readonly<Record<string, number>>) => void;
  readonly fail: (phase: string, errorCode: string) => void;
}

export function operationTrace(
  operation: ObservableOperation,
  observer?: OperationObserver,
): OperationTrace {
  const operationId = randomUUID();
  const started = performance.now();
  const phaseStarts = new Map<string, number>();
  let sequence = 0;
  const emit = (
    phase: string,
    state: OperationObservation["state"],
    counts: Readonly<Record<string, number>> = {},
    errorCode: string | null = null,
  ): void => {
    if (observer === undefined) return;
    const now = performance.now();
    const phaseStarted = phaseStarts.get(phase);
    sequence += 1;
    const event: OperationObservation = {
      schemaVersion: "startup_opportunity.operation_observation.current",
      operationId,
      operation,
      phase,
      state,
      sequence,
      elapsedMs: Math.max(0, now - started),
      phaseDurationMs:
        state === "started" || phaseStarted === undefined ? null : Math.max(0, now - phaseStarted),
      counts: Object.fromEntries(
        Object.entries(counts)
          .filter(([, value]) => Number.isFinite(value) && value >= 0)
          .sort(([left], [right]) => left.localeCompare(right)),
      ),
      errorCode,
    };
    try {
      observer(event);
    } catch {
      // Observability is optional and cannot change validation, publication, or recovery.
    }
  };
  return {
    start(phase, counts) {
      phaseStarts.set(phase, performance.now());
      emit(phase, "started", counts);
    },
    complete(phase, counts) {
      emit(phase, "completed", counts);
    },
    fail(phase, errorCode) {
      emit(phase, "failed", {}, errorCode);
    },
  };
}
