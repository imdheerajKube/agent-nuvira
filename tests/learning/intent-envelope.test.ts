/**
 * The Intent Envelope — authorization as a property of the INTENT.
 *
 * The behavior pinned here is the one a live session broke: permission was
 * re-derived from the last message on every turn, so an approval was forgotten
 * at the turn boundary and an unrelated word at the front of a message could
 * de-authorize the whole turn ("why are you asking me this again? Apply a safe
 * expression parser by updating script.js" → UNAUTHORIZED → four permission
 * prompts for a syntax check).
 *
 * The envelope is the durable, scoped grant that fixes both. What must stay
 * true: it never covers `external` or `destructive`, it expires, it is scoped to
 * the paths it names, and it does NOT authorize a whole-file overwrite of a file
 * the request never mentioned.
 */

import { describe, it, expect } from 'vitest';

import {
  clearEnvelope,
  envelopeCoversAction,
  envelopeFromPlan,
  envelopeFromRequest,
  envelopeNamesPath,
  getEnvelope,
  grantEnvelope,
  isEnvelopeKey,
  ENVELOPE_TTL_MS,
  type IntentEnvelope,
} from '../../src/learning/intent-envelope.js';

/** A session handle, as the loop passes the plan store. */
function session(): { id: string } {
  return { id: `s-${Math.random().toString(36).slice(2)}` };
}

const REQUEST = 'fix the calculator so the scientific functions parse the whole expression';

describe('envelopeFromRequest', () => {
  it('grants an envelope for a directive request', () => {
    const env = envelopeFromRequest(REQUEST);
    expect(env).not.toBeNull();
    expect(env!.source).toBe('request');
    expect(env!.goal).toContain('fix the calculator');
    expect(env!.expiresAt).toBeGreaterThan(env!.grantedAt);
  });

  it('grants NOTHING for a question about the work', () => {
    expect(envelopeFromRequest('how do I update the parser?')).toBeNull();
    expect(envelopeFromRequest('why is the build failing?')).toBeNull();
  });

  it('grants for the live regression turn (question + directive in one message)', () => {
    // Verbatim from session f624a182, turn 38.
    const live =
      'why are you asking me this again and again ? 🤔 Apply a safe expression parser ' +
      '(supporting parentheses, advanced functions, and a degree/radian toggle) by ' +
      'updating script.js — replace calculate & scientific functions';
    const env = envelopeFromRequest(live);
    expect(env).not.toBeNull();
    // The whole point: the leading question does NOT revoke the directive.
    expect(env!.goal).toContain('Apply a safe expression parser');
  });

  it('scopes to the path the request NAMES', () => {
    const env = envelopeFromRequest('create the story at /Users/me/story/kharig-nights.md');
    expect(env).not.toBeNull();
    expect(env!.scope.paths).toEqual(['/Users/me/story/kharig-nights.md']);
  });

  it('leaves the scope open for a project-wide request (no path named)', () => {
    const env = envelopeFromRequest(REQUEST);
    expect(env!.scope.paths).toEqual([]);
  });
});

describe('envelopeFromPlan — the approve-once path', () => {
  it('records the plan approval as the source', () => {
    const env = envelopeFromPlan('Fix the calculator parser and add tests');
    expect(env.source).toBe('plan-approval');
    expect(env.goal).toContain('Fix the calculator parser');
    expect(env.scope.paths).toEqual([]);
  });

  it('honours the paths the plan named', () => {
    const env = envelopeFromPlan('Parser work', ['script.js', 'src/']);
    expect(env.scope.paths).toEqual(['script.js', 'src']);
  });
});

