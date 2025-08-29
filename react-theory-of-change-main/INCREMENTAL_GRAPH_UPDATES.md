# Graph API System
## RESTful Communication Between Chat and Graph Components

### Current Problem
The existing system has significant token inefficiency issues:

1. **Chat → LLM**: Every user message appends the complete graph JSON (lines 130-132 in `chatService.ts`)
2. **LLM → Chat**: Responses include complete updated graph JSON in delimited blocks
3. **Token Waste**: Large graphs result in thousands of tokens per message for redundant data
4. **Scale Issues**: System becomes prohibitively expensive with complex graphs

### Proposed Solution: RESTful Graph API

Transform the graph communication into a RESTful API pattern using standard HTTP methods (GET, POST, PUT, DELETE) to manipulate graph resources efficiently.

---

## Graph API Resources

### 1. Node Resource
```typescript
interface NodeResource {
  id: string;
  title: string;
  text: string;
  connections: Connection[];
  yPosition: number;
  width: number;
  color: string;
  sectionIndex: number;
  columnIndex: number;
}

interface Connection {
  targetId: string;
  confidence: number;
  evidence: string;
  assumptions: string;
}
```

### 2. API Operation Types
```typescript
interface GraphApiOperation {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  resource: 'node' | 'connection' | 'section' | 'graph';
  id?: string;           // Resource identifier
  data?: any;           // Payload for POST/PUT/PATCH operations
  query?: string;       // Query parameters for filtering
}

interface GraphApiResponse {
  operations: GraphApiOperation[];
  success: boolean;
  message?: string;
}
```

---

## API Implementation Strategy

### Phase 1: Chat → LLM Communication (Request Format)

**Current (Inefficient)**:
```typescript
// chatService.ts:130-132
content += `\n\n[CURRENT_GRAPH_JSON]\n${JSON.stringify(currentGraphData, null, 2)}\n[/CURRENT_GRAPH_JSON]`;
```

**New (API-Efficient)**:
```typescript
// Only send recent changes as API operations
const recentOperations = getRecentApiOperations(lastSyncId);
content += `\n\n[GRAPH_API_STATE]\n${JSON.stringify({
  lastSyncId: lastSyncId,
  recentOperations: recentOperations,
  graphSummary: getGraphSummary() // Lightweight structure overview
}, null, 2)}\n[/GRAPH_API_STATE]`;
```

### Phase 2: LLM → Chat Communication (Response Format)

**Current (Inefficient)**:
```
[UPDATED_GRAPH_JSON]
{entire graph with thousands of lines}
[/UPDATED_GRAPH_JSON]
```

**New (API-Efficient)**:
```
[GRAPH_API_OPERATIONS]
[
  {
    "method": "PATCH",
    "resource": "node",
    "id": "node_123",
    "data": {"title": "Updated Title"}
  },
  {
    "method": "POST",
    "resource": "node",
    "data": {
      "id": "node_124",
      "title": "New Node",
      "text": "Node description",
      "sectionIndex": 1,
      "columnIndex": 0
    }
  },
  {
    "method": "DELETE",
    "resource": "node",
    "id": "node_125"
  },
  {
    "method": "PATCH",
    "resource": "connection",
    "id": "conn_456",
    "data": {
      "confidence": 90,
      "evidence": "Updated evidence"
    }
  },
  {
    "method": "PUT",
    "resource": "node",
    "id": "node_126",
    "data": {
      "title": "Completely Replaced Node",
      "text": "All properties replaced",
      "connections": [],
      "yPosition": 100,
      "width": 200,
      "color": "#blue"
    }
  }
]
[/GRAPH_API_OPERATIONS]
```

### Phase 3: API Operation Handler System

#### User Interactions → API Operations Log
Every graph manipulation creates an API operation entry:

