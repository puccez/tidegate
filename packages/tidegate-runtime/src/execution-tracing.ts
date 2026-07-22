import {
  ExecutionTraceSnapshotSchema,
  type ExecutionSpanTerminalStatus,
  type ExecutionTraceCoverageSnapshot,
  type ExecutionTraceEvent,
  type ExecutionTraceSnapshot,
  type ExecutionTraceSpan,
  type ExecutionTraceStatus,
  type ExecutionTraceSummary,
  type ExecutionTraceTerminalStatus,
} from "@tidegate/contracts";

/**
 * Trace kinds that are demo/reference workloads. Demo traces are excluded
 * from the overall product coverage score. The stored `reportedAsDemo` flag
 * is derived from this list server-side at ingest — never client-claimed.
 */
export const DEMO_EXECUTION_TRACE_KINDS = ["world.chunk.generate"] as const;

export function isDemoExecutionTraceKind(kind: string): boolean {
  return (DEMO_EXECUTION_TRACE_KINDS as readonly string[]).includes(kind);
}

export type ExecutionTraceClockReading = {
  readonly monotonicMs: number;
  readonly wallTime: string;
};

export type ExecutionTraceClock = {
  now(): ExecutionTraceClockReading;
};

export type ExecutionTraceStore = {
  putTrace(snapshot: ExecutionTraceSnapshot): Promise<void>;
  getTrace(ref: {
    readonly ownerId: string;
    readonly traceId: string;
  }): Promise<ExecutionTraceSnapshot | undefined>;
  listTraces(
    query: ExecutionTraceListQuery,
  ): Promise<readonly ExecutionTraceSummary[]>;
  /** Every owner with at least one persisted trace (for the retention sweep). */
  listTraceOwnerIds(): Promise<readonly string[]>;
  /**
   * Tiered, batched retention sweep across ALL owners. Deletes healthy
   * (`complete`/`partial`) traces started before `healthyCutoff` and
   * error-tier traces (every other status) started before `errorCutoff`,
   * `batchSize` parent rows per statement until none remain. Spans and
   * events are removed by the FK cascade, never directly.
   */
  deleteExpired(input: ExecutionTraceRetentionCutoffs): Promise<{
    readonly deletedCount: number;
  }>;
  /**
   * Owner-scoped single-trace erasure. Resolves false when not owned/found.
   * Deliberately keeps the owner's durable coverage snapshots: they are
   * attribute-free aggregates (counts and percentile durations), so they
   * contain nothing of the erased trace to remove, and purging a whole-owner
   * rollup for one trace would destroy the trend line retention exists to
   * preserve.
   */
  deleteTrace(ref: {
    readonly ownerId: string;
    readonly traceId: string;
  }): Promise<boolean>;
  /**
   * Owner-scoped full erasure (GDPR/right-to-erasure, test cleanup). Also
   * deletes the owner's durable coverage snapshots — those rows are keyed to
   * the owner, so a full-erasure request must remove them too.
   * `deletedCount` counts erased traces only.
   */
  deleteByOwner(ownerId: string): Promise<{ readonly deletedCount: number }>;
  /**
   * Upserts on the logical window (ownerId, windowStartedAt, windowEndedAt):
   * a recomputation of the same window supersedes the earlier write instead
   * of duplicating the trend point, so sweep retries stay idempotent. The
   * first-written row id stays stable across the upsert.
   */
  putCoverageSnapshot(snapshot: ExecutionTraceCoverageSnapshot): Promise<void>;
  listCoverageSnapshots(query: {
    readonly ownerId: string;
    readonly limit?: number;
  }): Promise<readonly ExecutionTraceCoverageSnapshot[]>;
};

export type ExecutionTraceRetentionCutoffs = {
  /** ISO timestamp; `complete`/`partial` traces started before it are deleted. */
  readonly healthyCutoff: string;
  /** ISO timestamp; all non-healthy traces started before it are deleted. */
  readonly errorCutoff: string;
  readonly batchSize?: number;
};