describe('the store — per conversation, and it expires', () => {
  it('round-trips a grant against a session handle', () => {
    const key = session();
    const env = envelopeFromPlan('Do the thing');
    grantEnvelope(key, env);
    expect(getEnvelope(key)?.goal).toBe('Do the thing');
  });

  it('returns null for no key, a non-object key, or no grant', () => {
    expect(getEnvelope(undefined)).toBeNull();
    expect(isEnvelopeKey('a-string')).toBe(false);
    expect(getEnvelope(session())).toBeNull();
  });

  it('EXPIRES — a stale grant can never be observed', () => {
    const key = session();
    grantEnvelope(key, envelopeFromPlan('Yesterday’s plan'));
    // One millisecond past the TTL the grant is gone, and asking again is the
    // safe direction: the failure mode is a prompt, never silent autonomy.
    expect(getEnvelope(key, Date.now() + ENVELOPE_TTL_MS + 1)).toBeNull();
    expect(getEnvelope(key, Date.now() + ENVELOPE_TTL_MS + 1)).toBeNull();
  });

  it('can be revoked', () => {
    const key = session();
    grantEnvelope(key, envelopeFromPlan('Do the thing'));
    clearEnvelope(key);
    expect(getEnvelope(key)).toBeNull();
  });

  it('does not leak across conversations', () => {
    const a = session();
    const b = session();
    grantEnvelope(a, envelopeFromPlan('Conversation A'));
    expect(getEnvelope(b)).toBeNull();
  });
});

describe('envelopeCoversAction', () => {
  const env: IntentEnvelope = envelopeFromPlan('Fix the calculator');

  it('covers reversible work inside the intent', () => {
    expect(envelopeCoversAction(env, { tool: 'edit_file', path: 'script.js', changeClass: 'modify' }).covered).toBe(true);
    expect(envelopeCoversAction(env, { tool: 'run_terminal', changeClass: 'local-state' }).covered).toBe(true);
    expect(envelopeCoversAction(env, { tool: 'git', changeClass: 'local-state' }).covered).toBe(true);
  });

  it('never covers a question with no grant (the original strictness)', () => {
    expect(envelopeCoversAction(null, { tool: 'edit_file', changeClass: 'modify' }).covered).toBe(false);
    expect(envelopeCoversAction(undefined, { tool: 'edit_file', changeClass: 'modify' }).covered).toBe(false);
  });

  it('NEVER covers external or destructive — a plan is not a licence to publish or delete', () => {
    for (const changeClass of ['external', 'destructive'] as const) {
      const verdict = envelopeCoversAction(env, { tool: 'edit_file', changeClass });
      expect(verdict.covered).toBe(false);
      expect(verdict.reason).toMatch(/never a/i);
    }
  });

  it('covers only the tools in its scope', () => {
    const scoped: IntentEnvelope = { ...env, scope: { paths: [], tools: ['edit_file'] } };
    expect(envelopeCoversAction(scoped, { tool: 'edit_file', changeClass: 'modify' }).covered).toBe(true);
    expect(envelopeCoversAction(scoped, { tool: 'run_terminal', changeClass: 'local-state' }).covered).toBe(false);
  });

  it('enforces named paths, and treats an empty path list as the whole workspace', () => {
    const scoped: IntentEnvelope = { ...env, scope: { paths: ['src/'], tools: [] } };
    expect(envelopeCoversAction(scoped, { tool: 'edit_file', path: 'src/a.ts', changeClass: 'modify' }).covered).toBe(true);
    expect(envelopeCoversAction(scoped, { tool: 'edit_file', path: 'script.js', changeClass: 'modify' }).covered).toBe(false);
    // …while a project-wide grant covers any path in the workspace.
    expect(envelopeCoversAction(env, { tool: 'edit_file', path: 'anything.js', changeClass: 'modify' }).covered).toBe(true);
  });
});

describe('envelopeNamesPath — the whole-file-overwrite guard', () => {
  it('is FALSE for a project-wide grant', () => {
    // "fix the calculator" authorizes edits, but must NOT authorize replacing a
    // file the request never mentioned — a re-run cannot recover that.
    const env = envelopeFromRequest(REQUEST);
    expect(envelopeNamesPath(env, 'index.html')).toBe(false);
  });

  it('is TRUE for a path the request or plan named', () => {
    const fromPlan = envelopeFromPlan('Rewrite the shell', ['index.html']);
    expect(envelopeNamesPath(fromPlan, 'index.html')).toBe(true);
    const fromRequest = envelopeFromRequest('create the story at /Users/me/story/kharig.md');
    expect(envelopeNamesPath(fromRequest, '/Users/me/story/kharig.md')).toBe(true);
  });

  it('is false without an envelope', () => {
    expect(envelopeNamesPath(null, 'index.html')).toBe(false);
  });
});
