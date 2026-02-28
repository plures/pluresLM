import { describe, expect, it, vi, afterEach } from "vitest";
import { MemorySync } from "../../src/sync.js";
import { makeTestDB } from "../helpers/db.js";

describe("MemorySync bootstrap timeout", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("start() resolves after timeout when DHT bootstrap hangs", async () => {
    vi.useFakeTimers();

    const { db } = makeTestDB();
    const key = MemorySync.generateKey();

    // Mock Hyperswarm so flushed() never resolves (simulates slow DHT bootstrap).
    const { default: Hyperswarm } = await import("hyperswarm");
    vi.spyOn(Hyperswarm.prototype, "join").mockReturnValue({
      // Intentionally never-resolving promise to simulate DHT bootstrap hang.
      flushed: () => new Promise<void>(() => { /* never resolves */ }),
      destroy: () => Promise.resolve(),
    } as any);
    // Stub swarm.destroy() so stop() doesn't fail.
    vi.spyOn(Hyperswarm.prototype, "destroy").mockResolvedValue(undefined as any);

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
    vi.useFakeTimers();

    const { db } = makeTestDB();
    const key = MemorySync.generateKey();

    const { default: Hyperswarm } = await import("hyperswarm");
    vi.spyOn(Hyperswarm.prototype, "join").mockReturnValue({
      flushed: () => Promise.resolve(),
      destroy: () => Promise.resolve(),
    } as any);
    vi.spyOn(Hyperswarm.prototype, "destroy").mockResolvedValue(undefined as any);

    const errors: unknown[] = [];
    const sync = new MemorySync(db, { key });
    sync.on("sync:error", (err: unknown) => errors.push(err));

    await sync.start();

    expect(errors).toHaveLength(0);
  });

  it("start() accepts custom bootstrap nodes without error", async () => {
    vi.useFakeTimers();

    const { db } = makeTestDB();
    const key = MemorySync.generateKey();
    const bootstrapNodes = [{ host: "localhost", port: 49737 }];

    const { default: Hyperswarm } = await import("hyperswarm");

    vi.spyOn(Hyperswarm.prototype, "join").mockReturnValue({
      flushed: () => Promise.resolve(),
      destroy: () => Promise.resolve(),
    } as any);
    vi.spyOn(Hyperswarm.prototype, "destroy").mockResolvedValue(undefined as any);

    const errors: unknown[] = [];
    const sync = new MemorySync(db, { key, bootstrap: bootstrapNodes });
    sync.on("sync:error", (err: unknown) => errors.push(err));

    await sync.start();

    // No errors: local bootstrap nodes are accepted and passed to the DHT constructor.
    expect(errors).toHaveLength(0);
    expect(sync.peerCount).toBe(0); // no real peers in test
  });

  it("start() passes no bootstrap option when syncBootstrap is empty", async () => {
    vi.useFakeTimers();

    const { db } = makeTestDB();
    const key = MemorySync.generateKey();

    const { default: Hyperswarm } = await import("hyperswarm");
    vi.spyOn(Hyperswarm.prototype, "join").mockReturnValue({
      flushed: () => Promise.resolve(),
      destroy: () => Promise.resolve(),
    } as any);
    vi.spyOn(Hyperswarm.prototype, "destroy").mockResolvedValue(undefined as any);

    const errors: unknown[] = [];
    // No bootstrap provided — should use public DHT (default behaviour).
    const sync = new MemorySync(db, { key });
    sync.on("sync:error", (err: unknown) => errors.push(err));

    await sync.start();

    expect(errors).toHaveLength(0);
  });
});
