/**
 * Memory Tool — Persistent curated memory.
 *
 * Hermes equivalent: memory_tool.py (1,240 lines)
 *
 * Features:
 * - Two stores: MEMORY.md (agent notes) and USER.md (user profile)
 * - Entry delimiter: § (section sign)
 * - Add, replace, remove entries
 * - Character limits (model-independent)
 * - Frozen snapshot pattern (system prompt stable, tool responses show live state)
 * - Threat scanning for injection/exfiltration
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolveNuviraHome } from '../config/paths.js';
import { join } from 'node:path';
import { logger } from '../utils/logger.js';
// ─── Memory Manager ──────────────────────────────────────────────────────
export class MemoryManager {
    memoryDir;
    memoryEntries = new Map();
    ENTRY_DELIMITER = '\n§\n';
    MAX_CHARS = {
        memory: 8000,
        user: 4000,
    };
    constructor() {
        this.memoryDir = join(resolveNuviraHome(), 'memories');
        this.ensureDir();
        this.loadAll();
    }
    ensureDir() {
        if (!existsSync(this.memoryDir)) {
            mkdirSync(this.memoryDir, { recursive: true });
        }
    }
    getFilePath(store) {
        return join(this.memoryDir, store === 'memory' ? 'MEMORY.md' : 'USER.md');
    }
    /**
     * Load entries from disk.
     */
    loadAll() {
        for (const store of ['memory', 'user']) {
            const filePath = this.getFilePath(store);
            if (!existsSync(filePath))
                continue;
            const content = readFileSync(filePath, 'utf-8');
            const entries = content.split(this.ENTRY_DELIMITER).filter((e) => e.trim());
            this.memoryEntries.set(store, entries.map((e) => ({
                content: e.trim(),
                timestamp: Date.now(),
            })));
        }
    }
    /**
     * Save entries to disk.
     */
    save(store) {
        const entries = this.memoryEntries.get(store) || [];
        const content = entries.map((e) => e.content).join(this.ENTRY_DELIMITER);
        writeFileSync(this.getFilePath(store), content, 'utf-8');
    }
    /**
     * Add an entry.
     */
    add(store, content) {
        // Threat scanning
        const threat = this.scanForThreats(content);
        if (threat) {
            return { success: false, error: threat };
        }
        const entries = this.memoryEntries.get(store) || [];
        // Check character limit
        const currentChars = entries.reduce((sum, e) => sum + e.content.length, 0);
        if (currentChars + content.length > this.MAX_CHARS[store]) {
            return { success: false, error: `Character limit exceeded (${this.MAX_CHARS[store]})` };
        }
        entries.push({ content, timestamp: Date.now() });
        this.memoryEntries.set(store, entries);
        this.save(store);
        logger.info(`[memory] Added entry to ${store}`);
        return { success: true };
    }
    /**
     * Replace an entry (by substring match).
     */
    replace(store, oldSubstring, newContent) {
        const threat = this.scanForThreats(newContent);
        if (threat) {
            return { success: false, error: threat };
        }
        const entries = this.memoryEntries.get(store) || [];
        const index = entries.findIndex((e) => e.content.includes(oldSubstring));
        if (index === -1) {
            return { success: false, error: 'Entry not found', replaced: false };
        }
        entries[index] = { content: newContent, timestamp: Date.now() };
        this.memoryEntries.set(store, entries);
        this.save(store);
        return { success: true, replaced: true };
    }
    /**
     * Remove an entry (by substring match).
     */
    remove(store, substring) {
        const entries = this.memoryEntries.get(store) || [];
        const index = entries.findIndex((e) => e.content.includes(substring));
        if (index === -1) {
            return { success: false, error: 'Entry not found', removed: false };
        }
        entries.splice(index, 1);
        this.memoryEntries.set(store, entries);
        this.save(store);
        return { success: true, removed: true };
    }
    /**
     * Get all entries as string.
     */
    getSnapshot(store) {
        const entries = this.memoryEntries.get(store) || [];
        return entries.map((e) => e.content).join(this.ENTRY_DELIMITER);
    }
    /**
     * Get stats.
     */
    getStats(store) {
        const entries = this.memoryEntries.get(store) || [];
        const charCount = entries.reduce((sum, e) => sum + e.content.length, 0);
        return {
            store,
            entryCount: entries.length,
            charCount,
            maxChars: this.MAX_CHARS[store],
            utilization: charCount / this.MAX_CHARS[store],
        };
    }
    /**
     * Get all stats.
     */
    getAllStats() {
        return [this.getStats('memory'), this.getStats('user')];
    }
    /**
     * Clear a store.
     */
    clear(store) {
        this.memoryEntries.set(store, []);
        this.save(store);
    }
    /**
     * Scan content for threats (injection, exfiltration).
     */
    scanForThreats(content) {
        const patterns = [
            { regex: /ignore\s+previous\s+instructions/i, message: 'Potential prompt injection' },
            { regex: /you\s+are\s+now\s+(?:a|an)/i, message: 'Potential role hijacking' },
            { regex: /system\s*:\s*/i, message: 'Potential system prompt injection' },
            { regex: /<\|im_start\|>/i, message: 'Potential token injection' },
            { regex: /curl\s+.*\|\s*sh/i, message: 'Potential command injection' },
            { regex: /eval\s*\(/i, message: 'Potential code injection' },
        ];
        for (const pattern of patterns) {
            if (pattern.regex.test(content)) {
                return pattern.message;
            }
        }
        return null;
    }
}
// ─── Singleton ─────────────────────────────────────────────────────────────
let _memoryManager = null;
export function getMemoryManager() {
    if (!_memoryManager)
        _memoryManager = new MemoryManager();
    return _memoryManager;
}
export function resetMemoryManager() {
    _memoryManager = null;
}
//# sourceMappingURL=memory-tool.js.map