export type ExecutionTraceListQuery = {
  readonly before?: string;
  /**
   * Cursor tiebreaker: with `before`, excludes traces at exactly `before`
   * whose id is >= `beforeId`, so paging never skips or repeats traces that
   * share a startedAt timestamp.
   */
  readonly beforeId?: string;
  readonly kind?: string;
  readonly limit?: number;
  readonly ownerId: string;
  readonly status?: ExecutionTraceStatus;
};

export type ExecutionTraceRecorderOptions = {
  readonly clock?: ExecutionTraceClock;
  readonly idFactory?: () => string;
  readonly store: ExecutionTraceStore;
};

export type StartExecutionTraceInput = {
  readonly attributes?: Readonly<Record<string, unknown>>;
  readonly clockDomain: string;
  readonly kind: string;
  readonly ownerId: string;
  readonly source: string;
  readonly tenantId?: string;
};

export type StartExecutionSpanInput = {
  readonly attributes?: Readonly<Record<string, unknown>>;
  readonly category: string;
  readonly name: string;
  readonly parentSpanId?: string;
};

export type ActiveExecutionSpan = {
  readonly id: string;
  finish(
    status: ExecutionSpanTerminalStatus,
    error?: { readonly code?: string; readonly message?: string },
  ): Promise<void>;
};

export type ActiveExecutionTrace = {
  readonly id: string;
  startSpan(input: StartExecutionSpanInput): ActiveExecutionSpan;
  mark(
    name: string,
    attributes?: Readonly<Record<string, unknown>>,
    spanId?: string,
  ): string;
  finish(status: ExecutionTraceTerminalStatus): Promise<ExecutionTraceSnapshot>;
};

export type ExecutionTraceRecorder = {
  startExecution(input: StartExecutionTraceInput): Promise<ActiveExecutionTrace>;
};

export type ExecutionTraceCoverageBucket = {
  readonly coveredDurationMs: number;
  readonly coverageRatio: number;
  readonly durationMs: number;
  readonly meetsTarget: boolean;
  readonly target: number;
  readonly traceCount: number;
};

export type ExecutionTraceFlowCoverage = Omit<
  ExecutionTraceCoverageBucket,
  "target"
> & {
  readonly demo: boolean;
  readonly kind: string;
  readonly target: number | null;
};

export type ExecutionTraceCoverageSummary = {
  readonly overall: ExecutionTraceCoverageBucket;
  readonly flows: readonly ExecutionTraceFlowCoverage[];
  readonly meetsGoal: boolean;
};

export type ExecutionTraceExportFormat = "json" | "jsonl";

export function serializeExecutionTraceSnapshot(
  input: ExecutionTraceSnapshot,
  format: ExecutionTraceExportFormat,
): string {
  const snapshot = ExecutionTraceSnapshotSchema.parse(input);
  if (format === "json") {
    return `${JSON.stringify(snapshot, null, 2)}\n`;
  }

  const records: Array<
    | { readonly type: "span"; readonly sequence: number; readonly data: ExecutionTraceSpan }
    | { readonly type: "event"; readonly sequence: number; readonly data: ExecutionTraceEvent }
  > = [
    ...snapshot.spans.map((data) => ({
      type: "span" as const,
      sequence: data.sequence,
      data,
    })),
    ...snapshot.events.map((data) => ({
      type: "event" as const,
      sequence: data.sequence,
      data,
    })),
  ];
  records.sort((left, right) => left.sequence - right.sequence);

  return [
    JSON.stringify({ type: "trace", data: snapshot.trace }),
    ...records.map(({ type, data }) => JSON.stringify({ type, data })),
    "",
  ].join("\n");
}

