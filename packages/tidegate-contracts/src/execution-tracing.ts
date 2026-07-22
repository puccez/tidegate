import { z } from "zod";

const TraceAttributesSchema = z.record(z.string(), z.unknown());

export const ExecutionTraceStatusSchema = z.enum([
  "running",
  "complete",
  "partial",
  "failed",
  "cancelled",
  "fallback",
  "incomplete",
]);

export type ExecutionTraceStatus = z.infer<typeof ExecutionTraceStatusSchema>;
export type ExecutionTraceTerminalStatus = Exclude<
  ExecutionTraceStatus,
  "running"
>;

export const ExecutionSpanStatusSchema = z.enum([
  "running",
  "ok",
  "error",
  "cancelled",
]);

export type ExecutionSpanStatus = z.infer<typeof ExecutionSpanStatusSchema>;
export type ExecutionSpanTerminalStatus = Exclude<
  ExecutionSpanStatus,
  "running"
>;

export const ExecutionTraceSummarySchema = z.object({
  id: z.string().min(1),
  ownerId: z.string().min(1),
  tenantId: z.string().min(1).optional(),
  kind: z.string().min(1),
  source: z.string().min(1),
  clockDomain: z.string().min(1),
  status: ExecutionTraceStatusSchema,
  startedAt: z.string().datetime({ offset: true }),
  endedAt: z.string().datetime({ offset: true }).optional(),
  durationMs: z.number().nonnegative().optional(),
  coveredDurationMs: z.number().nonnegative().optional(),
  coverageRatio: z.number().min(0).max(1).optional(),
  unknownDurationMs: z.number().nonnegative().optional(),
  // Demo workloads (World) are excluded from the product coverage score.
  // Server-derived from the trace kind at ingest — never client-claimed.
  // Defaulted so payloads from producers older than this field still parse.
  reportedAsDemo: z.boolean().default(false),
  // Forward-compat sampler plumbing only (no sampler is built yet): the
  // effective head-sampling rate this trace was persisted under and why.
  // A rate plus reason stays interpretable later where a bare boolean would not.
  sampleRate: z.number().gt(0).max(1).optional(),
  sampleReason: z.string().min(1).optional(),
  attributes: TraceAttributesSchema,
});

export type ExecutionTraceSummary = z.infer<
  typeof ExecutionTraceSummarySchema
>;

export const ExecutionTraceSpanSchema = z.object({
  id: z.string().min(1),
  traceId: z.string().min(1),
  parentSpanId: z.string().min(1).optional(),
  name: z.string().min(1),
  category: z.string().min(1),
  source: z.string().min(1),
  clockDomain: z.string().min(1),
  status: ExecutionSpanStatusSchema,
  startedAt: z.string().datetime({ offset: true }),
  endedAt: z.string().datetime({ offset: true }).optional(),
  startOffsetMs: z.number().nonnegative(),
  endOffsetMs: z.number().nonnegative().optional(),
  durationMs: z.number().nonnegative().optional(),
  sequence: z.number().int().nonnegative(),
  attributes: TraceAttributesSchema,
  errorCode: z.string().min(1).optional(),
  errorMessage: z.string().min(1).optional(),
});

export type ExecutionTraceSpan = z.infer<typeof ExecutionTraceSpanSchema>;

export const ExecutionTraceEventSchema = z.object({
  id: z.string().min(1),
  traceId: z.string().min(1),
  spanId: z.string().min(1).optional(),
  name: z.string().min(1),
  source: z.string().min(1),
  clockDomain: z.string().min(1),
  occurredAt: z.string().datetime({ offset: true }),
  monotonicOffsetMs: z.number().nonnegative(),
  sequence: z.number().int().nonnegative(),
  attributes: TraceAttributesSchema,
});

export type ExecutionTraceEvent = z.infer<typeof ExecutionTraceEventSchema>;

export const ExecutionTraceSnapshotSchema = z.object({
  trace: ExecutionTraceSummarySchema,
  spans: z.array(ExecutionTraceSpanSchema),
  events: z.array(ExecutionTraceEventSchema),
});

export type ExecutionTraceSnapshot = z.infer<
  typeof ExecutionTraceSnapshotSchema
>;

/**
 * Durable per-flow coverage/latency rollup. Retention deletes raw traces, so
 * the trend line (coverage numerator/denominator, p50/p95 per flow) must be
 * persisted BEFORE any retention delete can remove the underlying rows.
 */
export const ExecutionTraceCoverageSnapshotFlowSchema = z.object({
  kind: z.string().min(1),
  demo: z.boolean(),
  coveredDurationMs: z.number().nonnegative(),
  durationMs: z.number().nonnegative(),
  traceCount: z.number().int().nonnegative(),
  p50DurationMs: z.number().nonnegative(),
  p95DurationMs: z.number().nonnegative(),
});

export type ExecutionTraceCoverageSnapshotFlow = z.infer<
  typeof ExecutionTraceCoverageSnapshotFlowSchema
>;

export const ExecutionTraceCoverageSnapshotSchema = z.object({
  id: z.string().min(1),
  ownerId: z.string().min(1),
  windowStartedAt: z.string().datetime({ offset: true }),
  windowEndedAt: z.string().datetime({ offset: true }),
  overallCoveredDurationMs: z.number().nonnegative(),
  overallDurationMs: z.number().nonnegative(),
  overallTraceCount: z.number().int().nonnegative(),
  flows: z.array(ExecutionTraceCoverageSnapshotFlowSchema),
  computedAt: z.string().datetime({ offset: true }),
});

export type ExecutionTraceCoverageSnapshot = z.infer<
  typeof ExecutionTraceCoverageSnapshotSchema
>;

export const ExecutionTraceIngestRequestSchema = z
  .object({
    trace: ExecutionTraceSummarySchema.omit({ id: true, ownerId: true }).strict(),
    spans: z.array(ExecutionTraceSpanSchema.omit({ traceId: true }).strict()),
    events: z.array(ExecutionTraceEventSchema.omit({ traceId: true }).strict()),
  })
  .strict();

export type ExecutionTraceIngestRequest = z.infer<
  typeof ExecutionTraceIngestRequestSchema
>;
