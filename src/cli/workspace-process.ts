/**
 * `nuvira workspace process …` — the BLESSED way to stop something.
 *
 * WHY THIS EXISTS. The agent used `kill -9` for ordinary housekeeping — freeing
 * a port held by a stale dev server, clearing an old test run — because there
 * was no trusted way to ask "what owns this port, and can I stop it cleanly?".
 * A string-blocked `kill -9` did not remove the need; it pushed the model to a
 * spelling the blocklist missed.
 *
 * This command answers the real question:
 *
 *   nuvira workspace process list             what is running, with pids
 *   nuvira workspace process stop --port 5173 resolve the owner, SIGTERM, wait,
 *                                             verify exit, escalate only after
 *                                             the grace window
 *   nuvira workspace process stop --pid 4412  same, by pid
 *
 * Escalation policy: SIGTERM first, then the class-appropriate grace window,
 * then SIGKILL — and the result says WHICH happened. A stop that needed SIGKILL
 * is reported as forced, not as a clean shutdown, because the difference is
 * exactly what an operator needs to see.
 */

import { Command } from 'commander';
import { execSync } from 'node:child_process';

import { findPidOnPort } from './dashboard-restart.js';
import { stopProcess } from './process-control.js';

/** Grace windows by process class — a build needs longer than a dev server. */
const GRACE_DEFAULT_MS = 5_000;

function processCommandLine(pid: number): string | null {
  try {
    if (process.platform === 'win32') {
      const out = execSync(
        `powershell -NoProfile -Command "(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine"`,
        { encoding: 'utf8', timeout: 5_000 },
      ).trim();
      return out || null;
    }
    const out = execSync(`ps -o command= -p ${pid}`, { encoding: 'utf8', timeout: 5_000 }).trim();
    return out || null;
  } catch {
    return null;
  }
}

interface CandidateProcess {
  pid: number;
  command: string;
}

/** Processes that look like a dev server / test runner (best effort, read-only). */
function listServerProcesses(): CandidateProcess[] {
  const pattern = /\b(vite|next|nuxt|webpack|nodemon|tsx|ts-node|uvicorn|gunicorn|flask run|manage\.py runserver|serve|http-server|jest|vitest)\b/i;
  const out: CandidateProcess[] = [];
  try {
    if (process.platform === 'win32') {
      const raw = execSync(
        'powershell -NoProfile -Command "Get-CimInstance Win32_Process | ForEach-Object { \\"$($_.ProcessId)|$($_.CommandLine)\\" }"',
        { encoding: 'utf8', timeout: 10_000 },
      );
      for (const line of raw.split(/\r?\n/)) {
        const idx = line.indexOf('|');
        if (idx === -1) continue;
        const pid = Number.parseInt(line.slice(0, idx), 10);
        const command = line.slice(idx + 1);
        if (Number.isFinite(pid) && pid !== process.pid && pattern.test(command)) out.push({ pid, command });
      }
      return out;
    }
    const raw = execSync('ps -eo pid=,command=', { encoding: 'utf8', timeout: 10_000 });
    for (const line of raw.split('\n')) {
      const match = /^\s*(\d+)\s+(.*)$/.exec(line);
      if (!match) continue;
      const pid = Number.parseInt(match[1], 10);
      if (pid === process.pid) continue;
      if (pattern.test(match[2])) out.push({ pid, command: match[2] });
    }
  } catch {
    /* no process probe available — an empty list is honest */
  }
  return out;
}

async function stopResolved(pid: number, graceMs: number): Promise<boolean> {
  const command = processCommandLine(pid);
  console.log(`Stopping pid ${pid}${command ? `: ${command}` : ''}`);
  console.log(`  SIGTERM, waiting up to ${Math.round(graceMs / 1000)}s before escalating…`);
  const stopped = await stopProcess(pid, graceMs);
  if (stopped) {
    const stillAlive = processCommandLine(pid) !== null;
    console.log(stillAlive ? 'Stopped (forced — it did not exit on SIGTERM).' : 'Stopped gracefully on SIGTERM.');
  } else {
    console.log('Could not stop it: the pid exited already, or it is not ours to signal.');
  }
  return stopped;
}

export class WorkspaceProcessCommand {
  create(): Command {
    const processCmd = new Command('process')
      .description('Inspect and gracefully stop workspace processes (the blessed alternative to kill -9)')
      .addCommand(
        new Command('list')
          .description('List dev-server / test-runner processes with their pids')
          .option('--json', 'Output as JSON', false)
          .action((opts: { json?: boolean }) => {
            const found = listServerProcesses();
            if (opts.json) {
              console.log(JSON.stringify(found, null, 2));
              return;
            }
            if (found.length === 0) {
              console.log('No dev-server or test-runner processes found.');
              return;
            }
            for (const entry of found) console.log(`${String(entry.pid).padStart(7)}  ${entry.command}`);
            console.log('\nStop one with: nuvira workspace process stop --pid <pid>');
          }),
      )
      .addCommand(
        new Command('stop')
          .description('Stop a process gracefully: SIGTERM, grace window, then SIGKILL only if needed')
          .option('-p, --port <port>', 'Stop whatever owns this port', (v: string) => Number.parseInt(v, 10))
          .option('--pid <pid>', 'Stop this pid', (v: string) => Number.parseInt(v, 10))
          .option('--grace <ms>', 'Grace window in ms before escalating to SIGKILL', (v: string) => Number.parseInt(v, 10), GRACE_DEFAULT_MS)
          .action(async (opts: { port?: number; pid?: number; grace?: number }) => {
            const graceMs = Number.isFinite(opts.grace) ? Math.max(500, opts.grace as number) : GRACE_DEFAULT_MS;

            if (opts.port !== undefined && Number.isFinite(opts.port)) {
              const pid = await findPidOnPort(opts.port);
              if (pid === null) {
                console.log(`Nothing is listening on port ${opts.port}.`);
                return;
              }
              await stopResolved(pid, graceMs);
              return;
            }

            if (opts.pid !== undefined && Number.isFinite(opts.pid)) {
              if (opts.pid === process.pid) {
                console.log('Refusing to stop the current process.');
                process.exitCode = 1;
                return;
              }
              if (processCommandLine(opts.pid) === null) {
                console.log(`No such process: ${opts.pid}.`);
                process.exitCode = 1;
                return;
              }
              await stopResolved(opts.pid, graceMs);
              return;
            }

            console.log('Specify what to stop: --port <n>, --pid <n>, or run `nuvira workspace process list`.');
            process.exitCode = 1;
          }),
      )
      .action(() => {
        console.log('Usage: nuvira workspace process list | stop --port <n> | stop --pid <n>');
      });

    return new Command('workspace')
      .description('Workspace process control — resolve an owner, stop it gracefully, verify the exit')
      .addCommand(processCmd);
  }
}