export function sanitizeExecutionTraceSnapshot(
  input: ExecutionTraceSnapshot,
): ExecutionTraceSnapshot {
  const snapshot = ExecutionTraceSnapshotSchema.parse(input);
  return {
    trace: {
      ...snapshot.trace,
      attributes: redactAttributes(snapshot.trace.attributes),
    },
    spans: snapshot.spans.map((span) => ({
      ...span,
      attributes: redactAttributes(span.attributes),
    })),
    events: snapshot.events.map((event) => ({
      ...event,
      attributes: redactAttributes(event.attributes),
    })),
  };
}

export function summarizeExecutionTraceCoverage(
  traces: readonly ExecutionTraceSummary[],
  options: {
    readonly demoKinds?: readonly string[];
    readonly overallTarget: number;
    readonly perFlowTarget: number;
  },
): ExecutionTraceCoverageSummary {
  assertCoverageTarget(options.overallTarget);
  assertCoverageTarget(options.perFlowTarget);
  const demoKinds = new Set(options.demoKinds ?? []);
  // Demo detection prefers the stored per-trace flag; the kind list stays as
  // a fallback so rows persisted before the flag existed remain correct.
  const isDemoTrace = (trace: ExecutionTraceSummary): boolean =>
    trace.reportedAsDemo === true || demoKinds.has(trace.kind);
  const eligible = traces.filter(
    (trace) =>
      trace.status !== "running" &&
      trace.durationMs !== undefined &&
      trace.coveredDurationMs !== undefined,
  );
  // The product score is over non-demo flows only: a long, fully covered
  // demo workload (World) must never lift the overall gate.
  const overallTotals = coverageTotals(
    eligible.filter((trace) => !isDemoTrace(trace)),
  );
  const overall: ExecutionTraceCoverageBucket = {
    ...overallTotals,
    meetsTarget: overallTotals.coverageRatio >= options.overallTarget,
    target: options.overallTarget,
  };
  const tracesByKind = Map.groupBy(eligible, (trace) => trace.kind);
  const flows = [...tracesByKind.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([kind, kindTraces]) => {
      const totals = coverageTotals(kindTraces);
      // A flow is demo only when every trace in it is demo: one flagged
      // trace must not exempt a product flow from the per-flow floor.
      const demo =
        demoKinds.has(kind) || kindTraces.every((trace) => isDemoTrace(trace));
      return {
        ...totals,
        demo,
        kind,
        meetsTarget: demo || totals.coverageRatio >= options.perFlowTarget,
        target: demo ? null : options.perFlowTarget,
      };
    });

  return {
    overall,
    flows,
    meetsGoal: overall.meetsTarget && flows.every((flow) => flow.meetsTarget),
  };
}

/**
 * Builds the durable per-owner coverage/latency rollup that must be persisted
 * BEFORE retention deletes the raw traces it is derived from. Carries only
 * aggregates (numerators, denominators, percentiles) — never trace attributes,
 * so retention of snapshots cannot extend the attribute redaction guarantee.
 */
