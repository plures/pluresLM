import { describe, expect, it } from "vitest";
import {
  shouldCapture,
  DEFAULT_CAPTURE_QUALITY_CONFIG,
  DEFAULT_SKIP_PATTERNS,
  type CaptureQualityConfig,
} from "../../src/capture-quality.js";

const cfg = DEFAULT_CAPTURE_QUALITY_CONFIG;

describe("shouldCapture", () => {
  // ── length gate ────────────────────────────────────────────────────────────

  it("rejects text shorter than minContentLength (50 chars)", () => {
    expect(shouldCapture("Short text", cfg)).toBe(false);
    expect(shouldCapture("A".repeat(49), cfg)).toBe(false);
  });

  it("accepts text at exactly minContentLength", () => {
    // 50 chars, no noise markers
    const text = "A".repeat(50);
    expect(shouldCapture(text, cfg)).toBe(true);
  });

  // ── JSON tool output ───────────────────────────────────────────────────────

  it("rejects JSON tool output (starts with '{')", () => {
    const json = `{"type":"tool_result","content":"some data here","id":"abc123xyz"}`;
    expect(shouldCapture(json, cfg)).toBe(false);
  });

  it("rejects JSON tool output with leading whitespace", () => {
    const json = `  { "result": "value", "status": "ok", "data": "something here" }`;
    expect(shouldCapture(json, cfg)).toBe(false);
  });

  it("does not reject plain text that happens to contain a brace mid-sentence", () => {
    const text = "Use object destructuring { a, b } to extract values from configuration objects in TypeScript.";
    expect(shouldCapture(text, cfg)).toBe(true);
  });

  // ── tool_result marker ─────────────────────────────────────────────────────

  it("rejects text containing [tool_result]", () => {
    const text = "The [tool_result] shows the output of the command that was executed there.";
    expect(shouldCapture(text, cfg)).toBe(false);
  });

  it("rejects text containing <tool_result> XML tag", () => {
    const text = "<tool_result>some content from tool execution goes here in this text</tool_result>";
    expect(shouldCapture(text, cfg)).toBe(false);
  });

  // ── memory injection artifacts ─────────────────────────────────────────────

  it("rejects text containing <relevant-memories>", () => {
    const text = "<relevant-memories>\n- [preference] I prefer TypeScript\n</relevant-memories>";
    expect(shouldCapture(text, cfg)).toBe(false);
  });

  it("rejects text containing <session-context>", () => {
    const text = "<session-context>Current session context data goes here with details.</session-context>";
    expect(shouldCapture(text, cfg)).toBe(false);
  });

  it("rejects text containing <user-profile>", () => {
    const text = "<user-profile>User preferences and profile information stored here.</user-profile>";
    expect(shouldCapture(text, cfg)).toBe(false);
  });

  it("rejects text containing <memory-context>", () => {
    const text = "<memory-context>Some relevant memory context injected for the session.</memory-context>";
    expect(shouldCapture(text, cfg)).toBe(false);
  });

  // ── compaction artifacts ────────────────────────────────────────────────────

  it("rejects text containing [compacted: ...]", () => {
    const text = "[compacted: 120 messages from session abc123] Summary of what was discussed.";
    expect(shouldCapture(text, cfg)).toBe(false);
  });

  it("rejects text containing [truncated: ...]", () => {
    const text = "[truncated: content was cut at 10000 chars] Remaining content follows below here.";
    expect(shouldCapture(text, cfg)).toBe(false);
  });

  // ── system messages ─────────────────────────────────────────────────────────

  it("rejects text starting with [System Message]", () => {
    const text = "[System Message] You are a helpful assistant with memory capabilities enabled.";
    expect(shouldCapture(text, cfg)).toBe(false);
  });

  it("does NOT reject text that contains '[System Message]' mid-sentence", () => {
    const text = "The [System Message] prefix is used to mark injected context in the conversation.";
    // Does not START with [System Message]
    expect(shouldCapture(text, cfg)).toBe(true);
  });

  // ── PluresLM tool references (memories about memories) ────────────────────

  it("rejects text referencing pluresLM_store", () => {
    const text = "The pluresLM_store tool was called to store the memory with a specific category tag.";
    expect(shouldCapture(text, cfg)).toBe(false);
  });

  it("rejects text referencing pluresLM_search", () => {
    const text = "pluresLM_search returned 5 results for the query about TypeScript patterns used.";
    expect(shouldCapture(text, cfg)).toBe(false);
  });

  // ── repetitive boilerplate ─────────────────────────────────────────────────

  it("rejects pure boilerplate 'I'll help you with'", () => {
    expect(shouldCapture("I'll help you with that.", cfg)).toBe(false);
    expect(shouldCapture("I'll help you with this task!", cfg)).toBe(false);
  });

  it("rejects pure boilerplate 'Let me check'", () => {
    expect(shouldCapture("Let me check on that for you.", cfg)).toBe(false);
  });

  it("rejects pure boilerplate 'Here's what I found'", () => {
    expect(shouldCapture("Here's what I found for you.", cfg)).toBe(false);
  });

  it("does NOT reject substantive content that starts with boilerplate", () => {
    // Contains more than just the boilerplate opener
    const text =
      "I'll help you with that. The reason your TypeScript build fails is that you need to set 'moduleResolution' to 'bundler' in tsconfig.json for ESM imports.";
    expect(shouldCapture(text, cfg)).toBe(true);
  });

  // ── custom config ──────────────────────────────────────────────────────────

  it("respects custom minContentLength", () => {
    const custom: CaptureQualityConfig = { ...cfg, minContentLength: 100 };
    expect(shouldCapture("A".repeat(99), custom)).toBe(false);
    expect(shouldCapture("A".repeat(100), custom)).toBe(true);
  });

  it("respects empty skipPatterns", () => {
    const custom: CaptureQualityConfig = { ...cfg, skipPatterns: [] };
    const json = `{"type":"tool_result","x":"y","padding":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}`;
    // JSON tool output check is a separate code path, skipPatterns empty won't bypass it
    expect(shouldCapture(json, custom)).toBe(false);
  });

  it("respects custom skipPatterns", () => {
    const custom: CaptureQualityConfig = {
      ...cfg,
      skipPatterns: [/BLOCKED/],
    };
    const text = "This text is BLOCKED and should not be stored as a memory in the database.";
    expect(shouldCapture(text, custom)).toBe(false);
    const safe = "This text is perfectly fine and should be stored as a memory entry.";
    expect(shouldCapture(safe, custom)).toBe(true);
  });

  // ── happy path ─────────────────────────────────────────────────────────────

  it("accepts a genuine conversation memory", () => {
    const text =
      "We decided to use PluresDB for local-first storage because it provides CRDT semantics and HNSW vector search without requiring a server.";
    expect(shouldCapture(text, cfg)).toBe(true);
  });

  it("accepts a code-related memory", () => {
    const text =
      "TypeScript strict mode should always be enabled; it catches null dereferences and implicit any at compile time.";
    expect(shouldCapture(text, cfg)).toBe(true);
  });
});
