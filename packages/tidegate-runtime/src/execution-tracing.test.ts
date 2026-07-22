import { describe, expect, test } from "bun:test";
import {
  buildExecutionTraceCoverageSnapshot,
  createExecutionTraceRecorder,
  createInMemoryExecutionTraceStore,
  serializeExecutionTraceSnapshot,
  summarizeExecutionTraceCoverage,
  type ExecutionTraceClock,
} from "./execution-tracing.ts";
import type {
  ExecutionTraceCoverageSnapshot,
  ExecutionTraceStatus,
  ExecutionTraceSummary,
} from "@tidegate/contracts";

describe("ExecutionTraceRecorder", () => {
  test("persists the running root before returning control to the caller", async () => {
    const clock = createManualClock("2026-07-10T10:00:00.000Z");
    const store = createInMemoryExecutionTraceStore();
    const recorder = createExecutionTraceRecorder({
      clock,
      idFactory: sequentialIds(),
      store,
    });

    const execution = await recorder.startExecution({
      clockDomain: "server",
      kind: "sandbox.execute",
      ownerId: "user_123",
      source: "tidegate.runtime",
    });

    expect(
      await store.getTrace({ ownerId: "user_123", traceId: execution.id }),
    ).toEqual({
      trace: {
        attributes: {},
        clockDomain: "server",
        id: execution.id,
        kind: "sandbox.execute",
        ownerId: "user_123",
        reportedAsDemo: false,
        source: "tidegate.runtime",
        startedAt: "2026-07-10T10:00:00.000Z",
        status: "running",
      },
      spans: [],
      events: [],
    });
  });

  test("persists correlated spans and counts overlapping covered time once", async () => {
    const clock = createManualClock("2026-07-10T10:00:00.000Z");
    const store = createInMemoryExecutionTraceStore();
    const recorder = createExecutionTraceRecorder({
      clock,
      idFactory: sequentialIds(),
      store,
    });

    const execution = await recorder.startExecution({
      attributes: { chunk: { x: 2, z: -1 } },
      clockDomain: "browser",
      kind: "world.chunk.generate",
      ownerId: "user_123",
      source: "world.client",
    });

    clock.advance(100);
    const model = execution.startSpan({
      category: "model",
      name: "chunk-builder.generate",
    });

    clock.advance(400);
    const transport = execution.startSpan({
      category: "transport",
      name: "chunk-patch.stream",
    });

    clock.advance(100);
    await model.finish("ok");
    execution.mark("ui.first_valid_patch", { patchIndex: 1 });

    clock.advance(200);
    await transport.finish("ok");
    clock.advance(200);

    const snapshot = await execution.finish("complete");

    expect(snapshot.trace).toMatchObject({
      clockDomain: "browser",
      coveredDurationMs: 700,
      coverageRatio: 0.7,
      durationMs: 1000,
      kind: "world.chunk.generate",
      ownerId: "user_123",
      status: "complete",
      unknownDurationMs: 300,
    });
    expect(snapshot.spans.map(({ category, durationMs, name }) => ({
      category,
      durationMs,
      name,
    }))).toEqual([
      {
        category: "model",
        durationMs: 500,
        name: "chunk-builder.generate",
      },
      {
        category: "transport",
        durationMs: 300,
        name: "chunk-patch.stream",
      },
    ]);
    expect(snapshot.events).toHaveLength(1);
    expect(snapshot.events[0]).toMatchObject({
      attributes: { patchIndex: 1 },
      monotonicOffsetMs: 600,
      name: "ui.first_valid_patch",
    });
    expect(
      await store.getTrace({
        ownerId: "user_123",
        traceId: snapshot.trace.id,
      }),
    ).toEqual(snapshot);
  });

  test("marks a terminal trace incomplete when a span never finishes", async () => {
    const clock = createManualClock("2026-07-10T10:00:00.000Z");
    const recorder = createExecutionTraceRecorder({
      clock,
      idFactory: sequentialIds(),
      store: createInMemoryExecutionTraceStore(),
    });
    const execution = await recorder.startExecution({
      clockDomain: "server",
      kind: "interaction.invoke",
      ownerId: "user_123",
      source: "tidegate.server",
    });

    clock.advance(100);
    execution.startSpan({ category: "action", name: "customer.action" });
    clock.advance(400);

    const snapshot = await execution.finish("complete");

    expect(snapshot.trace).toMatchObject({
      coveredDurationMs: 0,
      coverageRatio: 0,
      durationMs: 500,
      status: "incomplete",
      unknownDurationMs: 500,
    });
    expect(snapshot.spans[0]?.status).toBe("running");
    expect(snapshot.spans[0]?.durationMs).toBeUndefined();
  });

  test("rejects an out-of-order span end without preventing a valid retry", async () => {
    const clock = createManualClock("2026-07-10T10:00:00.000Z");
    const recorder = createExecutionTraceRecorder({
      clock,
      idFactory: sequentialIds(),
      store: createInMemoryExecutionTraceStore(),
    });
    const execution = await recorder.startExecution({
      clockDomain: "eve",
      kind: "conversation.turn",
      ownerId: "user_123",
      source: "eve.session",
    });

    clock.advance(200);
    const span = execution.startSpan({ category: "model", name: "model.turn" });
    clock.set(100);

    await expect(span.finish("ok")).rejects.toThrow("monotonic");

    clock.set(300);
    await span.finish("ok");
    clock.set(400);
    const snapshot = await execution.finish("complete");

    expect(snapshot.trace.status).toBe("complete");
    expect(snapshot.spans[0]?.durationMs).toBe(100);
  });

  test("redacts secret-bearing attributes before they reach a snapshot or store", async () => {
    const clock = createManualClock("2026-07-10T10:00:00.000Z");
    const store = createInMemoryExecutionTraceStore();
    const recorder = createExecutionTraceRecorder({
      clock,
      idFactory: sequentialIds(),
      store,
    });
    const execution = await recorder.startExecution({
      attributes: {
        modelId: "gpt-test",
        prompt: "do not persist this prompt",
        headers: { authorization: "Bearer private" },
      },
      clockDomain: "server",
      kind: "ui.generate",
      ownerId: "user_123",
      source: "tidegate.server",
    });
    const span = execution.startSpan({
      attributes: {
        apiKey: "sk-private",
        outputTokens: 42,
        sessionToken: "tok-private",
        systemPrompt: "hidden system prompt",
      },
      category: "model",
      name: "model.generate",
    });
    execution.mark("model.first_token", { token: "private-token" });
    clock.advance(10);
    await span.finish("ok");
    const snapshot = await execution.finish("complete");

    expect(snapshot.trace.attributes).toEqual({
      modelId: "gpt-test",
      prompt: "[REDACTED]",
      headers: { authorization: "[REDACTED]" },
    });
    expect(snapshot.spans[0]?.attributes).toEqual({
      apiKey: "[REDACTED]",
      outputTokens: 42,
      sessionToken: "[REDACTED]",
      systemPrompt: "[REDACTED]",
    });
    expect(snapshot.events[0]?.attributes).toEqual({ token: "[REDACTED]" });
    expect(
      JSON.stringify(
        await store.getTrace({
          ownerId: "user_123",
          traceId: snapshot.trace.id,
        }),
      ),
    ).not.toContain("private");
  });
});

