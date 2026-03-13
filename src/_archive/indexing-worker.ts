/**
 * Forked indexing worker
 *
 * Responsibilities:
 * - Traverse provided paths (files or directories)
 * - Perform disk IO (stat/readdir/readFile) with throttling
 * - Retry transient fs errors with exponential backoff
 * - Batch results to minimize IPC overhead
 *
 * The parent process performs embeddings + DB writes.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import pThrottle from "p-throttle";

type StartMessage = {
  type: "start";
  paths: string[]; // absolute
  batchSize: number;
  readOpsPerSecond: number;
  maxFileBytes: number;
  retries: number;
};

type FilePayload = {
  path: string;
  content: string;
};

const DEFAULT_EXTS = new Set([".ts", ".tsx", ".md", ".rs", ".py", ".js", ".jsx"]);

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const log = (msg: string) => {
  // Keep logs concise; parent prefixes them.
  process.stderr.write(`${msg}\n`);
};

const isTransientFsError = (err: any): boolean => {
  const code = err?.code;
  return code === "EBUSY" || code === "EMFILE" || code === "ENFILE" || code === "EAGAIN" || code === "ENOENT" || code === "EPERM";
};

async function withRetry<T>(op: () => Promise<T>, label: string, retries: number): Promise<T> {
  let attempt = 0;
  let delayMs = 40;
  // retries means "extra tries" beyond the first
  const maxAttempts = Math.max(0, retries) + 1;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      return await op();
    } catch (err: any) {
      attempt++;
      const code = err?.code ? ` (${err.code})` : "";
      if (attempt >= maxAttempts || !isTransientFsError(err)) {
        log(`worker: fs op failed${code} after ${attempt} attempt(s) [${label}]: ${String(err)}`);
        throw err;
      }
      const jitter = Math.floor(Math.random() * 25);
      await sleep(Math.min(1500, delayMs + jitter));
      delayMs *= 2;
    }
  }
}

async function walkDir(root: string, maxDepth: number, retries: number, readdirThrottled: (p: string) => Promise<fs.Dirent[]>, statThrottled: (p: string) => Promise<fs.Stats>): Promise<string[]> {
  const out: string[] = [];
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];

  while (queue.length) {
    const { dir, depth } = queue.shift()!;
    if (depth > maxDepth) continue;

    let entries: fs.Dirent[];
    try {
      entries = await withRetry(() => readdirThrottled(dir), `readdir:${dir}`, retries);
    } catch {
      continue;
    }

    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        queue.push({ dir: full, depth: depth + 1 });
        continue;
      }
      if (!e.isFile()) continue;

      const ext = path.extname(full).toLowerCase();
      if (!DEFAULT_EXTS.has(ext)) continue;

      try {
        const st = await withRetry(() => statThrottled(full), `stat:${full}`, retries);
        if (st.isFile()) out.push(full);
      } catch {
        // ignore
      }
    }
  }

  return out;
}

async function runIndexing(msg: StartMessage) {
  const batchSize = Math.max(1, msg.batchSize || 5);
  const readOpsPerSecond = Math.max(1, msg.readOpsPerSecond || 10);
  const maxFileBytes = Math.max(1_000, msg.maxFileBytes || 1_000_000);
  const retries = Math.max(0, msg.retries ?? 3);

  // Throttle disk IO ops.
  // p-throttle rate is "calls per interval".
  const throttle = pThrottle({ limit: readOpsPerSecond, interval: 1000 });

  const readdirThrottled = throttle(async (dir: string) => {
    return fs.promises.readdir(dir, { withFileTypes: true });
  });

  const statThrottled = throttle(async (p: string) => {
    return fs.promises.stat(p);
  });

  const readFileThrottled = throttle(async (p: string) => {
    return fs.promises.readFile(p, "utf-8");
  });

  const startedAt = Date.now();
  let filesSeen = 0;
  let filesSent = 0;
  let skippedLarge = 0;

  const batch: FilePayload[] = [];
  const flush = async () => {
    if (batch.length === 0) return;
    const payload = batch.splice(0, batch.length);
    (process as any).send?.({ type: "batch", files: payload, progress: `${filesSent}/${filesSeen} files sent` });
    filesSent += payload.length;
    // Let IPC drain a bit.
    await sleep(1);
  };

  const emitError = (error: unknown) => {
    (process as any).send?.({ type: "error", error: String(error) });
  };

  try {
    for (const p of msg.paths) {
      let st: fs.Stats;
      try {
        st = await withRetry(() => statThrottled(p), `stat:${p}`, retries);
      } catch {
        continue;
      }

      let files: string[] = [];
      if (st.isDirectory()) {
        files = await walkDir(p, 15, retries, readdirThrottled, statThrottled);
      } else if (st.isFile()) {
        files = [p];
      }

      for (const filePath of files) {
        filesSeen++;
        try {
          const fst = await withRetry(() => statThrottled(filePath), `stat:${filePath}`, retries);
          if (!fst.isFile()) continue;
          if (fst.size > maxFileBytes) {
            skippedLarge++;
            continue;
          }

          const content = await withRetry(() => readFileThrottled(filePath), `read:${filePath}`, retries);
          batch.push({ path: filePath, content });

          if (batch.length >= batchSize) {
            await flush();
          }
        } catch (err) {
          emitError(err);
        }
      }
    }

    await flush();

    const elapsedMs = Date.now() - startedAt;
    (process as any).send?.({
      type: "done",
      stats: { filesSeen, filesSent, skippedLarge, elapsedMs },
    });
  } catch (err) {
    emitError(err);
    (process as any).send?.({ type: "done" });
  }
}

process.on("message", (m: unknown) => {
  const msg = m as Partial<StartMessage>;
  if (msg?.type !== "start") return;
  runIndexing(msg as StartMessage).catch((err) => {
    (process as any).send?.({ type: "error", error: String(err) });
    (process as any).send?.({ type: "done" });
  });
});
