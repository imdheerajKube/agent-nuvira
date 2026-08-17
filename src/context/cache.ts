import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';

// Resolve lazily (not at module load) and honor BUFF_MEMORY_DIR — the same
// convention every other memory file follows (ledger, registry, recall-hits,
// artifact-store). Without this, tests writing through a temp BUFF_MEMORY_DIR
// would still read/write the REAL ~/.buff/cache.json (cross-run cache hits
// make suites order-dependent), and a hermetic run could never isolate its
// cache. Production path is unchanged when the env var is unset.
function cachePath(): string {
  if (process.env.BUFF_MEMORY_DIR) return join(process.env.BUFF_MEMORY_DIR, 'cache.json');
  return join(homedir(), '.buff', 'cache.json');
}

function cacheDir(): string {
  return dirname(cachePath());
}

interface CacheEntry {
  response: string;
  model: string;
  provider: string;
  createdAt: number;
  ttl: number;
}

interface CacheData {
  entries: Record<string, CacheEntry>;
}

function ensureDir(): void {
  if (!existsSync(cacheDir())) {
    mkdirSync(cacheDir(), { recursive: true });
  }
}

function readCache(): CacheData {
  try {
    ensureDir();
    if (!existsSync(cachePath())) {
      return { entries: {} };
    }
    const raw = readFileSync(cachePath(), 'utf-8');
    return JSON.parse(raw) as CacheData;
  } catch {
    return { entries: {} };
  }
}

function writeCache(data: CacheData): void {
  ensureDir();
  writeFileSync(cachePath(), JSON.stringify(data, null, 2), 'utf-8');
}

/**
 * Remove expired entries from the cache data in-place
 */
function pruneExpired(data: CacheData): void {
  const now = Math.floor(Date.now() / 1000);
  for (const [key, entry] of Object.entries(data.entries)) {
    if (entry.createdAt + entry.ttl < now) {
      delete data.entries[key];
    }
  }
}

/**
 * Generate a cache key from the prompt and options
 */
function generateKey(prompt: string, model: string, provider: string): string {
  const hash = createHash('sha256')
    .update(`${provider}:${model}:${prompt}`)
    .digest('hex');
  return hash;
}

/**
 * Context cache for inference results.
 * Uses a simple JSON file — no native dependencies, works everywhere.
 */
export class InferenceCache {
  /**
   * Get cached response if available and not expired
   */
  async get(prompt: string, model: string, provider: string): Promise<string | null> {
    const data = readCache();
    const key = generateKey(prompt, model, provider);
    const entry = data.entries[key];

    if (!entry) return null;

    const now = Math.floor(Date.now() / 1000);
    if (entry.createdAt + entry.ttl < now) {
      // Expired — remove it
      delete data.entries[key];
      writeCache(data);
      return null;
    }

    return entry.response;
  }

  /**
   * Store a response in the cache
   */
  async set(
    prompt: string,
    response: string,
    model: string,
    provider: string,
    ttl: number = 3600
  ): Promise<void> {
    const data = readCache();
    pruneExpired(data); // Clean up expired entries before writing
    const key = generateKey(prompt, model, provider);

    data.entries[key] = {
      response,
      model,
      provider,
      createdAt: Math.floor(Date.now() / 1000),
      ttl,
    };

    writeCache(data);
  }

  /**
   * Clear all cache entries
   */
  async clear(): Promise<void> {
    writeCache({ entries: {} });
  }

  /**
   * Get cache statistics
   */
  async stats(): Promise<{ total: number; providers: Record<string, number> }> {
    const data = readCache();
    pruneExpired(data);

    const total = Object.keys(data.entries).length;
    const providers: Record<string, number> = {};

    for (const entry of Object.values(data.entries)) {
      providers[entry.provider] = (providers[entry.provider] || 0) + 1;
    }

    return { total, providers };
  }
}

// Singleton instance
let cacheInstance: InferenceCache | null = null;

export function getCache(): InferenceCache {
  if (!cacheInstance) {
    cacheInstance = new InferenceCache();
  }
  return cacheInstance;
}