describe("summarizeExecutionTraceCoverage", () => {
  test("weights coverage by duration and applies the non-demo flow floor", () => {
    const summary = summarizeExecutionTraceCoverage(
      [
        traceSummary({
          coveredDurationMs: 8_000,
          durationMs: 10_000,
          id: "conversation_slow",
          kind: "conversation.turn",
        }),
        traceSummary({
          coveredDurationMs: 0,
          durationMs: 100,
          id: "conversation_fast",
          kind: "conversation.turn",
        }),
        traceSummary({
          coveredDurationMs: 900,
          durationMs: 1_000,
          id: "world",
          kind: "world.chunk.generate",
        }),
      ],
      {
        demoKinds: ["world.chunk.generate"],
        overallTarget: 0.8,
        perFlowTarget: 0.7,
      },
    );

    // The demo workload is excluded from the product score: 900 fully
    // covered World milliseconds must not lift the overall gate.
    expect(summary.overall).toEqual({
      coveredDurationMs: 8_000,
      coverageRatio: 8_000 / 10_100,
      durationMs: 10_100,
      meetsTarget: false,
      target: 0.8,
      traceCount: 2,
    });
    expect(summary.flows).toEqual([
      {
        coveredDurationMs: 8_000,
        coverageRatio: 8_000 / 10_100,
        demo: false,
        durationMs: 10_100,
        kind: "conversation.turn",
        meetsTarget: true,
        target: 0.7,
        traceCount: 2,
      },
      {
        coveredDurationMs: 900,
        coverageRatio: 0.9,
        demo: true,
        durationMs: 1_000,
        kind: "world.chunk.generate",
        meetsTarget: true,
        target: null,
        traceCount: 1,
      },
    ]);
    expect(summary.meetsGoal).toBe(false);
  });

  test("detects demo via the stored flag and keeps the kind fallback", () => {
    const summary = summarizeExecutionTraceCoverage(
      [
        // Stored flag set, kind NOT in demoKinds: the flag must win.
        traceSummary({
          coveredDurationMs: 1_000,
          durationMs: 1_000,
          id: "flagged_demo",
          kind: "world.chunk.generate.v2",
          reportedAsDemo: true,
        }),
        // Pre-backfill row: flag false but kind is a known demo kind.
        traceSummary({
          coveredDurationMs: 900,
          durationMs: 1_000,
          id: "legacy_world",
          kind: "world.chunk.generate",
          reportedAsDemo: false,
        }),
        traceSummary({
          coveredDurationMs: 750,
          durationMs: 1_000,
          id: "product",
          kind: "conversation.turn",
        }),
      ],
      {
        demoKinds: ["world.chunk.generate"],
        overallTarget: 0.7,
        perFlowTarget: 0.7,
      },
    );

    // Only the product trace counts toward the overall score.
    expect(summary.overall.durationMs).toBe(1_000);
    expect(summary.overall.coveredDurationMs).toBe(750);
    const byKind = new Map(summary.flows.map((flow) => [flow.kind, flow]));
    expect(byKind.get("world.chunk.generate.v2")?.demo).toBe(true);
    expect(byKind.get("world.chunk.generate.v2")?.target).toBeNull();
    expect(byKind.get("world.chunk.generate")?.demo).toBe(true);
    expect(byKind.get("conversation.turn")?.demo).toBe(false);
  });

  test("one flagged trace does not exempt a product flow from its floor", () => {
    const summary = summarizeExecutionTraceCoverage(
      [
        traceSummary({
          coveredDurationMs: 0,
          durationMs: 1_000,
          id: "uncovered_product",
          kind: "conversation.turn",
        }),
        traceSummary({
          coveredDurationMs: 1_000,
          durationMs: 1_000,
          id: "mislabeled",
          kind: "conversation.turn",
          reportedAsDemo: true,
        }),
      ],
      { overallTarget: 0.8, perFlowTarget: 0.7 },
    );

    const flow = summary.flows.find((entry) => entry.kind === "conversation.turn");
    expect(flow?.demo).toBe(false);
    expect(flow?.meetsTarget).toBe(false);
  });
});