export function buildExecutionTraceCoverageSnapshot({
  computedAt,
  demoKinds = DEMO_EXECUTION_TRACE_KINDS,
  idFactory = () => crypto.randomUUID(),
  ownerId,
  traces,
  windowEndedAt,
  windowStartedAt,
}: {
  readonly computedAt: string;
  readonly demoKinds?: readonly string[];
  readonly idFactory?: () => string;
  readonly ownerId: string;
  readonly traces: readonly ExecutionTraceSummary[];
  readonly windowEndedAt: string;
  readonly windowStartedAt: string;
}): ExecutionTraceCoverageSnapshot {
  const demoKindSet = new Set(demoKinds);
  const isDemoTrace = (trace: ExecutionTraceSummary): boolean =>
    trace.reportedAsDemo === true || demoKindSet.has(trace.kind);
  const eligible = traces.filter(
    (trace) =>
      trace.status !== "running" &&
      trace.durationMs !== undefined &&
      trace.coveredDurationMs !== undefined,
  );
  const overall = coverageTotals(eligible.filter((trace) => !isDemoTrace(trace)));
  const flows = [...Map.groupBy(eligible, (trace) => trace.kind).entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([kind, kindTraces]) => {
      const totals = coverageTotals(kindTraces);
      const durations = kindTraces
        .map((trace) => trace.durationMs ?? 0)
        .sort((left, right) => left - right);
      return {
        kind,
        demo:
          demoKindSet.has(kind) || kindTraces.every((trace) => isDemoTrace(trace)),
        coveredDurationMs: totals.coveredDurationMs,
        durationMs: totals.durationMs,
        traceCount: totals.traceCount,
        p50DurationMs: percentile(durations, 0.5),
        p95DurationMs: percentile(durations, 0.95),
      };
    });
  return {
    id: idFactory(),
    ownerId,
    windowStartedAt,
    windowEndedAt,
    overallCoveredDurationMs: overall.coveredDurationMs,
    overallDurationMs: overall.durationMs,
    overallTraceCount: overall.traceCount,
    flows,
    computedAt,
  };
}

/** Nearest-rank percentile over an ascending-sorted list; 0 when empty. */
function percentile(sortedAscending: readonly number[], quantile: number): number {
  if (sortedAscending.length === 0) {
    return 0;
  }
  const rank = Math.ceil(quantile * sortedAscending.length);
  return sortedAscending[Math.min(sortedAscending.length, Math.max(1, rank)) - 1] ?? 0;
}

export function createExecutionTraceRecorder({
  clock = systemExecutionTraceClock,
  idFactory = () => crypto.randomUUID(),
  store,
}: ExecutionTraceRecorderOptions): ExecutionTraceRecorder {
  return {
    async startExecution(input) {
      const rootStart = clock.now();
      const traceId = idFactory();
      const spans: ExecutionTraceSpan[] = [];
      const events: ExecutionTraceEvent[] = [];
      let nextSequence = 0;
      let finished = false;

      await store.putTrace(
        ExecutionTraceSnapshotSchema.parse({
          trace: {
            id: traceId,
            ownerId: input.ownerId,
            ...(input.tenantId === undefined
              ? {}
              : { tenantId: input.tenantId }),
            kind: input.kind,
            source: input.source,
            clockDomain: input.clockDomain,
            status: "running",
            startedAt: rootStart.wallTime,
            reportedAsDemo: isDemoExecutionTraceKind(input.kind),
            attributes: redactAttributes(input.attributes),
          },
          spans,
          events,
        }),
      );

      const assertActive = () => {
        if (finished) {
          throw new Error(`Execution trace "${traceId}" is already finished.`);
        }
      };

      return {
        id: traceId,
        startSpan(spanInput) {
          assertActive();
          const start = clock.now();
          const spanId = idFactory();
          const span: ExecutionTraceSpan = {
            id: spanId,
            traceId,
            ...(spanInput.parentSpanId === undefined
              ? {}
              : { parentSpanId: spanInput.parentSpanId }),
            name: spanInput.name,
            category: spanInput.category,
            source: input.source,
            clockDomain: input.clockDomain,
            status: "running",
            startedAt: start.wallTime,
            startOffsetMs: elapsed(rootStart.monotonicMs, start.monotonicMs),
            sequence: nextSequence++,
            attributes: redactAttributes(spanInput.attributes),
          };
          spans.push(span);
          let spanFinished = false;

          return {
            id: spanId,
            async finish(status, error) {
              assertActive();
              if (spanFinished) {
                throw new Error(`Execution span "${spanId}" is already finished.`);
              }
              const end = clock.now();
              const endOffsetMs = elapsed(
                rootStart.monotonicMs,
                end.monotonicMs,
              );
              const durationMs = elapsed(span.startOffsetMs, endOffsetMs);
              spanFinished = true;
              Object.assign(span, {
                status,
                endedAt: end.wallTime,
                endOffsetMs,
                durationMs,
                ...(error?.code === undefined ? {} : { errorCode: error.code }),
                ...(error?.message === undefined
                  ? {}
                  : { errorMessage: error.message }),
              });
            },
          };
        },
        mark(name, attributes, spanId) {
          assertActive();
          const at = clock.now();
          const eventId = idFactory();
          events.push({
            id: eventId,
            traceId,
            ...(spanId === undefined ? {} : { spanId }),
            name,
            source: input.source,
            clockDomain: input.clockDomain,
            occurredAt: at.wallTime,
            monotonicOffsetMs: elapsed(
              rootStart.monotonicMs,
              at.monotonicMs,
            ),
            sequence: nextSequence++,
            attributes: redactAttributes(attributes),
          });
          return eventId;
        },
        async finish(status) {
          assertActive();
          finished = true;
          const end = clock.now();
          const durationMs = elapsed(
            rootStart.monotonicMs,
            end.monotonicMs,
          );
          const coveredDurationMs = coveredIntervalDuration(
            spans
              .filter((span) => span.endOffsetMs !== undefined)
              .map((span) => ({
                end: span.endOffsetMs ?? span.startOffsetMs,
                start: span.startOffsetMs,
              })),
            durationMs,
          );
          const effectiveStatus = spans.some(
            (span) => span.status === "running",
          )
            ? "incomplete"
            : status;
          const trace: ExecutionTraceSummary = {
            id: traceId,
            ownerId: input.ownerId,
            ...(input.tenantId === undefined ? {} : { tenantId: input.tenantId }),
            kind: input.kind,
            source: input.source,
            clockDomain: input.clockDomain,
            status: effectiveStatus,
            startedAt: rootStart.wallTime,
            endedAt: end.wallTime,
            reportedAsDemo: isDemoExecutionTraceKind(input.kind),
            durationMs,
            coveredDurationMs,
            coverageRatio: durationMs === 0 ? 0 : coveredDurationMs / durationMs,
            unknownDurationMs: durationMs - coveredDurationMs,
            attributes: redactAttributes(input.attributes),
          };
          const snapshot = ExecutionTraceSnapshotSchema.parse({
            trace,
            spans,
            events,
          });
          await store.putTrace(snapshot);
          return snapshot;
        },
      };
    },
  };
}

