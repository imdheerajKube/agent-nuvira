/**
 * RetrievalEngine — vectorization layer for Agent-Nuvira.
 *
 * Turns large code/doc context into token-efficient, semantically-relevant
 * context using a local embedding model + the pure-JS VectorStore (cosine
 * similarity, JSON-persisted, honors NUVIRA_MEMORY_DIR). This complements the
 * quota ledger: retrieval SAVES tokens (so free quotas stretch further),
 * the ledger MANAGES quotas.
 *
 * Flow (mirrors the assessment's 6-step plan):
 *   1. Chunking   — split large files into ~512-token chunks (with overlap)
 *   2. Indexing   — embed each chunk (bge-small-en-v1.5, 384-dim) into the
 *                   'repo' VectorStore namespace
 *   3. Query      — embed the user goal/subtask
 *   4. Retrieval  — top-k cosine search over the repo index
 *   5. Assembly   — concatenate retrieved chunks → reduced context
 *   6. Router hook— simple tasks go direct; large tasks embed+retrieve;
 *                   quota optimization = token reduction; failover = full
 *                   context fallback when retrieval fails.
 *
 * Every reduction is logged ("Retrieved 5 chunks — context 20k → 3k tokens")
 * and persisted to retrieval-stats.json for the dashboard + `nuvira retrieval`.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { envBuff, resolveNuviraHome } from '../config/paths.js';
import { join } from 'node:path';
import { embed, RETRIEVAL_MODEL } from '../memory/embedder.js';
import { getVectorStore } from '../memory/vector-store.js';
import { logger } from '../utils/logger.js';
// ─── Constants ──────────────────────────────────────────────────────────────
/** ~4 chars per token (matches ContextParser's estimate). */
const CHARS_PER_TOKEN = 4;
/** Default chunk size (tokens). */
export const DEFAULT_CHUNK_TOKENS = 512;
/** Overlap between adjacent chunks (tokens) — preserves boundary context. */
export const DEFAULT_OVERLAP_TOKENS = 64;
/** Default top-k chunks to retrieve. */
export const DEFAULT_TOP_K = 5;
/**
 * Default context threshold (tokens). Contexts SMALLER than this go straight
 * to the LLM (no embedding cost — simple tasks → direct call). Contexts
 * LARGER than this are vectorized (embed + retrieve → reduced context).
 */
export const DEFAULT_THRESHOLD_TOKENS = 12_000;
/** Retrieval VectorStore namespace (kept separate from memory/history vectors). */
export const REPO_NAMESPACE = 'repo';
/** Stats file for token-savings transparency (dashboard + CLI). */
export const RETRIEVAL_STATS_FILE = 'retrieval-stats.json';
function memoryDir() {
    return envBuff('MEMORY_DIR') || join(resolveNuviraHome(), 'memory');
}
function statsPath() {
    return join(memoryDir(), RETRIEVAL_STATS_FILE);
}
// ─── Token estimation ───────────────────────────────────────────────────────
/** Estimate token count from text length (~4 chars/token). */
export function estimateTokens(text) {
    return Math.ceil(text.length / CHARS_PER_TOKEN);
}
// ─── Chunking ───────────────────────────────────────────────────────────────
/**
 * Split text into overlapping chunks of ~chunkTokens. Chunk boundaries prefer
 * paragraph breaks, then line breaks, and finally hard-split on character
 * count (so code files with no blank lines still chunk deterministically).
 * Each chunk carries a stable id (`<label>#<i>`) so re-indexing overwrites
 * the same entries instead of duplicating.
 */
