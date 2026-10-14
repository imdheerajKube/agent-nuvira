/**
 * Process liveness — the mechanism that tells a HANG from a slow command.
 *
 * The whole point of handing a long command to monitoring (instead of killing it
 * at a clock) is that the work finishes. The hole it left is a command that is
 * genuinely STUCK: a prompt with no stdin, a lock, a socket that never answers.
 * Silence alone cannot identify one — a real test suite is quiet for minutes —
 * so the discriminator is CPU, and these tests pin the rules that follow from
 * that: recent output is WORKING, advancing CPU is WORKING, and only silence
 * PLUS a measurable absence of CPU is HUNG. Everything unprovable is `stalled`,
 * which is reported and never reaped on a guess.
 */

import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';

import {
  DEFAULT_LIVENESS_THRESHOLDS,
  classifyLiveness,
  formatSpan,
  killProcessTree,
  livenessThresholds,
  lookupProcess,
  parseCpuTime,
  parsePosixProcessTable,
  parseWindowsProcessTable,
  parseWmicProcessTable,
  processTreeOf,
  sampleProcessTree,
  type LivenessInput,
} from '../../src/tools/process-liveness.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A fast-forwarded input: the fields a caller actually varies in a test. */
function input(overrides: Partial<LivenessInput> = {}): LivenessInput {
  return {
    alive: true,
    bytes: 0,
    quietMs: 0,
    ageMs: 60_000,
    cpuMs: 1_000,
    prevCpuMs: 1_000,
    sampleWindowMs: 30_000,
    ...overrides,
  };
}

describe('parseCpuTime — every format `ps -o time=` really emits', () => {
  it('parses macOS MM:SS.cc, Linux HH:MM:SS and BSD DD-HH:MM:SS', () => {
    expect(parseCpuTime('0:00.08')).toBe(80);
    expect(parseCpuTime('1:36.53')).toBe(96_530);
    expect(parseCpuTime('00:00:06')).toBe(6_000);
    expect(parseCpuTime('10:20:30')).toBe(10 * 3_600_000 + 20 * 60_000 + 30_000);
    expect(parseCpuTime('2-10:20:30')).toBe(
      (2 * 24 * 3_600 + 10 * 3_600 + 20 * 60 + 30) * 1_000,
    );
  });

  it('returns null for anything it cannot read — "no reading" is not "no CPU"', () => {
    // A formatting change must not read as a hang: an unparsed value has to be
    // distinguishable from a real zero.
    for (const bad of ['', '  ', '-', 'n/a', 'abc', '1:2:3:4', '--:--']) {
      expect(parseCpuTime(bad), bad).toBeNull();
    }
  });
});