```typescript
// In graph interaction handlers
const logApiOperation = (method: 'POST' | 'PUT' | 'DELETE', resource: string, id?: string, data?: any) => {
  const operation: GraphApiOperation = {
    method,
    resource,
    id,
    data,
    timestamp: new Date(),
    syncId: generateSyncId()
  };
  
  // Add to persistent operation log
  apiOperationHistory.addOperation(operation);
};

// Usage examples:
// Node creation
logApiOperation('POST', 'node', undefined, { title: 'New Node', text: '...', sectionIndex: 1 });

// Partial node update (only changed fields)
logApiOperation('PATCH', 'node', 'node_123', { title: 'Updated Title' });

// Complete node replacement
logApiOperation('PUT', 'node', 'node_123', { title: 'New Title', text: 'New text', connections: [], yPosition: 100 });

// Node deletion
logApiOperation('DELETE', 'node', 'node_123');

// Connection creation
logApiOperation('POST', 'connection', undefined, { sourceId: 'node_1', targetId: 'node_2' });

// Partial connection update
logApiOperation('PATCH', 'connection', 'conn_456', { confidence: 95 });
```

#### API Operation Processor
```typescript
const applyApiOperations = (currentGraph: ToCData, operations: GraphApiOperation[]): ToCData => {
  let newGraph = { ...currentGraph };
  
  operations.forEach(operation => {
    switch (operation.method) {
      case 'POST':
        newGraph = handlePostOperation(newGraph, operation);
        break;
      case 'PUT':
        newGraph = handlePutOperation(newGraph, operation);
        break;
      case 'PATCH':
        newGraph = handlePatchOperation(newGraph, operation);
        break;
      case 'DELETE':
        newGraph = handleDeleteOperation(newGraph, operation);
        break;
      case 'GET':
        // GET operations are queries, not mutations
        break;
    }
  });
  
  return newGraph;
};

const handlePostOperation = (graph: ToCData, operation: GraphApiOperation): ToCData => {
  switch (operation.resource) {
    case 'node':
      return addNodeToGraph(graph, operation.data);
    case 'connection':
      return addConnectionToGraph(graph, operation.data);
    case 'section':
      return addSectionToGraph(graph, operation.data);
    default:
      return graph;
  }
};

const handlePutOperation = (graph: ToCData, operation: GraphApiOperation): ToCData => {
  switch (operation.resource) {
    case 'node':
      return replaceNodeInGraph(graph, operation.id!, operation.data); // Complete replacement
    case 'connection':
      return replaceConnectionInGraph(graph, operation.id!, operation.data);
    default:
      return graph;
  }
};

const handlePatchOperation = (graph: ToCData, operation: GraphApiOperation): ToCData => {
  switch (operation.resource) {
    case 'node':
      return patchNodeInGraph(graph, operation.id!, operation.data); // Partial update
    case 'connection':
      return patchConnectionInGraph(graph, operation.id!, operation.data);
    default:
      return graph;
  }
};

const handleDeleteOperation = (graph: ToCData, operation: GraphApiOperation): ToCData => {
  switch (operation.resource) {
    case 'node':
      return removeNodeFromGraph(graph, operation.id!);
    case 'connection':
      return removeConnectionFromGraph(graph, operation.id!);
    default:
      return graph;
  }
};
```

---

## API Implementation Roadmap

### Step 1: Update Type Definitions
- Add `GraphApiOperation`, `GraphApiResponse`, `NodeResource` interfaces
- Extend existing interfaces to support API operation tracking
- Define resource types for nodes, connections, sections, and graph

### Step 2: Create API Operation Management Service
```typescript
class GraphApiService {
  private operations: GraphApiOperation[] = [];
  private lastSyncId: string | null = null;
  
  // CRUD Operations
  createNode(data: NodeResource): string;
  updateNode(id: string, data: Partial<NodeResource>): boolean;
  deleteNode(id: string): boolean;
  getNode(id: string): NodeResource | null;
  
  // Connection Operations
  createConnection(sourceId: string, targetId: string, data: Connection): string;
  updateConnection(id: string, data: Partial<Connection>): boolean;
  deleteConnection(id: string): boolean;
  
  // Operation History
  addOperation(operation: GraphApiOperation): void;
  getRecentOperations(sinceSyncId?: string): GraphApiOperation[];
  markOperationsSynced(syncId: string): void;
  
  // Graph State
  getGraphSummary(): GraphSummary;
  applyOperations(operations: GraphApiOperation[]): ToCData;
}
```

