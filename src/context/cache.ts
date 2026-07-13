import { join } from 'node:path';
import { homedir } from 'node:os';
import { mkdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';

const DB_PATH = join(homedir(), '.buff', 'cache.db');

// Use dynamic import for better-sqlite3 (ESM compatible)
let db: any = null;
let dbInitPromise: Promise<any> | null = null;

async function getDb(): Promise<any> {
  if (db) return db;
  if (dbInitPromise) return dbInitPromise;

  dbInitPromise = initializeDb();
  return dbInitPromise;
}

async function initializeDb(): Promise<any> {
  const dir = join(homedir(), '.buff');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  try {
    const Database = (await import('better-sqlite3')).default;
    db = new Database(DB_PATH);
    db.exec(`
      CREATE TABLE IF NOT EXISTS inference_cache (
        key TEXT PRIMARY KEY,
        response TEXT NOT NULL,
        model TEXT NOT NULL,
        provider TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        ttl INTEGER NOT NULL DEFAULT 3600
      );
      CREATE INDEX IF NOT EXISTS idx_cache_created ON inference_cache(created_at);
      CREATE INDEX IF NOT EXISTS idx_cache_provider ON inference_cache(provider);
    `);

    // Clean up expired entries
    db.exec(`DELETE FROM inference_cache WHERE (created_at + ttl) < ${Math.floor(Date.now() / 1000)}`);

    return db;
  } catch (err) {
    // SQLite not available, cache disabled
    return null;
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
 * Context cache for inference results
 */
export class InferenceCache {
  private enabled: boolean = true;

  constructor() {
    // Initialization is lazy in get()/set() — no need to await in constructor
  }

  /**
   * Get cached response if available and not expired
   */
  async get(prompt: string, model: string, provider: string): Promise<string | null> {
    if (!this.enabled) return null;

    const database = await getDb();
    if (!database) {
      this.enabled = false;
      return null;
    }

    const key = generateKey(prompt, model, provider);
    const now = Math.floor(Date.now() / 1000);

    const row = database.prepare(
      `SELECT response FROM inference_cache WHERE key = ? AND (created_at + ttl) > ?`
    ).get(key, now);

    return row ? row.response : null;
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
    if (!this.enabled) return;

    const database = await getDb();
    if (!database) {
      this.enabled = false;
      return;
    }

    const key = generateKey(prompt, model, provider);
    const now = Math.floor(Date.now() / 1000);

    database.prepare(
      `INSERT OR REPLACE INTO inference_cache (key, response, model, provider, created_at, ttl)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(key, response, model, provider, now, ttl);
  }

  /**
   * Clear all cache entries
   */
  async clear(): Promise<void> {
    if (!this.enabled) return;

    const database = await getDb();
    if (!database) return;

    database.prepare('DELETE FROM inference_cache').run();
  }

  /**
   * Get cache statistics
   */
  async stats(): Promise<{ total: number; providers: Record<string, number> }> {
    if (!this.enabled) {
      return { total: 0, providers: {} };
    }

    const database = await getDb();
    if (!database) {
      return { total: 0, providers: {} };
    }

    const total = database.prepare('SELECT COUNT(*) as count FROM inference_cache').get().count;

    const providerRows = database.prepare(
      'SELECT provider, COUNT(*) as count FROM inference_cache GROUP BY provider'
    ).all();

    const providers: Record<string, number> = {};
    for (const row of providerRows) {
      providers[row.provider] = row.count;
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
