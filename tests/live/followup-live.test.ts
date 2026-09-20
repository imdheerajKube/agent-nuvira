/**
 * LIVE before/after harness — the two real-world prompts across every surface.
 *
 * GATED: nothing here runs in CI. It makes REAL provider calls and is driven
 * explicitly:
 *
 *   NUVIRA_LIVE_TESTS=1 NUVIRA_LIVE_IMPL=dist NUVIRA_LIVE_LABEL=before \
 *     npx vitest run tests/live/followup-live.test.ts
 *
 *   NUVIRA_LIVE_TESTS=1 NUVIRA_LIVE_IMPL=src  NUVIRA_LIVE_LABEL=after  \
 *     npx vitest run tests/live/followup-live.test.ts
 *
 * `IMPL=dist` runs the PRE-CHANGE build (the committed/compiled artifacts) and
 * `IMPL=src` runs the current source, so the SAME probe measures before vs
 * after. Results land in `tests/live/out-<label>.json` for a field-by-field
 * diff of the things that must only IMPROVE: followup cleanliness/structure,
 * the answer actually covering the ask, and followup continuity (a picked
 * followup being resolved against the previous execution).
 *
 * Credentials are read from an ISOLATED copy of the real config dir, so the run
 * never mutates the user's profile (cache/memory/routing state).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const LIVE = process.env.NUVIRA_LIVE_TESTS === '1';
const IMPL = (process.env.NUVIRA_LIVE_IMPL ?? 'src') as 'src' | 'dist';
const LABEL = process.env.NUVIRA_LIVE_LABEL ?? IMPL;
const RUN_EXECUTE = process.env.NUVIRA_LIVE_EXECUTE === '1';

const ROOT = resolve(__dirname, '../..');
const BASE = IMPL === 'dist' ? join(ROOT, 'dist') : join(ROOT, 'src');
const EXT = IMPL === 'dist' ? '.js' : '.ts';

/** Load a module from the chosen implementation (src via vite, dist as-is). */
async function load<T>(rel: string): Promise<T> {
  const url = pathToFileURL(join(BASE, rel + EXT)).href;
  return (await import(/* @vite-ignore */ url)) as T;
}

const cfgDir = mkdtempSync(join(tmpdir(), 'buff-live-'));
const ORIG = {
  cfg: process.env.NUVIRA_CONFIG_DIR,
  mem: process.env.NUVIRA_MEMORY_DIR,
};

/**
 * Optional provider/model pin. `auto` (the default) exercises the real router,
 * but on a quota-limited free tier every candidate 429s and the run measures
 * the rate limiter instead of behaviour. Pinning a working provider (e.g. the
 * keyless local one) makes the A/B deterministic — applied identically to both
 * sides, so the comparison stays fair.
 */
const PIN_PROVIDER = process.env.NUVIRA_LIVE_PROVIDER ?? 'auto';
const PIN_MODEL = process.env.NUVIRA_LIVE_MODEL ?? '';
/** Routing opts for a turn — OMIT the model when unpinned (sending the literal
 *  'auto' as a model id would re-trigger auto routing / reach a provider API). */
const pinOpts = { provider: PIN_PROVIDER, ...(PIN_MODEL ? { model: PIN_MODEL } : {}) } as Record<string, unknown>;

const PROMPT_A =
  'I am planning to visit out of India from Delhi, I have two destinations in mind Philippines and Vietnam, duration is Dec, so give recommendations with budget and itinerary';
const PROMPT_B =
  'Write a poem for my 9 year old daughter Kashvi to wish her 9th Birthday, the poem is from her father Dheeraj Sharma';

interface TurnRecord {
  surface: string;
  label: string;
  impl: string;
  promptId: 'A' | 'B';
  content: string;
  followups: Array<{ prompt: string; label?: string }>;
  provider?: string;
  model?: string;
  generationFailed?: boolean;
  bounded?: boolean;
  continuations?: number;
  ms: number;
}

