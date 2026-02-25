import { describe, expect, it } from "vitest";
import { CompatibilityLayer } from "../../src/compatibility-layer.js";

describe("CompatibilityLayer", () => {
  describe("enhanced mode", () => {
    const layer = new CompatibilityLayer("enhanced");

    it("shouldRegister returns true for registerMemoryStatus", () => {
      expect(layer.shouldRegister("registerMemoryStatus")).toBe(true);
    });

    it("requiresEnhancedMode returns false (feature is available)", () => {
      expect(layer.requiresEnhancedMode("registerMemoryStatus")).toBe(false);
    });

    it("getMode returns enhanced", () => {
      expect(layer.getMode()).toBe("enhanced");
    });
  });

  describe("compatible mode", () => {
    const layer = new CompatibilityLayer("compatible");

    it("shouldRegister returns false for registerMemoryStatus", () => {
      expect(layer.shouldRegister("registerMemoryStatus")).toBe(false);
    });

    it("requiresEnhancedMode returns true (feature requires fork APIs)", () => {
      expect(layer.requiresEnhancedMode("registerMemoryStatus")).toBe(true);
    });

    it("getMode returns compatible", () => {
      expect(layer.getMode()).toBe("compatible");
    });

    it("skips registerMemoryStatus hook in compatible mode", () => {
      const registered: string[] = [];
      const mockApi = {
        registerMemoryStatus: (_cb: () => unknown) => {
          registered.push("registerMemoryStatus");
        },
      };

      // Simulate what index.ts does at startup
      if (layer.shouldRegister("registerMemoryStatus") && typeof mockApi.registerMemoryStatus === "function") {
        mockApi.registerMemoryStatus(() => null);
      }

      expect(registered).toHaveLength(0);
    });
  });
});
