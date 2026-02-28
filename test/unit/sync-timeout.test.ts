import { describe, expect, it, vi, afterEach } from "vitest";
import { MemorySync } from "../../src/sync.js";
import { makeTestDB } from "../helpers/db.js";

describe("MemorySync fire-and-forget startup", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("start() returns immediately even when DHT bootstrap hangs", async () => {
    const { db } = makeTestDB();
    const key = MemorySync.generateKey();

    // Mock Hyperswarm so flushed() never resolves (simulates slow DHT bootstrap).
    const { default: Hyperswarm } = await import("hyperswarm");
    vi.spyOn(Hyperswarm.prototype, "join").mockReturnValue({
      // Intentionally never-resolving promise to simulate DHT bootstrap hang.
      flushed: () => new Promise<void>(() => { /* never resolves */ }),
      destroy: () => Promise.resolve(),
    } as any);
    vi.spyOn(Hyperswarm.prototype, "destroy").mockResolvedValue(undefined as any);

    const errors: unknown[] = [];
    const sync = new MemorySync(db, { key });
    sync.on("sync:error", (err: unknown) => errors.push(err));

    // start() must resolve immediately — never blocks on flushed().
    await sync.start();

    // No timeout error should be emitted; swarm remains alive for future connections.
    expect(errors).toHaveLength(0);
  });

  it("start() returns immediately when flushed() resolves quickly", async () => {
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

  it("exposes peerCount getter correctly when no peers connected", async () => {
    const { db } = makeTestDB();
    const key = MemorySync.generateKey();

    const { default: Hyperswarm } = await import("hyperswarm");
    vi.spyOn(Hyperswarm.prototype, "join").mockReturnValue({
      flushed: () => Promise.resolve(),
      destroy: () => Promise.resolve(),
    } as any);
    vi.spyOn(Hyperswarm.prototype, "destroy").mockResolvedValue(undefined as any);

    const sync = new MemorySync(db, { key });
    await sync.start();

    expect(sync.peerCount).toBe(0);
  });

  it("exposes lastSyncTime getter correctly before any sync occurs", async () => {
    const { db } = makeTestDB();
    const key = MemorySync.generateKey();

    const { default: Hyperswarm } = await import("hyperswarm");
    vi.spyOn(Hyperswarm.prototype, "join").mockReturnValue({
      flushed: () => Promise.resolve(),
      destroy: () => Promise.resolve(),
    } as any);
    vi.spyOn(Hyperswarm.prototype, "destroy").mockResolvedValue(undefined as any);

    const sync = new MemorySync(db, { key });
    await sync.start();

    expect(sync.lastSyncTime).toBe(0);
  });

  it("does not destroy swarm during start() — only stop() destroys it", async () => {
    const { db } = makeTestDB();
    const key = MemorySync.generateKey();

    const { default: Hyperswarm } = await import("hyperswarm");
    vi.spyOn(Hyperswarm.prototype, "join").mockReturnValue({
      flushed: () => new Promise<void>(() => { /* never resolves */ }),
      destroy: () => Promise.resolve(),
    } as any);
    const destroySpy = vi.spyOn(Hyperswarm.prototype, "destroy").mockResolvedValue(undefined as any);

    const sync = new MemorySync(db, { key });
    await sync.start();

    // destroy should NOT have been called during start() — even with slow bootstrap
    expect(destroySpy).not.toHaveBeenCalled();

    await sync.stop();

    // destroy should be called only during stop()
    expect(destroySpy).toHaveBeenCalledTimes(1);
  });
});
