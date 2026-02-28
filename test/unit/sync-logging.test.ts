import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import { Duplex } from "node:stream";
import { MemorySync } from "../../src/sync.js";
import { makeTestDB } from "../helpers/db.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Creates a fake Duplex socket: writes from MemorySync are silently consumed;
 *  `push(line)` injects NDJSON lines as if sent by a remote peer. */
function createFakeSocket(): { socket: Duplex; push: (line: string) => void } {
  const socket = new Duplex({
    read() {},
    write(_chunk: Buffer, _enc: BufferEncoding, cb: () => void) {
      cb();
    },
  });
  return {
    socket,
    push: (line: string) => socket.push(Buffer.from(line + "\n")),
  };
}

/** Build a fake PeerInfo-shaped object sufficient for handleConnection. */
function fakePeerInfo(hexKey: string): { publicKey: Buffer } {
  return { publicKey: Buffer.from(hexKey, "hex") };
}

/** Resolve after all pending microtasks + one setImmediate cycle. */
function flushAsync(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MemorySync data exchange logging", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs handshake id counts, sending, receiving and sync complete for full sync", async () => {
    const { db } = makeTestDB();
    const key = MemorySync.generateKey();

    const { default: Hyperswarm } = await import("hyperswarm");
    vi.spyOn(Hyperswarm.prototype, "join").mockReturnValue({
      flushed: () => Promise.resolve(),
      destroy: () => Promise.resolve(),
    } as any);
    vi.spyOn(Hyperswarm.prototype, "destroy").mockResolvedValue(undefined as any);

    const sync = new MemorySync(db, { key });
    const errors: unknown[] = [];
    sync.on("sync:error", (e: unknown) => errors.push(e));

    let completeResolve!: () => void;
    const completePromise = new Promise<void>((r) => {
      completeResolve = r;
    });
    sync.on("sync:complete", () => completeResolve());

    await sync.start();

    // Retrieve the real (mocked-join) swarm instance.
    const swarm = (sync as any).swarm as any;
    // Guard: ensure connections is a Set (real Hyperswarm sets this up).
    if (!swarm.connections) swarm.connections = new Set();

    const remotePeerId = "a".repeat(64); // valid 32-byte hex key
    const { socket, push } = createFakeSocket();

    // Trigger the "connection" event handler that was registered in start().
    swarm.emit("connection", socket, fakePeerInfo(remotePeerId));
    await flushAsync();

    // Simulate remote peer: full sync (lastSyncAt = 0) with empty id list.
    push(JSON.stringify({ t: "handshake", peerId: remotePeerId, lastSyncAt: 0 }));
    await flushAsync();

    push(JSON.stringify({ t: "idlist", items: [] }));
    await flushAsync();

    push(JSON.stringify({ t: "done", at: Date.now() }));

    await completePromise;

    const shortId = remotePeerId.slice(0, 8);
    const logged = logSpy.mock.calls.map((c) => String(c[0]));

    expect(logged.some((l) => l.includes(`peer ${shortId}: handshake — local:`))).toBe(true);
    expect(logged.some((l) => l.includes(`peer ${shortId}: sending`) && l.includes("remote missing"))).toBe(true);
    expect(logged.some((l) => l.includes(`peer ${shortId}: receiving`) && l.includes("deduped"))).toBe(true);
    expect(logged.some((l) => l.includes(`peer ${shortId}: sync complete in`) && l.includes("sent") && l.includes("received"))).toBe(true);

    expect(errors).toHaveLength(0);
  });

  it("logs correct id counts when local has memories the remote lacks", async () => {
    const { db } = makeTestDB();
    const key = MemorySync.generateKey();

    // Pre-load two memories into the local DB.
    await db.storeRaw({ id: "mem-001", content: "hello", created_at: 1000, source: "test", tags: [], category: "general" });
    await db.storeRaw({ id: "mem-002", content: "world", created_at: 2000, source: "test", tags: [], category: "general" });

    const { default: Hyperswarm } = await import("hyperswarm");
    vi.spyOn(Hyperswarm.prototype, "join").mockReturnValue({
      flushed: () => Promise.resolve(),
      destroy: () => Promise.resolve(),
    } as any);
    vi.spyOn(Hyperswarm.prototype, "destroy").mockResolvedValue(undefined as any);

    const sync = new MemorySync(db, { key });
    const errors: unknown[] = [];
    sync.on("sync:error", (e: unknown) => errors.push(e));

    let completeResolve!: () => void;
    const completePromise = new Promise<void>((r) => {
      completeResolve = r;
    });
    sync.on("sync:complete", () => completeResolve());

    await sync.start();

    const swarm = (sync as any).swarm as any;
    if (!swarm.connections) swarm.connections = new Set();

    const remotePeerId = "b".repeat(64);
    const { socket, push } = createFakeSocket();

    swarm.emit("connection", socket, fakePeerInfo(remotePeerId));
    await flushAsync();

    // Remote has 1 id, local has 2 → local needs to send 1 memory (mem-002 missing).
    push(JSON.stringify({ t: "handshake", peerId: remotePeerId, lastSyncAt: 0 }));
    await flushAsync();

    push(JSON.stringify({ t: "idlist", items: [{ id: "mem-001", created_at: 1000 }] }));
    await flushAsync();

    push(JSON.stringify({ t: "done", at: Date.now() }));

    await completePromise;

    const shortId = remotePeerId.slice(0, 8);
    const logged = logSpy.mock.calls.map((c) => String(c[0]));

    // Should report local: 2 ids, remote: 1 id.
    const handshakeLine = logged.find((l) => l.includes(`peer ${shortId}: handshake`));
    expect(handshakeLine).toBeDefined();
    expect(handshakeLine).toContain("local: 2 ids");
    expect(handshakeLine).toContain("remote: 1 id");

    // Should report sending 1 memory (mem-002 is missing from remote).
    const sendLine = logged.find((l) => l.includes(`peer ${shortId}: sending`));
    expect(sendLine).toBeDefined();
    expect(sendLine).toContain("1 memories (remote missing)");

    expect(errors).toHaveLength(0);
  });

  it("logs 0 received and 0 deduped when remote sends no memories", async () => {
    const { db } = makeTestDB();
    const key = MemorySync.generateKey();

    const { default: Hyperswarm } = await import("hyperswarm");
    vi.spyOn(Hyperswarm.prototype, "join").mockReturnValue({
      flushed: () => Promise.resolve(),
      destroy: () => Promise.resolve(),
    } as any);
    vi.spyOn(Hyperswarm.prototype, "destroy").mockResolvedValue(undefined as any);

    const sync = new MemorySync(db, { key });

    let completeResolve!: () => void;
    const completePromise = new Promise<void>((r) => {
      completeResolve = r;
    });
    sync.on("sync:complete", () => completeResolve());

    await sync.start();

    const swarm = (sync as any).swarm as any;
    if (!swarm.connections) swarm.connections = new Set();

    const remotePeerId = "c".repeat(64);
    const { socket, push } = createFakeSocket();

    swarm.emit("connection", socket, fakePeerInfo(remotePeerId));
    await flushAsync();

    push(JSON.stringify({ t: "handshake", peerId: remotePeerId, lastSyncAt: 0 }));
    await flushAsync();
    push(JSON.stringify({ t: "idlist", items: [] }));
    await flushAsync();
    push(JSON.stringify({ t: "done", at: Date.now() }));

    await completePromise;

    const shortId = remotePeerId.slice(0, 8);
    const logged = logSpy.mock.calls.map((c) => String(c[0]));

    const receivingLine = logged.find((l) => l.includes(`peer ${shortId}: receiving`));
    expect(receivingLine).toBeDefined();
    expect(receivingLine).toContain("0 memories (0 deduped)");

    const completeLine = logged.find((l) => l.includes(`peer ${shortId}: sync complete`));
    expect(completeLine).toBeDefined();
    expect(completeLine).toContain("0 received");
    expect(completeLine).toContain("0 deduped");
  });
});