describe('classifyLiveness — innocent until proven hung', () => {
  it('a dead process is finished, never hung', () => {
    expect(classifyLiveness(input({ alive: false })).verdict).toBe('finished');
  });

  it('a command seconds old is starting — it has simply not spoken yet', () => {
    expect(classifyLiveness(input({ ageMs: 500 })).verdict).toBe('starting');
  });

  it('recent output is WORKING, even with no CPU shown', () => {
    const verdict = classifyLiveness(input({ bytes: 40, quietMs: 1_000, cpuMs: null, prevCpuMs: null }));
    expect(verdict.verdict).toBe('working');
    expect(verdict.why).toContain('output');
  });

  it('silence WITH advancing CPU is WORKING — that is a build, not a hang', () => {
    // The measured false-positive this rule exists to prevent: a quiet-but-busy
    // command must never be mistaken for a stuck one.
    const verdict = classifyLiveness(
      input({ quietMs: 120_000, cpuMs: 9_000, prevCpuMs: 8_000, sampleWindowMs: 30_000 }),
    );
    expect(verdict.verdict).toBe('working');
    expect(verdict.why).toContain('still computing');
  });

  it('silence AND no CPU for long enough is HUNG, with the evidence in the reason', () => {
    const verdict = classifyLiveness(
      input({ quietMs: 400_000, cpuMs: 1_000, prevCpuMs: 1_000, sampleWindowMs: 30_000 }),
      { ...DEFAULT_LIVENESS_THRESHOLDS, hangQuietMs: 300_000 },
    );
    expect(verdict.verdict).toBe('hung');
    expect(verdict.why).toContain('no output for');
    expect(verdict.why).toContain('no CPU');
  });

  it('a command that produced NOTHING at all, for a long time, with no CPU is HUNG', () => {
    // The interactive-prompt case: no output from the first byte. `quietMs` is
    // time since the start, and zero CPU proves nothing is being computed.
    const verdict = classifyLiveness(
      input({ bytes: 0, quietMs: 600_000, ageMs: 600_000, cpuMs: 3, prevCpuMs: 3 }),
    );
    expect(verdict.verdict).toBe('hung');
  });

  it('silence we cannot measure CPU for is STALLED, not hung — never reaped on a guess', () => {
    const verdict = classifyLiveness(input({ quietMs: 600_000, cpuMs: null, prevCpuMs: null }));
    expect(verdict.verdict).toBe('stalled');
    expect(verdict.why).toContain('not measurable');
  });

  it('a run that is quiet but not yet a confirmed hang is STALLED (reported, not stopped)', () => {
    const verdict = classifyLiveness(input({ quietMs: 90_000, cpuMs: 1_050, prevCpuMs: 1_000 }));
    expect(verdict.verdict).toBe('stalled');
  });

  it('the CPU floor is what separates "computing" from "idle"', () => {
    const busy = classifyLiveness(
      input({ quietMs: 400_000, cpuMs: 2_000, prevCpuMs: 1_000, sampleWindowMs: 30_000 }),
      { ...DEFAULT_LIVENESS_THRESHOLDS, hangCpuFloorMs: 500 },
    );
    const idle = classifyLiveness(
      input({ quietMs: 400_000, cpuMs: 1_005, prevCpuMs: 1_000, sampleWindowMs: 30_000 }),
      { ...DEFAULT_LIVENESS_THRESHOLDS, hangCpuFloorMs: 500 },
    );
    expect(busy.verdict).toBe('working');
    expect(idle.verdict).toBe('hung');
  });
});

describe('livenessThresholds — operator-tunable, read at call time', () => {
  it('defaults when nothing is set', () => {
    expect(livenessThresholds({})).toEqual(DEFAULT_LIVENESS_THRESHOLDS);
  });

  it('honours the env overrides and ignores junk', () => {
    const tuned = livenessThresholds({
      NUVIRA_HANG_QUIET_MS: '120000',
      NUVIRA_STALL_QUIET_MS: '5000',
      NUVIRA_HANG_CPU_MS: '250',
    });
    expect(tuned).toEqual({ stallQuietMs: 5_000, hangQuietMs: 120_000, hangCpuFloorMs: 250 });
    // Junk and negatives fall back rather than producing a 0ms hang threshold,
    // which would classify every quiet command as hung.
    expect(livenessThresholds({ NUVIRA_HANG_QUIET_MS: 'nope' })).toEqual(DEFAULT_LIVENESS_THRESHOLDS);
    expect(livenessThresholds({ NUVIRA_HANG_QUIET_MS: '-5' })).toEqual(DEFAULT_LIVENESS_THRESHOLDS);
    expect(livenessThresholds({ NUVIRA_HANG_QUIET_MS: '0' })).toEqual(DEFAULT_LIVENESS_THRESHOLDS);
  });
});

