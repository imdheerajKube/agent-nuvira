/**
 * memory_tools — Dedicated memory tools for Agent-Nuvira.
 *
 * Provides explicit memory management:
 * - add_memory: Add facts, preferences, lessons, observations
 * - search_memory: Search by content, type, or tags
 * - delete_memory: Remove outdated memories
 * - replace_memory: Update existing memories
 *
 * Integrates with the existing fact-store and trajectory-store.
 */
import * as fs from 'fs';
import { join } from 'node:path';
import { resolveNuviraHome } from '../config/paths.js';
import * as path from 'path';
// ─── Memory Store ───────────────────────────────────────────────────────────
class MemoryStore {
    entries = new Map();
    indexPath;
    memoryDir;
    constructor(memoryDir) {
        this.memoryDir = memoryDir || join(resolveNuviraHome(), 'memory');
        this.indexPath = path.join(this.memoryDir, 'memory-index.json');
        this.loadIndex();
    }
    /**
     * Load memory index from disk.
     */
    loadIndex() {
        try {
            if (fs.existsSync(this.indexPath)) {
                const data = JSON.parse(fs.readFileSync(this.indexPath, 'utf-8'));
                for (const entry of data.entries || []) {
                    this.entries.set(entry.id, entry);
                }
            }
        }
        catch {
            // Start fresh
        }
    }
    /**
     * Save memory index to disk.
     */
    saveIndex() {
        try {
            const dir = path.dirname(this.indexPath);
            fs.mkdirSync(dir, { recursive: true });
            const data = {
                version: 1,
                updatedAt: Date.now(),
                entries: Array.from(this.entries.values()),
            };
            fs.writeFileSync(this.indexPath, JSON.stringify(data, null, 2), 'utf-8');
        }
        catch {
            // Best effort
        }
    }
    /**
     * Add a memory entry.
     */
    add(params) {
        const id = `mem_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const now = Date.now();
        const entry = {
            id,
            content: params.content,
            type: params.type,
            tags: params.tags || [],
            source: params.source,
            createdAt: now,
            updatedAt: now,
            accessCount: 0,
        };
        this.entries.set(id, entry);
        this.saveIndex();
        return entry;
    }
    /**
     * Get a memory entry by ID.
     */
    get(id) {
        const entry = this.entries.get(id);
        if (entry) {
            entry.accessCount++;
            entry.lastAccessed = Date.now();
        }
        return entry || null;
    }
    /**
     * Search memory entries.
     */
    search(params) {
        const results = [];
        const limit = params.limit || 10;
        for (const entry of this.entries.values()) {
            let score = 0;
            let matchType = 'partial';
            // Type filter
            if (params.type && entry.type !== params.type) {
                continue;
            }
            // Tag filter
            if (params.tags && params.tags.length > 0) {
                const hasTag = params.tags.some(t => entry.tags.includes(t));
                if (!hasTag) {
                    continue;
                }
                score += 0.3;
                matchType = 'tag';
            }
            // Content search
            if (params.query) {
                const queryLower = params.query.toLowerCase();
                const contentLower = entry.content.toLowerCase();
                if (contentLower === queryLower) {
                    score += 1.0;
                    matchType = 'exact';
                }
                else if (contentLower.includes(queryLower)) {
                    score += 0.7;
                    matchType = 'partial';
                }
                else {
                    // Check for word overlap
                    const queryWords = queryLower.split(/\s+/);
                    const contentWords = contentLower.split(/\s+/);
                    const overlap = queryWords.filter(w => contentWords.includes(w)).length;
                    score += (overlap / queryWords.length) * 0.5;
                }
            }
            else {
                // No query, return all (filtered by type/tags)
                score = 0.5;
            }
            // Boost recently accessed
            if (entry.lastAccessed) {
                const age = Date.now() - entry.lastAccessed;
                if (age < 3600_000)
                    score += 0.2; // Last hour
                else if (age < 86400_000)
                    score += 0.1; // Last day
            }
            // Boost frequently accessed
            if (entry.accessCount > 10)
                score += 0.1;
            if (score > 0) {
                results.push({ entry, score, matchType });
            }
        }
        // Sort by score descending
        results.sort((a, b) => b.score - a.score);
        return results.slice(0, limit);
    }
    /**
     * Update a memory entry.
     */
    update(id, params) {
        const entry = this.entries.get(id);
        if (!entry) {
            return null;
        }
        if (params.content !== undefined)
            entry.content = params.content;
        if (params.type !== undefined)
            entry.type = params.type;
        if (params.tags !== undefined)
            entry.tags = params.tags;
        entry.updatedAt = Date.now();
        this.saveIndex();
        return entry;
    }
    /**
     * Delete a memory entry.
     */
    delete(id) {
        const deleted = this.entries.delete(id);
        if (deleted) {
            this.saveIndex();
        }
        return deleted;
    }
    /**
     * List all memory entries.
     */
    list(params) {
        let entries = Array.from(this.entries.values());
        if (params?.type) {
            entries = entries.filter(e => e.type === params.type);
        }
        // Sort by creation date descending
        entries.sort((a, b) => b.createdAt - a.createdAt);
        if (params?.limit) {
            entries = entries.slice(0, params.limit);
        }
        return entries;
    }
    /**
     * Get statistics.
     */
    getStats() {
        const entries = Array.from(this.entries.values());
        const byType = {
            fact: 0,
            preference: 0,
            lesson: 0,
            observation: 0,
            pattern: 0,
        };
        let totalAccessCount = 0;
        let recentlyAccessed = 0;
        for (const entry of entries) {
            byType[entry.type]++;
            totalAccessCount += entry.accessCount;
            if (entry.lastAccessed && Date.now() - entry.lastAccessed < 86400_000) {
                recentlyAccessed++;
            }
        }
        return {
            total: entries.length,
            byType,
            recentlyAccessed,
            averageAccessCount: entries.length > 0 ? totalAccessCount / entries.length : 0,
        };
    }
}
/**
 * Search BOTH memory stores and merge the results.
 *
 * Why: this file and `memory/fact-store.ts` were separate silos — the model's
 * `add_memory`/`search_memory` tools wrote/read only this JSON store, while the
 * narrative memory provider and session recall read only the FACT store. So a
 * memory the model recorded was invisible to recall, and a fact the extractor
 * learned was invisible to `search_memory` — the same feature, two disjoint
 * halves.
 *
 * The memory store is keyword/tag matched (always available, no embeddings);
 * the fact store is semantic and needs an embedding tier, so it is queried
 * best-effort — a failure degrades to memory-store results instead of an empty
 * answer.
 */
export async function searchMemories(params) {
    const limit = params.limit || 10;
    const hits = [];
    const seen = new Set();
    const push = (hit) => {
        const key = hit.content.trim().toLowerCase();
        if (!key || seen.has(key))
            return; // dedupe across stores by text
        seen.add(key);
        hits.push(hit);
    };
    // 1) This store — keyword/tag match, no embeddings required.
    for (const r of getMemoryStore().search({
        query: params.query,
        type: params.type,
        tags: params.tags,
        limit,
    })) {
        push({
            id: r.entry.id,
            content: r.entry.content,
            type: r.entry.type,
            tags: r.entry.tags,
            score: r.score,
            source: 'memory',
        });
    }
    // 2) The fact store — semantic. Facts carry no memory `type`, so a `type`
    // filter other than 'fact' excludes them; tag filters must overlap.
    if (params.projectId && (!params.type || params.type === 'fact')) {
        try {
            const { getFactStore } = await import('../memory/fact-store.js');
            const store = getFactStore();
            const facts = params.query
                ? await store.retrieveFacts(params.projectId, params.query, undefined, { k: limit })
                : await store.listFacts(params.projectId);
            for (const fact of facts) {
                if (params.tags && params.tags.length > 0 && !params.tags.some((t) => fact.tags.includes(t)))
                    continue;
                push({
                    id: fact.id,
                    content: fact.text,
                    type: 'fact',
                    tags: fact.tags,
                    // Semantic hits rank below exact/partial keyword matches but above
                    // the no-query floor (0.5) so both halves interleave predictably.
                    score: params.query ? 0.6 : 0.5,
                    source: 'facts',
                });
            }
        }
        catch {
            // Best-effort — the memory store's half is still returned.
        }
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}
// ─── Singleton ──────────────────────────────────────────────────────────────
let _instance = null;
export function getMemoryStore() {
    if (!_instance)
        _instance = new MemoryStore();
    return _instance;
}
/** Test-only: drop the cached instance so a new memory dir takes effect. */
export function resetMemoryStore() {
    _instance = null;
}
export { MemoryStore };
//# sourceMappingURL=memory-tools.js.map