describe("buildExecutionTraceCoverageSnapshot", () => {
  test("captures per-flow numerators, denominators, and p50/p95", () => {
    const durations = [100, 200, 300, 400, 1_000];
    const snapshot = buildExecutionTraceCoverageSnapshot({
      computedAt: "2026-07-10T12:00:00.000Z",
      idFactory: () => "coverage_snapshot_1",
      ownerId: "user_a",
      traces: [
        ...durations.map((durationMs, index) =>
          traceSummary({
            coveredDurationMs: durationMs / 2,
            durationMs,
            id: `turn_${index}`,
            kind: "conversation.turn",
          }),
        ),
        traceSummary({
          coveredDurationMs: 500,
          durationMs: 500,
          id: "world",
          kind: "world.chunk.generate",
          reportedAsDemo: true,
        }),
      ],
      windowEndedAt: "2026-07-10T12:00:00.000Z",
      windowStartedAt: "2026-07-01T00:00:00.000Z",
    });

    // Demo excluded from the overall numerator/denominator.
    expect(snapshot.overallDurationMs).toBe(2_000);
    expect(snapshot.overallCoveredDurationMs).toBe(1_000);
    expect(snapshot.overallTraceCount).toBe(5);
    const turnFlow = snapshot.flows.find(
      (flow) => flow.kind === "conversation.turn",
    );
    expect(turnFlow).toEqual({
      kind: "conversation.turn",
      demo: false,
      coveredDurationMs: 1_000,
      durationMs: 2_000,
      traceCount: 5,
      p50DurationMs: 300,
      p95DurationMs: 1_000,
    });
    const worldFlow = snapshot.flows.find(
      (flow) => flow.kind === "world.chunk.generate",
    );
    expect(worldFlow?.demo).toBe(true);
    // The durable rollup carries aggregates only — never trace attributes,
    // so retaining snapshots cannot extend the redaction guarantee.
    expect(JSON.stringify(snapshot)).not.toContain("attributes");
  });
});

