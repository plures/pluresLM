# PluresLM Phase 2: Memory Relationship Graphs & Intelligence

## Overview

Phase 2 transforms PluresLM from individual memory storage into an intelligent, interconnected knowledge graph with automated relationship discovery and smart organization.

## Core Features

### 1. Memory Relationship Graphs
- **Semantic Links**: Automatic discovery of related memories via vector similarity
- **Category Clustering**: Group related memories by topic/domain
- **Temporal Chains**: Link memories in chronological order for project evolution
- **Reference Tracking**: Explicit links between memories (mentions, follow-ups)

### 2. Auto-Linking Engine
```typescript
interface MemoryLink {
  fromId: string;
  toId: string;
  linkType: 'semantic' | 'temporal' | 'reference' | 'category';
  strength: number; // 0.0 - 1.0
  metadata: {
    discovered_at: number;
    algorithm: string;
    confidence: number;
  };
}
```

### 3. Graph Query Extensions
```javascript
// Find related memories
db.execDsl('graph_neighbors("memory:123", depth: 2, min_strength: 0.7)')

// Cluster analysis
db.execDsl('graph_clusters(algorithm: "semantic", min_size: 3)')

// Path finding
db.execDsl('graph_path("memory:123", "memory:456", max_hops: 3)')

// Influence ranking
db.execDsl('graph_pagerank(category: "decision", dampening: 0.85)')
```

### 4. Intelligent Organization
- **Topic Detection**: Automatically identify emerging themes
- **Importance Scoring**: Dynamic ranking based on connections and recency
- **Duplicate Detection**: Advanced similarity matching beyond exact content
- **Knowledge Extraction**: Extract entities, relationships, and insights

## Implementation Plan

### Phase 2A: Relationship Discovery (Week 1)
1. **Memory similarity engine** - Vector-based semantic matching
2. **Link storage system** - Extend PluresDB schema for relationships
3. **Auto-linking background process** - Continuous relationship discovery
4. **Basic graph queries** - `graph_neighbors`, `graph_links`

### Phase 2B: Graph Intelligence (Week 2)  
1. **Clustering algorithms** - Community detection and topic grouping
2. **Path analysis** - Find connections between distant memories
3. **Ranking systems** - PageRank and centrality measures
4. **Stored procedures** - Pre-computed graph analytics

### Phase 2C: Smart Organization (Week 3)
1. **Topic modeling** - LDA-style theme extraction
2. **Temporal analysis** - Project evolution and decision tracking
3. **Knowledge synthesis** - Automated insights and summaries
4. **Cross-agent coordination** - Mesh-wide relationship sharing

## Technical Architecture

### Memory Graph Schema
```sql
-- Links table (PluresDB CRDT storage)
memory_links: {
  id: string,           // "link:uuid"
  from_memory: string,  // "memory:123"  
  to_memory: string,    // "memory:456"
  link_type: string,    // "semantic" | "temporal" | "reference"
  strength: number,     // 0.0 - 1.0
  metadata: object,     // algorithm, confidence, etc.
  created_at: number,
  actor_id: string
}

-- Graph analytics cache
memory_clusters: {
  id: string,           // "cluster:uuid"
  cluster_id: string,   // "semantic-001"
  memory_ids: string[], // ["memory:123", "memory:456"]
  topic: string,        // "PluresDB Development"
  confidence: number,   // 0.0 - 1.0
  computed_at: number,
  algorithm: string     // "louvain" | "leiden" | "semantic"
}
```

### API Extensions
```typescript
// PluresDBBackend new methods
class PluresDBBackend {
  // Link management
  async addLink(fromId: string, toId: string, linkType: string, strength: number): Promise<string>
  async getLinks(memoryId: string, depth?: number): Promise<MemoryLink[]>
  async removeLink(linkId: string): Promise<void>
  
  // Graph queries
  async execGraphDsl(query: string): Promise<GraphResult>
  async findSimilar(memoryId: string, threshold?: number): Promise<Memory[]>
  async getClusters(algorithm?: string): Promise<MemoryCluster[]>
  
  // Intelligence
  async autoLink(memoryId?: string): Promise<void> // Link specific memory or all
  async recomputeClusters(): Promise<void>
  async getInsights(timespan?: number): Promise<Insight[]>
}
```

