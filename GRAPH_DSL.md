# Graph Operations for PluresDB Procedures DSL

## New Operations for Phase 2

### graph_neighbors
Find related memories within N hops of a target memory.

**Syntax:**
```
graph_neighbors(memory_id, depth: number, min_strength?: number, link_types?: string[])
```

**Examples:**
```javascript
// Find direct neighbors
db.execDsl('graph_neighbors("memory:123", depth: 1)')

// Find neighbors within 2 hops, minimum strength 0.7
db.execDsl('graph_neighbors("memory:123", depth: 2, min_strength: 0.7)')

// Only semantic and category links
db.execDsl('graph_neighbors("memory:123", depth: 1, link_types: ["semantic", "category"])')
```

### graph_links
Query the link graph directly.

**Syntax:**
```
graph_links(from?: string, to?: string, link_type?: string, min_strength?: number)
```

**Examples:**
```javascript
// All links from a memory
db.execDsl('graph_links(from: "memory:123")')

// All semantic links above threshold
db.execDsl('graph_links(link_type: "semantic", min_strength: 0.8)')

// Bidirectional links between two memories
db.execDsl('graph_links(from: "memory:123", to: "memory:456")')
```

### graph_clusters
Perform clustering analysis on the memory graph.

**Syntax:**
```
graph_clusters(algorithm: string, min_size?: number, min_strength?: number)
```

**Examples:**
```javascript
// Semantic clustering
db.execDsl('graph_clusters(algorithm: "semantic", min_size: 3)')

// Community detection
db.execDsl('graph_clusters(algorithm: "louvain", min_size: 5, min_strength: 0.6)')
```

### graph_path
Find paths between two memories.

**Syntax:**
```
graph_path(from: string, to: string, max_hops?: number, algorithm?: string)
```

**Examples:**
```javascript
// Shortest path
db.execDsl('graph_path(from: "memory:123", to: "memory:456", max_hops: 5)')

// Weighted shortest path
db.execDsl('graph_path(from: "memory:123", to: "memory:456", algorithm: "dijkstra")')
```

### graph_pagerank
Rank memories by importance in the graph.

**Syntax:**
```
graph_pagerank(dampening?: number, iterations?: number, min_strength?: number)
```

**Examples:**
```javascript
// Basic PageRank
db.execDsl('graph_pagerank()')

// Custom dampening factor
db.execDsl('graph_pagerank(dampening: 0.85, iterations: 100)')
```

### auto_link
Automatically discover and create links for memories.

**Syntax:**
```
auto_link(memory_id?: string, algorithms?: string[], thresholds?: object)
```

**Examples:**
```javascript
// Link specific memory
db.execDsl('auto_link("memory:123")')

// Link all unlinked memories
db.execDsl('auto_link()')

// Custom algorithms and thresholds
db.execDsl('auto_link(algorithms: ["semantic", "category"], thresholds: {semantic: 0.8, category: 0.6})')
```

## Implementation Notes

### Link Storage
Links are stored as CRDT nodes with the prefix `link:` and special fields:
```typescript
interface MemoryLink {
  id: string;           // "link:uuid"
  from_memory: string;  // "memory:123"
  to_memory: string;    // "memory:456"  
  link_type: 'semantic' | 'temporal' | 'reference' | 'category';
  strength: number;     // 0.0 - 1.0
  metadata: {
    algorithm: string;
    confidence: number;
    discovered_at: number;
  };
  created_at: number;
  actor_id: string;
}
```

### Graph Traversal
Graph operations traverse the link network, respecting:
- **Directionality**: Links can be directional or bidirectional
- **Strength filtering**: Only include links above threshold
- **Type filtering**: Limit to specific relationship types
- **Hop limits**: Prevent infinite traversal

### Clustering Algorithms
- **Semantic**: Group by vector similarity
- **Louvain**: Community detection algorithm
- **Leiden**: Improved community detection
- **Category**: Group by explicit categories
- **Temporal**: Group by time proximity

### Performance Considerations
- Graph operations use indices on `from_memory`, `to_memory`, and `link_type`
- Results are cached for frequently accessed subgraphs
- Large graphs (>10k memories) may need pagination
- Background processes incrementally update link networks

## Integration with Existing DSL

Graph operations can be combined with existing filters and operations:

```javascript
// Find neighbors of recent decisions
db.execDsl(`
  filter(category == "decision") 
  |> filter(created_at > ${Date.now() - 30*24*60*60*1000})
  |> graph_neighbors(depth: 2, min_strength: 0.7)
`)

// Rank memories in a category
db.execDsl(`
  filter(category == "project-context")
  |> graph_pagerank(dampening: 0.8)
  |> sort(by: "pagerank_score", dir: "desc")
  |> limit(10)
`)

// Cluster and analyze
db.execDsl(`
  graph_clusters(algorithm: "semantic", min_size: 4)
  |> project(["cluster_id", "topic", "memory_count"])
  |> sort(by: "memory_count", dir: "desc")
`)
```

This extends the procedures DSL with powerful graph analytics while maintaining composability with existing operations.