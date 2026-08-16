import { describe, it, expect } from 'vitest';
import { splitCommand, stripCliPrefix } from '../../src/tools/run-cli.js';
import { resolveAsk } from '../../src/commands/intent-router.js';

describe('run_cli — command splitting', () => {
  it('splits simple argv', () => {
    expect(splitCommand('buff gateway stop')).toEqual(['buff', 'gateway', 'stop']);
  });

  it('strips the buff/bin prefix so the spawn hits the real subcommand', () => {
    expect(stripCliPrefix(['buff', 'gateway', 'stop'])).toEqual(['gateway', 'stop']);
    expect(stripCliPrefix(['gateway', 'status'])).toEqual(['gateway', 'status']);
    expect(stripCliPrefix(['agent-nuvira', 'doctor'])).toEqual(['doctor']);
  });

  it('honors double and single quotes (spaces inside quotes stay one arg)', () => {
    expect(splitCommand('buff gateway send ops "nightly build done"')).toEqual([
      'buff',
      'gateway',
      'send',
      'ops',
      'nightly build done',
    ]);
    expect(splitCommand("buff chat 'hi there'")).toEqual(['buff', 'chat', 'hi there']);
  });

  it('handles empty / whitespace-only input', () => {
    expect(splitCommand('')).toEqual([]);
    expect(splitCommand('   ')).toEqual([]);
  });
});

describe('run_cli — manifest resolution (the tool feeds resolveAsk)', () => {
  it('resolves stop/kill/bounce dashboard to dashboard.stop', () => {
    for (const ask of ['stop the dashboard', 'kill dashboard', 'bounce the dashboard']) {
      const top = resolveAsk(ask)[0];
      expect(top?.intent, ask).toBe('dashboard.stop');
      expect(top?.confirmation).toBe(true);
    }
  });

  it('marks add-contact asks ambiguous so the agent asks before running', () => {
    const top = resolveAsk('add Rahul mobile +919958604222 to whatsapp')[0];
    expect(top?.ambiguous).toBe(true);
    expect(top?.options?.length).toBe(2);
  });

  it('resolves run-the-eval-suite to an executable (non-confirm) command', () => {
    const top = resolveAsk('run the eval suite')[0];
    expect(top?.intent).toBe('eval.run');
    expect(top?.confirmation).toBe(false);
    expect(top?.command).toContain('buff eval run');
  });
});
