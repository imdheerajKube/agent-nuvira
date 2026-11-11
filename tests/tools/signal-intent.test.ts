/**
 * Signal INTENT, not spelling.
 *
 * The old floor refused `/kill\s+-9\b/` and nothing else, so four equivalent
 * spellings of the same forced kill passed, and the graceful form of a normal
 * restart was refused. These tests pin the behaviour that replaces it:
 *
 *   - every spelling of SIGKILL is recognised as the same intent;
 *   - a forced stop of a pid this session OWNS is allowed (supervisor action);
 *   - a forced stop of a pid it does not own is refused, naming the rule;
 *   - a forced stop by name/pattern is refused before it can kill a stranger;
 *   - graceful mass stops are refused; graceful single stops are confirm-class.
 */

import { describe, it, expect, beforeEach } from 'vitest';

import {
  classifySignalCommand,
  decideSignalCommand,
  isOwnedPid,
  parseSignalCommand,
  registerOwnedPid,
  resetOwnedPids,
  unregisterOwnedPid,
} from '../../src/tools/signal-intent.js';
import { describeDenial } from '../../src/tools/run-terminal.js';

beforeEach(() => resetOwnedPids());

describe('parseSignalCommand', () => {
  it('parses kill -9 as a forced single-pid operation', () => {
    const parsed = parseSignalCommand('kill -9 1234');
    expect(parsed).toMatchObject({ tool: 'kill', signal: 'KILL', force: true, scope: 'single', pid: 1234 });
  });

  it('parses every spelling of SIGKILL identically', () => {
    for (const command of [
      'kill -9 1234',
      'kill -KILL 1234',
      'kill -SIGKILL 1234',
      'kill -s KILL 1234',
      'kill -s 9 1234',
      'kill --signal=9 1234',
      'kill --signal=KILL 1234',
    ]) {
      expect(parseSignalCommand(command), command).toMatchObject({ force: true, scope: 'single', pid: 1234 });
    }
  });

  it('defaults to TERM for a bare kill (not forced)', () => {
    expect(parseSignalCommand('kill 4412')).toMatchObject({ signal: 'TERM', force: false, pid: 4412 });
  });

  it('classifies killall as a mass stop and pkill as a pattern stop', () => {
    expect(parseSignalCommand('killall node')).toMatchObject({ tool: 'killall', scope: 'mass' });
    expect(parseSignalCommand('pkill -9 node')).toMatchObject({ tool: 'pkill', scope: 'pattern', force: true });
    expect(parseSignalCommand('pkill -9 -f "vite --port 5173"')).toMatchObject({
      tool: 'pkill', scope: 'pattern', force: true, pattern: 'vite --port 5173',
    });
  });

  it('finds a signal operation after a separator or env assignment', () => {
    expect(parseSignalCommand('npm run build && kill -9 1234')).toMatchObject({ force: true, pid: 1234 });
    expect(parseSignalCommand('FOO=1 kill 1234')).toMatchObject({ pid: 1234 });
  });

  it('returns null for commands that are not signal operations', () => {
    expect(parseSignalCommand('rg "kill -9" src')).toBeNull();
    expect(parseSignalCommand('npm test')).toBeNull();
  });
});

describe('decideSignalCommand', () => {
  it('refuses a forced kill of a pid the session does not own, naming the rule', () => {
    const decision = classifySignalCommand('kill -9 1234');
    expect(decision?.action).toBe('deny');
    expect(decision?.rule).toBe('forced kill');
    expect(decision?.reason).toContain('does not own');
  });

  it('allows a forced kill of a pid this session owns (supervisor reap)', () => {
    registerOwnedPid(1234);
    const decision = classifySignalCommand('kill -9 1234');
    expect(decision?.action).toBe('allow');
  });

  it('allows a graceful stop of an owned pid without a prompt', () => {
    registerOwnedPid(1234);
    expect(classifySignalCommand('kill 1234')?.action).toBe('allow');
  });

  it('asks once for a graceful stop of an unowned pid', () => {
    const decision = classifySignalCommand('kill 1234');
    expect(decision?.action).toBe('confirm');
  });

  it('refuses a forced stop by pattern before it can kill a stranger', () => {
    const decision = classifySignalCommand('pkill -9 -f node');
    expect(decision?.action).toBe('deny');
    expect(decision?.rule).toBe('forced mass kill');
  });

  it('refuses a mass stop by name', () => {
    const decision = classifySignalCommand('killall node');
    expect(decision?.action).toBe('deny');
    expect(decision?.rule).toBe('mass process kill');
  });

  it('asks once for a graceful bounded pattern stop', () => {
    expect(classifySignalCommand('pkill -TERM -f "vite --port 5173"')?.action).toBe('confirm');
  });

  it('drops ownership when the child exits (a reused pid is not ours)', () => {
    registerOwnedPid(1234);
    expect(isOwnedPid(1234)).toBe(true);
    unregisterOwnedPid(1234);
    expect(isOwnedPid(1234)).toBe(false);
    expect(classifySignalCommand('kill -9 1234')?.action).toBe('deny');
  });

  it('treats this process as owned', () => {
    expect(decideSignalCommand({
      tool: 'kill', signal: 'KILL', force: true, scope: 'single', pid: process.pid,
    }).action).toBe('allow');
  });
});

describe('the tool floor uses the intent classifier', () => {
  it('refuses the unowned forced kill by rule name', () => {
    expect(describeDenial('kill -9 1234')).toBe('forced kill');
  });

  it('refuses every equivalent spelling with the same rule', () => {
    for (const command of ['kill -KILL 1234', 'kill -s KILL 1234', 'kill --signal=9 1234']) {
      expect(describeDenial(command), command).toBe('forced kill');
    }
  });

  it('allows the owned forced kill through the floor', () => {
    registerOwnedPid(1234);
    expect(describeDenial('kill -9 1234')).toBeUndefined();
  });

  it('keeps privilege escalation ahead of the signal rules', () => {
    expect(describeDenial('sudo kill -9 1')).toBe('privilege escalation');
  });

  it('refuses forced and mass pattern stops by name', () => {
    expect(describeDenial('pkill -9 node')).toBe('forced mass kill');
    expect(describeDenial('killall node')).toBe('mass process kill');
  });

  it('does not treat the word kill inside a quoted search as a signal operation', () => {
    expect(describeDenial('rg "kill -9" src')).toBeUndefined();
  });
});
