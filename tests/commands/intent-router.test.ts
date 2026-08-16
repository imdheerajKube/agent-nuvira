import { describe, it, expect } from 'vitest';
import { resolveAsk, resolveBest, extractEntities } from '../../src/commands/intent-router.js';

describe('intent-router — plain English → CLI', () => {
  it('maps "stop the dashboard" (and variants) to buff dashboard stop', () => {
    for (const ask of ['stop the dashboard', 'kill dashboard', 'bounce the dashboard', 'shut down the dashboard']) {
      const best = resolveBest(ask);
      expect(best, ask).not.toBeNull();
      expect(best?.intent, ask).toBe('dashboard.stop');
      expect(best?.command).toBe('buff dashboard stop');
      expect(best?.confirmation).toBe(true);
    }
  });

  it('maps "start the gateway" / "stop the gateway" to the gateway lifecycle commands', () => {
    expect(resolveBest('start the gateway')?.command).toBe('buff gateway start');
    expect(resolveBest('stop the gateway')?.command).toBe('buff gateway stop');
    expect(resolveBest('is the gateway running?')?.intent).toBe('gateway.status');
  });

  it('maps "start the dashboard" to buff dashboard', () => {
    const best = resolveBest('open the dashboard');
    expect(best?.intent).toBe('dashboard.start');
    expect(best?.command).toBe('buff dashboard');
  });

  it('flags "add Rahul mobile +919958604222 to whatsapp" as AMBIGUOUS and offers both lists', () => {
    const matches = resolveAsk('add Rahul mobile +919958604222 to whatsapp');
    const top = matches[0];
    expect(top).toBeTruthy();
    // The contact-add intent is ambiguous by design (verified vs send-by-name).
    expect(top?.ambiguous).toBe(true);
    expect(top?.ambiguityGroup).toBe('contacts.add');
    expect(top?.options?.length).toBe(2);
    // Both resolutions must be present, with placeholders filled from the ask
    // (E.164, no leading +) — the router never guesses between the two.
    const commands = top?.options?.map((o) => o.command) ?? [];
    expect(commands).toContain('buff config gateway allow whatsapp user 919958604222');
    expect(commands).toContain('buff whatsapp contact add Rahul 919958604222');
    // Entities extracted from the ask.
    expect(top?.entities?.phone).toContain('+919958604222');
    expect(top?.entities?.name).toContain('Rahul');
  });

  it('resolves explicit "verified list" language straight to disallow (no re-ask)', () => {
    const top = resolveBest('remove Rahul from the verified list');
    expect(top?.ambiguous).toBeFalsy();
    expect(top?.intent).toBe('permissions.disallow');
    expect(top?.command).toBe('buff config gateway disallow <platform> user|group <id...>');
  });

  it('flags the VAGUE "remove Rahul from whatsapp" as ambiguous (disallow vs mapping)', () => {
    const top = resolveBest('remove Rahul from whatsapp');
    expect(top?.ambiguous).toBe(true);
    expect(top?.ambiguityGroup).toBe('contacts.remove');
    const commands = top?.options?.map((o) => o.command) ?? [];
    expect(commands).toContain('buff config gateway disallow whatsapp user <number>');
    expect(commands).toContain('buff whatsapp contact remove Rahul');
  });

  it('maps explicit trigger-language to the verified list without ambiguity', () => {
    // "let him message the bot" is trigger language — but the manifest marks
    // the whole contact-add intent ambiguous, so the agent asks. The
    // permissions.allow intent is the explicit, unambiguous path, and its
    // placeholders are filled from the ask.
    const best = resolveBest('allow 919958604222 on whatsapp');
    expect(best?.intent).toBe('permissions.allow');
    // The kind (user|group) stays a placeholder — only the router's caller
    // (the agent) resolves it; the number and platform are filled.
    expect(best?.command).toBe('buff config gateway allow whatsapp user|group 919958604222');
  });

  it('maps "send a message to ops" to gateway.send with target entity', () => {
    const best = resolveBest('send a message to ops');
    expect(best?.intent).toBe('gateway.send');
    expect(best?.entities?.target ?? []).toContain('ops');
  });

  it('maps "run the eval suite" and "how much have i spent"', () => {
    expect(resolveBest('run the eval suite')?.intent).toBe('eval.run');
    expect(resolveBest('run evals')?.intent).toBe('eval.run');
    expect(resolveBest('how much have i spent on the api')?.intent).toBe('stats.cost');
  });

  it('maps "enable whatsapp support" / "set up telegram bot" to the setup intents', () => {
    expect(resolveBest('enable whatsapp support')?.intent).toBe('whatsapp.pair');
    expect(resolveBest('enable telegram support')?.intent).toBe('platform.setup');
    expect(resolveBest('set up telegram bot')?.intent).toBe('platform.setup');
    expect(resolveBest('configure discord')?.intent).toBe('platform.setup');
  });

  it('maps expanded manifest intents (cron, sbom, audit, history, memory, retrieval, skills)', () => {
    expect(resolveBest('list cron jobs')?.intent).toBe('cron.list');
    expect(resolveBest('schedule the nightly build')?.intent).toBe('cron.add');
    expect(resolveBest('generate a sbom')?.intent).toBe('sbom.generate');
    expect(resolveBest('export the audit log')?.intent).toBe('audit.export');
    expect(resolveBest('is this prompt safe')?.intent).toBe('security.prompt');
    expect(resolveBest('clear conversation history')?.intent).toBe('history.clear');
    expect(resolveBest('prune memory')?.intent).toBe('memory.prune');
    expect(resolveBest('index the repo for search')?.intent).toBe('retrieval.index');
    expect(resolveBest('install the git-release skill')?.intent).toBe('skill.install');
    expect(resolveBest('approve the review bundle')?.intent).toBe('team.review.approve');
    expect(resolveBest('enable sandboxing')?.intent).toBe('sandbox.config');
    expect(resolveBest('show phase progress')?.intent).toBe('phase.status');
  });

  it('does not false-positive on single shared words (enable → whatsapp pair)', () => {
    expect(resolveBest('enable sandboxing')?.intent).toBe('sandbox.config');
    // Generic one-word overlap no longer matches an unrelated intent.
    expect(resolveBest('what is the meaning of life')).toBeNull();
  });

  it('returns nothing close for gibberish', () => {
    expect(resolveBest('flurbity glorp wibble')).toBeNull();
  });

  it('extractEntities pulls phones, names, targets and platforms', () => {
    const e = extractEntities('add Rahul mobile +919958604222 to whatsapp, send to telegram:123456');
    expect(e.phone).toContain('+919958604222');
    expect(e.name).toContain('Rahul');
    expect(e.platform).toContain('whatsapp');
    expect(e.target).toContain('telegram:123456');
  });
});

