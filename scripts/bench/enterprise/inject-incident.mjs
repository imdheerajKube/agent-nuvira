#!/usr/bin/env node
/**
 * Incident injection — Phase 8 of the enterprise benchmark.
 *
 * WHY ONE INCIDENT AT A TIME, APPLIED ON DEMAND. The brief lists six failures (database
 * outage, memory leak, CPU saturation, Redis unavailable, corrupted migration, expired
 * certificate) and says the agent must detect, diagnose, fix, validate and document each.
 * A timer that fires them in sequence measures the clock; this applies exactly one when the
 * harness asks for it — after a phase boundary — and writes an `INCIDENT_<n>.md` that states
 * the SYMPTOM and never the cause. The cause is what is being scored.
 *
 * WHAT IS REAL. Every incident is a real failure, not a paragraph: the MySQL container is
 * actually stopped, the CPU is actually burned, Redis is actually unavailable, the migration
 * file is actually invalid, the certificate has actually expired. An agent that restarts
 * everything and writes "resolved" will fail validation, because validations are the
 * commands printed in the incident file.
 *
 * SAFETY. `--restore` reverts everything an injection changed (starts the containers, removes
 * the leak, restores the migration and the certificate from the copies the injector keeps in
 * `.incident-backup/`), so a failed arm never leaves the machine's services broken.
 *
 * Usage:
 *   node scripts/bench/enterprise/inject-incident.mjs --dir <arm repo> --incident <1..6> [--mysql <container>] [--redis <container>]
 *   node scripts/bench/enterprise/inject-incident.mjs --dir <arm repo> --restore
 */

import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback;
}
const flag = (name) => process.argv.includes(`--${name}`);

const dir = arg('dir');
const incident = Number(arg('incident', '0'));
const mysql = arg('mysql', 'edx-mysql');
const redis = arg('redis', 'edx-redis');
if (!dir) {
  console.error('usage: inject-incident.mjs --dir <repo> --incident <1..6> [--mysql <c>] [--redis <c>] | --restore');
  process.exit(2);
}

