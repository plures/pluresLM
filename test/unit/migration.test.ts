import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseMemoryMd } from "../../src/migration.js";

describe("migration utilities", () => {
  let tmpDir: string;
  let memoryMdPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pluresLM-migration-test-"));
    memoryMdPath = join(tmpDir, "MEMORY.md");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("parseMemoryMd", () => {
    it("parses bullet points into separate memories", () => {
      writeFileSync(
        memoryMdPath,
        "- TypeScript is a typed superset of JavaScript\n- Use vitest for unit testing",
      );
      const memories = parseMemoryMd(memoryMdPath);
      expect(memories.length).toBe(2);
      expect(memories[0].content).toBe("TypeScript is a typed superset of JavaScript");
      expect(memories[1].content).toBe("Use vitest for unit testing");
    });

    it("parses asterisk and plus bullet styles", () => {
      writeFileSync(
        memoryMdPath,
        "* Asterisk bullet point content here\n+ Plus bullet point content here",
      );
      const memories = parseMemoryMd(memoryMdPath);
      expect(memories.length).toBe(2);
    });

    it("parses section headers as tags", () => {
      writeFileSync(
        memoryMdPath,
        "# Tech Stack\n- Using TypeScript and Node.js\n\n# Preferences\n- Prefer dark mode in editors",
      );
      const memories = parseMemoryMd(memoryMdPath);
      expect(memories.some(m => m.tags.includes("section:tech-stack"))).toBe(true);
      expect(memories.some(m => m.tags.includes("section:preferences"))).toBe(true);
    });

    it("all parsed memories have source:memory.md tag", () => {
      writeFileSync(memoryMdPath, "- TypeScript is a typed superset of JavaScript");
      const memories = parseMemoryMd(memoryMdPath);
      expect(memories.every(m => m.tags.includes("source:memory.md"))).toBe(true);
    });

    it("all parsed memories have migration source and critical priority", () => {
      writeFileSync(memoryMdPath, "- TypeScript is a typed superset of JavaScript");
      const memories = parseMemoryMd(memoryMdPath);
      expect(memories[0].source).toBe("migration:MEMORY.md");
      expect(memories[0].priority).toBe("critical");
      expect(memories[0].category).toBe("migrated-memory");
    });

    it("skips bullet points shorter than 20 characters", () => {
      writeFileSync(memoryMdPath, "- Short\n- This is long enough to be included in memories");
      const memories = parseMemoryMd(memoryMdPath);
      expect(memories.length).toBe(1);
      expect(memories[0].content).toBe("This is long enough to be included in memories");
    });

    it("skips regular paragraph lines shorter than 20 characters", () => {
      writeFileSync(memoryMdPath, "Too short\nThis is a long enough paragraph line to be included");
      const memories = parseMemoryMd(memoryMdPath);
      expect(memories.length).toBe(1);
    });

    it("parses regular paragraphs (non-bullet, non-header)", () => {
      writeFileSync(
        memoryMdPath,
        "This is a regular paragraph with enough content to be included.",
      );
      const memories = parseMemoryMd(memoryMdPath);
      expect(memories.length).toBe(1);
      expect(memories[0].content).toBe(
        "This is a regular paragraph with enough content to be included.",
      );
    });

    it("returns empty array for file with only short lines", () => {
      writeFileSync(memoryMdPath, "# Header\nShort\n- Tiny");
      const memories = parseMemoryMd(memoryMdPath);
      expect(memories.length).toBe(0);
    });

    it("throws for non-existent file", () => {
      expect(() => parseMemoryMd("/nonexistent/path/MEMORY.md")).toThrow("File not found");
    });

    it("handles empty file gracefully", () => {
      writeFileSync(memoryMdPath, "");
      const memories = parseMemoryMd(memoryMdPath);
      expect(memories).toEqual([]);
    });
  });
});
