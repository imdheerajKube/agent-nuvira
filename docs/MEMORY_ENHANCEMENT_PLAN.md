# Memory Enhancement Plan — Agent-Nuvira

**Author:** Dheeraj Sharma <imdheeraj@gmail.com>  
**Date:** August 22, 2026  
**Status:** Analysis Complete — Awaiting Approval

---

## Executive Summary

Agent-Nuvira has a **functional but incomplete** memory system compared to Hermes. The core architecture is sound (pluggable providers, FAISS integration, trajectory storage), but lacks **enterprise-grade durability, dedicated tools, and background sync**.

### Current State

| Component | Our Status | Hermes Status | Gap |
|-----------|------------|---------------|-----|
| **Vector Store** | ✅ FAISS (optional) | ✅ FAISS | PARITY |
| **Fact Extraction** | ✅ Rules + LLM | ✅ Rules + LLM | PARITY |
| **Trajectory Store** | ✅ Session history | ✅ Session history | PARITY |
| **Pluggable Backend** | ✅ Provider interface | ✅ Plugin architecture | PARITY |
| **Memory Manager** | ✅ Orchestration | ✅ Full orchestration | PARITY |
| **Dedicated Tools** | ❌ No | ✅ add/search/delete | **CRITICAL GAP** |
| **Background Sync** | ❌ No | ✅ Daemon threads | **HIGH GAP** |
| **Enterprise Durability** | ⚠️ JSON files | ✅ SQLite | **MEDIUM GAP** |
| **Cross-Session Persistence** | ⚠️ Basic | ✅ Full | **MEDIUM GAP** |
| **Memory CLI** | ❌ No | ✅ User-facing CLI | **LOW GAP** |

### Recommendation

**Implement a 4-phase enhancement plan** to close all gaps and achieve memory parity with Hermes.

---

## Phase 1: Dedicated Memory Tools (CRITICAL — 1 week)

### 1.1 Add Memory Tool

**Purpose:** Allow users to explicitly add memories  
**Impact:** HIGH — Enables persistent knowledge accumulation  
**Effort:** 2 days

```typescript
// Tool schema
{
  name: 'add_memory',
  description: 'Add a new memory entry (fact, preference, lesson, observation)',
  parameters: {
    content: string,      // Memory content
    type: 'fact' | 'preference' | 'lesson' | 'observation',
    tags: string[],       // Optional tags for categorization
    source: string        // Source context (auto-filled)
  }
}
```

**Implementation:**
1. Create `src/tools/memory-tools.ts` with add/search/delete/replace actions
2. Register in tool registry
3. Add to memory toolset
4. Integrate with fact-store for persistence

### 1.2 Search Memory Tool

**Purpose:** Retrieve relevant memories for a query  
**Impact:** HIGH — Enables context-aware responses  
**Effort:** 1 day

```typescript
// Tool schema
{
  name: 'search_memory',
  description: 'Search memories by content, type, or tags',
  parameters: {
    query: string,        // Search query
    type: string,         // Optional type filter
    tags: string[],       // Optional tag filter
    limit: number         // Max results (default: 10)
  }
}
```

### 1.3 Delete Memory Tool

**Purpose:** Remove outdated or incorrect memories  
**Impact:** MEDIUM — Enables memory curation  
**Effort:** 0.5 days

```typescript
// Tool schema
{
  name: 'delete_memory',
  description: 'Delete a memory by ID or content match',
  parameters: {
    id: string,           // Memory ID (if known)
    content: string       // Content substring to match (if ID unknown)
  }
}
```

### 1.4 Replace Memory Tool

**Purpose:** Update existing memories  
**Impact:** MEDIUM — Enables memory refinement  
**Effort:** 0.5 days

```typescript
// Tool schema
{
  name: 'replace_memory',
  description: 'Replace an existing memory with updated content',
  parameters: {
    id: string,           // Memory ID to replace
    content: string       // New content
  }
}
```

### Phase 1 Deliverables

| File | Lines | Description |
|------|-------|-------------|
| `src/tools/memory-tools.ts` | 400 | Memory tool implementation |
| `src/tools/registry.ts` | +50 | Register memory tools |
| `src/tools/toolsets.ts` | +10 | Add to memory toolset |
| Tests | 100 | Unit tests for memory tools |

**Total:** ~560 lines, 1 week effort

---

## Phase 2: Background Sync (HIGH — 1 week)

### 2.1 Daemon Thread Manager

**Purpose:** Run memory operations in background threads  
**Impact:** HIGH — Zero-cost per-turn memory operations  
**Effort:** 3 days