describe('intent-router — health group (self-heal)', () => {
  const cases: Array<[string, string]> = [
    ['check system health', 'health.check'],
    ['run a health check', 'health.check'],
    ['is the system healthy', 'health.check'],
    ['fix my setup', 'health.selfheal'],
    ['self heal', 'health.selfheal'],
    ['repair the agent', 'health.selfheal'],
    ['check provider health', 'health.providers'],
    ['is my llm provider up', 'health.providers'],
    ['is my memory getting full', 'health.memory'],
    ['how big is my memory store', 'health.memory'],
    ['why is search slow', 'health.vector'],
    ['is faiss working', 'health.vector'],
    ['is the gateway healthy', 'gateway.status'],
    ['check the gateway health', 'gateway.status'],
  ];

  it.each(cases)('resolves %j → %s', (ask, expected) => {
    const matches = resolveAsk(ask);
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0].intent).toBe(expected);
    expect(matches[0].ambiguous).toBeFalsy();
  });

  it('health.selfheal requires confirmation (state-changing)', () => {
    expect(resolveBest('fix my setup')?.confirmation).toBe(true);
  });

  it('read-only health checks do not require confirmation', () => {
    for (const ask of ['check system health', 'check provider health', 'why is search slow']) {
      expect(resolveBest(ask)?.confirmation).toBeFalsy();
    }
  });
});
