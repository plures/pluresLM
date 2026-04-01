#!/usr/bin/env node
/**
 * Back-compat entrypoint. Prefer src/plureslm-service.ts.
 */
import { startPluresLMService } from "./plureslm-service.js";

startPluresLMService().catch((error) => {
  console.error("plureslm-mcp failed:", error);
  process.exit(1);
});
