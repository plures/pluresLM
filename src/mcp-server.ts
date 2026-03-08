#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { PluresDBBackend } from "./pluresdb-backend.js";

const server = new Server(
  { name: "plureslm-mcp", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

const dbPath = process.env.PLURESLM_DB_PATH ?? ".plureslm";
const vectorDimension = Number(process.env.PLURESLM_VECTOR_DIM ?? "384");
const backend = new PluresDBBackend(dbPath, vectorDimension);

function textResult(text: string) {
  return {
    content: [{ type: "text" as const, text }],
  };
}

function asObject(input: unknown): Record<string, unknown> {
  if (input && typeof input === "object" && !Array.isArray(input)) return input as Record<string, unknown>;
  return {};
}

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "plureslm_store",
      description: "Store a memory in PluresLM",
      inputSchema: {
        type: "object",
        properties: {
          content: { type: "string" },
          category: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
          source: { type: "string" },
        },
        required: ["content"],
      },
    },
    {
      name: "plureslm_list",
      description: "List recent memories from PluresLM",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "number" },
          category: { type: "string" },
        },
      },
    },
    {
      name: "plureslm_search_text",
      description: "Simple text search over memory content (substring match)",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          limit: { type: "number" },
        },
        required: ["query"],
      },
    },
    {
      name: "plureslm_query_dsl",
      description: "Run PluresDB DSL query through backend execDsl",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
        },
        required: ["query"],
      },
    },
    {
      name: "plureslm_world_state",
      description: "Generate high-priority world state summary",
      inputSchema: { type: "object", properties: {} },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const input = asObject(args);

  switch (name) {
    case "plureslm_store": {
      const content = String(input.content ?? "").trim();
      if (!content) return textResult("error: content is required");
      const category = input.category ? String(input.category) : "conversation";
      const source = input.source ? String(input.source) : "mcp";
      const tags = Array.isArray(input.tags) ? input.tags.map((t) => String(t)) : [];

      const result = await backend.storeContent(content, { category, source, tags });
      return textResult(JSON.stringify({ ok: true, id: result.entry.id, duplicate: result.isDuplicate }));
    }

    case "plureslm_list": {
      const limit = Number(input.limit ?? 10);
      const category = input.category ? String(input.category) : undefined;
      const memories = category
        ? await backend.getMemoriesByCategories([category], limit)
        : await backend.listMemories();
      const sliced = memories
        .sort((a, b) => b.created_at - a.created_at)
        .slice(0, Math.max(1, Math.min(limit, 100)))
        .map((m) => ({ id: m.id, category: m.category, created_at: m.created_at, content: m.content }));
      return textResult(JSON.stringify(sliced));
    }

    case "plureslm_search_text": {
      const query = String(input.query ?? "").toLowerCase().trim();
      const limit = Number(input.limit ?? 5);
      if (!query) return textResult("error: query is required");
      const memories = await backend.listMemories();
      const results = memories
        .filter((m) => m.content.toLowerCase().includes(query))
        .sort((a, b) => b.created_at - a.created_at)
        .slice(0, Math.max(1, Math.min(limit, 100)))
        .map((m) => ({ id: m.id, category: m.category, created_at: m.created_at, content: m.content }));
      return textResult(JSON.stringify(results));
    }

    case "plureslm_query_dsl": {
      const query = String(input.query ?? "").trim();
      if (!query) return textResult("error: query is required");
      const result = await backend.execDsl(query);
      return textResult(JSON.stringify(result));
    }

    case "plureslm_world_state": {
      const result = await backend.generateWorldState();
      return textResult(result);
    }

    default:
      return textResult(`error: unknown tool ${name}`);
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("plureslm-mcp failed:", error);
  process.exit(1);
});

process.on("SIGINT", async () => {
  await backend.close();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await backend.close();
  process.exit(0);
});
