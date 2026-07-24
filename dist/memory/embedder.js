/**
 * Embedder — Generates vector embeddings from text using a tiered approach.
 *
 * Embedding Tier Strategy:
 *   Tier 1: @huggingface/transformers (fast, local, 384-dim) — DEFAULT
 *   Tier 2: Python sentence-transformers via subprocess
 *   Tier 3: LLM-based (any configured InferenceProvider) — FALLBACK
 *
 * The embedder auto-selects the best available tier, caches results to avoid
 * redundant computation, and gracefully degrades when tiers are unavailable.
 *
 * Dimensionality: 384 (all-MiniLM-L6-v2 default) — 6x more expressive than
 * the previous 64-dim LLM-based embeddings while being 10x faster and free.
 */
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { logger } from '../utils/logger.js';
// ─── Constants ──────────────────────────────────────────────────────────────
/** Dimensionality of the generated embeddings (all-MiniLM-L6-v2 default) */
export const EMBEDDING_DIM = 384;
/** Max text length for embedding (characters) */
const MAX_EMBEDDING_TEXT_LENGTH = 2000;
/** Default model for @huggingface/transformers */
const XENOVA_MODEL = 'Xenova/all-MiniLM-L6-v2';
/** LLM-based embedding system prompt (Tier 3 fallback) */
const EMBEDDING_PROMPT = `You are a semantic embedding generator. Given a piece of text, generate a dense vector representation that captures its semantic meaning.

Return ONLY a valid JSON array of ${EMBEDDING_DIM} floating-point numbers between -1 and 1.
No markdown, no explanations, no code blocks — just the raw JSON array.

The vector should encode:
- The main topic and domain (e.g., "authentication", "database", "CLI tool")
- The action being requested (e.g., "add", "fix", "refactor", "create")
- The technology stack or language if mentioned
- Key entities and concepts

Example output: [${Array(5).fill('0.0').join(', ')}, ...]`;
// ─── Tier Availability Cache ────────────────────────────────────────────────
let _xenovaAvailable = null;
let _pythonAvailable = null;
// ─── In-Memory Cache ────────────────────────────────────────────────────────
class EmbeddingCache {
    cache = new Map();
    maxSize;
    constructor(maxSize = 200) {
        this.maxSize = maxSize;
    }
    get(key) {
        const value = this.cache.get(key);
        if (value !== undefined) {
            this.cache.delete(key);
            this.cache.set(key, value);
        }
        return value;
    }
    set(key, value) {
        if (this.cache.size >= this.maxSize) {
            const firstKey = this.cache.keys().next().value;
            if (firstKey !== undefined) {
                this.cache.delete(firstKey);
            }
        }
        this.cache.set(key, value);
    }
    get size() {
        return this.cache.size;
    }
    clear() {
        this.cache.clear();
    }
}
const cache = new EmbeddingCache();
// ─── Embedder ───────────────────────────────────────────────────────────────
function cacheKey(text) {
    return createHash('md5').update(text.toLowerCase().trim()).digest('hex');
}
/**
 * Generate a vector embedding for the given text.
 *
 * Uses a tiered approach:
 *   1. @huggingface/transformers (fast local embeddings) — preferred
 *   2. Python sentence-transformers via subprocess
 *   3. LLM-based embedding (requires callLLM function) — fallback
 *
 * @param text          The text to embed (e.g., a user goal or task description)
 * @param callLLM       Optional LLM call function (only needed for Tier 3 fallback)
 * @param forceLLM      If true, skip native tiers and use LLM directly (useful for testing)
 * @returns             A promise that resolves to a number[] embedding vector (384-dim)
 */
export async function embed(text, callLLM, forceLLM) {
    const key = cacheKey(text);
    // Check cache first
    const cached = cache.get(key);
    if (cached)
        return cached;
    const truncatedText = text.slice(0, MAX_EMBEDDING_TEXT_LENGTH);
    // When forceLLM is true, skip native tiers and go directly to LLM
    // This is useful in test environments where mock LLMs are used
    if (!forceLLM) {
        // Tier 1: @huggingface/transformers (fast, local, free)
        try {
            const vector = await embedWithXenova(truncatedText);
            if (vector) {
                cache.set(key, vector);
                return vector;
            }
        }
        catch (err) {
            logger.debug(`Tier 1 embedding (Xenova) failed: ${err}`);
        }
        // Tier 2: Python sentence-transformers via subprocess
        try {
            const vector = await embedWithPython(truncatedText);
            if (vector) {
                cache.set(key, vector);
                return vector;
            }
        }
        catch (err) {
            logger.debug(`Tier 2 embedding (Python) failed: ${err}`);
        }
    }
    // Tier 3: LLM-based embedding (requires callLLM)
    if (callLLM) {
        try {
            const vector = await embedWithLLM(truncatedText, callLLM);
            cache.set(key, vector);
            return vector;
        }
        catch (err) {
            logger.debug(`Tier 3 embedding (LLM) failed: ${err}`);
        }
    }
    // All tiers failed — return zero vector (no meaningful matches)
    logger.debug('All embedding tiers failed, returning zero vector');
    return new Array(EMBEDDING_DIM).fill(0);
}
// ─── Tier 1: @huggingface/transformers ──────────────────────────────────────
/**
 * Generate embedding using @huggingface/transformers (Xenova).
 * This is the fastest and most reliable tier — runs locally with ONNX runtime.
 * Returns null if the library is not installed or model fails to load.
 */
