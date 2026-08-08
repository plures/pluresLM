import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { z } from "zod";
import {
  PatternSchema,
  PolicySchema,
  SchemaRegistry,
  validatePatterns,
  PatternEngine,
  type PatternValidationResult,
} from "../../src/patterns.js";

describe("PolicySchema", () => {
  const basePattern = {
    name: "test-policy",
    version: 1,
    trigger: { event: "memory-capture" },
    capture: { content: "{{msg}}", opts: { category: "ops" } },
    recall: { query: "{{msg}}" },
    action: { on_no_match: { type: "store-new" } },
  };

  it("validates a complete policy definition", () => {
    const result = PolicySchema.safeParse({
      ...basePattern,
      policy: {
        severity: "error",
        enforcement: "block",
        cooldown_seconds: 30,
        scope: "per-source",
        message: "Blocked: rate exceeded",
      },
    });
    expect(result.success).toBe(true);
  });

  it("applies defaults for severity and enforcement", () => {
    const result = PolicySchema.safeParse({
      ...basePattern,
      policy: {},
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.policy.severity).toBe("warning");
      expect(result.data.policy.enforcement).toBe("audit");
    }
  });

  it("rejects invalid severity value", () => {
    const result = PolicySchema.safeParse({
      ...basePattern,
      policy: { severity: "fatal" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid enforcement value", () => {
    const result = PolicySchema.safeParse({
      ...basePattern,
      policy: { enforcement: "deny" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects negative cooldown_seconds", () => {
    const result = PolicySchema.safeParse({
      ...basePattern,
      policy: { cooldown_seconds: -1 },
    });
    expect(result.success).toBe(false);
  });
});

describe("SchemaRegistry", () => {
  it("detects policy kind when data has policy field", () => {
    const registry = new SchemaRegistry();
    const data = {
      name: "p",
      version: 1,
      trigger: { event: "x" },
      capture: { content: "x", opts: {} },
      recall: { query: "x" },
      action: {},
      policy: { severity: "info", enforcement: "audit" },
    };
    const result = registry.validate(data);
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.kind).toBe("policy");
  });

  it("detects base pattern kind when no policy field", () => {
    const registry = new SchemaRegistry();
    const data = {
      name: "p",
      version: 1,
      trigger: { event: "x" },
      capture: { content: "x", opts: {} },
      recall: { query: "x" },
      action: {},
    };
    const result = registry.validate(data);
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.kind).toBe("pattern");
  });

  it("returns errors for invalid data", () => {
    const registry = new SchemaRegistry();
    const result = registry.validate({ name: "" });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.length).toBeGreaterThan(0);
    }
  });

  it("supports registering custom schemas", () => {
    const registry = new SchemaRegistry();
    const customSchema = PatternSchema.extend({
      custom_field: z.string().optional(),
    });
    registry.register("custom", customSchema);
    expect(registry.getKinds()).toContain("custom");
  });
});

describe("validatePatterns", () => {
  it("validates all files in a directory", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "validate-patterns-"));
    try {
      fs.writeFileSync(
        path.join(tmpDir, "good.yml"),
        `name: good\nversion: 1\ntrigger:\n  event: x\ncapture:\n  content: x\n  opts: {}\nrecall:\n  query: x\naction: {}\n`,
      );
      fs.writeFileSync(
        path.join(tmpDir, "bad.yml"),
        `name: ""\nversion: 0\n`,
      );

      const results = validatePatterns([tmpDir]);
      expect(results).toHaveLength(2);

      const good = results.find((r) => r.file.includes("good.yml"));
      expect(good?.result.valid).toBe(true);

      const bad = results.find((r) => r.file.includes("bad.yml"));
      expect(bad?.result.valid).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("handles non-existent directories gracefully", () => {
    const results = validatePatterns(["/tmp/nonexistent-dir-xyz"]);
    expect(results).toHaveLength(0);
  });
});

describe("PatternEngine with policies", () => {
  it("loads policy YAML files successfully", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "policy-engine-"));
    try {
      fs.writeFileSync(
        path.join(tmpDir, "policy.yml"),
        `name: test-policy\nversion: 1\ntrigger:\n  event: memory-capture\n  conditions:\n    captures_last_minute: ">10"\ncapture:\n  content: "rate limit"\n  opts:\n    category: ops\nrecall:\n  query: "rate limit"\naction:\n  on_match:\n    type: escalate\n  on_no_match:\n    type: store-new\npolicy:\n  severity: warning\n  enforcement: warn\n  cooldown_seconds: 60\n`,
      );

      const engine = new PatternEngine({ patternsDirs: [tmpDir] });
      engine.load();
      expect(engine.getPatternNames()).toContain("test-policy");

      const pattern = engine.getPattern("test-policy");
      expect(pattern).toBeDefined();
      expect((pattern as any).policy?.severity).toBe("warning");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("loads built-in ops-policy.yml", () => {
    const builtinDir = path.resolve(__dirname, "../../src/patterns");
    const engine = new PatternEngine({ patternsDirs: [builtinDir] });
    engine.load();
    expect(engine.getPatternNames()).toContain("rate-limit-capture");
  });
});
