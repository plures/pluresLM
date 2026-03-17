import { describe, expect, it } from "vitest";
import { computeContextBudget } from "../../src/index.js";

describe("computeContextBudget", () => {
  // Default fraction=0.25, min=5_000, max=150_000

  it("computes 25% of contextWindow * 4 chars for a typical model", () => {
    // 128_000 tokens * 4 chars/token * 0.25 = 128_000
    expect(computeContextBudget(128_000)).toBe(128_000);
  });

  it("caps at maxContextChars for very large context windows (Opus 200k)", () => {
    // 200_000 * 4 * 0.25 = 200_000, capped at 150_000
    expect(computeContextBudget(200_000)).toBe(150_000);
  });

  it("floors at minContextChars for tiny context windows (2k model)", () => {
    // 2_000 * 4 * 0.25 = 2_000, floored to 5_000
    expect(computeContextBudget(2_000)).toBe(5_000);
  });

  it("floors at minContextChars for small context windows (8k model)", () => {
    // 8_000 * 4 * 0.25 = 8_000, within range
    expect(computeContextBudget(8_000)).toBe(8_000);
  });

  it("falls back to 200k tokens when contextWindow is undefined", () => {
    // 200_000 * 4 * 0.25 = 200_000, capped at 150_000
    expect(computeContextBudget(undefined)).toBe(150_000);
  });

  it("falls back to 200k tokens when contextWindow is 0", () => {
    expect(computeContextBudget(0)).toBe(150_000);
  });

  it("respects custom fraction", () => {
    // 128_000 * 4 * 0.5 = 256_000, capped at 150_000
    expect(computeContextBudget(128_000, 0.5)).toBe(150_000);
    // 128_000 * 4 * 0.1 = 51_200
    expect(computeContextBudget(128_000, 0.1)).toBe(51_200);
  });

  it("respects custom min and max", () => {
    // 2_000 * 4 * 0.25 = 2_000, floored to custom min 1_000
    expect(computeContextBudget(2_000, 0.25, 1_000, 200_000)).toBe(2_000);
    // 500_000 * 4 * 0.25 = 500_000, capped to custom max 300_000
    expect(computeContextBudget(500_000, 0.25, 1_000, 300_000)).toBe(300_000);
  });

  it("applies floor when fraction yields less than min", () => {
    // 1_000 * 4 * 0.25 = 1_000, floored to default 5_000
    expect(computeContextBudget(1_000)).toBe(5_000);
  });

  it("returns integer (no decimals)", () => {
    const result = computeContextBudget(7_777);
    expect(Number.isInteger(result)).toBe(true);
  });

  it("handles non-finite fraction (NaN) by falling back to 0.25", () => {
    // NaN fraction → falls back to 0.25 → 128_000 * 4 * 0.25 = 128_000
    expect(computeContextBudget(128_000, NaN)).toBe(128_000);
  });

  it("handles Infinity fraction by falling back to 0.25", () => {
    expect(computeContextBudget(128_000, Infinity)).toBe(128_000);
  });

  it("handles negative fraction by clamping to 0, then floors to min", () => {
    // negative fraction → safeFraction=0 → budget=0 → floored to 5_000
    expect(computeContextBudget(128_000, -0.5)).toBe(5_000);
  });

  it("handles non-finite min/max by falling back to defaults", () => {
    // NaN min/max → fallback to 5_000/150_000 → 128_000 normal
    expect(computeContextBudget(128_000, 0.25, NaN, NaN)).toBe(128_000);
  });

  it("handles swapped min > max by swapping them internally", () => {
    // min=150_000, max=5_000 → swapped → 128_000 is within [5_000, 150_000]
    expect(computeContextBudget(128_000, 0.25, 150_000, 5_000)).toBe(128_000);
  });

  it("handles non-finite contextWindow (NaN) by falling back to 200k", () => {
    // NaN contextWindow → 200_000 * 4 * 0.25 = 200_000, capped at 150_000
    expect(computeContextBudget(NaN)).toBe(150_000);
  });
});
