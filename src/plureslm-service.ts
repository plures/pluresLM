#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { PluresDBBackend } from "./pluresdb-backend.js";

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function asObject(input: unknown): Record<string, unknown> {
  if (input && typeof input === "object" && !Array.isArray(input)) return input as Record<string, unknown>;
  return {};
}

export async function startPluresLMService() {
  const server = new Server(
    { name: "plureslm-service", version: "0.2.0" },
    { capabilities: { tools: {} } },
  );

  const storePath = process.env.PLURESLM_STORE_PATH ?? process.env.PLURESLM_DB_PATH ?? ".plureslm-store";
  const vectorDimension = Number(process.env.PLURESLM_VECTOR_DIM ?? "384");
  process.env.PLURESLM_EXPLICIT_DB_PATH = process.env.PLURESLM_EXPLICIT_DB_PATH ?? "1";
  const backend = new PluresDBBackend(storePath, vectorDimension);

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "plureslm_store",
        description: "Store a memory in PluresLM service",
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
        description: "List recent memories",
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
        description: "Simple substring search over content",
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
        description: "Run PluresDB DSL query",
        inputSchema: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
      },
      {
        name: "plureslm_world_state",
        description: "Generate high-priority world state summary",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "plureslm_health",
        description: "Health check for pluresLM service",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "plureslm_stats",
        description: "Service/storage stats",
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

      case "plureslm_health": {
        const open = await backend.isOpen();
        return textResult(JSON.stringify({ ok: true, service: "plureslm-service", open }));
      }

      case "plureslm_stats": {
        const stats = await backend.stats();
        return textResult(JSON.stringify(stats));
      }

      default:
        return textResult(`error: unknown tool ${name}`);
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  const close = async () => {
    await backend.close();
    process.exit(0);
  };

  process.on("SIGINT", close);
  process.on("SIGTERM", close);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startPluresLMService().catch((error) => {
    console.error("plureslm-service failed:", error);
    process.exit(1);
  });
}
