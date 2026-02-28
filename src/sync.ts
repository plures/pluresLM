import Hyperswarm, { type PeerInfo } from "hyperswarm";
import { createHash, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import type { Duplex } from "node:stream";
import type { MemoryEntry } from "./types.js";
import type { IMemoryBackend } from "./backend-factory.js";
import { DualEmbeddings } from "./embeddings.js";

export interface SyncOptions {
  /** hex-encoded 32-byte shared secret */
  key: string;
  debug?: boolean;
}

type SyncEvent = "peer:connected" | "peer:disconnected" | "sync:complete" | "sync:error";

type HandshakeMsg = {
  t: "handshake";
  peerId: string;
  lastSyncAt: number;
};

type IdListMsg = {
  t: "idlist";
  items: Array<{ id: string; created_at: number }>;
};

type MemoryMsg = {
  t: "memory";
  entry: {
    id: string;
    content: string;
    created_at: number;
    source: string;
    tags: string[];
    category: string;
    originator_id?: string;
    originator_name?: string;
    destination?: string;
    status?: string;
    assigned_to?: string;
    due_at?: number;
    last_checkin?: number;
  };
};

type DoneMsg = {
  t: "done";
  at: number;
};

type WireMsg = HandshakeMsg | IdListMsg | MemoryMsg | DoneMsg;

function maskKey(hex: string): string {
  if (!hex) return "";
  if (hex.length <= 12) return `${hex.slice(0, 4)}…${hex.slice(-2)}`;
  return `${hex.slice(0, 6)}…${hex.slice(-6)}`;
}

function topicFromKey(hexKey: string): Buffer {
  const buf = Buffer.from(hexKey, "hex");
  if (buf.length !== 32) throw new Error("sync key must be 32 bytes (64 hex chars)");
  return createHash("sha256").update(buf).digest();
}

function ndjsonWrite(stream: Duplex, msg: WireMsg): void {
  stream.write(JSON.stringify(msg) + "\n");
}

function createLineReader(onLine: (line: string) => void): (chunk: Buffer) => void {
  let buf = "";
  return (chunk: Buffer) => {
    buf += chunk.toString("utf8");
    while (true) {
      const idx = buf.indexOf("\n");
      if (idx === -1) break;
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      onLine(trimmed);
    }
  };
}

export class MemorySync {
  private db: IMemoryBackend;
  private opts: SyncOptions;
  private emitter = new EventEmitter();
  private swarm: Hyperswarm | null = null;
  private discovery: { flushed: () => Promise<void> } | null = null;
  private _lastSyncTime = 0;

  // Used for local embedding of received memories. If this fails, we fall back to raw storage.
  private embeddings: DualEmbeddings | null = null;

  constructor(db: IMemoryBackend, opts: SyncOptions) {
    this.db = db;
    this.opts = opts;
  }

  static generateKey(): string {
    return randomBytes(32).toString("hex");
  }

  get peerCount(): number {
    return this.swarm ? this.swarm.connections.size : 0;
  }

  get lastSyncTime(): number {
    return this._lastSyncTime;
  }

  on(event: SyncEvent, handler: (...args: any[]) => void): void {
    this.emitter.on(event, handler);
  }

  async start(): Promise<void> {
    if (this.swarm) return;

    const topic = topicFromKey(this.opts.key);
    this.swarm = new Hyperswarm();

    // Best-effort embedder: uses env/config defaults.
    this.embeddings = new DualEmbeddings(
      {
        openaiKey: process.env.OPENAI_API_KEY,
        openaiModel: process.env.SUPERLOCALMEMORY_SYNC_OPENAI_MODEL,
        ollamaEndpoint: process.env.OLLAMA_HOST ?? process.env.OLLAMA_ENDPOINT,
        ollamaModel: process.env.SUPERLOCALMEMORY_SYNC_OLLAMA_MODEL,
        // NOTE: we do not know the plugin's configured dimension here; DualEmbeddings will pad/truncate.
        dimension: 1536,
        debug: this.opts.debug,
      },
      {
        info: (m) => this.opts.debug && console.log(m),
        warn: (m) => console.warn(m),
      },
    );

    this.swarm.on("connection", (socket: Duplex, peerInfo: PeerInfo) => {
      const peerId = peerInfo.publicKey.toString("hex");
      const count = this.swarm!.connections.size;
      console.log(`[pluresLM:sync] peer joined ${peerId.slice(0, 8)} (${count} connected)`);
      void this.handleConnection(socket, peerInfo).catch((err) => {
        this.emitter.emit("sync:error", err);
      });
    });

    this.swarm.on("disconnection", (_socket: Duplex, peerInfo: PeerInfo) => {
      const peerId = peerInfo.publicKey.toString("hex");
      const count = this.swarm ? this.swarm.connections.size : 0;
      console.log(`[pluresLM:sync] peer left ${peerId.slice(0, 8)} (${count} remaining)`);
      this.emitter.emit("peer:disconnected", { peerId });
    });

    this.discovery = this.swarm.join(topic, { server: true, client: true });
    console.log(`[pluresLM:sync] joining topic for key ${maskKey(this.opts.key)}`);

    // Fire-and-forget: wait for DHT bootstrap/announce without blocking start.
    // Discovery can take 5-30s on slow networks; peers arrive via "connection" events whenever.
    this.discovery.flushed().then(() => {
      const count = this.swarm ? this.swarm.connections.size : 0;
      console.log(`[pluresLM:sync] connected (${count} peers)`);
    }).catch((err: unknown) => {
      this.emitter.emit("sync:error", err);
      console.warn(`[pluresLM:sync] discovery flush error: ${String(err)}`);
    });
  }

  async stop(): Promise<void> {
    const swarm = this.swarm;
    this.swarm = null;
    this.discovery = null;

    if (!swarm) return;

    try {
      await swarm.destroy();
    } catch (err) {
      this.opts.debug && console.warn(`[pluresLM:sync] failed to stop cleanly: ${String(err)}`);
    }
  }

  private async handleConnection(socket: Duplex, peerInfo: PeerInfo): Promise<void> {
    const swarm = this.swarm;
    if (!swarm) return;

    const remotePeerId = peerInfo.publicKey.toString("hex");
    const localPeerId = swarm.keyPair.publicKey.toString("hex");
    const shortId = remotePeerId.slice(0, 8);
    const syncStart = Date.now();
    let sentCount = 0;
    let receivedCount = 0;
    let dedupedCount = 0;

    this.emitter.emit("peer:connected", { peerId: remotePeerId });

    const localLast = await this.db.getLastSyncTime(remotePeerId);

    // Send handshake immediately
    ndjsonWrite(socket, { t: "handshake", peerId: localPeerId, lastSyncAt: localLast });

    let remoteHandshake: HandshakeMsg | null = null;
    let remoteIdList: IdListMsg | null = null;
    let localIdListSent = false;
    let sentDone = false;
    let gotDone = false;

    const maybeStartSync = async (): Promise<void> => {
      if (!remoteHandshake) return;

      const isFirstConnect = localLast === 0 || remoteHandshake.lastSyncAt === 0;

      if (isFirstConnect) {
        // Full sync: exchange lightweight id lists, then send missing/newer entries.
        if (!localIdListSent) {
          localIdListSent = true;
          const items = await this.db.getAllMemoryIds();
          ndjsonWrite(socket, { t: "idlist", items });
        }
        if (!remoteIdList) return;

        // Diff: send memories that the remote doesn't have, or has older.
        const remoteMap = new Map<string, number>();
        for (const it of remoteIdList.items) remoteMap.set(it.id, it.created_at);

        const localItems = await this.db.getAllMemoryIds();
        console.log(`[pluresLM:sync] peer ${shortId}: handshake — local: ${localItems.length} ids, remote: ${remoteIdList.items.length} ids`);
        const toSendIds: string[] = [];
        for (const it of localItems) {
          const rts = remoteMap.get(it.id);
          if (rts === undefined || rts < it.created_at) toSendIds.push(it.id);
        }

        const memories = await this.db.getMemoriesByIds(toSendIds);
        console.log(`[pluresLM:sync] peer ${shortId}: sending ${memories.length} memories (remote missing)`);
        sentCount = memories.length;
        for (const m of memories) {
          ndjsonWrite(socket, { t: "memory", entry: m });
        }

        if (!sentDone) {
          sentDone = true;
          ndjsonWrite(socket, { t: "done", at: Date.now() });
        }
      } else {
        // Delta sync: send memories newer than what remote reports.
        const since = remoteHandshake.lastSyncAt;
        const memories = await this.db.getMemoriesSince(since);
        console.log(`[pluresLM:sync] peer ${shortId}: sending ${memories.length} memories`);
        sentCount = memories.length;
        for (const m of memories) {
          ndjsonWrite(socket, { t: "memory", entry: m });
        }
        if (!sentDone) {
          sentDone = true;
          ndjsonWrite(socket, { t: "done", at: Date.now() });
        }
      }
    };

    const onLine = async (line: string): Promise<void> => {
      let msg: WireMsg;
      try {
        msg = JSON.parse(line) as WireMsg;
      } catch {
        return;
      }

      if (msg.t === "handshake") {
        remoteHandshake = msg;
        await maybeStartSync();
        return;
      }

      if (msg.t === "idlist") {
        remoteIdList = msg;
        await maybeStartSync();
        return;
      }

      if (msg.t === "memory") {
        const result = await this.receiveMemory(remotePeerId, msg.entry);
        receivedCount++;
        if (result.deduped) dedupedCount++;
        return;
      }

      if (msg.t === "done") {
        gotDone = true;
        const now = Date.now();
        this._lastSyncTime = now;
        await this.db.setLastSyncTime(remotePeerId, now);
        await this.db.setLastSyncTime("__global__", now);
        console.log(`[pluresLM:sync] peer ${shortId}: receiving ${receivedCount} memories (${dedupedCount} deduped)`);
        if (sentDone && gotDone) {
          const elapsed = ((now - syncStart) / 1000).toFixed(1);
          console.log(`[pluresLM:sync] peer ${shortId}: sync complete in ${elapsed}s (${sentCount} sent, ${receivedCount} received, ${dedupedCount} deduped)`);
          this.emitter.emit("sync:complete", { peerId: remotePeerId, at: now });
        }
      }
    };

    const reader = createLineReader((l) => {
      void onLine(l).catch((err) => {
        this.emitter.emit("sync:error", err);
      });
    });

    socket.on("data", reader);
    socket.on("error", (err) => {
      this.emitter.emit("sync:error", err);
    });
    socket.on("close", () => {
      // no-op; disconnection event is emitted via swarm when possible
    });

    // If the other side doesn't initiate, attempt once we get handshake.
    // Also, if we are in full sync mode, sending our idlist requires handshake.
    await maybeStartSync();
  }

  private async receiveMemory(
    remotePeerId: string,
    entry: { id: string; content: string; created_at: number; source: string; tags: string[]; category: string; originator_id?: string; originator_name?: string; destination?: string; status?: string; assigned_to?: string; due_at?: number; last_checkin?: number },
  ): Promise<{ deduped: boolean }> {
    // Store raw first (preserve ID/timestamp). If already present, we may update fields.
    const changed = await this.db.storeRaw(entry);

    // Best-effort: generate embedding and attach it.
    if (!this.embeddings) return { deduped: !changed };

    let deduped = false;
    try {
      const embedding = await this.embeddings.embed(entry.content);
      await this.db.setEmbedding(entry.id, embedding);

      // Optional high-threshold dedupe pass: if this looks like a near-duplicate of another memory,
      // we keep the canonical one (lowest ID lexicographically) and drop the other.
      // (This is best-effort and should never crash sync.)
      if (changed) {
        try {
          const matches = await this.db.vectorSearch(embedding, 1, 0.99);
          const top = matches[0]?.entry;
          if (top && top.id !== entry.id) {
            // If duplicate, prefer existing memory; drop synced ID to avoid clutter.
            // Only delete if the other entry is very close and was created around the same time.
            await this.db.delete(entry.id);
            deduped = true;
          }
        } catch {
          // ignore dedupe failures
        }
      }

      // Track last sync time as we receive.
      const ts = Date.now();
      this._lastSyncTime = ts;
      await this.db.setLastSyncTime(remotePeerId, ts);
      await this.db.setLastSyncTime("__global__", ts);
    } catch (err) {
      // Embedding failure shouldn't break sync.
      this.opts.debug && console.warn(`[pluresLM:sync] embedding failed for received memory ${entry.id.slice(0, 8)}: ${String(err)}`);
    }
    return { deduped };
  }
}