describe('sampleProcessTree — the TREE, not just the shell we hold the handle for', () => {
  it('finds the shell AND the real work underneath it', async () => {
    // A COMPOUND command is the case that matters: `/bin/sh -c 'sleep 5'` EXECs
    // the command (one process), but anything with `;` / `&&` / a pipe keeps the
    // shell as a parent — and then the work is a CHILD, so a sample that looked
    // only at the root would report the shell's own ~0 CPU while the build below
    // used a core.
    const child = spawn('sleep 5; echo done', { shell: true, stdio: 'ignore' });
    try {
      await sleep(300);
      const sample = sampleProcessTree(child.pid!);
      expect(sample.found).toBe(true);
      expect(sample.pids[0]).toBe(child.pid);
      expect(sample.pids.length).toBeGreaterThan(1);
      expect(sample.cpuMs).not.toBeNull();
    } finally {
      killProcessTree(child.pid!, 'SIGKILL', child);
    }
  }, 20_000);

  it('CPU separates a sleeping process from a busy one', async () => {
    const idle = spawn('sleep 5', { shell: true, stdio: 'ignore' });
    const busy = spawn('node -e "const t=Date.now(); while(Date.now()-t<1200){}"', {
      shell: true,
      stdio: 'ignore',
    });
    try {
      await sleep(900);
      const idleCpu = sampleProcessTree(idle.pid!).cpuMs ?? 0;
      const busyCpu = sampleProcessTree(busy.pid!).cpuMs ?? 0;
      expect(busyCpu).toBeGreaterThan(idleCpu);
      expect(busyCpu).toBeGreaterThan(100);
    } finally {
      // The TREE, not the shell: a bare `kill()` leaves the `sleep` grandchild
      // running, and this suite's own config names leaked children as the cause of
      // its load-dependent flakiness.
      killProcessTree(idle.pid!, 'SIGKILL', idle);
      killProcessTree(busy.pid!, 'SIGKILL', busy);
    }
  }, 20_000);

  it('a pid that is not a process yields an EMPTY sample, never the whole process table', () => {
    // `process.kill(-1, …)` signals every process the user can signal; the guard
    // that prevents it starts here.
    for (const bad of [0, -1, Number.NaN]) {
      expect(sampleProcessTree(bad)).toEqual({ found: false, cpuMs: null, pids: [] });
    }
  });
});