```typescript
// Implementation
class MemoryBackgroundSync {
  private executor: ThreadPoolExecutor;
  private syncQueue: SyncTask[];
  private isRunning: boolean;

  // Run memory extraction in background
  async syncTurn(userText: string, assistantText: string): Promise<void> {
    this.syncQueue.push({ userText, assistantText, timestamp: Date.now() });
    this.processQueue();
  }

  // Process queue in background
  private async processQueue(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;

    while (this.syncQueue.length > 0) {
      const task = this.syncQueue.shift();
      if (task) {
        await this.extractAndStore(task);
      }
    }

    this.isRunning = false;
  }
}
```

### 2.2 Session-End Extraction

**Purpose:** Extract facts from buffered turns at session end  
**Impact:** HIGH — Captures conversation insights  
**Effort:** 2 days

```typescript
// Implementation
async onSessionEnd(sessionId: string, callLLM?: LLMCallFn): Promise<void> {
  const turns = this.getBufferedTurns(sessionId);

  // Extract facts using rules + LLM
  const facts = await this.extractFacts(turns, callLLM);

  // Store in fact-store
  for (const fact of facts) {
    await this.factStore.add(fact);
  }

  // Clear buffer
  this.clearBuffer(sessionId);
}
```

### 2.3 Drift Detection

**Purpose:** Detect external modifications to memory files  
**Impact:** MEDIUM — Prevents data corruption  
**Effort:** 2 days

```typescript
// Implementation
class MemoryDriftDetector {
  private checksums = new Map<string, string>();

  // Record checksum on load
  async onLoad(path: string): Promise<void> {
    const content = await fs.readFile(path, 'utf-8');
    this.checksums.set(path, this.computeChecksum(content));
  }

  // Verify checksum on save
  async onSave(path: string): Promise<boolean> {
    const content = await fs.readFile(path, 'utf-8');
    const currentChecksum = this.computeChecksum(content);
    const savedChecksum = this.checksums.get(path);

    if (savedChecksum && currentChecksum !== savedChecksum) {
      // Drift detected — refuse write
      return false;
    }

    return true;
  }
}
```

### Phase 2 Deliverables

| File | Lines | Description |
|------|-------|-------------|
| `src/memory/background-sync.ts` | 300 | Background sync manager |
| `src/memory/drift-detector.ts` | 200 | Drift detection |
| `src/memory/manager.ts` | +100 | Integration |
| Tests | 150 | Unit tests |

**Total:** ~750 lines, 1 week effort

---

## Phase 3: Enterprise Durability (MEDIUM — 1 week)

### 3.1 SQLite Backend

**Purpose:** Replace JSON files with SQLite for durability  
**Impact:** MEDIUM — ACID transactions, concurrent access  
**Effort:** 4 days

```typescript
// Implementation
import Database from 'better-sqlite3';

class SQLiteFactStore {
  private db: Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.initialize();
  }

  private initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS facts (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        type TEXT NOT NULL,
        tags TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        source TEXT,
        embedding BLOB
      );

      CREATE INDEX IF NOT EXISTS idx_facts_type ON facts(type);
      CREATE INDEX IF NOT EXISTS idx_facts_created ON facts(created_at);
    `);
  }

  async add(fact: Fact): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO facts (id, content, type, tags, created_at, updated_at, source)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      fact.id,
      fact.content,
      fact.type,
      JSON.stringify(fact.tags),
      fact.createdAt,
      Date.now(),
      fact.source
    );
  }

  async search(query: string, limit: number = 10): Promise<Fact[]> {
    const stmt = this.db.prepare(`
      SELECT * FROM facts
      WHERE content LIKE ?
      ORDER BY created_at DESC
      LIMIT ?
    `);

    return stmt.all(`%${query}%`, limit) as Fact[];
  }
}
```

### 3.2 Cross-Session Persistence

**Purpose:** Maintain memory across sessions  
**Impact:** MEDIUM — Continuous learning  
**Effort:** 2 days

```typescript
// Implementation
class CrossSessionPersistence {
  private sessionStore: SessionStore;
  private factStore: FactStore;

  // Load memories at session start
  async loadSessionContext(sessionId: string): Promise<MemoryContext> {
    const facts = await this.factStore.getRecent(100);
    const trajectories = await this.sessionStore.getTrajectories(50);

    return {
      facts,
      trajectories,
      lastSession: await this.sessionStore.getLastSession(),
    };
  }