export function createInMemoryExecutionTraceStore(): ExecutionTraceStore {
  const snapshots = new Map<string, ExecutionTraceSnapshot>();
  const coverageSnapshots = new Map<string, ExecutionTraceCoverageSnapshot>();

  return {
    async putTrace(snapshot) {
      const sanitized = sanitizeExecutionTraceSnapshot(snapshot);
      const existing = snapshots.get(sanitized.trace.id);
      // Unawaited producers can deliver snapshots out of order: a stale
      // "running" snapshot must never roll back a settled trace.
      if (
        existing !== undefined &&
        existing.trace.status !== "running" &&
        sanitized.trace.status === "running"
      ) {
        return;
      }
      snapshots.set(sanitized.trace.id, structuredClone(sanitized));
    },
    async getTrace({ ownerId, traceId }) {
      const snapshot = snapshots.get(traceId);
      return snapshot === undefined || snapshot.trace.ownerId !== ownerId
        ? undefined
        : structuredClone(snapshot);
    },
    async listTraces({ before, beforeId, kind, limit, ownerId, status }) {
      return [...snapshots.values()]
        .map(({ trace }) => trace)
        .filter(
          (trace) =>
            trace.ownerId === ownerId &&
            (kind === undefined || trace.kind === kind) &&
            (status === undefined || trace.status === status) &&
            isBeforeTraceCursor(trace, before, beforeId),
        )
        .sort(
          (left, right) =>
            right.startedAt.localeCompare(left.startedAt) ||
            right.id.localeCompare(left.id),
        )
        .slice(0, normalizeTraceListLimit(limit))
        .map((trace) => structuredClone(trace));
    },
    async listTraceOwnerIds() {
      return [
        ...new Set([...snapshots.values()].map(({ trace }) => trace.ownerId)),
      ].sort();
    },
    async deleteExpired({ errorCutoff, healthyCutoff }) {
      let deletedCount = 0;
      for (const [traceId, { trace }] of snapshots) {
        const cutoff = HEALTHY_EXECUTION_TRACE_STATUSES.has(trace.status)
          ? healthyCutoff
          : errorCutoff;
        if (trace.startedAt < cutoff) {
          snapshots.delete(traceId);
          deletedCount += 1;
        }
      }
      return { deletedCount };
    },
    async deleteTrace({ ownerId, traceId }) {
      const snapshot = snapshots.get(traceId);
      if (snapshot === undefined || snapshot.trace.ownerId !== ownerId) {
        return false;
      }
      snapshots.delete(traceId);
      return true;
    },
    async deleteByOwner(ownerId) {
      let deletedCount = 0;
      for (const [traceId, { trace }] of snapshots) {
        if (trace.ownerId === ownerId) {
          snapshots.delete(traceId);
          deletedCount += 1;
        }
      }
      // Full erasure covers the durable rollups too: coverage snapshots are
      // keyed to the owner, so a right-to-erasure request removes them.
      for (const [key, coverageSnapshot] of coverageSnapshots) {
        if (coverageSnapshot.ownerId === ownerId) {
          coverageSnapshots.delete(key);
        }
      }
      return { deletedCount };
    },
    async putCoverageSnapshot(snapshot) {
      // One row per logical window: a recompute of the same window replaces
      // the earlier aggregate (last write wins — the newer computation can
      // only include more late-arriving data), keeping the original row id.
      const key = `${snapshot.ownerId}|${snapshot.windowStartedAt}|${snapshot.windowEndedAt}`;
      const existing = coverageSnapshots.get(key);
      coverageSnapshots.set(
        key,
        structuredClone(
          existing === undefined ? snapshot : { ...snapshot, id: existing.id },
        ),
      );
    },
    async listCoverageSnapshots({ limit, ownerId }) {
      return [...coverageSnapshots.values()]
        .filter((snapshot) => snapshot.ownerId === ownerId)
        .sort(
          (left, right) =>
            right.computedAt.localeCompare(left.computedAt) ||
            right.id.localeCompare(left.id),
        )
        .slice(0, normalizeTraceListLimit(limit))
        .map((snapshot) => structuredClone(snapshot));
    },
  };
}