export function chunkText(text, label, chunkTokens = DEFAULT_CHUNK_TOKENS, overlapTokens = DEFAULT_OVERLAP_TOKENS) {
    const maxChars = chunkTokens * CHARS_PER_TOKEN;
    const overlapChars = overlapTokens * CHARS_PER_TOKEN;
    if (text.length <= maxChars) {
        return [{
                id: `${label}#0`,
                filePath: label,
                chunkIndex: 0,
                text,
                tokenCount: estimateTokens(text),
            }];
    }
    // Prefer paragraph boundaries for the first split pass.
    const paragraphs = text.split(/\n\s*\n/);
    const chunks = [];
    let current = '';
    let chunkIndex = 0;
    const flush = () => {
        if (!current.trim())
            return;
        chunks.push({
            id: `${label}#${chunkIndex}`,
            filePath: label,
            chunkIndex: chunkIndex++,
            text: current.trim(),
            tokenCount: estimateTokens(current),
        });
    };
    for (const para of paragraphs) {
        // A single paragraph larger than maxChars gets hard-split.
        if (para.length > maxChars) {
            flush();
            let rest = para;
            while (rest.length > maxChars) {
                // Prefer a line break near the boundary, else hard cut.
                let cut = maxChars;
                const near = rest.lastIndexOf('\n', maxChars);
                if (near > maxChars * 0.6)
                    cut = near + 1;
                const piece = rest.slice(0, cut);
                chunks.push({
                    id: `${label}#${chunkIndex}`,
                    filePath: label,
                    chunkIndex: chunkIndex++,
                    text: piece.trim(),
                    tokenCount: estimateTokens(piece),
                });
                rest = overlapChars > 0 ? rest.slice(cut - overlapChars) : rest.slice(cut);
            }
            current = rest;
            continue;
        }
        if (current && (current.length + para.length + 2) > maxChars) {
            flush();
            current = para;
        }
        else {
            current = current ? `${current}\n\n${para}` : para;
        }
    }
    flush();
    return chunks;
}
// ─── Indexing ───────────────────────────────────────────────────────────────
/**
 * Read a file, chunk it, embed each chunk, and store it in the repo index.
 * Idempotent per chunk id — re-indexing a changed file overwrites its chunks.
 * Returns the number of chunks indexed.
 */
export async function indexFile(filePath, opts = {}) {
    const chunkTokens = opts.chunkTokens ?? DEFAULT_CHUNK_TOKENS;
    const overlapTokens = opts.overlapTokens ?? DEFAULT_OVERLAP_TOKENS;
    const model = opts.model ?? RETRIEVAL_MODEL;
    const content = readFileSync(filePath, 'utf-8');
    const chunks = chunkText(content, filePath, chunkTokens, overlapTokens);
    const store = getVectorStore(REPO_NAMESPACE);
    for (const chunk of chunks) {
        let vector = new Array(384).fill(0);
        try {
            vector = await embed(chunk.text, opts.callLLM, false, model);
        }
        catch {
            // Zero-vector chunk → will never outrank real matches; index continues.
        }
        await store.insert(chunk.id, vector, {
            kind: 'repo-chunk',
            filePath: chunk.filePath,
            chunkIndex: chunk.chunkIndex,
            text: chunk.text,
            tokenCount: chunk.tokenCount,
            model,
        });
    }
    return chunks.length;
}
/**
 * Index a list of files (best-effort per file — a missing/unreadable file is
 * skipped, never thrown). Returns { files, chunks }.
 */
export async function indexFiles(filePaths, opts = {}) {
    let chunks = 0;
    let files = 0;
    for (const filePath of filePaths) {
        try {
            if (!existsSync(filePath))
                continue;
            chunks += await indexFile(filePath, opts);
            files++;
        }
        catch (err) {
            logger.debug(`Retrieval: skip unreadable file ${filePath}: ${err instanceof Error ? err.message : err}`);
        }
    }
    return { files, chunks };
}
// ─── Query & retrieval ──────────────────────────────────────────────────────
/**
 * Embed the query and return the top-k most similar repo chunks.
 * Throws on embed failure — callers decide whether to fail over.
 */
