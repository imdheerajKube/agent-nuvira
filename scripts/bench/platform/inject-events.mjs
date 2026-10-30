#!/usr/bin/env node
/**
 * Hidden change events for the Ultimate Agent Benchmark.
 *
 * WHY THIS EXISTS. Adaptability is 10 % of the benchmark's rubric and the only
 * aspect that cannot be measured from a finished folder: it needs a requirement
 * change to arrive WHILE the agent is working. In a one-shot run there is nobody to
 * type it into the chat, so the event is delivered where every agent already looks —
 * a file in the workspace — and the run is scored on whether the delivered change
 * shows up in the agent's own artifacts.
 *
 * WHAT IT DELIVERS. Four events, in the benchmark's own order:
 *   1. Teams instead of Projects        (requirement change / adaptability)
 *   2. PostgreSQL → SQLite              (architecture quality)
 *   3. Audit logs for every operation   (extensibility)
 *   4. JWT storage security review      (debugging + security awareness)
 *
 * Each is written to `CHANGE_REQUEST.md` (overwritten with the newest, and appended
 * to `CHANGE_REQUESTS.md` so nothing is lost), because an agent that re-reads its
 * root before a milestone sees it, and one that never does has demonstrated
 * something real about its working style.
 *
 * Usage:
 *   # keep injecting every 5 minutes for a 30-minute run (4 events, one per slot)
 *   node scripts/bench/platform/inject-events.mjs --dir /tmp/run/nuvira --interval 300 --times 4
 *
 *   # inject one specific event now (event 3), e.g. by hand from another shell
 *   node scripts/bench/platform/inject-events.mjs --dir /tmp/run/nuvira --now 3
 */

import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const EVENTS = [
  {
    id: 'event-1',
    title: 'Requirement change — Teams replace Projects',
    body: [
      'Users now need TEAMS instead of Projects. A Team owns members, and every task and',
      'document belongs to a team rather than to a project.',
      '',
      'Update the architecture and the data model accordingly: keep the change coherent',
      'end to end (schema, API, UI, tests) rather than adding a second concept alongside',
      'the old one. Record the decision and its consequences in your docs, and update',
      'todo.md / progress.md to reflect the new scope.',
    ].join('\n'),
  },
  {
    id: 'event-2',
    title: 'Infrastructure change — the database is now SQLite',
    body: [
      'The database was switched from PostgreSQL to SQLite. The deployment target no longer',
      'provides a Postgres server.',
      '',
      'Adapt the persistence layer (driver, connection, migrations, SQL dialect differences),',
      'keep the tests running against the new store, and state in progress.md what could not',
      'be verified without a real Postgres instance. Do not leave Postgres-only SQL that',
      'cannot run.',
    ].join('\n'),
  },
  {
    id: 'event-3',
    title: 'Extensibility — audit logs for every operation',
    body: [
      'Auditing now requires an audit log for EVERY mutating operation: who did what, to',
      'which resource, when, and with what outcome.',
      '',
      'Add it centrally rather than per endpoint (middleware or interceptor), make it',
      'queryable by an admin, and cover it with a test. Update the API docs.',
    ].join('\n'),
  },
  {
    id: 'event-4',
    title: 'Security review — JWT storage is wrong',
    body: [
      'A security review found the JWT is stored incorrectly (readable by JavaScript and',
      'surviving logout).',
      '',
      'Move to an httpOnly, Secure, SameSite cookie with a refresh-token rotation flow,',
      'invalidate tokens on logout, explain the change in the docs, and add a test that',
      'proves a logged-out token is rejected.',
    ].join('\n'),
  },
];

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

/** Write one event into the workspace, newest-wins plus a durable log. */
export function injectEvent(dir, index) {
  const event = EVENTS[index];
  if (!event) throw new Error(`no event ${index + 1} (there are ${EVENTS.length})`);
  const text = `# ${event.title}\n\nDelivered ${new Date().toISOString()}\n\n${event.body}\n`;
  writeFileSync(join(dir, 'CHANGE_REQUEST.md'), text, 'utf-8');
  appendFileSync(join(dir, 'CHANGE_REQUESTS.md'), `${text}\n---\n`, 'utf-8');
  return event.id;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.dir) {
    console.error('inject-events: --dir is required');
    process.exit(2);
  }
  const dir = String(args.dir);

  if (args.now !== undefined) {
    const index = Number(args.now) - 1;
    console.log(`injected ${injectEvent(dir, index)} into ${dir}`);
    return;
  }

  const interval = Number(args.interval ?? 300);
  const times = Number(args.times ?? EVENTS.length);
  for (let i = 0; i < times; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, interval * 1000));
    try {
      console.log(`injected ${injectEvent(dir, i)} into ${dir} (t+${(i + 1) * interval}s)`);
    } catch (err) {
      console.error(String(err));
      return;
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err?.stack ?? String(err));
    process.exit(1);
  });
}