describe('the process table — one shape per platform, one rule on top', () => {
  it('parses `ps` output, command lines and all', () => {
    const table = parsePosixProcessTable(
      [
        '    1     0   1:36.53 /sbin/launchd',
        '  330     1   0:34.33 /usr/libexec/logd',
        '52714 52713   0:00.00 /bin/sh -c npm test -- --reporter dot',
        '52716 52714   0:00.00 node /repo/node_modules/.bin/vitest run',
      ].join('\n'),
    );
    expect(table.get(1)).toEqual({
      ppid: 0,
      cpuMs: 96_530,
      command: '/sbin/launchd',
      startedAtText: null,
    });
    // The command column is last precisely because it contains spaces and flags.
    expect(table.get(52714)!.command).toBe('/bin/sh -c npm test -- --reporter dot');
    expect(table.get(52716)).toEqual({
      ppid: 52714,
      cpuMs: 0,
      command: 'node /repo/node_modules/.bin/vitest run',
      startedAtText: null,
    });
  });

  it('parses the start-time column out of `ps -o …,lstart=,command=`', () => {
    // The second identity witness. It has to be read from the SAME column shape
    // as the command — `lstart` is five space-separated tokens, and the command
    // follows it — so this pins that neither is mistaken for the other.
    const table = parsePosixProcessTable(
      [
        '52714 52713   0:00.00 Tue Oct 14 15:02:03 2026 /bin/sh -c npm test -- --reporter dot',
        '52716 52714   0:01.20 Tue Oct 14 15:02:03 2026 node /repo/node_modules/.bin/vitest run',
      ].join('\n'),
    );
    expect(table.get(52714)).toEqual({
      ppid: 52713,
      cpuMs: 0,
      command: '/bin/sh -c npm test -- --reporter dot',
      startedAtText: 'Tue Oct 14 15:02:03 2026',
    });
    expect(table.get(52716)!.startedAtText).toBe('Tue Oct 14 15:02:03 2026');
    expect(table.get(52716)!.command).toBe('node /repo/node_modules/.bin/vitest run');

    // Column padding is NOT part of the value: two readings of the same process
    // must compare equal, or every identity check would refuse.
    const padded = parsePosixProcessTable('52714 52713 0:00.00  Tue   Oct 14 15:02:03 2026  /bin/sh -c x');
    expect(padded.get(52714)!.startedAtText).toBe('Tue Oct 14 15:02:03 2026');
    expect(padded.get(52714)!.command).toBe('/bin/sh -c x');
  });

  it('parses the Windows probe — pid|ppid|kernel|user|command — into the SAME units', () => {
    // Windows reports CPU in 100ns ticks, `ps` in ms; both must arrive as ms or
    // the CPU floor would mean something different on each platform.
    const table = parseWindowsProcessTable(
      [
        '1234|1|468750|9375000|C:\\Windows\\System32\\cmd.exe /c npm test',
        '5678|1234|0|0|C:\\Program Files\\nodejs\\node.exe dist/index.js test',
        '99|1234|||',
      ].join('\r\n'),
    );
    expect(table.get(1234)!.cpuMs).toBe(984); // (468750+9375000)/10000, rounded
    expect(table.get(1234)!.command).toContain('cmd.exe /c npm test');
    expect(table.get(5678)).toEqual({
      ppid: 1234,
      cpuMs: 0,
      command: 'C:\\Program Files\\nodejs\\node.exe dist/index.js test',
      startedAtText: null,
    });
    // An UNREADABLE counter stays unmeasurable — NOT zero. A zero here would be
    // "no CPU", which is the evidence that certifies a hang.
    expect(table.get(99)!.cpuMs).toBeNull();
    expect(table.get(99)!.command).toBeNull();
  });

  it('parses the wmic CSV fallback by HEADER, so column order cannot lie', () => {
    const table = parseWmicProcessTable(
      [
        'Node,UserModeTime,ProcessId,ParentProcessId,KernelModeTime',
        'HOST,9375000,1234,1,468750',
        'HOST,0,5678,1234,0',
      ].join('\r\n'),
    );
    expect(table.get(1234)).toEqual({ ppid: 1, cpuMs: 984, command: null, startedAtText: null });
    expect(table.get(5678)!.ppid).toBe(1234);
    // The process id column is the only one that must exist.
    expect(parseWmicProcessTable('Node,CommandLine\nHOST,whatever').size).toBe(0);
  });

  it('walks the tree from a Windows-shaped table too — a cmd → node → vitest chain', () => {
    const table = parseWindowsProcessTable(
      [
        '100|1|100000|100000|C:\\Windows\\System32\\cmd.exe /c npm test',
        '200|100|50000|150000|node dist/index.js test',
        '300|200|10000|20000|node vitest run',
      ].join('\r\n'),
    );
    const tree = processTreeOf(table, 100);
    expect(tree.found).toBe(true);
    expect(tree.pids).toEqual([100, 200, 300]);
    // (100000+100000) + (50000+150000) + (10000+20000) = 430000 ticks = 43ms
    expect(tree.cpuMs).toBe(43);
  });

  it('a tree with ONE unreadable counter is unmeasurable, not "no CPU"', () => {
    const table = parseWindowsProcessTable(
      ['100|1|100000|100000|cmd.exe /c npm test', '200|100|||node dist/index.js test'].join('\r\n'),
    );
    const tree = processTreeOf(table, 100);
    // Counting the readable part as a total would under-report the CPU and look
    // like a hang in progress; "unmeasurable" cannot certify one at all.
    expect(tree.pids).toEqual([100, 200]);
    expect(tree.cpuMs).toBeNull();
  });

  it('a pid that is not in the table is a not-found tree, never an empty success', () => {
    const table = parsePosixProcessTable(' 1 0 0:00.10 /sbin/launchd');
    expect(processTreeOf(table, 4242).found).toBe(false);
    expect(processTreeOf(table, -1)).toEqual({ found: false, cpuMs: null, pids: [] });
  });

  it('lookupProcess answers for the live process, and for nonsense', () => {
    const self = lookupProcess(process.pid);
    expect(self?.found).toBe(true);
    expect(self?.command ?? '').toMatch(/node/);
    expect(lookupProcess(-1)).toEqual({ found: false, command: null, startedAtText: null });
    expect(lookupProcess(0)).toEqual({ found: false, command: null, startedAtText: null });
  });
});

