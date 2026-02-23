/**
 * YAML-extensible operational memory patterns engine.
 *
 * Loads PatternDefinition objects from YAML files, registers them to
 * an event system, renders Mustache templates, and dispatches
 * capture/recall/action sequences via pluggable store/search callbacks.
 */

import { z } from "zod";
import * as yaml from "js-yaml";
import Mustache from "mustache";
import * as fs from "node:fs";
import * as path from "node:path";
import { EventEmitter } from "node:events";

// ============================================================================
// Constants
// ============================================================================

/** Matches numeric comparison operators in pattern condition values, e.g. ">3", "<=5.5" */
const NUMERIC_CONDITION_PATTERN = /^(>=|<=|>|<)\s*(\d+(?:\.\d+)?)$/;

// ============================================================================
// Zod Schema + Types
// ============================================================================

export const PatternTriggerSchema = z.object({
  event: z.string(),
  conditions: z.record(z.string(), z.string()).optional(),
});

export const PatternCaptureSchema = z.object({
  content: z.string(),
  opts: z.record(z.string(), z.unknown()),
});

export const PatternRecallSchema = z.object({
  query: z.string(),
  filter: z.record(z.string(), z.unknown()).optional(),
  limit: z.number().int().positive().optional(),
  min_similarity: z.number().min(0).max(1).optional(),
});

export const PatternActionSchema = z.object({
  on_match: z
    .object({
      type: z.string(),
      template: z.string().optional(),
    })
    .optional(),
  on_no_match: z
    .object({
      type: z.string(),
    })
    .optional(),
});

export const PatternSchema = z.object({
  name: z.string().min(1),
  version: z.number().int().positive(),
  description: z.string().optional(),
  trigger: PatternTriggerSchema,
  capture: PatternCaptureSchema,
  recall: PatternRecallSchema,
  action: PatternActionSchema,
});

export type PatternDefinition = z.infer<typeof PatternSchema>;

// ============================================================================
// Action result types
// ============================================================================

export interface PatternMatch {
  content: string;
  metadata: Record<string, unknown>;
  score: number;
}

export type ActionType =
  | "suggest-fix"
  | "apply-preference"
  | "context-inject"
  | "store-new"
  | "escalate"
  | (string & NonNullable<unknown>);

export interface PatternActionResult {
  patternName: string;
  action: ActionType;
  /** Rendered message when on_match has a template */
  message?: string;
  /** Recalled matches used to build the message */
  matches?: PatternMatch[];
}

// ============================================================================
// Engine options
// ============================================================================

export interface PatternEngineOptions {
  /**
   * Directories to scan for .yml / .yaml pattern files.
   * Scanned in order; a later directory can override an earlier pattern
   * with the same `name`.
   */
  patternsDirs?: string[];
  /**
   * Callback to persist a captured memory.
   * Receives rendered content + opts (category, tags, etc.).
   */
  store?: (content: string, opts: Record<string, unknown>) => Promise<void>;
  /**
   * Callback to search existing memories for recall.
   * Returns at most `limit` matches above `minSimilarity`.
   */
  search?: (
    query: string,
    filter?: Record<string, unknown>,
    limit?: number,
    minSimilarity?: number,
  ) => Promise<PatternMatch[]>;
  /** Watch pattern directories for hot-reload (default: false) */
  watch?: boolean;
  debug?: boolean;
}

// ============================================================================
// Template rendering helpers
// ============================================================================

/**
 * Recursively render Mustache templates in an object/array/string.
 */
export function renderValue(value: unknown, context: Record<string, unknown>): unknown {
  if (typeof value === "string") {
    return Mustache.render(value, context);
  }
  if (Array.isArray(value)) {
    return value.map((v) => renderValue(v, context));
  }
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      result[k] = renderValue(v, context);
    }
    return result;
  }
  return value;
}

// ============================================================================
// PatternEngine
// ============================================================================

