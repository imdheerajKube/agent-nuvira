/**
 * The durable monitored-run registry — the part that has to outlive the process.
 *
 * Two facts must survive a restart or a crash: WHAT is running (so it can still
 * be polled and collected) and WHAT IT SAID (so a diagnosis is not missing the
 * beginning of a long run). These tests pin the machinery underneath that — the
 * bounded window, the spool's head/tail discipline, and the pid-identity check
 * that keeps a recovered run from ever signalling a stranger's process.
 */

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';

import { killProcessTree, lookupProcess } from '../../src/tools/process-liveness.js';
import {
  SPOOL_HEAD_BYTES,
  SPOOL_TAIL_BYTES,
  SpoolWriter,
  commandMatchesProcess,
  loadRuns,
  outputWindow,
  processIdentityCheck,
  processIdentityMatches,
  processIdentityVerdict,
  runsDir,
  saveRun,
  spoolPath,
  spoolBytes,
  sweepSpools,
} from '../../src/tools/run-registry.js';

let configDir: string;
const created: string[] = [];

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'buff-registry-'));
  created.push(configDir);
  // `resolveNuviraDataPath` reads this at CALL time, so pointing it here keeps
  // every test out of the developer's real ~/.nuvira.
  process.env.NUVIRA_CONFIG_DIR = configDir;
});