describe("serializeExecutionTraceSnapshot", () => {
  test("exports JSONL in causal sequence order", async () => {
    const clock = createManualClock("2026-07-10T10:00:00.000Z");
    const recorder = createExecutionTraceRecorder({
      clock,
      idFactory: sequentialIds(),
      store: createInMemoryExecutionTraceStore(),
    });
    const execution = await recorder.startExecution({
      clockDomain: "browser",
      kind: "ui.generate",
      ownerId: "user_123",
      source: "tidegate.client",
    });
    const span = execution.startSpan({
      category: "artifact_compile",
      name: "ui.compile",
    });
    clock.advance(5);
    execution.mark("ui.first_valid_patch");
    clock.advance(5);
    await span.finish("ok");
    const snapshot = await execution.finish("complete");

    const lines = serializeExecutionTraceSnapshot(snapshot, "jsonl")
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string; data: unknown });

    expect(lines.map((line) => line.type)).toEqual(["trace", "span", "event"]);
    expect(lines[0]?.data).toEqual(snapshot.trace);
    expect(JSON.parse(serializeExecutionTraceSnapshot(snapshot, "json"))).toEqual(
      snapshot,
    );
  });
});

describe("InMemoryExecutionTraceStore", () => {
  test("lists only the requested owner's traces newest first", async () => {
    const store = createInMemoryExecutionTraceStore();
    const older = traceSummary({
      coveredDurationMs: 80,
      durationMs: 100,
      id: "trace_older",
      kind: "ui.generate",
      ownerId: "user_a",
      startedAt: "2026-07-10T10:00:00.000Z",
    });
    const newer = traceSummary({
      coveredDurationMs: 90,
      durationMs: 100,
      id: "trace_newer",
      kind: "interaction.invoke",
      ownerId: "user_a",
      startedAt: "2026-07-10T11:00:00.000Z",
    });
    const foreign = traceSummary({
      coveredDurationMs: 100,
      durationMs: 100,
      id: "trace_foreign",
      kind: "ui.generate",
      ownerId: "user_b",
      startedAt: "2026-07-10T12:00:00.000Z",
    });
    for (const trace of [older, newer, foreign]) {
      await store.putTrace({ trace, spans: [], events: [] });
    }

    expect((await store.listTraces({ ownerId: "user_a" })).map(({ id }) => id))
      .toEqual(["trace_newer", "trace_older"]);
    expect(
      await store.getTrace({ ownerId: "user_b", traceId: "trace_newer" }),
    ).toBeUndefined();
  });

  test("filters by kind, status, cursor, and limit", async () => {
    const store = createInMemoryExecutionTraceStore();
    await store.putTrace({
      trace: traceSummary({
        coveredDurationMs: 80,
        durationMs: 100,
        id: "trace_before",
        kind: "ui.generate",
        ownerId: "user_a",
        startedAt: "2026-07-10T10:00:00.000Z",
      }),
      spans: [],
      events: [],
    });
    await store.putTrace({
      trace: traceSummary({
        coveredDurationMs: 80,
        durationMs: 100,
        id: "trace_after",
        kind: "ui.generate",
        ownerId: "user_a",
        startedAt: "2026-07-10T12:00:00.000Z",
      }),
      spans: [],
      events: [],
    });

    expect(
      (
        await store.listTraces({
          before: "2026-07-10T11:00:00.000Z",
          kind: "ui.generate",
          limit: 1,
          ownerId: "user_a",
          status: "complete",
        })
      ).map(({ id }) => id),
    ).toEqual(["trace_before"]);
  });

  test("pages same-timestamp traces exactly once with the id tiebreaker", async () => {
    const store = createInMemoryExecutionTraceStore();
    const sharedStartedAt = "2026-07-10T10:00:00.000Z";
    const ids = ["trace_a", "trace_b", "trace_c", "trace_d", "trace_e"];
    for (const id of ids) {
      await store.putTrace({
        trace: traceSummary({
          coveredDurationMs: 80,
          durationMs: 100,
          id,
          kind: "ui.generate",
          ownerId: "user_a",
          startedAt: sharedStartedAt,
        }),
        spans: [],
        events: [],
      });
    }

    const seen: string[] = [];
    let before: string | undefined;
    let beforeId: string | undefined;
    for (;;) {
      const page = await store.listTraces({
        before,
        beforeId,
        limit: 2,
        ownerId: "user_a",
      });
      if (page.length === 0) {
        break;
      }
      seen.push(...page.map(({ id }) => id));
      before = page.at(-1)?.startedAt;
      beforeId = page.at(-1)?.id;
    }

    // A plain startedAt cursor would loop or skip: every trace shares the
    // same timestamp. The tiebreaker must visit each exactly once.
    expect(seen.toSorted()).toEqual(ids);
    expect(new Set(seen).size).toBe(ids.length);
  });

  test("deletes expired traces per tier and erases only within owner scope", async () => {
    const store = createInMemoryExecutionTraceStore();
    const put = (
      id: string,
      status: ExecutionTraceStatus,
      startedAt: string,
      ownerId = "user_a",
    ) =>
      store.putTrace({
        trace: traceSummary({
          coveredDurationMs: 50,
          durationMs: 100,
          id,
          kind: "conversation.turn",
          ownerId,
          startedAt,
          status,
        }),
        spans: [],
        events: [],
      });
    await put("healthy_old", "complete", "2026-04-01T00:00:00.000Z");
    await put("healthy_young", "complete", "2026-06-01T00:00:00.000Z");
    await put("failed_mid", "failed", "2026-06-01T00:00:00.000Z");
    await put("failed_ancient", "failed", "2026-03-01T00:00:00.000Z");
    await put("foreign", "complete", "2026-06-01T00:00:00.000Z", "user_b");

    const { deletedCount } = await store.deleteExpired({
      errorCutoff: "2026-04-11T00:00:00.000Z",
      healthyCutoff: "2026-05-11T00:00:00.000Z",
    });

    expect(deletedCount).toBe(2);
    const remaining = (await store.listTraces({ ownerId: "user_a" })).map(
      ({ id }) => id,
    );
    expect(remaining.toSorted()).toEqual(["failed_mid", "healthy_young"]);

    // Owner-scoped erasure: a foreign owner cannot delete the trace...
    expect(
      await store.deleteTrace({ ownerId: "user_b", traceId: "healthy_young" }),
    ).toBe(false);
    // ...and deleteByOwner never crosses the owner boundary.
    expect(await store.deleteByOwner("user_a")).toEqual({ deletedCount: 2 });
    expect(await store.listTraces({ ownerId: "user_b" })).toHaveLength(1);
  });

  test("full-owner erasure removes coverage snapshots; single-trace erasure keeps them", async () => {
    const store = createInMemoryExecutionTraceStore();
    await store.putTrace({
      trace: traceSummary({
        coveredDurationMs: 50,
        durationMs: 100,
        id: "trace_a",
        kind: "conversation.turn",
        ownerId: "user_a",
      }),
      spans: [],
      events: [],
    });
    await store.putCoverageSnapshot(coverageSnapshotFixture("user_a", "cov_a"));
    await store.putCoverageSnapshot(coverageSnapshotFixture("user_b", "cov_b"));

    // Single-trace erasure keeps the aggregate rollup: it carries no trace
    // content, and one deletion must not destroy the owner's trend line.
    await store.deleteTrace({ ownerId: "user_a", traceId: "trace_a" });
    expect(await store.listCoverageSnapshots({ ownerId: "user_a" })).toHaveLength(
      1,
    );

    // Full right-to-erasure removes the owner-keyed rollups too, and only
    // within the owner boundary.
    await store.deleteByOwner("user_a");
    expect(await store.listCoverageSnapshots({ ownerId: "user_a" })).toHaveLength(
      0,
    );
    expect(await store.listCoverageSnapshots({ ownerId: "user_b" })).toHaveLength(
      1,
    );
  });

  test("recomputing a coverage snapshot for the same window updates in place", async () => {
    const store = createInMemoryExecutionTraceStore();
    const first = coverageSnapshotFixture("user_a", "cov_first");
    await store.putCoverageSnapshot(first);
    // A retried sweep recomputes the same logical window under a fresh id:
    // the trend point is replaced (fresher aggregate wins), never duplicated,
    // and the original row id stays stable.
    await store.putCoverageSnapshot({
      ...coverageSnapshotFixture("user_a", "cov_retry"),
      computedAt: "2026-07-10T05:00:00.000Z",
      overallTraceCount: 13,
    });

    const rows = await store.listCoverageSnapshots({ ownerId: "user_a" });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe("cov_first");
    expect(rows[0]?.overallTraceCount).toBe(13);
    expect(rows[0]?.computedAt).toBe("2026-07-10T05:00:00.000Z");

    // A different window is a new trend point, not an overwrite.
    await store.putCoverageSnapshot({
      ...coverageSnapshotFixture("user_a", "cov_next"),
      windowEndedAt: "2026-07-11T04:00:00.000Z",
    });
    expect(await store.listCoverageSnapshots({ ownerId: "user_a" })).toHaveLength(
      2,
    );
  });
});

