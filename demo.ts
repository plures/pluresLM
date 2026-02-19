import { MemoryDB } from "./src/memory-db.js";
import { DualEmbeddings } from "./src/embeddings.js";

async function demo() {
  const db = new MemoryDB("/home/kbristol/.openclaw/pluresLM.db", 1536);
  const emb = new DualEmbeddings({ openaiKey: process.env.OPENAI_API_KEY, dimension: 1536 });

  console.log("\n🧠 === SUPERLOCALMEMORY DEMO ===\n");

  // 1. Store memories
  console.log("📝 STORING MEMORIES...\n");
  const memories = [
    { text: "Paradox prefers using internal plures tools over external dependencies", category: "preference", tags: ["plures"] },
    { text: "OASIS is a privacy-preserving decentralized commerce system using PluresDB and Praxis", category: "project", tags: ["oasis", "pluresdb", "praxis"] },
    { text: "PluresDB npm package requires server process - native N-API bindings needed for embedded use", category: "decision", tags: ["pluresdb", "tech:rust"] },
    { text: "Replaced GUN with PluresDB as the sole data/sync layer in OASIS", category: "decision", tags: ["oasis", "pluresdb"] },
    { text: "Replaced state machines with Praxis logic engine (facts/events/rules) in OASIS", category: "decision", tags: ["oasis", "praxis"] },
    { text: "AI model routing: Opus for main session and judgment, GPT for automation sweeps, Gemini for summarization and triage", category: "decision", tags: ["infrastructure"] },
    { text: "Superlocalmemory plugin uses better-sqlite3 for embedded storage until PluresDB supports pure embedded mode", category: "project", tags: ["pluresLM", "pluresdb"] },
    { text: "Kayode Bristol TSA PreCheck expires June 2026, reminder set for May 1", category: "entity", tags: ["personal", "travel"] },
  ];

  let stored = 0;
  for (const m of memories) {
    const vec = await emb.embed(m.text);
    const r = await db.store(m.text, vec, { source: "demo", tags: m.tags, category: m.category, dedupeThreshold: 0.95 });
    if (!r.isDuplicate) {
      console.log(`  ✅ [${m.category}] ${m.text.slice(0, 70)}...`);
      stored++;
    } else {
      console.log(`  🔄 (deduped) ${m.text.slice(0, 70)}...`);
    }
  }
  console.log(`\n  Stored ${stored} new memories\n`);

  // 2. Graph edges
  console.log("🔗 CREATING GRAPH EDGES...\n");
  const oasis = (await db.vectorSearch(await emb.embed("OASIS privacy commerce"), 1, 0.3))[0];
  const pluresdb = (await db.vectorSearch(await emb.embed("PluresDB embedded native"), 1, 0.3))[0];
  const praxis = (await db.vectorSearch(await emb.embed("Praxis logic engine facts"), 1, 0.3))[0];

  if (oasis && pluresdb) {
    db.addEdge(oasis.entry.id, pluresdb.entry.id, "depends-on");
    console.log(`  OASIS → depends-on → PluresDB`);
  }
  if (oasis && praxis) {
    db.addEdge(oasis.entry.id, praxis.entry.id, "depends-on");
    console.log(`  OASIS → depends-on → Praxis`);
  }

  // 3. Semantic search
  console.log("\n\n🔍 SEMANTIC SEARCH: 'What database does OASIS use?'\n");
  const q1 = await db.vectorSearch(await emb.embed("What database does OASIS use?"), 3, 0.3);
  for (const r of q1) {
    console.log(`  ${(r.score * 100).toFixed(1)}% [${r.entry.category}] ${r.entry.content}`);
  }

  console.log("\n🔍 SEMANTIC SEARCH: 'travel documents expiring'\n");
  const q2 = await db.vectorSearch(await emb.embed("travel documents expiring"), 3, 0.3);
  for (const r of q2) {
    console.log(`  ${(r.score * 100).toFixed(1)}% [${r.entry.category}] ${r.entry.content}`);
  }

  console.log("\n🔍 SEMANTIC SEARCH: 'which AI model for what task'\n");
  const q3 = await db.vectorSearch(await emb.embed("which AI model for what task"), 3, 0.3);
  for (const r of q3) {
    console.log(`  ${(r.score * 100).toFixed(1)}% [${r.entry.category}] ${r.entry.content}`);
  }

  // 4. Graph traversal
  console.log("\n\n🕸️  GRAPH: What's related to OASIS?\n");
  if (oasis) {
    const related = db.getRelated(oasis.entry.id);
    for (const r of related) {
      console.log(`  → ${r.content}`);
    }
  }

  // 5. Dedup demo
  console.log("\n\n🔄 DEDUP TEST: storing same content again...\n");
  const dupVec = await emb.embed("OASIS is a privacy-preserving decentralized commerce system using PluresDB and Praxis");
  const dupResult = await db.store("OASIS is a privacy-preserving decentralized commerce system using PluresDB and Praxis", dupVec, {
    source: "demo", category: "project", dedupeThreshold: 0.95,
  });
  console.log(`  isDuplicate: ${dupResult.isDuplicate} ${dupResult.isDuplicate ? "✅ (updated existing, no bloat)" : "❌"}`);

  // 6. Stats
  console.log("\n\n📊 STATS\n");
  const stats = db.stats();
  console.log(`  Total memories: ${stats.totalMemories}`);
  console.log(`  Categories: ${JSON.stringify(stats.categories)}`);
  console.log(`  Graph edges: ${stats.edgeCount}`);

  // 7. Profile
  console.log("\n\n👤 PROFILE\n");
  db.setProfile({
    summary: `Active developer working on plures ecosystem. Key projects: OASIS (privacy commerce), PluresDB (graph DB), Praxis (logic engine). Prefers internal tools, automation-first approach. Uses 3 AI providers: Anthropic (Opus), OpenAI (GPT), Google (Gemini).`,
    facts: [
      "Prefers internal plures tools over external deps",
      "Automation-first: fresh env → run → success",
      "Uses Opus for reasoning, GPT for automation, Gemini for summarization",
      "Building OASIS privacy-preserving commerce system",
      "TSA PreCheck expires June 2026",
    ],
    updated_at: Date.now(),
    capture_count: stats.totalMemories,
  });
  const profile = db.getProfile();
  console.log(`  ${profile!.summary}`);
  console.log(`\n  Key facts:`);
  for (const f of profile!.facts) console.log(`  • ${f}`);

  console.log("\n🧠 === DEMO COMPLETE ===\n");
  db.close();
}

demo().catch(console.error);
