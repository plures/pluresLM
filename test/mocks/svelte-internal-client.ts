/**
 * Minimal stub for `svelte/internal/client`.
 *
 * @plures/praxis bundles a Svelte-based ReactiveLogicEngine that imports
 * from this module at the top level of its node distribution. PluresLM
 * is a Node.js/MCP service and does not use the Svelte reactive engine —
 * we use the plain LogicEngine / createPraxisEngine API only.
 *
 * This stub satisfies the import so tests can run without a full Svelte
 * installation. All functions are no-ops or identity wrappers that mirror
 * the minimal surface used by ReactiveLogicEngine.
 */

/** Wrap a value in a minimal mutable signal-like container. */
export function state(value: unknown) {
  return { _v: value };
}

/** Retrieve the value of a signal-like container. */
export function get(signal: { _v: unknown }) {
  return signal._v;
}

/** Set the value of a signal-like container. */
export function set(signal: { _v: unknown }, value: unknown, _force?: boolean) {
  signal._v = value;
}

/** Return the value as-is (no reactive proxy needed in Node.js tests). */
export function proxy<T>(value: T): T {
  return value;
}
