import { describe, expect, it, vi, afterEach } from "vitest";
import { MemorySync } from "../../src/sync.js";
import { makeTestDB } from "../helpers/db.js";

// Captured Hyperswarm constructor calls (reset in afterEach).
// Named with `mock` prefix so vitest hoists the declaration alongside vi.mock().
const mockConstructorCalls: Array<unknown> = [];
let mockFlushedFn: () => Promise<void> = () => Promise.resolve();

vi.mock("hyperswarm", async () => {
  const { EventEmitter } = await import("node:events");
  class MockHyperswarm extends EventEmitter {
    keyPair = { publicKey: Buffer.alloc(32), secretKey: Buffer.alloc(64) };
    connections = new Set();
    constructor(opts?: unknown) {
      super();
      mockConstructorCalls.push(opts);
    }
    join() {
      return { flushed: () => mockFlushedFn(), destroy: () => Promise.resolve() };
    }
    destroy() {
      return Promise.resolve();
    }
  }
  return { default: MockHyperswarm };
});

describe("MemorySync bootstrap timeout", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    mockConstructorCalls.length = 0;
    mockFlushedFn = () => Promise.resolve();
  });

  it("start() resolves after timeout when DHT bootstrap hangs", async () => {
    vi.useFakeTimers();
    mockFlushedFn = () => new Promise<void>(() => { /* never resolves */ });

    const { db } = makeTestDB();
    const key = MemorySync.generateKey();

    const errors: unknown[] = [];
    const sync = new MemorySync(db, { key });
    sync.on("sync:error", (err: unknown) => errors.push(err));

    const startPromise = sync.start();

    // Advance time past the 30-second bootstrap timeout (BOOTSTRAP_TIMEOUT_MS + margin).
    await vi.advanceTimersByTimeAsync(31_000);
    await startPromise;

    expect(errors).toHaveLength(1);
    expect(String(errors[0])).toContain("sync start timed out");
  });

  it("start() completes immediately when flushed() resolves quickly", async () => {
    const { db } = makeTestDB();
    const key = MemorySync.generateKey();

    const errors: unknown[] = [];
    const sync = new MemorySync(db, { key });
    sync.on("sync:error", (err: unknown) => errors.push(err));

    await sync.start();

    expect(errors).toHaveLength(0);
  });

  it("start() passes custom bootstrap nodes to Hyperswarm constructor", async () => {
    const { db } = makeTestDB();
    const key = MemorySync.generateKey();
    const bootstrapNodes = [{ host: "localhost", port: 49737 }];

    const sync = new MemorySync(db, { key, bootstrap: bootstrapNodes });
    await sync.start();

    expect(mockConstructorCalls).toHaveLength(1);
    expect(mockConstructorCalls[0]).toEqual({ bootstrap: bootstrapNodes });
  });

  it("start() passes no bootstrap to Hyperswarm when none configured", async () => {
    const { db } = makeTestDB();
    const key = MemorySync.generateKey();

    const sync = new MemorySync(db, { key });
    await sync.start();

    expect(mockConstructorCalls).toHaveLength(1);
    // No bootstrap entries → constructor receives {} (not { bootstrap: [...] }).
    expect((mockConstructorCalls[0] as any)?.bootstrap).toBeUndefined();
  });

  it("start() passes no bootstrap to Hyperswarm when empty array configured", async () => {
    const { db } = makeTestDB();
    const key = MemorySync.generateKey();

    const sync = new MemorySync(db, { key, bootstrap: [] });
    await sync.start();

    expect(mockConstructorCalls).toHaveLength(1);
    // Empty bootstrap array is normalized to omitted — same as public DHT.
    expect((mockConstructorCalls[0] as any)?.bootstrap).toBeUndefined();
  });
});
