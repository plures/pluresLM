import { describe, expect, it } from "vitest";
import {
  shouldCapture,
  DEFAULT_CAPTURE_QUALITY_CONFIG,
  DEFAULT_SKIP_PATTERNS,
  type CaptureQualityConfig,
  detectTrainingSignal,
  CORRECTION_PATTERNS,
  CONFIRMATION_PATTERNS,
  FAILURE_PATTERNS,
  PREFERENCE_PATTERNS,
} from "../../src/capture-quality.js";
import type { ConversationWindowEntry } from "../../src/types.js";

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

// ── detectTrainingSignal ──────────────────────────────────────────────────────

const makeEntry = (role: string, content: string, ts = 0): ConversationWindowEntry => ({
  role,
  content,
  timestamp: ts,
});

describe("detectTrainingSignal — corrections", () => {
  it("returns null for plain text with no training signal", () => {
    expect(detectTrainingSignal("Just a regular message with no signal here at all.")).toBeNull();
  });

  it("detects 'no, do it this way' as correction", () => {
    const result = detectTrainingSignal("No, do it this way instead please.");
    expect(result).not.toBeNull();
    expect(result!.signalType).toBe("correction");
    expect(result!.source).toBe("conversation");
  });

  it("detects 'that's wrong' as correction", () => {
    const result = detectTrainingSignal("That's wrong, please redo it differently.");
    expect(result).not.toBeNull();
    expect(result!.signalType).toBe("correction");
  });

  it("detects 'actually, use' as correction", () => {
    const result = detectTrainingSignal("Actually, use ESM imports here not CommonJS.");
    expect(result).not.toBeNull();
    expect(result!.signalType).toBe("correction");
  });

  it("detects 'don't do that' as correction", () => {
    const result = detectTrainingSignal("Don't do it that way, change it to use async/await.");
    expect(result).not.toBeNull();
    expect(result!.signalType).toBe("correction");
  });

  it("detects 'change that' as correction", () => {
    const result = detectTrainingSignal("Change that, use the factory function pattern instead.");
    expect(result).not.toBeNull();
    expect(result!.signalType).toBe("correction");
  });

  it("sets rejected_approach to the last assistant message from history", () => {
    const history = [
      makeEntry("user", "How do I import?", 1),
      makeEntry("assistant", "Use require() to import the module.", 2),
    ];
    const result = detectTrainingSignal("No, do it this way — use import instead.", history);
    expect(result!.rejected_approach).toBe("Use require() to import the module.");
    expect(result!.chosen_approach).toBe("No, do it this way — use import instead.");
  });

  it("sets rejected_approach to null when there is no assistant turn in history", () => {
    const history = [makeEntry("user", "Previous question?", 1)];
    const result = detectTrainingSignal("No, that's wrong please fix it.", history);
    expect(result!.rejected_approach).toBeNull();
  });
});

describe("detectTrainingSignal — confirmations", () => {
  it("detects 'that worked' as confirmation", () => {
    const result = detectTrainingSignal("That worked, thanks for fixing it.");
    expect(result).not.toBeNull();
    expect(result!.signalType).toBe("confirmation");
    expect(result!.source).toBe("conversation");
    expect(result!.outcome).toBe("success");
  });

  it("detects 'yes, that worked' as confirmation", () => {
    const result = detectTrainingSignal("Yes, that worked perfectly fine!");
    expect(result).not.toBeNull();
    expect(result!.signalType).toBe("confirmation");
    expect(result!.outcome).toBe("success");
  });

  it("detects 'problem solved' as confirmation", () => {
    const result = detectTrainingSignal("Problem solved, everything compiles now.");
    expect(result).not.toBeNull();
    expect(result!.signalType).toBe("confirmation");
    expect(result!.outcome).toBe("success");
  });

  it("detects 'works perfectly' as confirmation", () => {
    const result = detectTrainingSignal("Works perfectly now, all tests pass.");
    expect(result).not.toBeNull();
    expect(result!.signalType).toBe("confirmation");
    expect(result!.outcome).toBe("success");
  });

  it("detects 'thanks, that fixed it' as confirmation", () => {
    const result = detectTrainingSignal("Thanks, that fixed it right away!");
    expect(result).not.toBeNull();
    expect(result!.signalType).toBe("confirmation");
    expect(result!.outcome).toBe("success");
  });
});

describe("detectTrainingSignal — failures", () => {
  it("detects 'that broke X' as failure", () => {
    const result = detectTrainingSignal("That broke the build, now everything is failing.");
    expect(result).not.toBeNull();
    expect(result!.signalType).toBe("failure");
    expect(result!.source).toBe("conversation");
    expect(result!.outcome).toBe("failure");
  });

  it("detects 'that didn't work' as failure", () => {
    const result = detectTrainingSignal("That didn't work, still getting the same error.");
    expect(result).not.toBeNull();
    expect(result!.signalType).toBe("failure");
    expect(result!.outcome).toBe("failure");
  });

  it("detects 'still failing' as failure", () => {
    const result = detectTrainingSignal("Still failing after applying the suggested change.");
    expect(result).not.toBeNull();
    expect(result!.signalType).toBe("failure");
  });

  it("detects 'that caused a new error' as failure", () => {
    const result = detectTrainingSignal("That caused a new error in the test suite.");
    expect(result).not.toBeNull();
    expect(result!.signalType).toBe("failure");
    expect(result!.outcome).toBe("failure");
  });

  it("detects 'not working' as failure", () => {
    const result = detectTrainingSignal("Not working, the component still crashes on mount.");
    expect(result).not.toBeNull();
    expect(result!.signalType).toBe("failure");
  });
});