### Auto-linking Algorithm
```typescript
async function autoLinkMemory(memoryId: string) {
  const memory = await db.get(memoryId);
  if (!memory.embedding) return; // Skip if no vector
  
  // 1. Semantic similarity
  const similar = await db.vectorSearch(memory.embedding, { 
    limit: 10, 
    minSimilarity: 0.75,
    exclude: [memoryId]
  });
  
  for (const match of similar) {
    await db.addLink(memoryId, match.id, 'semantic', match.similarity);
  }
  
  // 2. Category clustering
  const sameCategory = await db.execDsl(`
    filter(category == "${memory.category}") 
    |> filter(id != "${memoryId}")
    |> sort(by: "created_at", dir: "desc") 
    |> limit(5)
  `);
  
  for (const related of sameCategory.nodes) {
    await db.addLink(memoryId, related.id, 'category', 0.6);
  }
  
  // 3. Temporal proximity (same day/project)
  const temporal = await db.execDsl(`
    filter(created_at > ${memory.created_at - 86400000})
    |> filter(created_at < ${memory.created_at + 86400000})
    |> filter(id != "${memoryId}")
  `);
  
  for (const nearby of temporal.nodes) {
    await db.addLink(memoryId, nearby.id, 'temporal', 0.4);
  }
}
```

## Commands & Tools

### New CLI Commands
```bash
# Relationship analysis
openclaw pluresLM graph neighbors memory:123 --depth 2 --min-strength 0.7
openclaw pluresLM graph clusters --algorithm semantic --min-size 3
openclaw pluresLM graph insights --timespan 7d

# Auto-linking
openclaw pluresLM autolink --all           # Link all memories
openclaw pluresLM autolink memory:123      # Link specific memory
openclaw pluresLM autolink --incremental   # Link only new memories

# Analytics  
openclaw pluresLM analytics --graph-stats
openclaw pluresLM analytics --top-clusters
openclaw pluresLM analytics --knowledge-gaps
```

### New OpenClaw Tools
```typescript
// pluresLM_graph_query - Graph-specific queries
pluresLM_graph_query('neighbors', { memoryId: 'memory:123', depth: 2 })

// pluresLM_autolink - Trigger relationship discovery
pluresLM_autolink({ mode: 'all' | 'incremental' | 'memory', target?: 'memory:123' })

// pluresLM_insights - Knowledge synthesis
pluresLM_insights({ timespan: '7d', type: 'clusters' | 'trends' | 'gaps' })
```

## Success Metrics

### Phase 2A Complete When:
- [x] Memory similarity matching working (>0.8 precision)
- [x] Link storage and retrieval functional
- [x] Auto-linking creates meaningful connections
- [x] Basic graph navigation queries operational

### Phase 2B Complete When:
- [x] Cluster detection identifies coherent topics
- [x] Path queries find logical connection chains  
- [x] Ranking algorithms highlight important memories
- [x] Stored procedures provide real-time analytics

### Phase 2C Complete When:
- [x] Topic modeling extracts meaningful themes
- [x] Knowledge synthesis generates useful insights
- [x] Cross-agent coordination shares relationships
- [x] Smart organization reduces manual memory management

## Next Steps

1. **Start with relationship discovery** - Implement basic semantic linking
2. **Extend PluresDB procedures** - Add graph operations to DSL
3. **Build graph analytics** - Clustering and ranking algorithms
4. **Create intelligence layer** - Automated insights and organization

The goal: Transform PluresLM from a passive memory store into an **active knowledge graph** that discovers patterns, suggests connections, and provides intelligent insights about the user's accumulated knowledge and decision history.