/**
 * Retention tiers: healthy traces are the 60-day tier; every other status
 * (failed, cancelled, incomplete, fallback — and abandoned "running" roots
 * that will never settle) is the longer 90-day error tier.
 */
export const HEALTHY_EXECUTION_TRACE_STATUSES: ReadonlySet<ExecutionTraceStatus> =
  new Set(["complete", "partial"]);

function isBeforeTraceCursor(
  trace: ExecutionTraceSummary,
  before: string | undefined,
  beforeId: string | undefined,
): boolean {
  if (before === undefined) {
    return true;
  }
  if (trace.startedAt < before) {
    return true;
  }
  return (
    beforeId !== undefined &&
    trace.startedAt === before &&
    trace.id < beforeId
  );
}

function normalizeTraceListLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return 50;
  }
  return Math.min(Math.max(Math.trunc(limit), 1), 100);
}

function elapsed(start: number, end: number): number {
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    throw new Error("Execution trace clock must be finite and monotonic.");
  }
  return end - start;
}

function coverageTotals(
  traces: readonly ExecutionTraceSummary[],
): Pick<
  ExecutionTraceCoverageBucket,
  "coveredDurationMs" | "coverageRatio" | "durationMs" | "traceCount"
> {
  let durationMs = 0;
  let coveredDurationMs = 0;
  for (const trace of traces) {
    const duration = trace.durationMs ?? 0;
    durationMs += duration;
    coveredDurationMs += Math.max(
      0,
      Math.min(duration, trace.coveredDurationMs ?? 0),
    );
  }
  return {
    coveredDurationMs,
    coverageRatio: durationMs === 0 ? 0 : coveredDurationMs / durationMs,
    durationMs,
    traceCount: traces.length,
  };
}