async function embedWithXenova(text) {
    if (_xenovaAvailable === false)
        return null;
    try {
        // Dynamic import — the package is optional (user may not have it installed)
        const { pipeline } = await import('@huggingface/transformers');
        // Use 'feature-extraction' pipeline with all-MiniLM-L6-v2
        // This model produces 384-dimensional embeddings
        const extractor = await pipeline('feature-extraction', XENOVA_MODEL);
        const output = await extractor(text, {
            pooling: 'mean',
            normalize: true,
        });
        // Convert Tensor to plain JS array
        const arr = output.tolist();
        const vector = arr[0];
        if (!vector || !Array.isArray(vector) || vector.length !== EMBEDDING_DIM) {
            logger.debug(`Xenova embedding returned unexpected shape: ${vector?.length}`);
            return null;
        }
        _xenovaAvailable = true;
        return vector;
    }
    catch (err) {
        _xenovaAvailable = false;
        const msg = err instanceof Error ? err.message : String(err);
        // Provide helpful messages for common issues
        if (msg.includes('Cannot find package') || msg.includes('Cannot find module')) {
            logger.debug('@huggingface/transformers not installed. Install with: npm install @huggingface/transformers');
        }
        else if (msg.includes('download')) {
            logger.debug('Xenova model download failed. Will use fallback embedding.');
        }
        else {
            logger.debug(`Xenova embedding error: ${msg}`);
        }
        return null;
    }
}
// ─── Tier 2: Python sentence-transformers ───────────────────────────────────
/**
 * Generate embedding using Python's sentence-transformers via subprocess.
 * Second fallback — slower than Xenova but doesn't require npm package.
 * Returns null if Python or sentence-transformers is not available.
 */
async function embedWithPython(text) {
    if (_pythonAvailable === false)
        return null;
    // Escape the text for safe embedding in Python script
    const escapedText = text
        .replace(/\\/g, '\\\\')
        .replace(/'/g, "\\'")
        .replace(/\n/g, '\\n')
        .replace(/\r/g, '\\r');
    const pythonScript = `
import sys, json
try:
    from sentence_transformers import SentenceTransformer
    model = SentenceTransformer('all-MiniLM-L6-v2')
    embedding = model.encode('${escapedText}').tolist()
    # Ensure 384 dimensions
    while len(embedding) < ${EMBEDDING_DIM}:
        embedding.append(0.0)
    embedding = embedding[:${EMBEDDING_DIM}]
    print(json.dumps({"embedding": embedding}))
except ImportError:
    print(json.dumps({"error": "sentence-transformers not installed. Run: pip install sentence-transformers"}))
    sys.exit(1)
except Exception as e:
    print(json.dumps({"error": str(e)}))
    sys.exit(1)
`;
    return new Promise((resolve) => {
        const python = spawn('python3', ['-c', pythonScript], {
            stdio: ['pipe', 'pipe', 'pipe'],
            timeout: 30000, // 30 second timeout
        });
        let output = '';
        let errorOutput = '';
        python.stdout?.on('data', (chunk) => {
            output += chunk.toString();
        });
        python.stderr?.on('data', (chunk) => {
            errorOutput += chunk.toString();
        });
        python.on('error', (err) => {
            _pythonAvailable = false;
            if (err.code === 'ENOENT') {
                logger.debug('Python 3 not found. Install sentence-transformers with: pip install sentence-transformers');
            }
            else {
                logger.debug(`Python subprocess error: ${err.message}`);
            }
            resolve(null);
        });
        python.on('close', (exitCode) => {
            if (exitCode === 0) {
                try {
                    const parsed = JSON.parse(output);
                    if (parsed.error) {
                        logger.debug(`Python embedding error: ${parsed.error}`);
                        _pythonAvailable = false;
                        resolve(null);
                    }
                    else if (Array.isArray(parsed.embedding) && parsed.embedding.length === EMBEDDING_DIM) {
                        _pythonAvailable = true;
                        resolve(parsed.embedding);
                    }
                    else {
                        resolve(null);
                    }
                }
                catch {
                    resolve(null);
                }
            }
            else {
                _pythonAvailable = false;
                if (errorOutput)
                    logger.debug(`Python embedding stderr: ${errorOutput.slice(0, 200)}`);
                resolve(null);
            }
        });
    });
}
// ─── Tier 3: LLM-based embedding ────────────────────────────────────────────
/**
 * Generate embedding using an LLM via the InferenceProvider.
 * This is the slowest and most expensive tier — fallback only.
 * Requires a callLLM function (provided by the Orchestrator).
 */
async function embedWithLLM(text, callLLM) {
    const prompt = `${EMBEDDING_PROMPT}\n\nText to embed:\n${text}`;
    const response = await callLLM(prompt, {
        temperature: 0.1,
        maxTokens: 2048,
    });
    const vector = parseLLMEmbedding(response);
    return vector;
}
/**
 * Parse an embedding vector from the LLM's text response.
 * Tries multiple strategies to extract a valid array of numbers.
 */
function parseLLMEmbedding(response) {
    const trimmed = response.trim();
    // Strategy 1: Direct JSON parse
    try {
        const parsed = JSON.parse(trimmed);
        if (isValidEmbedding(parsed))
            return parsed;
    }
    catch {
        // Fall through
    }
    // Strategy 2: Extract from ```json code block
    const jsonMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
        try {
            const parsed = JSON.parse(jsonMatch[1].trim());
            if (isValidEmbedding(parsed))
                return parsed;
        }
        catch {
            // Fall through
        }
    }
    // Strategy 3: Find array pattern in text
    const arrayMatch = trimmed.match(/\[[\s\S]*?\]/);
    if (arrayMatch) {
        try {
            const parsed = JSON.parse(arrayMatch[0]);
            if (isValidEmbedding(parsed))
                return parsed;
        }
        catch {
            // Fall through
        }
    }
    // Fallback: return zero vector (no meaningful match)
    logger.debug('Could not parse embedding from LLM response, using zero vector');
    return new Array(EMBEDDING_DIM).fill(0);
}
/**
 * Validate that a parsed value is a valid embedding vector.
 */