const records: TurnRecord[] = [];

/** Structural quality checks — the things that must never regress. */
function analyze(r: { content: string; followups: Array<{ prompt: string; label?: string }> }) {
  const prompts = r.followups.map((f) => (f?.prompt ?? '').trim());
  return {
    followupCount: prompts.length,
    followupsClean:
      prompts.length >= 1 &&
      prompts.length <= 3 &&
      prompts.every((p) => p.length > 0 && p.length <= 301 && !/^\s*[{[]/.test(p) && !/"tool"\s*:/.test(p)) &&
      new Set(prompts.map((p) => p.toLowerCase())).size === prompts.length,
    answerLeaksToolJson: /"tool"\s*:\s*"suggest_followups"|<function=suggest_followups/.test(r.content),
    answerLeaksMarker: r.content.includes('[CONTINUATION —'),
  };
}

function travelChecks(content: string) {
  const c = content.toLowerCase();
  return {
    bothDestinations: /philipp/.test(c) && /vietnam/.test(c),
    budget: /budget|cost|price|₹|inr|\$|usd|per day|total/.test(c),
    itinerary: /itinerary|day\s*1\b|day-by-day|day wise|day 1|day-by-day/.test(c),
  };
}

function poemChecks(content: string) {
  const c = content.toLowerCase();
  return {
    hasKashvi: /kashvi/.test(c),
    hasBirthday: /birthday|\b9th\b|\bnine\b/.test(c),
    hasFather: /dheeraj|father|dad|papa/.test(c),
    looksLikePoem: content.split('\n').filter((l) => l.trim()).length >= 6,
  };
}

function referencesPrior(content: string) {
  const c = content.toLowerCase();
  return /philipp|vietnam|budget|itinerary|delhi|december|\bdec\b/.test(c);
}

async function record(surface: string, promptId: 'A' | 'B', run: () => Promise<Omit<TurnRecord, 'surface' | 'label' | 'impl' | 'promptId' | 'ms'>>): Promise<TurnRecord> {
  const t0 = Date.now();
  const out = await run();
  const rec: TurnRecord = { surface, label: LABEL, impl: IMPL, promptId, ms: Date.now() - t0, ...out };
  records.push(rec);
  const a = analyze(rec);
  console.log(
    `[${LABEL}/${IMPL}/${surface}/P${promptId}] ${rec.ms}ms followups=${a.followupCount} clean=${a.followupsClean} ` +
      `leakJson=${a.answerLeaksToolJson} provider=${rec.provider ?? '?'} bounded=${rec.bounded ?? false} cont=${rec.continuations ?? 0} chars=${rec.content.length}`,
  );
  return rec;
}

beforeAll(() => {
  mkdirSync(join(cfgDir, 'gateway'), { recursive: true });
  mkdirSync(join(cfgDir, 'memory'), { recursive: true });
  // Copy the real credentials + config into the isolated dir (never mutate the
  // user's profile during a live run).
  for (const f of ['.env', 'nuviraconfig.json', 'buffconfig.json']) {
    const src = join(homedir(), '.nuvira', f);
    if (existsSync(src)) copyFileSync(src, join(cfgDir, f));
  }
  // Force auto routing so the live run exercises the real router/failover.
  for (const f of ['nuviraconfig.json', 'buffconfig.json']) {
    const p = join(cfgDir, f);
    if (!existsSync(p)) continue;
    try {
      const cfg = JSON.parse(readFileSync(p, 'utf-8')) as Record<string, unknown>;
      // `defaultProvider` drives the GATEWAY's routing decision too, so the pin
      // applies to every surface.
      cfg.defaultProvider = PIN_PROVIDER;
      // Tiered tool exposure on BOTH sides: the default 'all' sends ~110 tool
      // schemas (~17K tokens) on every step, which immediately trips Groq's
      // 7K input-tokens-per-minute and Gemini's 16K free-tier cap — the live run
      // then measures quota, not behaviour. Tiered (~16 core tools, ~3.8K
      // tokens) is a supported config, applied identically before and after, so
      // the comparison stays fair AND actually answers.
      cfg.tools = { ...((cfg.tools as Record<string, unknown>) ?? {}), loopExposure: 'tiered' };
      writeFileSync(p, JSON.stringify(cfg, null, 2));
    } catch {
      /* best-effort */
    }
  }
  writeFileSync(join(cfgDir, 'gateway', 'contacts.json'), JSON.stringify({ version: 1, contacts: [] }, null, 2));
  process.env.NUVIRA_CONFIG_DIR = cfgDir;
  process.env.NUVIRA_MEMORY_DIR = join(cfgDir, 'memory');
});

afterAll(() => {
  try {
    writeFileSync(join(ROOT, 'tests', 'live', `out-${LABEL}.json`), JSON.stringify(records, null, 2));
    console.log(`\n📄 wrote tests/live/out-${LABEL}.json (${records.length} turns)`);
  } catch {
    /* best-effort */
  }
  if (ORIG.cfg === undefined) delete process.env.NUVIRA_CONFIG_DIR;
  else process.env.NUVIRA_CONFIG_DIR = ORIG.cfg;
  if (ORIG.mem === undefined) delete process.env.NUVIRA_MEMORY_DIR;
  else process.env.NUVIRA_MEMORY_DIR = ORIG.mem;
  rmSync(cfgDir, { recursive: true, force: true });
});

describe.skipIf(!LIVE)('LIVE — followups across surfaces', () => {
  it('chat surface — travel prompt, then a picked followup', { timeout: 240_000 }, async () => {
    const { ChatCommand } = await load<{ ChatCommand: new () => { answerOnce: (m: string, o?: Record<string, unknown>) => Promise<Record<string, unknown>> } }>('cli/chat');
    const cmd = new ChatCommand();
    const history: Array<{ role: string; content: string }> = [];

    const first = await record('chat', 'A', async () => {
      const r: any = await cmd.answerOnce(PROMPT_A, { ...pinOpts, history });
      history.push({ role: 'user', content: PROMPT_A });
      if (r.content) history.push({ role: 'assistant', content: r.content });
      return { content: r.content ?? '', followups: r.followups ?? [], provider: r.provider, model: r.model, generationFailed: r.generationFailed, bounded: r.bounded, continuations: r.continuations };
    });
    expect(first.content.length).toBeGreaterThan(0);

    const followupPrompt = first.followups[0]?.prompt;
    expect(followupPrompt, 'the turn must offer at least one followup').toBeTruthy();

    const second = await record('chat', 'A', async () => {
      const r: any = await cmd.answerOnce(followupPrompt as string, { ...pinOpts, history, continuation: true });
      return { content: r.content ?? '', followups: r.followups ?? [], provider: r.provider, model: r.model, bounded: r.bounded, continuations: r.continuations };
    });
    expect(second.content.length, 'the followup must be answered, not dropped').toBeGreaterThan(0);
    console.log(`   ↳ followup referenced prior execution: ${referencesPrior(second.content)}`);
  });

  it('chat surface — birthday poem prompt', { timeout: 240_000 }, async () => {
    const { ChatCommand } = await load<{ ChatCommand: new () => { answerOnce: (m: string, o?: Record<string, unknown>) => Promise<Record<string, unknown>> } }>('cli/chat');
    const r = await record('chat', 'B', async () => {
      const x: any = await new ChatCommand().answerOnce(PROMPT_B, { ...pinOpts, history: [] });
      return { content: x.content ?? '', followups: x.followups ?? [], provider: x.provider, model: x.model, generationFailed: x.generationFailed, bounded: x.bounded, continuations: x.continuations };
    });
    expect(r.content.length).toBeGreaterThan(0);
    console.log(`   ↳ poem checks: ${JSON.stringify(poemChecks(r.content))}`);
  });

  it('dashboard console — travel prompt, then a followup chip', { timeout: 240_000 }, async () => {
    const { ChatConsole } = await load<{ ChatConsole: new (o?: Record<string, unknown>) => { answer: (s: string, m: string, o?: Record<string, unknown>) => Promise<Record<string, unknown>> } }>('web-dashboard/chat-console');
    const console_ = new ChatConsole({});
    const session = `live-${LABEL}-${Date.now()}`;

    const first = await record('dashboard', 'A', async () => {
      const r: any = await console_.answer(session, PROMPT_A);
      return { content: r.content ?? '', followups: r.followups ?? [], provider: r.provider, model: r.model, generationFailed: r.generationFailed, bounded: r.bounded };
    });
    expect(first.content.length).toBeGreaterThan(0);
    const followupPrompt = first.followups[0]?.prompt;
    expect(followupPrompt).toBeTruthy();

    const second = await record('dashboard', 'A', async () => {
      const r: any = await console_.answer(session, followupPrompt as string);
      return { content: r.content ?? '', followups: r.followups ?? [], provider: r.provider, model: r.model, bounded: r.bounded };
    });
    expect(second.content.length).toBeGreaterThan(0);
    console.log(`   ↳ followup referenced prior execution: ${referencesPrior(second.content)}`);
  });

  it('gateway (WhatsApp/Telegram path) — travel prompt, then a replied followup', { timeout: 240_000 }, async () => {
    const { GatewayRegistry } = await load<{ GatewayRegistry: new (o?: Record<string, unknown>) => { register: (a: unknown) => void; handleInbound: (m: Record<string, unknown>) => Promise<string | undefined> } }>('gateway/registry');
    const sent: string[] = [];
    const adapter = {
      platform: 'telegram' as const,
      configured: true,
      describe: () => 'Live probe (test)',
      start: async () => {},
      stop: async () => {},
      send: async (_c: string, t: string) => {
        sent.push(t);
        return true;
      },
    };
    const registry = new GatewayRegistry({ streamEvents: false });
    registry.register(adapter);
    const from = { platform: 'telegram', channelId: '555000999', from: 'LiveProbe', senderId: '555000999' };

    const firstReply = await record('gateway', 'A', async () => {
      const reply = await registry.handleInbound({ ...from, text: PROMPT_A });
      return { content: reply ?? '', followups: [] };
    });
    expect(firstReply.content.length).toBeGreaterThan(0);

    // The sender replies with one of the rendered "Try next" lines.
    const line = firstReply.content.match(/^\d+\.\s+(.+)$/m)?.[1]?.trim();
    expect(line, 'the reply must render a usable "Try next" list').toBeTruthy();

    const secondReply = await record('gateway', 'A', async () => {
      const reply = await registry.handleInbound({ ...from, text: line as string });
      return { content: reply ?? '', followups: [] };
    });
    expect(secondReply.content.length).toBeGreaterThan(0);
    console.log(`   ↳ followup referenced prior execution: ${referencesPrior(secondReply.content)}`);
  });

  it.skipIf(!RUN_EXECUTE)('execute (loop engine) — travel prompt', { timeout: 300_000 }, async () => {
    const cli = IMPL === 'dist' ? join(ROOT, 'dist', 'index.js') : join(ROOT, 'node_modules', '.bin', 'tsx');
    const args = IMPL === 'dist'
      ? ['execute', '--engine', 'loop', PROMPT_A]
      : [join(ROOT, 'src', 'index.ts'), 'execute', '--engine', 'loop', PROMPT_A];
    const proc = spawnSync(cli, args, { cwd: ROOT, encoding: 'utf-8', timeout: 280_000, env: { ...process.env } });
    const content = `${proc.stdout ?? ''}\n${proc.stderr ?? ''}`;
    await record('execute', 'A', async () => ({ content, followups: [] }));
    expect(content.length).toBeGreaterThan(0);
    console.log(`   ↳ execute travel checks: ${JSON.stringify(travelChecks(content))}`);
  });
});
