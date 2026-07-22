import { describe, expect, test } from "bun:test";
import {
  ExecutionTraceCoverageSnapshotSchema,
  ExecutionTraceIngestRequestSchema,
  ExecutionTraceSummarySchema,
} from "./execution-tracing.ts";

describe("execution trace ingest back-compat", () => {
  // The exact shape a producer built before reportedAsDemo/sampleRate/
  // sampleReason existed. The ingest schema is strict, so these fields must
  // carry Zod defaults — a bare DB default would not make this parse.
  const legacyIngestRequest = {
    trace: {
      kind: "conversation.turn",
      source: "tidegate.browser",
      clockDomain: "browser",
      status: "complete",
      startedAt: "2026-07-10T10:00:00.000Z",
      endedAt: "2026-07-10T10:00:01.000Z",
      durationMs: 1_000,
      coveredDurationMs: 800,
      coverageRatio: 0.8,
      unknownDurationMs: 200,
      attributes: {},
    },
    spans: [],
    events: [],
  };

  test("parses payloads from producers that predate the new fields", () => {
    const parsed = ExecutionTraceIngestRequestSchema.parse(legacyIngestRequest);
    expect(parsed.trace.reportedAsDemo).toBe(false);
    expect(parsed.trace.sampleRate).toBeUndefined();
    expect(parsed.trace.sampleReason).toBeUndefined();
  });

  test("accepts explicit sampler plumbing values", () => {
    const parsed = ExecutionTraceIngestRequestSchema.parse({
      ...legacyIngestRequest,
      trace: {
        ...legacyIngestRequest.trace,
        reportedAsDemo: true,
        sampleRate: 0.25,
        sampleReason: "steady-state",
      },
    });
    expect(parsed.trace.reportedAsDemo).toBe(true);
    expect(parsed.trace.sampleRate).toBe(0.25);
    expect(parsed.trace.sampleReason).toBe("steady-state");
  });

  test("rejects sample rates outside (0, 1]", () => {
    for (const sampleRate of [0, -0.5, 1.5]) {
      expect(() =>
        ExecutionTraceIngestRequestSchema.parse({
          ...legacyIngestRequest,
          trace: { ...legacyIngestRequest.trace, sampleRate },
        }),
      ).toThrow();
    }
  });

  test("defaults reportedAsDemo on stored summaries as well", () => {
    const parsed = ExecutionTraceSummarySchema.parse({
      ...legacyIngestRequest.trace,
      id: "trace_1",
      ownerId: "user_1",
    });
    expect(parsed.reportedAsDemo).toBe(false);
  });
});

describe("execution trace coverage snapshot contract", () => {
  test("round-trips a durable per-flow rollup", () => {
    const snapshot = {
      id: "covsnap_1",
      ownerId: "user_1",
      windowStartedAt: "2026-06-01T00:00:00.000Z",
      windowEndedAt: "2026-07-10T00:00:00.000Z",
      overallCoveredDurationMs: 8_000,
      overallDurationMs: 10_000,
      overallTraceCount: 12,
      flows: [
        {
          kind: "conversation.turn",
          demo: false,
          coveredDurationMs: 8_000,
          durationMs: 10_000,
          traceCount: 12,
          p50DurationMs: 700,
          p95DurationMs: 2_400,
        },
      ],
      computedAt: "2026-07-10T04:00:00.000Z",
    };
    expect(ExecutionTraceCoverageSnapshotSchema.parse(snapshot)).toEqual(
      snapshot,
    );
  });
});