  // Save context at session end
  async saveSessionContext(sessionId: string, context: MemoryContext): Promise<void> {
    await this.sessionStore.saveSession({
      id: sessionId,
      facts: context.facts,
      trajectories: context.trajectories,
      endedAt: Date.now(),
    });
  }
}
```

### Phase 3 Deliverables

| File | Lines | Description |
|------|-------|-------------|
| `src/memory/sqlite-store.ts` | 400 | SQLite backend |
| `src/memory/cross-session.ts` | 300 | Cross-session persistence |
| `src/memory/fact-store.ts` | +100 | Integration |
| Tests | 200 | Unit tests |

**Total:** ~1000 lines, 1 week effort

---

## Phase 4: Memory CLI (LOW — 3 days)

### 4.1 CLI Commands

**Purpose:** User-facing memory management  
**Impact:** LOW — Nice-to-have for power users  
**Effort:** 3 days

```bash
# Commands
nuvira memory list              # List all memories
nuvira memory search <query>    # Search memories
nuvira memory add <content>     # Add a memory
nuvira memory delete <id>       # Delete a memory
nuvira memory export            # Export memories to JSON
nuvira memory import <file>     # Import memories from JSON
nuvira memory stats             # Show memory statistics
```

### 4.2 Implementation

```typescript
// src/cli/memory.ts
import { Command } from 'commander';
import { getMemoryManager } from '../memory/manager.js';

const memory = new Command('memory')
  .description('Manage persistent memory');

memory
  .command('list')
  .description('List all memories')
  .action(async () => {
    const mgr = getMemoryManager();
    const memories = await mgr.listMemories();
    console.table(memories);
  });

memory
  .command('search <query>')
  .description('Search memories')
  .action(async (query: string) => {
    const mgr = getMemoryManager();
    const results = await mgr.searchMemories(query);
    console.log(JSON.stringify(results, null, 2));
  });

// ... etc
```

### Phase 4 Deliverables

| File | Lines | Description |
|------|-------|-------------|
| `src/cli/memory.ts` | 200 | CLI commands |
| `src/memory/manager.ts` | +100 | CLI integration |
| Tests | 50 | Unit tests |

**Total:** ~350 lines, 3 days effort

---

## Implementation Roadmap

```
┌─────────────────────────────────────────────────────────────────┐
│                    MEMORY ENHANCEMENT ROADMAP                   │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Phase 1: Dedicated Memory Tools (Week 1)                       │
│  ├── Day 1-2: Add Memory Tool                                   │
│  ├── Day 3: Search Memory Tool                                  │
│  ├── Day 4: Delete/Replace Memory Tools                         │
│  └── Day 5: Tests + Integration                                 │
│                                                                 │
│  Phase 2: Background Sync (Week 2)                              │
│  ├── Day 1-3: Daemon Thread Manager                             │
│  ├── Day 4-5: Session-End Extraction                            │
│  └── Day 6-7: Drift Detection                                   │
│                                                                 │
│  Phase 3: Enterprise Durability (Week 3)                        │
│  ├── Day 1-4: SQLite Backend                                    │
│  └── Day 5-7: Cross-Session Persistence                         │
│                                                                 │
│  Phase 4: Memory CLI (Week 4)                                   │
│  ├── Day 1-2: CLI Commands                                      │
│  └── Day 3: Tests + Documentation                               │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Timeline

| Phase | Duration | Effort | Impact |
|-------|----------|--------|--------|
| **Phase 1** | Week 1 | 560 lines | CRITICAL |
| **Phase 2** | Week 2 | 750 lines | HIGH |
| **Phase 3** | Week 3 | 1000 lines | MEDIUM |
| **Phase 4** | Week 4 | 350 lines | LOW |
| **Total** | 4 weeks | 2,660 lines | FULL PARITY |

---

## Success Metrics

| Metric | Current | Target | How to Measure |
|--------|---------|--------|----------------|
| **Memory Tools** | 0 | 4 | Tool registry count |
| **Background Sync** | ❌ | ✅ | Zero per-turn latency |
| **Durability** | JSON | SQLite | ACID transactions |
| **Cross-Session** | ⚠️ Basic | ✅ Full | Memory persistence |
| **Memory CLI** | ❌ | ✅ | CLI commands available |

---

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| **FAISS integration issues** | Medium | High | Use SQLite as fallback |
| **Background sync race conditions** | Medium | Medium | Use thread-safe patterns |
| **Memory corruption** | Low | High | Implement drift detection |
| **Performance degradation** | Low | Medium | Profile and optimize |

---

## Open Questions

1. **Should we use better-sqlite3 or sql.js?**  
   - better-sqlite3: Native, faster, but requires compilation
   - sql.js: Pure JS, no compilation, but slower

2. **Should we keep JSON as fallback?**  
   - Yes, for users without SQLite support
   - No, for simplicity

3. **Should memory tools be always-on or opt-in?**  
   - Always-on: More convenient, but adds tool bloat
   - Opt-in: Cleaner, but users must enable

4. **Should we support Mem0 as alternative provider?**  
   - Yes, for enterprise users
   - No, for simplicity

---

## Conclusion

**Agent-Nuvira has a solid memory foundation** but lacks enterprise-grade features. The 4-phase enhancement plan will close all gaps and achieve full parity with Hermes.

**Recommendation:** Approve Phase 1 (Dedicated Memory Tools) immediately — it has the highest impact and can be implemented in 1 week.

---

**Developed by Dheeraj Sharma <imdheeraj@gmail.com>**
