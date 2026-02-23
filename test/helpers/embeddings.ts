/**
 * Deterministic test embedding helpers.
 *
 * Creates unit vectors and near-unit vectors suitable for controlling
 * cosine similarity in tests — no network, no model downloads.
 */

/**
 * Create a unit basis vector (all zeros except position `primary`).
 * Cosine similarity between two different basis vectors = 0.
 * Cosine similarity between two identical basis vectors = 1.
 */
export function makeVec(primary: number, dim: number = 8): number[] {
  const vec = new Array<number>(dim).fill(0.0);
  vec[primary % dim] = 1.0;
  return vec;
}

/**
 * Create a vector near the `primary` basis direction.
 * Adding a small component at the adjacent position reduces cosine similarity
 * with the pure basis vector.
 *
 * Approximate cosine similarities with makeVec(primary):
 *   noiseLevel = 0.1  → cos ≈ 0.995  (triggers simple dedup at 0.95 threshold)
 *   noiseLevel = 0.3  → cos ≈ 0.958  (triggers simple dedup at 0.95 threshold)
 *   noiseLevel = 0.5  → cos ≈ 0.894  (above semantic dedup 0.85, below simple 0.95)
 *   noiseLevel = 0.8  → cos ≈ 0.781  (below all dedup thresholds)
 */
export function makeNearVec(primary: number, noiseLevel: number = 0.3, dim: number = 8): number[] {
  const vec = new Array<number>(dim).fill(0.0);
  vec[primary % dim] = 1.0;
  vec[(primary + 1) % dim] = noiseLevel;
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  return vec.map(v => v / norm);
}

/**
 * Compute cosine similarity between two vectors (test utility).
 */
export function cosineSim(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}