function assertCoverageTarget(target: number): void {
  if (!Number.isFinite(target) || target < 0 || target > 1) {
    throw new Error("Execution trace coverage targets must be between 0 and 1.");
  }
}

function coveredIntervalDuration(
  intervals: readonly { readonly start: number; readonly end: number }[],
  rootDurationMs: number,
): number {
  const clipped = intervals
    .map(({ start, end }) => ({
      start: Math.max(0, Math.min(rootDurationMs, start)),
      end: Math.max(0, Math.min(rootDurationMs, end)),
    }))
    .filter(({ start, end }) => end > start)
    .sort((left, right) => left.start - right.start || left.end - right.end);

  let covered = 0;
  let currentStart: number | undefined;
  let currentEnd: number | undefined;

  for (const interval of clipped) {
    if (currentStart === undefined || currentEnd === undefined) {
      currentStart = interval.start;
      currentEnd = interval.end;
      continue;
    }
    if (interval.start <= currentEnd) {
      currentEnd = Math.max(currentEnd, interval.end);
      continue;
    }
    covered += currentEnd - currentStart;
    currentStart = interval.start;
    currentEnd = interval.end;
  }

  if (currentStart !== undefined && currentEnd !== undefined) {
    covered += currentEnd - currentStart;
  }
  return covered;
}

const REDACTED_TRACE_ATTRIBUTE_KEYS = new Set([
  "apikey",
  "authorization",
  "cookie",
  "generatedsource",
  "password",
  "prompt",
  "requestbody",
  "responsebody",
  "secret",
  "setcookie",
  "token",
  "accesstoken",
  "refreshtoken",
]);

function redactAttributes(
  attributes: Readonly<Record<string, unknown>> | undefined,
): Record<string, unknown> {
  if (attributes === undefined) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(attributes).map(([key, value]) => [
      key,
      // Numeric/boolean values under sensitive-looking keys are metrics
      // (outputTokens, promptTokens), not secrets — secrets are strings.
      isSensitiveAttributeKey(key) &&
      typeof value !== "number" &&
      typeof value !== "boolean"
        ? "[REDACTED]"
        : redactAttributeValue(value),
    ]),
  );
}

function redactAttributeValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactAttributeValue);
  }
  if (typeof value === "object" && value !== null) {
    return redactAttributes(value as Readonly<Record<string, unknown>>);
  }
  return value;
}

// Substring fragments: producers name keys freely (`systemPrompt`,
// `sessionToken`, `rawRequestBody`), so exact-key matching is not enough.
const REDACTED_TRACE_ATTRIBUTE_KEY_FRAGMENTS = [
  "apikey",
  "authorization",
  "bearer",
  "cookie",
  "credential",
  "password",
  "prompt",
  "secret",
  "token",
] as const;

function isSensitiveAttributeKey(key: string): boolean {
  const normalized = key.toLowerCase().replaceAll(/[^a-z0-9]/g, "");
  return (
    REDACTED_TRACE_ATTRIBUTE_KEYS.has(normalized) ||
    REDACTED_TRACE_ATTRIBUTE_KEY_FRAGMENTS.some((fragment) =>
      normalized.includes(fragment),
    )
  );
}

const systemExecutionTraceClock: ExecutionTraceClock = {
  now() {
    return {
      monotonicMs: performance.now(),
      wallTime: new Date().toISOString(),
    };
  },
};