function isValidEmbedding(value) {
    if (!Array.isArray(value))
        return false;
    if (value.length !== EMBEDDING_DIM)
        return false;
    return value.every((v) => typeof v === 'number' && isFinite(v));
}
// ─── Detection Helpers ──────────────────────────────────────────────────────
/**
 * Reset the tier availability cache.
 * Call this when the environment changes (e.g., user installs a package)
 * or in test setup to force re-detection.
 */
export function resetEmbeddingTierCache() {
    _xenovaAvailable = null;
    _pythonAvailable = null;
}
/**
 * Set the force-LLM mode for testing.
 * When called with force=true, all native embedding tiers are disabled
 * and only the LLM-based fallback (Tier 3) is used.
 */
export function setForceLLM(force) {
    if (force) {
        _xenovaAvailable = false;
        _pythonAvailable = false;
    }
    else {
        _xenovaAvailable = null;
        _pythonAvailable = null;
    }
}
/**
 * Check if @huggingface/transformers is available.
 * This is a lightweight check that doesn't load the model.
 */
export async function isXenovaAvailable() {
    if (_xenovaAvailable !== null)
        return _xenovaAvailable;
    try {
        // Try to resolve the package without loading it
        await import('@huggingface/transformers');
        _xenovaAvailable = true;
        return true;
    }
    catch {
        _xenovaAvailable = false;
        return false;
    }
}
/**
 * Check if Python sentence-transformers is available.
 */
export async function isPythonAvailable() {
    if (_pythonAvailable !== null)
        return _pythonAvailable;
    return new Promise((resolve) => {
        const python = spawn('python3', ['-c', 'from sentence_transformers import SentenceTransformer; print("ok")'], {
            stdio: ['pipe', 'pipe', 'pipe'],
            timeout: 10000,
        });
        python.on('close', (code) => {
            _pythonAvailable = code === 0;
            resolve(code === 0);
        });
        python.on('error', () => {
            _pythonAvailable = false;
            resolve(false);
        });
    });
}
/**
 * Get the name of the currently active embedding tier.
 */
export async function getActiveEmbeddingTier() {
    if (await isXenovaAvailable())
        return 'local (Xenova, 384-dim)';
    if (await isPythonAvailable())
        return 'python (sentence-transformers, 384-dim)';
    return 'llm (fallback, 384-dim)';
}
// ─── Cache Management ───────────────────────────────────────────────────────
/**
 * Clear the in-memory embedding cache.
 */
export function clearEmbeddingCache() {
    cache.clear();
}
/**
 * Get the current size of the embedding cache.
 */
export function embeddingCacheSize() {
    return cache.size;
}
//# sourceMappingURL=embedder.js.map