afterAll(() => {
  delete process.env.NUVIRA_CONFIG_DIR;
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const longText = (chars: number, marker = 'x'): string => marker.repeat(chars);

describe('outputWindow — the head is kept, the middle is what goes', () => {
  it('passes short output through untouched', () => {
    const window = outputWindow('a\nb\nc', 1_000);
    expect(window.text).toBe('a\nb\nc');
    expect(window.omittedChars).toBe(0);
  });

  it('keeps the BEGINNING and the END of a long run, and says what it dropped', () => {
    // The defect this exists for: the in-memory buffer is a bounded TAIL, so the
    // first line — what was run and what it was doing — was simply gone.
    const text = `${'HEAD-LINE\n'}${longText(100_000)}${'TAIL-LINE\n'}`;
    const window = outputWindow(text, 4_000);
    expect(window.text).toContain('HEAD-LINE');
    expect(window.text).toContain('TAIL-LINE');
    expect(window.text).toContain('characters omitted');
    expect(window.omittedChars).toBeGreaterThan(0);
    // Bounded: the window never grows past what the caller asked for.
    expect(window.text.length).toBeLessThanOrEqual(4_000 + 200);
  });
});

describe('SpoolWriter — bounded on disk, head and tail readable', () => {
  it('writes NOTHING before the run is durable — the config dir stays clean', () => {
    // The defect this pins. Spooling started at SPAWN, so the first output chunk
    // created `<config>/run-terminal/out/<id>.log` in the developer's REAL profile
    // for every command that then finished inside its wait budget — a file the run
    // deleted on its way out, leaving the directory behind. A run that never hands
    // off has no registry entry, so nobody could have read that file anyway.
    const spool = new SpoolWriter('run-not-durable');
    spool.write('output while still inside the wait budget\n');
    expect(existsSync(spoolPath('run-not-durable'))).toBe(false);
    expect(existsSync(join(runsDir(), 'out'))).toBe(false);
    // Flushing on the way out still writes nothing — a run that finished inside
    // its wait budget is discarded, and its spool must never have existed.
    spool.flush();
    expect(existsSync(spoolPath('run-not-durable'))).toBe(false);
    const discarded = new SpoolWriter('run-discarded-early');
    discarded.write('never collected\n');
    discarded.close();
    discarded.discard();
    expect(existsSync(spoolPath('run-discarded-early'))).toBe(false);
    expect(existsSync(join(runsDir(), 'out'))).toBe(false);

    // …and the buffered head/tail is NOT lost: the moment the run becomes
    // durable, the whole window lands — including the bytes written before it.
    spool.startPersisting();
    spool.flush();
    expect(readFileSync(spoolPath('run-not-durable'), 'utf-8')).toBe(
      'output while still inside the wait budget\n',
    );
  });

  it('keeps the WHOLE run while it fits under the cap — the middle is not lost', () => {
    // The trade this replaces: a bounded window throws away the middle of a long
    // run, and that is where a failure explains itself. Most runs are far under
    // the cap, so for them nothing is dropped at all.
    const spool = new SpoolWriter('run-middle');
    spool.startPersisting();
    spool.write('FIRST-LINE\n');
    for (let i = 0; i < 100; i++) spool.write(longText(1_000, 'a'));
    spool.write('\nMIDDLE-LINE-THAT-MATTERS\n');
    for (let i = 0; i < 100; i++) spool.write(longText(1_000, 'b'));
    spool.write('LAST-LINE\n');
    spool.close();

    const text = readFileSync(spoolPath('run-middle'), 'utf-8');
    expect(text).toContain('FIRST-LINE');
    expect(text).toContain('LAST-LINE');
    expect(text).toContain('MIDDLE-LINE-THAT-MATTERS');
    expect(text).not.toContain('characters omitted');
    // ~200KB written, and all of it is there.
    expect(text.length).toBeGreaterThan(150_000);
  });

  it('past the cap it collapses ONCE to head+tail, and says how much it dropped', () => {
    const spool = new SpoolWriter('run-head');
    spool.startPersisting();
    spool.write('UNIQUE-HEAD-BYTE-1\n');
    // 3MB: past the 2MB full-log cap, so the file must stop growing.
    for (let i = 0; i < 3_000; i++) spool.write(longText(1_000, 'a'));
    spool.write('\nUNIQUE-TAIL-BYTE-9\n');
    spool.close();

    const text = readFileSync(spoolPath('run-head'), 'utf-8');
    expect(text).toContain('UNIQUE-HEAD-BYTE-1');
    expect(text).toContain('UNIQUE-TAIL-BYTE-9');
    // The file is the head+tail window (plus the omission marker, the only thing
    // allowed past it) — a chatty command cannot fill the disk.
    expect(text.length).toBeLessThanOrEqual(SPOOL_HEAD_BYTES + SPOOL_TAIL_BYTES + 300);
    expect(text).toContain('characters omitted');
  });

  it('the cap can be turned off, restoring an always-bounded window', () => {
    // `NUVIRA_RUN_LOG_FULL_BYTES=0` is the operator's way of saying "never keep
    // more than the window", and it is also how a test can pin the old shape.
    const spool = new SpoolWriter('run-capped', SPOOL_HEAD_BYTES, SPOOL_TAIL_BYTES, undefined, 0);
    spool.startPersisting();
    spool.write('HEAD\n');
    for (let i = 0; i < 200; i++) spool.write(longText(1_000, 'z'));
    spool.write('\nTAIL\n');
    spool.close();
    const text = readFileSync(spoolPath('run-capped'), 'utf-8');
    expect(text.length).toBeLessThanOrEqual(SPOOL_HEAD_BYTES + SPOOL_TAIL_BYTES + 300);
    expect(text).toContain('characters omitted');
  });

  it('stores a SHORT run once — the head is not also written as the tail', () => {
    const spool = new SpoolWriter('run-size');
    spool.startPersisting();
    spool.write('hello');
    spool.close();
    expect(spoolBytes('run-size')).toBe(5);
    expect(readFileSync(spoolPath('run-size'), 'utf-8')).toBe('hello');
  });

  it('sweeps spools nothing refers to — the log dir cannot grow forever', () => {
    const kept = new SpoolWriter('run-kept');
    kept.startPersisting();
    kept.write('live output\n');
    kept.close();
    const orphan = new SpoolWriter('run-orphan');
    orphan.startPersisting();
    orphan.write('from a run the registry no longer knows\n');
    orphan.close();
    expect(existsSync(spoolPath('run-orphan'))).toBe(true);

    sweepSpools(['run-kept']);
    expect(existsSync(spoolPath('run-kept'))).toBe(true);
    expect(existsSync(spoolPath('run-orphan'))).toBe(false);
  });

  it('discard() removes the spool — a run that finished inside its budget leaves nothing', () => {
    const spool = new SpoolWriter('run-discard');
    spool.startPersisting();
    spool.write('transient');
    spool.close();
    expect(existsSync(spoolPath('run-discard'))).toBe(true);
    spool.discard();
    expect(existsSync(spoolPath('run-discard'))).toBe(false);
    // …and a late write after discard must not resurrect it.
    spool.write('too late');
    expect(existsSync(spoolPath('run-discard'))).toBe(false);
  });
});

/**
 * Identity: pid is a NUMBER the kernel reuses, so it is a hint and never a
 * proof. These pin the rule that turns two hints into a decision — and, just as
 * importantly, the branches where the answer has to stay "I cannot tell".
 */
describe('processIdentityVerdict — the rule that keeps a recycled pid from becoming ours', () => {
  const live = (over: Partial<{ found: boolean; command: string | null; startedAtText: string | null }> = {}) => ({
    found: true,
    command: 'node dist/index.js release:gate',
    startedAtText: 'T1',
    ...over,
  });
  const recorded = { command: 'node dist/index.js release:gate', osStartedAt: 'T1' };

  it('accepts only when the witnesses agree (or the second one was never recorded)', () => {
    expect(processIdentityVerdict(recorded, live())).toBe(true);
    // A record written before the start token existed: the command line is the
    // only witness, exactly as before — the token ADDS checks, it does not
    // invalidate old records.
    expect(processIdentityVerdict({ command: recorded.command }, live())).toBe(true);
    expect(processIdentityVerdict(recorded, live({ startedAtText: null }))).toBe(true);
  });

  it('REFUSES a recycled pid running the SAME command line (the new protection)', () => {
    // The case command matching alone cannot see, and the reason a pid plus a
    // command line is not identity: another `npm test`, in another directory,
    // adopted because it looks the same.
    expect(processIdentityVerdict(recorded, live({ startedAtText: 'T2' }))).toBe(false);
    // …and the evidence says WHY, because the consequence is a command that keeps
    // running and can only be stopped by hand.
    const check = processIdentityCheck(recorded, live({ startedAtText: 'T2' }));
    expect(check.verdict).toBe(false);
    expect(check.why).toContain('RECYCLED');
    expect(check.why).toContain('T2');
  });

  it('refuses a different command line even when the start token matches', () => {
    // A witness may VETO. The start token agreeing is not a licence to signal a
    // process that is plainly running something else.
    const check = processIdentityCheck(recorded, live({ command: 'sleep 30' }));
    expect(check.verdict).toBe(false);
    expect(check.why).toContain('different command line');
  });

  it('ACCEPTS on the start token alone when the command line cannot be read', () => {
    // The value of the token in one line: some platforms hide command lines, and
    // a kernel process has none. Before this, such a run could be followed but
    // never stopped — the token is a value the OS does not hand out twice.
    const check = processIdentityCheck(recorded, live({ command: null }));
    expect(check.verdict).toBe(true);
    expect(check.why).toContain('command line could not be read');
  });

  it('recognises OUR OWN process when the shell reports it with ESCAPED quotes (the Windows shape)', () => {
    // What Windows hands back is the SHELL's own line, so the quotes of the
    // command we recorded arrive escaped: `bash.exe -c "node -e \"…\""`,
    // `cmd.exe /d /s /c "…"`. Stripping the quote but keeping its backslash left
    // `node -e \for (…)`, which does not contain `node -e for (…)` — and the
    // consequence was not cosmetic: a run recovered from the registry refused to
    // stop the process it had started itself, saying the pid ran a different
    // command line (observed on the Windows CI runners).
    const command = 'node -e "for (let i = 0; i < 400; i++) console.log(\'line-\' + i)"';
    const shellLine =
      '"C:\\Program Files\\Git\\bin\\bash.exe" -c "node -e \\"for (let i = 0; i < 400; i++) console.log(\'line-\' + i)\\""';
    const check = processIdentityCheck(
      { command },
      { found: true, command: shellLine, startedAtText: null },
    );
    expect(check.verdict, check.why).toBe(true);

    // …and unescaping must not turn a STRANGER into ours: the same wrapper around
    // a DIFFERENT inner command is still refused.
    const stranger = '"C:\\Program Files\\Git\\bin\\bash.exe" -c "node -e \\"console.log(1)\\""';
    expect(
      processIdentityCheck({ command }, { found: true, command: stranger, startedAtText: null }).verdict,
    ).toBe(false);
  });

  it('stays UNKNOWN when nothing can be read — never "ours" and never "gone"', () => {
    expect(processIdentityVerdict(recorded, null)).toBeNull(); // no process table
    expect(processIdentityVerdict(recorded, live({ command: null, startedAtText: null }))).toBeNull();
    // A start token that disagrees plus no command line is a refusal to decide,
    // not an adoption.
    expect(processIdentityVerdict(recorded, live({ command: null, startedAtText: 'T2' }))).toBeNull();
    // …and a pid that is simply not there is DEFINITELY not ours (a fact, not an
    // absence of one).
    expect(processIdentityVerdict(recorded, live({ found: false }))).toBe(false);
  });

  it('answers against a REAL process: the same run is ours, a stranger is not', async () => {
    const child = spawn(wrappable(8_000), { shell: true, stdio: 'ignore' });
    try {
      await new Promise((r) => setTimeout(r, 300));
      const token = lookupProcess(child.pid!)?.startedAtText ?? null;
      // Whatever the platform reports (the shell may have exec'd into `sleep`).
      const line = lookupProcess(child.pid!)?.command ?? null;
      expect(line).toBeTruthy();
      expect(processIdentityMatches(child.pid!, { command: line! })).toBe(true);
      if (token) {
        expect(processIdentityMatches(child.pid!, { command: line!, osStartedAt: token })).toBe(true);
        // The token from a DIFFERENT moment cannot belong to this process — this
        // is the recycled-pid case, driven against a live table.
        expect(processIdentityMatches(child.pid!, { command: line!, osStartedAt: `${token}9` })).toBe(
          false,
        );
      }
      // A record for some other command is refused even though the pid is alive.
      expect(processIdentityMatches(child.pid!, { command: 'node dist/index.js release:gate' })).toBe(
        false,
      );
      // A pid nobody is using is not ours either.
      expect(processIdentityMatches(2 ** 30, { command: wrappable(8_000) })).toBe(false);
    } finally {
      killProcessTree(child.pid!, 'SIGKILL', child);
    }
  }, 20_000);
});

describe('saveRun / loadRuns — the registry outlives the process, and is bounded', () => {
  it('round-trips a live run and a finished one', () => {
    saveRun({ id: 'a', command: 'npm test', cwd: '/tmp', pid: 4321, startedAt: 1, status: 'running', exitCode: null });
    saveRun({ id: 'b', command: 'npm run build', cwd: '/tmp', pid: 4322, startedAt: 2, status: 'done', exitCode: 0, endedAt: 3 });
    const runs = loadRuns();
    expect(runs.map((r) => r.id).sort()).toEqual(['a', 'b']);
    expect(runs.find((r) => r.id === 'b')!.exitCode).toBe(0);
  });

  it('a corrupt registry reads as EMPTY, never as a throw', () => {
    saveRun({ id: 'a', command: 'npm test', cwd: '/tmp', pid: 1, startedAt: 1, status: 'running', exitCode: null });
    writeFileSync(join(runsDir(), 'runs.json'), '{ this is not json');
    expect(loadRuns()).toEqual([]);
  });

  it('caps history while NEVER dropping a live run', () => {
    for (let i = 0; i < 40; i++) {
      saveRun({ id: `done-${i}`, command: 'x', cwd: '/tmp', pid: 100 + i, startedAt: i, status: 'done', exitCode: 0, endedAt: i });
    }
    saveRun({ id: 'live', command: 'npm test', cwd: '/tmp', pid: 999, startedAt: 99, status: 'running', exitCode: null });
    const runs = loadRuns();
    expect(runs.length).toBeLessThanOrEqual(30);
    // The one that matters most is the one still going.
    expect(runs.map((r) => r.id)).toContain('live');
  });
});

/**
 * A compound command that EXISTS IN BOTH SHELLS — cmd.exe on Windows, /bin/sh
 * elsewhere — because that is what `spawn(..., { shell: true })` uses.
 *
 * `sleep 30` is not a long-running command on Windows: it is a command that does
 * not exist, so the child was already gone when these assertions ran and they
 * failed with "the pid is not running any more" rather than testing identity.
 * `node` is on PATH wherever this suite runs, and `&& echo done` keeps the
 * command compound, so the shell stays as the parent and the line we read back
 * really is the wrapper that carries the command (which is the case under test).
 */
const wrappable = (ms: number) => `node -e "setTimeout(() => {}, ${ms})" && echo done`;

describe('commandMatchesProcess — never adopt a stranger by pid', () => {
  it('recognises the shell wrapper we spawn', async () => {
    const command = wrappable(30_000);
    const child = spawn(command, { shell: true, stdio: 'ignore' });
    try {
      await new Promise((r) => setTimeout(r, 300));
      expect(commandMatchesProcess(child.pid!, command)).toBe(true);
    } finally {
      // The whole tree: `child.kill()` alone leaves the `sleep` grandchild behind,
      // and leaked children are what make this suite's slow files flaky under load.
      killProcessTree(child.pid!, 'SIGKILL', child);
    }
  }, 20_000);

  it('recognises a command the shell exec\'d, quotes and all', async () => {
    const command = 'node -e "setTimeout(() => {}, 30000)"';
    const child = spawn(command, { shell: true, stdio: 'ignore' });
    try {
      await new Promise((r) => setTimeout(r, 400));
      // The shell strips the quotes before the process exists, so the raw text
      // differs from the process line — identity must survive that.
      expect(commandMatchesProcess(child.pid!, command)).toBe(true);
    } finally {
      killProcessTree(child.pid!, 'SIGKILL', child);
    }
  }, 20_000);

  it('rejects a DIFFERENT command on a live pid', async () => {
    const child = spawn(wrappable(30_000), { shell: true, stdio: 'ignore' });
    try {
      await new Promise((r) => setTimeout(r, 300));
      expect(commandMatchesProcess(child.pid!, 'npm test')).toBe(false);
      // A bare binary name must not satisfy a long recorded command — that is how
      // a recycled pid would be adopted and signalled.
      expect(commandMatchesProcess(child.pid!, `${wrappable(30_000)}; rm -rf ./build`)).toBe(false);
    } finally {
      killProcessTree(child.pid!, 'SIGKILL', child);
    }
  }, 20_000);

  it('reports "unknown" for a pid that is gone, and false for nonsense', async () => {
    const child = spawn(wrappable(30_000), { shell: true, stdio: 'ignore' });
    const pid = child.pid!;
    killProcessTree(pid, 'SIGKILL', child);
    await new Promise((r) => setTimeout(r, 500));
    expect(commandMatchesProcess(pid, wrappable(30_000))).not.toBe(true);
    expect(commandMatchesProcess(-1, wrappable(30_000))).toBe(false);
    expect(commandMatchesProcess(0, wrappable(30_000))).toBe(false);
  }, 20_000);
});

describe('the registry is not the developer\'s real profile', () => {
  it('writes under the isolated config dir', () => {
    saveRun({ id: 'iso', command: 'x', cwd: '/tmp', pid: 1, startedAt: 1, status: 'running', exitCode: null });
    expect(runsDir().startsWith(configDir)).toBe(true);
    expect(statSync(join(runsDir(), 'runs.json')).size).toBeGreaterThan(0);
  });
});