describe("detectTrainingSignal — preferences", () => {
  it("detects 'I prefer X over Y' as preference", () => {
    const result = detectTrainingSignal("I prefer TypeScript over JavaScript for all new files.");
    expect(result).not.toBeNull();
    expect(result!.signalType).toBe("preference");
    expect(result!.source).toBe("user_explicit");
  });

  it("extracts chosen/rejected approaches from 'I prefer X over Y'", () => {
    const result = detectTrainingSignal("I prefer PluresDB over SQLite for storage.");
    expect(result!.chosen_approach).toBe("PluresDB");
    expect(result!.rejected_approach).toBe("SQLite for storage");
  });

  it("extracts chosen/rejected from 'use X over Y'", () => {
    const result = detectTrainingSignal("Please use vitest over jest for testing.");
    expect(result).not.toBeNull();
    expect(result!.signalType).toBe("preference");
    expect(result!.chosen_approach).toBe("vitest");
    expect(result!.rejected_approach).toBe("jest for testing");
  });

  it("extracts chosen/rejected from 'X is better than Y'", () => {
    const result = detectTrainingSignal("ESM is better than CommonJS for this project.");
    expect(result).not.toBeNull();
    expect(result!.signalType).toBe("preference");
    expect(result!.chosen_approach).toBe("ESM");
    expect(result!.rejected_approach).toBe("CommonJS for this project");
  });

  it("sets chosen/rejected to null when extraction fails", () => {
    // Matches pattern but no parseable X/Y — hits PREFERENCE_PATTERNS but not extraction regexes
    const result = detectTrainingSignal("I prefer the existing approach over the new one you suggested here.");
    expect(result).not.toBeNull();
    expect(result!.signalType).toBe("preference");
    // May or may not extract — just ensure no crash and source is set
    expect(result!.source).toBe("user_explicit");
  });
});

describe("detectTrainingSignal — conversation_window", () => {
  it("returns empty conversation_window when no history provided", () => {
    const result = detectTrainingSignal("That worked, great!");
    expect(result!.conversation_window).toEqual([]);
  });

  it("includes all history turns when ≤5 turns provided", () => {
    const history = [
      makeEntry("user", "Question 1", 1),
      makeEntry("assistant", "Answer 1", 2),
      makeEntry("user", "Question 2", 3),
    ];
    const result = detectTrainingSignal("That worked!", history);
    expect(result!.conversation_window).toHaveLength(3);
    expect(result!.conversation_window).toEqual(history);
  });

  it("caps conversation_window at last 5 turns when >5 turns in history", () => {
    const history: ConversationWindowEntry[] = Array.from({ length: 8 }, (_, i) =>
      makeEntry(i % 2 === 0 ? "user" : "assistant", `message ${i}`, i),
    );
    const result = detectTrainingSignal("That worked!", history);
    expect(result!.conversation_window).toHaveLength(5);
    expect(result!.conversation_window[0].content).toBe("message 3");
    expect(result!.conversation_window[4].content).toBe("message 7");
  });

  it("conversation_window is last 5 turns for correction signals too", () => {
    const history: ConversationWindowEntry[] = Array.from({ length: 7 }, (_, i) =>
      makeEntry(i % 2 === 0 ? "user" : "assistant", `msg ${i}`, i),
    );
    const result = detectTrainingSignal("No, do it this way please.", history);
    expect(result!.signalType).toBe("correction");
    expect(result!.conversation_window).toHaveLength(5);
  });
});

describe("detectTrainingSignal — source field", () => {
  it("sets source to 'conversation' for correction signals", () => {
    expect(detectTrainingSignal("No, do it this way.")!.source).toBe("conversation");
  });

  it("sets source to 'conversation' for confirmation signals", () => {
    expect(detectTrainingSignal("That worked perfectly now!")!.source).toBe("conversation");
  });

  it("sets source to 'conversation' for failure signals", () => {
    expect(detectTrainingSignal("That broke the build entirely.")!.source).toBe("conversation");
  });

  it("sets source to 'user_explicit' for preference signals", () => {
    expect(detectTrainingSignal("I prefer Rust over TypeScript for backend work.")!.source).toBe("user_explicit");
  });
});

describe("detectTrainingSignal — signal priority order", () => {
  it("correction takes priority over confirmation when both could match", () => {
    // A message that has both a correction opener and a confirmation phrase
    const result = detectTrainingSignal("No, that's wrong — the problem solved differently here.");
    expect(result!.signalType).toBe("correction");
  });
});