export class PatternEngine extends EventEmitter {
  private patterns: Map<string, PatternDefinition> = new Map();
  private watchers: fs.FSWatcher[] = [];
  private opts: PatternEngineOptions;

  constructor(opts: PatternEngineOptions = {}) {
    super();
    this.opts = opts;
    if (opts.watch) {
      this.startWatching();
    }
  }

  // --------------------------------------------------------------------------
  // Loading
  // --------------------------------------------------------------------------

  /** Parse and validate a single YAML file. Returns null on failure. */
  loadFile(filePath: string): PatternDefinition | null {
    try {
      const raw = fs.readFileSync(filePath, "utf-8");
      const parsed = yaml.load(raw);
      const result = PatternSchema.safeParse(parsed);
      if (!result.success) {
        this._debug(`Invalid pattern ${filePath}: ${result.error.message}`);
        return null;
      }
      return result.data;
    } catch (err) {
      this._debug(`Failed to load ${filePath}: ${String(err)}`);
      return null;
    }
  }

  /** Load all .yml/.yaml files from a directory into the pattern registry. */
  loadDirectory(dir: string): void {
    if (!fs.existsSync(dir)) return;
    try {
      const files = fs
        .readdirSync(dir)
        .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));
      for (const file of files) {
        const pattern = this.loadFile(path.join(dir, file));
        if (pattern) {
          this.patterns.set(pattern.name, pattern);
          this.emit("pattern:loaded", pattern);
        }
      }
    } catch (err) {
      this._debug(`Failed to scan dir ${dir}: ${String(err)}`);
    }
  }

  /** (Re-)load patterns from all configured directories. */
  load(): void {
    this.patterns.clear();
    for (const dir of this.opts.patternsDirs ?? []) {
      this.loadDirectory(dir);
    }
  }

  // --------------------------------------------------------------------------
  // Hot-reload via fs.watch
  // --------------------------------------------------------------------------

  startWatching(): void {
    this.stopWatching();
    for (const dir of this.opts.patternsDirs ?? []) {
      if (!fs.existsSync(dir)) continue;
      try {
        const watcher = fs.watch(dir, { persistent: false }, (event, filename) => {
          if (!filename) return;
          const name = Buffer.isBuffer(filename) ? filename.toString() : (filename as string);
          if (!name.endsWith(".yml") && !name.endsWith(".yaml")) return;
          const filePath = path.join(dir, name);
          if (event === "rename" && !fs.existsSync(filePath)) {
            // File deleted – reload everything so removed patterns are purged
            this.load();
            this.emit("patterns:reloaded");
          } else {
            const pattern = this.loadFile(filePath);
            if (pattern) {
              this.patterns.set(pattern.name, pattern);
              this.emit("pattern:reloaded", pattern);
            }
          }
        });
        this.watchers.push(watcher);
      } catch (err) {
        this._debug(`Cannot watch ${dir}: ${String(err)}`);
      }
    }
  }

  stopWatching(): void {
    for (const w of this.watchers) {
      try {
        w.close();
      } catch {
        // ignore
      }
    }
    this.watchers = [];
  }

  // --------------------------------------------------------------------------
  // Query helpers
  // --------------------------------------------------------------------------

  /** Patterns registered for a given event type. */
  getPatternsForEvent(event: string): PatternDefinition[] {
    return Array.from(this.patterns.values()).filter(
      (p) => p.trigger.event === event,
    );
  }

  /** Names of all loaded patterns. */
  getPatternNames(): string[] {
    return Array.from(this.patterns.keys());
  }

  /** Look up a pattern by name. */
  getPattern(name: string): PatternDefinition | undefined {
    return this.patterns.get(name);
  }

  // --------------------------------------------------------------------------
  // Event dispatch
  // --------------------------------------------------------------------------

  /**
   * Dispatch an event to all matching patterns.
   *
   * For each matching pattern:
   *  1. Render recall query + filter from context
   *  2. Search existing memories
   *  3. Execute on_match or on_no_match action
   */
  async dispatch(
    event: string,
    context: Record<string, unknown>,
  ): Promise<PatternActionResult[]> {
    const matching = this.getPatternsForEvent(event).filter((p) =>
      this._matchesConditions(p, context),
    );
    const results: PatternActionResult[] = [];

    for (const pattern of matching) {
      try {
        const result = await this._executePattern(pattern, context);
        if (result) results.push(result);
      } catch (err) {
        this._debug(`Pattern ${pattern.name} failed: ${String(err)}`);
      }
    }

    return results;
  }

  // --------------------------------------------------------------------------
  // Internals
  // --------------------------------------------------------------------------

  private _matchesConditions(
    pattern: PatternDefinition,
    context: Record<string, unknown>,
  ): boolean {
    if (!pattern.trigger.conditions) return true;
    for (const [key, valueTemplate] of Object.entries(
      pattern.trigger.conditions,
    )) {
      const rendered = Mustache.render(valueTemplate, context);
      const contextVal = String(context[key] ?? "");
      // Support simple numeric comparisons: ">3", ">=3", "<3", "<=3"
      const numericCmp = rendered.match(NUMERIC_CONDITION_PATTERN);
      if (numericCmp) {
        const [, op, threshStr] = numericCmp;
        const threshold = parseFloat(threshStr);
        const actual = parseFloat(contextVal);
        if (isNaN(actual)) return false;
        if (op === ">" && !(actual > threshold)) return false;
        if (op === ">=" && !(actual >= threshold)) return false;
        if (op === "<" && !(actual < threshold)) return false;
        if (op === "<=" && !(actual <= threshold)) return false;
      } else if (rendered.includes("*")) {
        // Support simple glob wildcards: "*" matches any sequence of characters.
        // Use a callback for the replacement to avoid any "$&" interpretation issues.
        const regexStr = rendered
          .replace(/[.+?^${}()|[\]\\]/g, (ch) => `\\${ch}`)
          .replace(/\*/g, ".*");
        if (!new RegExp(`^${regexStr}$`).test(contextVal)) return false;
      } else if (rendered !== contextVal) {
        return false;
      }
    }
    return true;
  }

  private async _executePattern(
    pattern: PatternDefinition,
    context: Record<string, unknown>,
  ): Promise<PatternActionResult | null> {
    // Render recall fields
    const recallQuery = Mustache.render(pattern.recall.query, context);
    const recallFilter = pattern.recall.filter
      ? (renderValue(pattern.recall.filter, context) as Record<string, unknown>)
      : undefined;

    // Search for prior matches
    const matches: PatternMatch[] = this.opts.search
      ? await this.opts.search(
          recallQuery,
          recallFilter,
          pattern.recall.limit ?? 5,
          pattern.recall.min_similarity ?? 0.7,
        )
      : [];

    if (matches.length > 0) {
      const actionType: ActionType = pattern.action.on_match?.type ?? "suggest-fix";
      const tmpl = pattern.action.on_match?.template;
      let message: string | undefined;
      if (tmpl) {
        message = Mustache.render(tmpl, {
          ...context,
          recalled: { content: matches[0].content },
        });
      }
      this.emit("pattern:match", { pattern: pattern.name, matches, message });
      return { patternName: pattern.name, action: actionType, message, matches };
    }

    // No match → on_no_match (default: store-new)
    const noMatchAction: ActionType =
      pattern.action.on_no_match?.type ?? "store-new";

    if (noMatchAction === "store-new" && this.opts.store) {
      const captureContent = Mustache.render(pattern.capture.content, context);
      const captureOpts = renderValue(
        pattern.capture.opts,
        context,
      ) as Record<string, unknown>;
      await this.opts.store(captureContent, captureOpts);
      this.emit("pattern:captured", {
        pattern: pattern.name,
        content: captureContent,
      });
    }

    return { patternName: pattern.name, action: noMatchAction };
  }

  private _debug(msg: string): void {
    if (this.opts.debug) {
      console.warn(`[PatternEngine] ${msg}`);
    }
  }
}