function coverageSnapshotFixture(
  ownerId: string,
  id: string,
): ExecutionTraceCoverageSnapshot {
  return {
    id,
    ownerId,
    windowStartedAt: "2026-06-01T00:00:00.000Z",
    windowEndedAt: "2026-07-10T04:00:00.000Z",
    overallCoveredDurationMs: 8_000,
    overallDurationMs: 10_000,
    overallTraceCount: 12,
    flows: [],
    computedAt: "2026-07-10T04:00:00.000Z",
  };
}

function sequentialIds(): () => string {
  let next = 1;
  return () => `trace_test_${next++}`;
}

function traceSummary({
  coveredDurationMs,
  durationMs,
  id,
  kind,
  ownerId = "user_123",
  reportedAsDemo = false,
  startedAt = "2026-07-10T10:00:00.000Z",
  status = "complete",
}: {
  coveredDurationMs: number;
  durationMs: number;
  id: string;
  kind: string;
  ownerId?: string;
  reportedAsDemo?: boolean;
  startedAt?: string;
  status?: ExecutionTraceStatus;
}): ExecutionTraceSummary {
  return {
    attributes: {},
    clockDomain: "server",
    coverageRatio: coveredDurationMs / durationMs,
    coveredDurationMs,
    durationMs,
    endedAt: "2026-07-10T10:00:10.000Z",
    id,
    kind,
    ownerId,
    reportedAsDemo,
    source: "test",
    startedAt,
    status,
    unknownDurationMs: durationMs - coveredDurationMs,
  };
}

function createManualClock(initialWallTime: string): ExecutionTraceClock & {
  advance(milliseconds: number): void;
  set(milliseconds: number): void;
} {
  const epoch = Date.parse(initialWallTime);
  let monotonicMs = 0;

  return {
    advance(milliseconds) {
      monotonicMs += milliseconds;
    },
    set(milliseconds) {
      monotonicMs = milliseconds;
    },
    now() {
      return {
        monotonicMs,
        wallTime: new Date(epoch + monotonicMs).toISOString(),
      };
    },
  };
}
