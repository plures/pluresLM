/**
 * Compatibility Layer: Mode detection and feature gating
 *
 * Enhanced Mode: All hooks registered (registerMemoryStatus, pluggable memory slot)
 * Compatible Mode: Only core tools (store/search/forget); hooks needing fork APIs are skipped
 */

import type { OperatingMode } from "./compatibility.js";

export class CompatibilityLayer {
  constructor(private mode: OperatingMode) {}

  /**
   * Returns true when the given hook requires fork-level APIs that are only
   * available in Enhanced mode.
   */
  requiresEnhancedMode(_feature: "registerMemoryStatus" | "pluggableMemorySlot"): boolean {
    return this.mode !== "enhanced";
  }

  /**
   * Returns true if the hook/feature should be registered for this mode.
   */
  shouldRegister(_feature: "registerMemoryStatus" | "pluggableMemorySlot"): boolean {
    return this.mode === "enhanced";
  }

  getMode(): OperatingMode {
    return this.mode;
  }
}