export async function retrieve(query, opts = {}) {
    const topK = opts.topK ?? DEFAULT_TOP_K;
    const model = opts.model ?? RETRIEVAL_MODEL;
    const queryVector = await embed(query, opts.callLLM, false, model);
    const store = getVectorStore(REPO_NAMESPACE);
    const results = await store.search(queryVector, topK, (entry) => {
        return entry.metadata?.kind === 'repo-chunk' && typeof entry.metadata?.text === 'string';
    });
    return results.map(({ entry, similarity }) => ({
        chunk: {
            id: entry.id,
            filePath: String(entry.metadata?.filePath || entry.id),
            chunkIndex: Number(entry.metadata?.chunkIndex ?? 0),
            text: String(entry.metadata?.text || ''),
            tokenCount: Number(entry.metadata?.tokenCount ?? estimateTokens(String(entry.metadata?.text || ''))),
        },
        similarity,
    }));
}
// ─── Context assembly (the main router hook) ────────────────────────────────
/**
 * Assemble context for a task/goal with retrieval-aware token reduction.
 *
 * Router policy:
 *   - retrieval disabled OR context ≤ threshold → direct call (no embedding,
 *     zero overhead — simple tasks go straight to the LLM).
 *   - context > threshold → index files (idempotent) + retrieve top-k +
 *     assemble reduced context.
 *   - any retrieval failure → FAIL OVER to the full context unchanged
 *     (never break the LLM call on a retrieval error).
 *
 * @param query        The user goal / subtask description
 * @param filePaths    Files to consider as context (already gathered)
 * @param rawContext   The full context string those files represent (or null
 *                     to rebuild from filePaths)
 * @param opts         Retrieval options
 * @returns Assembled (possibly reduced) context + per-call stats
 */
export async function assembleContext(query, filePaths, rawContext = null, opts = {}) {
    const enabled = opts.enabled ?? true;
    const thresholdTokens = opts.thresholdTokens ?? DEFAULT_THRESHOLD_TOKENS;
    // Rebuild full context from the files if not provided.
    let fullContext = rawContext;
    let originalTokens = estimateTokens(rawContext || '');
    if (fullContext === null) {
        const parts = [];
        let tokens = 0;
        for (const filePath of filePaths) {
            try {
                if (!existsSync(filePath))
                    continue;
                const content = readFileSync(filePath, 'utf-8');
                tokens += estimateTokens(content);
                parts.push(`--- ${filePath} ---\n${content}`);
            }
            catch {
                // Skip unreadable files.
            }
        }
        fullContext = parts.join('\n\n');
        originalTokens = tokens;
    }
    const notUsed = {
        context: fullContext,
        stats: {
            used: false,
            originalTokens,
            reducedTokens: originalTokens,
            savedTokens: 0,
            pctReduced: 0,
            chunksRetrieved: 0,
            failover: false,
            hits: [],
            timestamp: Date.now(),
        },
    };
    // Simple-task fast path: small context goes straight to the LLM.
    if (!enabled || originalTokens <= thresholdTokens || filePaths.length === 0) {
        return notUsed;
    }
    try {
        // Index (idempotent) then retrieve top-k against the goal.
        await indexFiles(filePaths, opts);
        const hits = await retrieve(query, opts);
        if (hits.length === 0)
            return notUsed;
        const chunksText = hits.map((h) => `--- ${h.chunk.filePath} (chunk ${h.chunk.chunkIndex + 1}) ---\n${h.chunk.text}`).join('\n\n');
        const reducedTokens = estimateTokens(chunksText);
        const savedTokens = Math.max(0, originalTokens - reducedTokens);
        const pctReduced = originalTokens > 0 ? Math.round((savedTokens / originalTokens) * 1000) / 10 : 0;
        const stats = {
            used: true,
            originalTokens,
            reducedTokens,
            savedTokens,
            pctReduced,
            chunksRetrieved: hits.length,
            failover: false,
            hits: hits.map((h) => ({ filePath: h.chunk.filePath, similarity: Math.round(h.similarity * 1000) / 1000 })),
            timestamp: Date.now(),
        };
        logger.info(`🧠 Retrieved ${hits.length} chunk${hits.length === 1 ? '' : 's'} from repo — ` +
            `reduced context ${originalTokens.toLocaleString()} → ${reducedTokens.toLocaleString()} tokens ` +
            `(${pctReduced.toFixed(0)}% saved)`);
        return { context: chunksText, stats };
    }
    catch (err) {
        // Failover: retrieval must NEVER break the LLM call — fall back to full context.
        logger.debug(`Retrieval failed, falling back to full context: ${err instanceof Error ? err.message : err}`);
        return {
            context: fullContext,
            stats: { ...notUsed.stats, failover: true },
        };
    }
}
// ─── Token-savings transparency (persisted for dashboard + CLI) ────────────
/** Append a call's stats to the aggregate retrieval-stats file (best-effort). */
export function recordRetrievalStats(stats) {
    try {
        const current = readRetrievalAggregateStats();
        const recent = [stats, ...current.recent].slice(0, 50);
        const savedTotal = recent.reduce((s, r) => s + (r.used ? r.savedTokens : 0), 0);
        const callsWithRetrieval = recent.filter((r) => r.used).length;
        const totalOriginal = recent.reduce((s, r) => s + r.originalTokens, 0);
        const totalReduced = recent.reduce((s, r) => s + r.reducedTokens, 0);
        const next = {
            totalCalls: current.totalCalls + 1,
            totalRetrievals: callsWithRetrieval,
            totalFailovers: recent.filter((r) => r.failover).length,
            totalOriginalTokens: totalOriginal,
            totalReducedTokens: totalReduced,
            totalSavedTokens: savedTotal,
            avgPctReduced: totalOriginal > 0 ? Math.round((1 - totalReduced / totalOriginal) * 1000) / 10 : 0,
            lastCall: stats,
            recent,
            updatedAt: Date.now(),
        };
        if (!existsSync(memoryDir()))
            mkdirSync(memoryDir(), { recursive: true });
        writeFileSync(statsPath(), JSON.stringify(next, null, 2), 'utf-8');
    }
    catch {
        // Best-effort — stats must never break the pipeline.
    }
}
/** Read the aggregate retrieval stats (empty default when missing/corrupt). */
export function readRetrievalAggregateStats() {
    try {
        if (!existsSync(statsPath()))
            return emptyAggregate();
        const raw = readFileSync(statsPath(), 'utf-8');
        const data = JSON.parse(raw);
        if (!data || typeof data !== 'object')
            return emptyAggregate();
        return { ...emptyAggregate(), ...data };
    }
    catch {
        return emptyAggregate();
    }
}
function emptyAggregate() {
    return {
        totalCalls: 0,
        totalRetrievals: 0,
        totalFailovers: 0,
        totalOriginalTokens: 0,
        totalReducedTokens: 0,
        totalSavedTokens: 0,
        avgPctReduced: 0,
        recent: [],
        updatedAt: 0,
    };
}
/**
 * Clear retrieval stats + the repo index (used by `nuvira retrieval clear`).
 * ASYNC: the VectorStore facade lazily resolves its backend, so the clear must
 * be awaited to guarantee the on-disk index is wiped before callers check it.
 */
