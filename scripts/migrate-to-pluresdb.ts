#!/usr/bin/env npx tsx
/**
 * Dev shim for the migration script.
 *
 * Canonical source: src/migrate-to-pluresdb.ts
 * Compiled for production use: dist/migrate-to-pluresdb.js
 *
 * This file exists so that `npx tsx scripts/migrate-to-pluresdb.ts` continues
 * to work during development. For installed use, `npx pluresLM migrate` calls
 * the compiled dist/migrate-to-pluresdb.js (no tsx required at runtime).
 */
export * from "../src/migrate-to-pluresdb.js";

// CLI is triggered automatically: src/migrate-to-pluresdb.ts detects
// process.argv[1].includes("migrate-to-pluresdb"), which matches this
// file path, so running this shim directly also invokes the CLI.
