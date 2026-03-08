import { spawn } from "node:child_process";
import * as path from "node:path";

interface JsonRpcResponse {
  id?: number;
  result?: unknown;
  error?: { code: number; message: string };
}

export async function callPluresLMServiceTool(name: string, args: Record<string, unknown> = {}, timeoutMs = 15000) {
  const servicePath = path.resolve(path.dirname(new URL(import.meta.url).pathname), "plureslm-service.js");

  return await new Promise<unknown>((resolve, reject) => {
    const child = spawn(process.execPath, [servicePath], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        PLURESLM_EXPLICIT_DB_PATH: process.env.PLURESLM_EXPLICIT_DB_PATH ?? "1",
      },
    });

    let buffer = "";
    let sawInit = false;
    let finished = false;
    let nextId = 1;

    const done = (err?: Error, value?: unknown) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try { child.kill(); } catch {}
      if (err) reject(err);
      else resolve(value);
    };

    const send = (method: string, params: Record<string, unknown> = {}, notify = false) => {
      const msg = notify
        ? { jsonrpc: "2.0", method, params }
        : { jsonrpc: "2.0", id: nextId++, method, params };
      child.stdin.write(`${JSON.stringify(msg)}\n`);
    };

    const timer = setTimeout(() => done(new Error(`service call timeout for ${name}`)), timeoutMs);

    child.on("error", (e) => done(e));
    child.stderr.on("data", () => {});

    child.stdout.on("data", (d) => {
      buffer += d.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith("{")) continue;
        let msg: JsonRpcResponse;
        try {
          msg = JSON.parse(t);
        } catch {
          continue;
        }

        if ((msg.result as any)?.serverInfo && !sawInit) {
          sawInit = true;
          send("tools/call", { name, arguments: args });
          continue;
        }

        if (msg.error) {
          done(new Error(`service error ${msg.error.code}: ${msg.error.message}`));
          return;
        }

        const content = (msg.result as any)?.content;
        if (Array.isArray(content) && content[0]?.type === "text") {
          done(undefined, String(content[0].text ?? ""));
          return;
        }
      }
    });

    send("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "plureslm-plugin-bridge", version: "0.1.0" },
    });
    send("notifications/initialized", {}, true);
  });
}
