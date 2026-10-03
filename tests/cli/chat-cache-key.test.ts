/**
 * Response-cache key — never the `default` sentinel.
 *
 * Live defect: `runChatAnswer` keyed the cache with
 * `session.model ?? 'default'`. Auto routing routinely resolves a provider
 * while leaving the MODEL undefined, so `~/.nuvira/cache.json` on the user's
 * machine held:
 *
 *   "provider": "gemini", "model": "default",
 *   "response": "Sure, I can help you with suggestions and followups. Please
 *                provide me with more details so I can assist you better."
 *
 * Two consequences, both real:
 *  1. EVERY model of a provider collapsed into ONE entry, so an answer written
 *     by a weak model (gemma-4-26b / qwen2.5:0.5b) was replayed as though a
 *     strong model had produced it.
 *  2. A contract-confusion reply was CACHED as a success for an hour
 *     (`ttl: 3600`), so every retry inside that window replayed the deflection
 *     — which is exactly the "sometimes it answers, sometimes it deflects"
 *     behaviour the user reported.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ChatCommand } from '../../src/cli/chat.js';
import { getCache } from '../../src/context/cache.js';

/** A ChatCommand with a stubbed config (only `getAll().providers` is read). */
function cmdWith(providers: Record<string, { model?: string }>): ChatCommand {
  const cmd = new ChatCommand() as any;
  cmd.configManager = { getAll: () => ({ providers }) };
  return cmd;
}

const cacheModelFor = (cmd: ChatCommand, session: { type: string; model?: string }): string =>
  (cmd as any).cacheModelFor(session);

describe('chat response-cache key', () => {
  const ORIG_MEMORY = process.env.NUVIRA_MEMORY_DIR;
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nuvira-cachekey-'));
    process.env.NUVIRA_MEMORY_DIR = dir;
  });

  afterEach(() => {
    if (ORIG_MEMORY === undefined) delete process.env.NUVIRA_MEMORY_DIR;
    else process.env.NUVIRA_MEMORY_DIR = ORIG_MEMORY;
    rmSync(dir, { recursive: true, force: true });
  });

  it('resolves the provider pin instead of storing the `default` sentinel', () => {
    const cmd = cmdWith({ gemini: { model: 'gemini-flash-latest' } });
    expect(cacheModelFor(cmd, { type: 'gemini' })).toBe('gemini-flash-latest');
    // The sentinel (and undefined) must ALSO resolve, not pass through.
    expect(cacheModelFor(cmd, { type: 'gemini', model: 'default' })).toBe('gemini-flash-latest');
    expect(cacheModelFor(cmd, { type: 'gemini' })).not.toBe('default');
  });

  it('passes a real routed model through untouched', () => {
    const cmd = cmdWith({ gemini: { model: 'gemini-flash-latest' } });
    expect(cacheModelFor(cmd, { type: 'gemini', model: 'gemma-4-26b-a4b-it' })).toBe('gemma-4-26b-a4b-it');
  });

  it('never returns a bare `default` even when nothing is configured', () => {
    const cmd = cmdWith({});
    const key = cacheModelFor(cmd, { type: 'gemini' });
    expect(key).not.toBe('default');
    expect(key.length).toBeGreaterThan(0);
    // Provider-qualified, so two unresolved providers can never collide.
    expect(key).toContain('gemini');
  });

  it('survives a config read that throws (still no sentinel)', () => {
    const cmd = new ChatCommand() as any;
    cmd.configManager = {
      getAll: () => {
        throw new Error('config unreadable');
      },
    };
    const key = cacheModelFor(cmd, { type: 'groq' });
    expect(key).not.toBe('default');
    expect(key).toContain('groq');
  });

  it('the underlying cache keeps per-model entries distinct (the invariant the key protects)', async () => {
    const cache = getCache();
    await cache.set('same question', 'weak-model answer', 'qwen2.5:0.5b', 'local');
    await cache.set('same question', 'strong-model answer', 'openai/gpt-4o', 'local');

    expect(await cache.get('same question', 'qwen2.5:0.5b', 'local')).toBe('weak-model answer');
    expect(await cache.get('same question', 'openai/gpt-4o', 'local')).toBe('strong-model answer');

    // The defect shape: a 'default' key would have served the WEAK answer to a
    // strong-model request. Prove it is a distinct entry, not a fallback.
    expect(await cache.get('same question', 'default', 'local')).toBeNull();

    const raw = JSON.parse(readFileSync(join(dir, 'cache.json'), 'utf8'));
    expect(Object.keys(raw.entries)).toHaveLength(2);
  });

  it('writes the cache under the isolated memory dir (hermetic)', async () => {
    await getCache().set('q', 'a', 'm', 'p');
    expect(existsSync(join(dir, 'cache.json'))).toBe(true);
  });

  /**
   * The reported defect: same prompt answered in a DIFFERENT project replayed the
   * first project's answer. "What's the current status of this project?" was
   * answered while no folder was attached (cwd = the dashboard server's own,
   * which held an unrelated checkout) and every later ask of that exact wording
   * replayed that report — while a differently-worded ask ("assess this
   * project") missed the cache and correctly worked on the attached folder.
   */
  it('scopes an answer to the WORKSPACE it was produced in', async () => {
    const cache = getCache();
    const ask = "what's the current status of this project";
    await cache.set(ask, 'answer about some other folder', 'm', 'p', undefined, '/Users/me');

    // A different workspace MUST miss — this is the cross-project replay.
    expect(await cache.get(ask, 'm', 'p', '/Users/me/Documents/anuj_voice')).toBeNull();
    // The workspace it was produced in still hits.
    expect(await cache.get(ask, 'm', 'p', '/Users/me')).toBe('answer about some other folder');
  });

  it('keeps unscoped entries out of every workspace', async () => {
    const cache = getCache();
    await cache.set('q', 'no-workspace answer', 'm', 'p');

    // An unscoped answer is about no directory, so an attached project must not
    // inherit it — that inheritance is exactly the defect.
    expect(await cache.get('q', 'm', 'p', '/some/project')).toBeNull();
    expect(await cache.get('q', 'm', 'p')).toBe('no-workspace answer');
  });
});