### Step 3: Modify Chat Service API Communication
- Replace full graph serialization with API operation history
- Update parser to handle `[GRAPH_API_OPERATIONS]` instead of `[UPDATED_GRAPH_JSON]`
- Implement REST-like operation application logic
- Add lightweight graph summary for context

### Step 4: Update System Prompt for API Operations
Modify LLM instructions to:
- Understand API operation-based input format
- Respond with REST-style operations (GET/POST/PUT/PATCH/DELETE)
- Use proper HTTP semantics:
  - **POST**: Create new resources
  - **PUT**: Complete resource replacement
  - **PATCH**: Partial resource updates (most common for graph edits)
  - **DELETE**: Remove resources
  - **GET**: Query resources (for analysis)
- Maintain resource relationships and referential integrity

### Step 5: Add API Operation Tracking to Graph Components  
- Instrument all user interaction handlers (drag, edit, delete, create)
- Log operations with proper HTTP methods and resource types
- Implement operation batching for performance

### Step 6: Add Query Capabilities (GET Operations)
- Support filtering nodes by section, column, or properties
- Enable search operations across graph content
- Provide graph analytics and statistics via GET requests

---

## API System Benefits

### Token Reduction
- **Before**: 5,000+ tokens per message for large graphs
- **After**: 50-200 tokens per message (95%+ reduction)
- **Method**: Send only API operations instead of full graph state

### RESTful Architecture Benefits
- **Familiar Patterns**: Developers understand GET/POST/PUT/DELETE semantics
- **Cacheable**: GET operations can be cached for performance
- **Stateless**: Each operation is self-contained and independent
- **Scalable**: Standard HTTP methods scale with any graph size

### Performance Improvement
- Faster API responses due to smaller payloads
- Reduced parsing and serialization overhead
- Lower memory usage in browser
- Batch operations for efficiency

### Developer Experience
- **Intuitive**: REST API patterns are universally understood
- **Debuggable**: Each operation is explicit and traceable
- **Testable**: Individual operations can be unit tested
- **Extensible**: Easy to add new resource types and operations

### Future-Ready Architecture
- Enables real-time collaborative editing with WebSocket integration
- Supports graph analytics through GET queries
- Ready for microservice architecture if needed
- Compatible with GraphQL as a query layer

---

## API Migration Strategy

1. **Implement in parallel**: Keep existing system while building new API layer
2. **Feature flag**: Allow switching between full-graph/API modes via environment variable
3. **Gradual rollout**: Start with simple operations (POST node, PUT node, DELETE node)
4. **Fallback mechanism**: Revert to full graph mode if API operation parsing fails
5. **Complete transition**: Remove old system once API system is stable and tested

---

## API Technical Considerations

### Operation Conflict Resolution
- Use timestamps to order conflicting operations
- Implement last-write-wins for simplicity
- HTTP status codes: 409 Conflict for competing operations
- Future: Add optimistic concurrency control with ETags

### Resource Management
- Periodic cleanup of old operations (keep last N operations per sync)
- Compact operation history by merging sequential updates to same resource
- Implement operation expiry based on age and graph state

### Error Handling & HTTP Semantics
- **400 Bad Request**: Invalid operation format or missing required fields
- **404 Not Found**: Resource ID doesn't exist (for PUT/DELETE operations)
- **409 Conflict**: Operation conflicts with current graph state
- **422 Unprocessable Entity**: Valid format but business rule violations
- Graceful degradation when API operations fail
- Automatic fallback to full graph refresh on persistent failures

### Testing Strategy
- Unit tests for each HTTP method handler (GET/POST/PUT/DELETE)
- Integration tests for chat service API communication
- Performance benchmarks comparing token usage before/after
- End-to-end tests for complete API operation flows
- Load testing with high-frequency operations

### API Validation & Security
- Validate all resource IDs and references exist
- Sanitize user input in node titles and text content
- Rate limiting for operation frequency
- Schema validation for operation payloads

### Monitoring & Observability
- Log all API operations with timestamps and sync IDs
- Track token usage reduction metrics
- Monitor operation success/failure rates
- Performance metrics for operation processing time