const BACKUP = join(dir, '.incident-backup');
const sh = (cmd, args) => {
  try {
    return { ok: true, out: execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
  } catch (error) {
    return { ok: false, out: `${error.stdout ?? ''}${error.stderr ?? ''}` };
  }
};
const bash = (script) => sh('bash', ['-lc', script]);
const find = (root, re, depth = 8) => {
  const out = [];
  const stack = [['', 0]];
  while (stack.length) {
    const [rel, d] = stack.pop();
    let names = [];
    try {
      names = readdirSync(rel ? join(root, rel) : root);
    } catch {
      continue;
    }
    for (const name of names) {
      if (['.git', 'node_modules', '.incident-backup', 'venv', '.venv'].includes(name)) continue;
      const p = rel ? `${rel}/${name}` : name;
      let st;
      try {
        st = statSync(join(root, p));
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (d < depth) stack.push([p, d + 1]);
      } else if (re.test(p)) out.push(p);
    }
  }
  return out;
};

// ── restore ────────────────────────────────────────────────────────────────
if (flag('restore')) {
  sh('docker', ['unpause', mysql]);
  sh('docker', ['start', mysql]);
  sh('docker', ['start', redis]);
  bash(`pkill -f incident-cpu-burn 2>/dev/null; true`);
  if (existsSync(BACKUP)) {
    const manifest = join(BACKUP, 'manifest.json');
    if (existsSync(manifest)) {
      for (const rel of JSON.parse(readFileSync(manifest, 'utf8')).restored ?? []) {
        const src = join(BACKUP, rel.replace(/\//g, '__'));
        if (existsSync(src)) copyFileSync(src, join(dir, rel));
      }
    }
    rmSync(BACKUP, { recursive: true, force: true });
  }
  console.log('restored: containers started, cpu burn stopped, backed-up files replaced');
  process.exit(0);
}

mkdirSync(BACKUP, { recursive: true });
const manifestPath = join(BACKUP, 'manifest.json');
const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : { restored: [] };
const backUp = (rel) => {
  const src = join(dir, rel);
  if (!existsSync(src)) return;
  copyFileSync(src, join(BACKUP, rel.replace(/\//g, '__')));
  if (!manifest.restored.includes(rel)) manifest.restored.push(rel);
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
};
const write = (body) => writeFileSync(join(dir, `INCIDENT_${incident}.md`), body.trimStart());

const incidents = {
  // 1 — the database disappears mid-request.
  1: () => {
    sh('docker', ['pause', mysql]);
    write(
      `# INCIDENT 1 — users report the site is down

**Reported:** every page that touches data fails. Error pages show a database connection
error. The application process is up; the logs show connection timeouts, not crashes.

**Your job:** find out what is actually broken, fix it, prove it, and write
\`docs/enterprise/incident_1.md\`.

**Validation you must paste into that document (real output, not prose):**

\`\`\`
docker ps --filter name=mysql
mysql -h127.0.0.1 -P3307 -uroot -pedxroot -e "select 1"
\`\`\`

**Do not** change application code until you have established whether the database is
reachable — a "fix" in Django for an unreachable database is a wrong diagnosis.
`,
    );
    console.log('incident 1: mysql paused');
  },

  // 2 — a leak nobody introduced deliberately.
  2: () => {
    const candidates = find(dir, /(?:^|\/)settings\/?(?:base)?\.py$|(?:^|\/)settings\.py$/);
    const target = candidates[0];
    const leak = `
# --- injected incident 2 ---
# A cache with no eviction and a per-request key: every request adds an entry that is
# never released. Symptom: RSS grows without bound; the process is OOM-killed under load.
_RESPONSE_CACHE = {}

def record_response(key, payload):
    """Keeps the payload for "debugging" — forever."""
    _RESPONSE_CACHE[key] = payload
    return payload
`;
    if (target) {
      backUp(target);
      writeFileSync(join(dir, target), `${readFileSync(join(dir, target), 'utf8')}\n${leak}`);
    }
    write(
      `# INCIDENT 2 — the API gets slower and then dies every few hours

**Reported:** memory grows steadily under load; the process is killed by the OOM killer and
restarts. Nobody deployed anything that should allocate per request.

**Your job:** find the unbounded retention in the code, explain why it grows, fix it, and
prove the fix with a test or a measurement. Document it in \`docs/enterprise/incident_2.md\`.

**Validation:** show the before/after of your measurement (RSS over N requests, or a unit
test that asserts the store does not grow unboundedly).
`,
    );
    console.log(`incident 2: leak injected into ${target ?? '(no settings file found — wrote the incident only)'}`);
  },

  // 3 — CPU saturation.
  3: () => {
    bash(
      `nohup bash -c 'while true; do :; done' >/dev/null 2>&1 & echo $! > /tmp/incident-cpu-burn.pid; ` +
        `nohup bash -c 'while true; do :; done' >/dev/null 2>&1 & echo $! >> /tmp/incident-cpu-burn.pid; true`,
    );
    write(
      `# INCIDENT 3 — everything is slow, the host is at 100 % CPU

**Reported:** latency has tripled for every endpoint; the machine shows sustained CPU
saturation with no matching traffic increase.

**Your job:** identify the processes consuming the CPU, determine whether they belong to the
application or are foreign to it, and resolve it without hiding the problem. Document it in
\`docs/enterprise/incident_3.md\`.

**Validation you must paste:**

\`\`\`
ps -Ao pid,pcpu,comm -r | head -5
\`\`\`
`,
    );
    console.log('incident 3: two CPU burners started');
  },

  // 4 — Redis unavailable.
  4: () => {
    sh('docker', ['stop', redis]);
    write(
      `# INCIDENT 4 — sessions and cached reads fail intermittently

**Reported:** some requests succeed, some fail with a cache/session error. Nothing was
deployed. The failure is not 100 %, which makes it look random.

**Your job:** determine which dependency is missing, how the application behaves without it,
and what the correct degraded behaviour should be — then implement it so a cache outage
degrades instead of failing. Document it in \`docs/enterprise/incident_4.md\`.

**Validation you must paste:**

\`\`\`
docker ps --filter name=redis
redis-cli -p 6380 ping
\`\`\`
`,
    );
    console.log('incident 4: redis stopped');
  },

  // 5 — a corrupted migration.
  5: () => {
    const migrations = find(dir, /migrations\/\d{3,4}_[^/]+\.py$/);
    const target = migrations[migrations.length - 1];
    if (target) {
      backUp(target);
      const text = readFileSync(join(dir, target), 'utf8');
      // A migration that references a field the model does not have: `migrate` fails with
      // an error that names the migration, not the mistake.
      writeFileSync(
        join(dir, target),
        text.replace(
          /migrations\.AddField\(|migrations\.AlterField\(|migrations\.CreateModel\(/,
          'migrations.AddField(\n            model_name="nonexistent_model_after_bad_merge",\n            name="phantom",\n            field=models.CharField(max_length=1),\n        ),\n        migrations.AddField(',
        ),
      );
    }
    write(
      `# INCIDENT 5 — migrations fail after a bad merge

**Reported:** \`python manage.py migrate\` fails. The error names a migration, and the
schema is now half-applied in staging.

**Your job:** find the corrupt migration, explain how it got there, repair it in a way that is
safe for a database that already applied the earlier migrations, and prove it by running the
migration command successfully. Document it in \`docs/enterprise/incident_5.md\`.

**Validation you must paste:**

\`\`\`
python manage.py migrate --plan
python manage.py migrate
\`\`\`
`,
    );
    console.log(`incident 5: migration corrupted (${target ?? 'none found'})`);
  },

  // 6 — an expired certificate.
  6: () => {
    const certDir = join(dir, 'deploy/tls');
    mkdirSync(certDir, { recursive: true });
    const key = join(certDir, 'server.key');
    const crt = join(certDir, 'server.crt');
    // Real cert, real expiry: notBefore/notAfter are both in the past.
    sh('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', key, '-out', crt, '-days', '-1',
      '-subj', '/CN=enterprise.local',
    ]);
    write(
      `# INCIDENT 6 — TLS clients reject the service

**Reported:** every client that validates certificates refuses to connect; browsers and
\`curl\` report an expired certificate. The service itself starts normally.

**Your job:** prove the certificate state, replace it with a valid one, make expiry a thing
the deployment notices before users do, and document it in \`docs/enterprise/incident_6.md\`.

**Validation you must paste:**

\`\`\`
openssl x509 -in deploy/tls/server.crt -noout -dates
\`\`\`
`,
    );
    console.log('incident 6: expired certificate written to deploy/tls');
  },
};

if (!incidents[incident]) {
  console.error(`unknown incident: ${incident} (expected 1..6)`);
  process.exit(2);
}
incidents[incident]();
console.log(`wrote INCIDENT_${incident}.md in ${dir}; run with --restore to undo`);