describe('the OS start token — the second identity witness', () => {
  it('reads Windows CreationDate ticks, and says "unknown" rather than shifting columns', () => {
    const table = parseWindowsProcessTable(
      [
        // The marked shape the probe actually emits: `t<ticks>` then the command.
        '1234|1|468750|9375000|t638960000000000000|C:\\Windows\\System32\\cmd.exe /c npm test',
        // CreationDate unreadable: bare `t`, so the COMMAND stays in its column
        // instead of being mistaken for a timestamp (and vice versa).
        '5678|1234|0|0|t|C:\\Program Files\\nodejs\\node.exe dist/index.js test',
        // The older 5-field shape still parses: no token, command at index 4.
        '99|1234|10000|20000|some-old-style-command --flag',
      ].join('\r\n'),
    );
    expect(table.get(1234)!.startedAtText).toBe('638960000000000000');
    expect(table.get(1234)!.command).toContain('cmd.exe /c npm test');
    expect(table.get(5678)!.startedAtText).toBeNull();
    expect(table.get(5678)!.command).toBe('C:\\Program Files\\nodejs\\node.exe dist/index.js test');
    expect(table.get(99)!.startedAtText).toBeNull();
    expect(table.get(99)!.command).toBe('some-old-style-command --flag');
  });

  it('reads wmic creationdate when the column is there', () => {
    const table = parseWmicProcessTable(
      [
        'Node,CreationDate,KernelModeTime,ProcessId,UserModeTime',
        'HOST,20261014150203.000000+060,468750,1234,9375000',
      ].join('\r\n'),
    );
    expect(table.get(1234)!.startedAtText).toBe('20261014150203.000000+060');
  });

  it('the live table gives a stable token for a real process (or says so honestly)', async () => {
    // A token that changed between two reads would make every recovered run
    // unverifiable — so stability is the property under test, not just presence.
    const self = lookupProcess(process.pid);
    if (self?.startedAtText == null) {
      // Honest, not passing: this platform's `ps` gave no `lstart`, so the
      // second witness does not exist here and the command line is the only one.
      expect(process.platform === 'win32' || self?.startedAtText === null).toBe(true);
      return;
    }
    expect(self.startedAtText.length).toBeGreaterThan(0);
    await sleep(30);
    expect(lookupProcess(process.pid)?.startedAtText).toBe(self.startedAtText);

    // And the token separates PROCESSES, which is the whole point: two commands
    // started at different moments must not share one. Spawned >1s apart so this
    // is a statement about identity rather than about the clock's resolution.
    const first = spawn('sleep 6', { shell: true, stdio: 'ignore' });
    let second: ReturnType<typeof spawn> | null = null;
    try {
      await sleep(300);
      const firstRow = lookupProcess(first.pid!);
      expect(firstRow?.found).toBe(true);
      await sleep(1_300);
      second = spawn('sleep 6', { shell: true, stdio: 'ignore' });
      await sleep(300);
      const secondRow = lookupProcess(second.pid!);
      expect(secondRow?.found).toBe(true);
      expect(firstRow?.startedAtText).not.toBe(secondRow?.startedAtText);
      // …and both are stable across reads, which is what makes them comparable
      // later (a token that drifted between reads would refuse every run).
      expect(lookupProcess(first.pid!)?.startedAtText).toBe(firstRow?.startedAtText);
      expect(lookupProcess(second.pid!)?.startedAtText).toBe(secondRow?.startedAtText);
    } finally {
      killProcessTree(first.pid!, 'SIGKILL', first);
      if (second) killProcessTree(second.pid!, 'SIGKILL', second);
    }
  }, 20_000);
});

describe('killProcessTree — the safety guard is load-bearing', () => {
  it('signals NOTHING for 0 / -1 (that would be every process on the machine)', () => {
    expect(killProcessTree(-1, 'SIGTERM')).toEqual([]);
    expect(killProcessTree(0, 'SIGTERM')).toEqual([]);
    expect(killProcessTree(Number.NaN, 'SIGTERM')).toEqual([]);
  });

  it('stops the shell and the real work under it — not just the shell', async () => {
    // Killing only the root would leave the actual work orphaned and running,
    // which is why a "stopped" hung command would otherwise keep building.
    const child = spawn('sleep 30; echo done', { shell: true, stdio: 'ignore' });
    await sleep(300);
    const signalled = killProcessTree(child.pid!, 'SIGTERM', child);
    expect(signalled.length).toBeGreaterThan(1);
    await sleep(500);
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  }, 20_000);
});

describe('formatSpan — how long, for a human reading the evidence', () => {
  it('reads in seconds, then minutes', () => {
    expect(formatSpan(45_000)).toBe('45s');
    expect(formatSpan(185_000)).toBe('3m 05s');
    expect(formatSpan(3_700_000)).toBe('1h 01m');
  });
});
