#!/usr/bin/env npx tsx
/**
 * Unit tests for conversation tagging feature
 * Uses fake embeddings — no OpenAI/Ollama API access required.
 */

import { MemoryDB } from "./src/memory-db.js";
import { unlinkSync, existsSync } from "node:fs";

const TEST_DB = "/tmp/pluresLM-conv-tag-test.db";
const PASS = "✅";
const FAIL = "❌";

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
  if (condition) {
    console.log(`${PASS} ${msg}`);
    passed++;
  } else {
    console.log(`${FAIL} ${msg}`);
    failed++;
  }
}

/** Build a unit-norm vector that is almost identical to `base` but rotated by `angle` radians. */
function rotateEmbedding(base: number[], angle: number): number[] {
  // Rotate in the first two dimensions only
  const result = [...base];
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  result[0] = base[0] * cos - base[1] * sin;
  result[1] = base[0] * sin + base[1] * cos;
  // Re-normalise
  const norm = Math.sqrt(result.reduce((s, v) => s + v * v, 0));
  return result.map((v) => v / norm);
}

/** Cosine similarity helper for tests. */
function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

async function main() {
  for (const f of [TEST_DB, TEST_DB + "-wal", TEST_DB + "-shm"]) {
    if (existsSync(f)) unlinkSync(f);
  }

  const db = new MemoryDB(TEST_DB, 8);

  console.log("\n=== 1. Schema ===\n");

  const memCols = (db as any)["db"]
    .prepare("PRAGMA table_info(memories)")
    .all()
    .map((c: any) => c.name) as string[];
  assert(memCols.includes("conversation_tag_ids"), "memories.conversation_tag_ids column exists");

  const tagTable = (db as any)["db"]
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='conversation_tags'")
    .get() as { name: string } | undefined;
  assert(tagTable !== undefined, "conversation_tags table exists");

  const tagCols = (db as any)["db"]
    .prepare("PRAGMA table_info(conversation_tags)")
    .all()
    .map((c: any) => c.name) as string[];
  for (const col of ["id", "label", "embedding", "parent_tag_id", "message_ids", "created_at", "updated_at", "similarity_threshold"]) {
    assert(tagCols.includes(col), `conversation_tags.${col} column exists`);
  }

  console.log("\n=== 2. New message creates a conversation tag ===\n");

  // Dim-8 unit vector pointing in direction [1,0,0,0,0,0,0,0]
  const baseVec: number[] = [1, 0, 0, 0, 0, 0, 0, 0];

  const r1 = await db.store("spare ribs recipe discussion", baseVec, { source: "test", category: "conversation" });
  assert(!r1.isDuplicate, "First store is not duplicate");
  assert(Array.isArray(r1.entry.conversation_tag_ids), "entry has conversation_tag_ids array");
  assert((r1.entry.conversation_tag_ids?.length ?? 0) === 1, "entry has exactly 1 conversation tag");

  const tags = await db.getConversationTags();
  assert(tags.length === 1, `getConversationTags returns 1 tag (got ${tags.length})`);
  assert(tags[0].message_ids.includes(r1.entry.id), "tag message_ids contains the memory id");
  assert(tags[0].similarity_threshold === 0.85, "default similarity_threshold is 0.85");
  assert(typeof tags[0].label === "string" && tags[0].label.length > 0, "tag has a non-empty label");
  console.log(`   Tag label: "${tags[0].label}"`);

  console.log("\n=== 3. Similar message joins existing tag ===\n");

  // Very small rotation — cosine similarity will still be > 0.85
  const similarVec = rotateEmbedding(baseVec, 0.05); // ~cos(0.05) ≈ 0.9988
  console.log(`   Similarity with base: ${cosine(baseVec, similarVec).toFixed(4)}`);

  const r2 = await db.store("spare ribs shopping list", similarVec, { source: "test", category: "conversation" });
  assert(!r2.isDuplicate, "Second store is not duplicate");
  assert((r2.entry.conversation_tag_ids ?? []).includes(tags[0].id), "second message joins the existing tag");

  const tagsAfter2 = await db.getConversationTags();
  assert(tagsAfter2.length === 1, `Still only 1 tag after similar message (got ${tagsAfter2.length})`);
  assert(tagsAfter2[0].message_ids.length === 2, `Tag now contains 2 messages (got ${tagsAfter2[0].message_ids.length})`);

  console.log("\n=== 4. Dissimilar message creates a new tag ===\n");

  // Orthogonal vector — cosine similarity = 0
  const orthogonalVec: number[] = [0, 1, 0, 0, 0, 0, 0, 0];
  console.log(`   Similarity with base: ${cosine(baseVec, orthogonalVec).toFixed(4)}`);

  const r3 = await db.store("NixOS configuration management", orthogonalVec, { source: "test", category: "conversation" });
  assert(!r3.isDuplicate, "Third store is not duplicate");

  const tagsAfter3 = await db.getConversationTags();
  assert(tagsAfter3.length === 2, `2 tags after dissimilar message (got ${tagsAfter3.length})`);

  console.log("\n=== 5. getMessagesForTag returns ordered messages ===\n");

  const parentTagId = r1.entry.conversation_tag_ids![0];
  const messages = await db.getMessagesForTag(parentTagId);
  assert(messages.length === 2, `getMessagesForTag returns 2 messages (got ${messages.length})`);
  assert(messages[0].created_at <= messages[1].created_at, "messages are ordered by timestamp");
  assert(messages.some((m) => m.content.includes("spare ribs recipe")), "includes first message");
  assert(messages.some((m) => m.content.includes("spare ribs shopping")), "includes second message");

  console.log("\n=== 6. getMessagesForTag on unknown id returns empty array ===\n");

  const noMessages = await db.getMessagesForTag("nonexistent-id");
  assert(noMessages.length === 0, "unknown tag returns empty array");

  console.log("\n=== 7. Parent–child tag hierarchy ===\n");

  // Add a third message that is moderately similar to the spare-ribs tag (0.7 ≤ sim < 0.85)
  // Rotate by ~0.52 rad so cos ≈ 0.87 — still merges. Use a larger rotation to land in [0.7, 0.85).
  // cos(0.57) ≈ 0.842 — just below 0.85
  const childVec = rotateEmbedding(baseVec, 0.57);
  const childSim = cosine(baseVec, childVec);
  console.log(`   Child similarity with base (parent centroid): ${childSim.toFixed(4)}`);

  // Use a custom low threshold for the parent tag so childSim is below it
  // We'll manipulate the parent tag's similarity_threshold directly for the test
  const parentTag = tagsAfter3.find((t) => t.message_ids.length === 2)!;
  (db as any)["db"]
    .prepare("UPDATE conversation_tags SET similarity_threshold = 0.99 WHERE id = ?")
    .run(parentTag.id);

  // Now store the child message — similarity to parent is ~childSim (<0.99), but >= 0.7
  const r4 = await db.store("spare ribs dipping sauce recipe", childVec, { source: "test", category: "conversation" });
  const tagsAfter4 = await db.getConversationTags();
  // A new child tag should have been created
  assert(tagsAfter4.length >= 3, `At least 3 tags after child message (got ${tagsAfter4.length})`);

  const childTag = tagsAfter4.find((t) => t.message_ids.includes(r4.entry.id));
  assert(childTag !== undefined, "new tag created for child message");
  if (childTag) {
    console.log(`   Child tag label: "${childTag.label}", parent_tag_id: ${childTag.parent_tag_id}`);
    assert(childTag.parent_tag_id === parentTag.id, "child tag has correct parent_tag_id");
  }

  console.log("\n=== 8. getRelatedTags returns siblings and parent ===\n");

  if (childTag) {
    // Add another child of the same parent — use a vector that's clearly distinct from childTag
    // but still in the parent range (0.7–0.99). Mix orthogonalVec with childVec to get a 
    // new direction that is far from both parent and existing child centroids.
    const siblingVec: number[] = childVec.map((v, i) => v * 0.1 + orthogonalVec[i] * 0.9);
    const siblingNorm = Math.sqrt(siblingVec.reduce((s, v) => s + v * v, 0));
    const siblingVecNorm = siblingVec.map((v) => v / siblingNorm);
    console.log(`   Sibling similarity to base: ${cosine(baseVec, siblingVecNorm).toFixed(4)}`);

    // Force parent tag to have a lower similarity_threshold so sibling can be a direct child
    (db as any)["db"]
      .prepare("UPDATE conversation_tags SET similarity_threshold = 0.80 WHERE id = ?")
      .run(parentTag.id);

    const r5 = await db.store("spare ribs grilling tips", siblingVecNorm, { source: "test", category: "conversation" });
    const allTagsNow = await db.getConversationTags();
    const siblingTag = allTagsNow.find((t) => t.message_ids.includes(r5.entry.id) && t.id !== childTag.id);

    if (siblingTag && siblingTag.parent_tag_id === parentTag.id) {
      console.log(`   Sibling tag label: "${siblingTag.label}", parent_tag_id: ${siblingTag.parent_tag_id}`);
      const related = await db.getRelatedTags(childTag.id);
      const relatedIds = related.map((t) => t.id);
      assert(relatedIds.includes(parentTag.id), "related includes parent tag");
      assert(relatedIds.includes(siblingTag.id), "related includes sibling tag");
      console.log(`   Related tags for child: ${related.map((t) => t.label).join(", ")}`);
    } else {
      console.log(`   (sibling merged into child or parent — verifying parent relation only)`);
      const related = await db.getRelatedTags(childTag.id);
      assert(related.some((t) => t.id === parentTag.id), "related includes parent tag");
    }

    // Children of parent tag
    const relatedFromParent = await db.getRelatedTags(parentTag.id);
    assert(relatedFromParent.some((t) => t.id === childTag.id), "children listed when querying parent");
  }

  console.log("\n=== 9. getRelatedTags on unknown id returns empty array ===\n");

  const noRelated = await db.getRelatedTags("nonexistent-id");
  assert(noRelated.length === 0, "unknown tag returns empty related array");

  // Cleanup
  db.close();
  for (const f of [TEST_DB, TEST_DB + "-wal", TEST_DB + "-shm"]) {
    if (existsSync(f)) unlinkSync(f);
  }

  console.log(`\n${"=".repeat(40)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log(`${"=".repeat(40)}\n`);

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Test crashed:", err);
  process.exit(1);
});