export async function clearRetrievalState() {
    try {
        if (existsSync(statsPath()))
            writeFileSync(statsPath(), JSON.stringify(emptyAggregate(), null, 2), 'utf-8');
    }
    catch {
        // Best-effort.
    }
    try {
        await getVectorStore(REPO_NAMESPACE).clear();
    }
    catch {
        // Best-effort.
    }
}
/** Resolve retrieval options from config (routing.retrieval). */
export function retrievalOptionsFromConfig(configManager, overrides = {}) {
    const cfg = configManager?.getAll().routing?.retrieval;
    return {
        enabled: cfg?.enabled ?? overrides.enabled ?? true,
        topK: overrides.topK ?? cfg?.topK ?? DEFAULT_TOP_K,
        chunkTokens: overrides.chunkTokens ?? cfg?.chunkTokens ?? DEFAULT_CHUNK_TOKENS,
        overlapTokens: overrides.overlapTokens ?? cfg?.overlapTokens ?? DEFAULT_OVERLAP_TOKENS,
        thresholdTokens: overrides.thresholdTokens ?? cfg?.thresholdTokens ?? DEFAULT_THRESHOLD_TOKENS,
        model: overrides.model ?? cfg?.model ?? RETRIEVAL_MODEL,
        callLLM: overrides.callLLM,
    };
}
//# sourceMappingURL=retrieval.js.map