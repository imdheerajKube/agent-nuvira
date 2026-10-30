#!/usr/bin/env node
/**
 * Ultimate Agent Benchmark — the SaaS Operations Platform, scored.
 *
 * WHAT THIS IS. The task asks an agent to plan, build, test and document a whole
 * product in one turn. Almost everything a reviewer would say about the result is
 * qualitative — "is this architecture good?" — and this script does NOT answer
 * that. It answers the part that can be counted the same way for every agent:
 * which documents exist, which parts of the requested stack are actually present,
 * how many tests and assertions there are, whether the security and performance
 * requirements appear in code, how much of the workspace the agent actually
 * TOUCHED (tool usage, from the run log), and whether it left the repo runnable.
 *
 * WHY THE NUMBERS ARE A FLOOR, NOT A GRADE. A file present is not a file correct:
 * `docs/PRD.md` with three lines and a real PRD score the same here. So the
 * weights mirror the task's own rubric, and every aspect prints its evidence, so
 * the human part of the review starts from a list of what was found rather than
 * from an impression. The qualitative half lives in the report written beside it.
 *
 * ADAPTABILITY IS MEASURED ONLY IF IT WAS EXERCISED. The hidden change events are
 * injected by a person mid-run; when nobody injected one, the aspect is reported
 * as `not-exercised` and its weight is removed from the denominator rather than
 * scored as zero — otherwise every clean run looks like it failed adaptability.
 *
 * Usage:
 *   node scripts/bench/platform/score-platform.mjs --dir /tmp/bench/nuvira [--log run.log] [--json]
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join, relative, sep } from 'node:path';

const WEIGHTS = {
  planning: 0.15,
  toolUsage: 0.2,
  taskManagement: 0.1,
  development: 0.2,
  problemSolving: 0.1,
  testing: 0.1,
  documentation: 0.05,
  adaptability: 0.1,
};

const IGNORED = new Set(['.git', 'node_modules', '.next', 'dist', 'build', 'coverage', '.turbo', '.venv', 'venv']);
const CODE_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.sql', '.prisma', '.json', '.yml', '.yaml', '.md']);
const DOC_EXT = new Set(['.md', '.mdx', '.txt']);

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

function walk(root) {
  const files = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let names = [];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (IGNORED.has(name)) continue;
      const abs = join(dir, name);
      let st;
      try {
        st = statSync(abs);
      } catch {
        continue;
      }
      if (st.isDirectory()) stack.push(abs);
      else if (st.isFile()) files.push({ abs, path: relative(root, abs).split(sep).join('/'), size: st.size, mtime: st.mtimeMs });
    }
  }
  return files.sort((a, b) => (a.path < b.path ? -1 : 1));
}

const read = (file) => {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return '';
  }
};

const has = (paths, pattern) => paths.some((p) => pattern.test(p));
const clamp = (n) => Math.max(0, Math.min(100, Math.round(n)));

/** Points for crossing thresholds, e.g. [[10, 5], [20, 10], [40, 15]]. */
function step(value, thresholds) {
  let points = 0;
  for (const [at, score] of thresholds) if (value >= at) points = score;
  return points;
}

export function scorePlatform({ workspace, log = '' }) {
  const files = walk(workspace);
  const paths = files.map((f) => f.path.toLowerCase());
  const textOf = (file) => read(join(workspace, file));
  const codeFiles = files.filter((f) => CODE_EXT.has(f.path.slice(f.path.lastIndexOf('.'))));
  const docFiles = files.filter((f) => DOC_EXT.has(f.path.slice(f.path.lastIndexOf('.'))));
  const allText = codeFiles
    .filter((f) => f.size < 400_000)
    .map((f) => read(f.abs))
    .join('\n')
    .toLowerCase();
  const loc = allText.split('\n').length;

  const lowerPaths = (needle) => paths.filter((p) => p.includes(needle));
  const anyContent = (re) => re.test(allText);
  const evidence = {};

  // ── 1. Planning ──────────────────────────────────────────────────────────
  const planDocs = {
    prd: lowerPaths('prd').length > 0,
    architecture: lowerPaths('architecture').length > 0 || lowerPaths('system-design').length > 0,
    roadmap: lowerPaths('roadmap').length > 0 || lowerPaths('plan').length > 0,
    risk: lowerPaths('risk').length > 0,
    taskList: lowerPaths('todo').length > 0 || lowerPaths('task').length > 0,
  };
  evidence.planning = planDocs;
  const planning = clamp(Object.values(planDocs).filter(Boolean).length * 20);

  // ── 2. Tool usage (from the run log) ─────────────────────────────────────
  // Each surface logs differently; count STARTS only, because Cline's JSON stream
  // repeats the name on every stdout chunk of the same call (639 `run_commands`
  // occurrences for ~100 calls).
  const starts = [
    ...[...log.matchAll(/⚙\s+([a-z_]+)\(/g)],
    // nuvira's OWN durable session log (`~/.nuvira/debug-logs/cli-chat-*.log`):
    // one `tool.start {"tool":"write_file"}` line per call. Added 2026-10-26 after
    // a benchmark arm DELETED its own stdout capture mid-run: the workspace is the
    // agent's to clean, so the transcript has to come from somewhere the agent does
    // not own. Counted only as `tool.start`, never `tool.end`, so a call is one.
    ...[...log.matchAll(/tool\.start \{"tool":"([\w_-]+)"/g)],
    // Cline: anchored to content_*START* — content_update repeats the same name for
    // every stdout chunk of one call (1297 "starts" for 442 real calls, measured).
    ...[...log.matchAll(/"type":"content_start","contentType":"tool","toolName":"([\w_-]+)"/g)],
  ];
  const toolNames = starts.map((m) => m[1]);
  const toolCalls = toolNames.length;
  const toolKinds = new Set(toolNames);
  const SHELL_TOOLS = new Set(['run_terminal', 'run_commands', 'execute_command', 'bash', 'shell', 'terminal', 'run']);
  const shellCalls = toolNames.filter((name) => SHELL_TOOLS.has(name)).length;

  /**
   * A full-screen TUI log is a REDRAW stream: the same action is re-rendered many
   * times, so counting its markers inflates every tool call by an unknown factor.
   * Reported as unmeasured (and removed from the weighted total) rather than
   * guessed — a made-up tool count is worse than an admitted gap.
   */
  const redraws = (log.match(/working\.\.\.|thinking\.\.\./g) ?? []).length;
  // A capture full of ANSI escapes is a SCREEN, not a record: one 2026-10-25 run
  // logged 10 MB of cursor addressing with no newline in it, so every count read
  // zero. Detect the control sequences themselves, not just redraw words.
  const ansiStream = /\u001b\[[0-9;?]*[A-Za-z]|\u001b\]/.test(log);
  const tuiRedrawStream = (redraws > 20 || ansiStream) && toolCalls === 0;
  // An ABSENT log is not an agent that made zero calls. Measured 2026-10-25: one
  // run's log was captured through a PTY that produced an empty file, and a zero
  // there silently deleted 20 % of that agent's score. Unmeasured, and out of the
  // denominator, is the only honest reading of "no evidence either way".
  const logCaptured = log.trim().length > 0;
  evidence.toolUsage = !logCaptured
    ? { measured: false, reason: 'no run log was captured — tool usage not counted' }
    : tuiRedrawStream
      ? { measured: false, reason: `full-screen TUI redraw stream (${redraws} redraw ticks) — counts not reliable` }
      : { measured: true, toolCalls, distinctTools: toolKinds.size, shellCalls };
  const toolUsage = !logCaptured || tuiRedrawStream
    ? null
    : clamp(
        step(toolCalls, [[30, 20], [80, 30], [150, 40]]) +
          step(toolKinds.size, [[4, 20], [6, 30]]) +
          step(shellCalls, [[5, 10], [15, 20], [40, 30]]),
      );

  // ── 3. Task management ───────────────────────────────────────────────────
  const tracking = {
    todo: lowerPaths('todo.md').length > 0,
    progress: lowerPaths('progress.md').length > 0,
    issues: lowerPaths('issues.md').length > 0,
    changelog: lowerPaths('changelog').length > 0,
  };
  const todoText = tracking.todo ? textOf(files.find((f) => f.path.toLowerCase().endsWith('todo.md')).path) : '';
  const progressText = tracking.progress ? textOf(files.find((f) => f.path.toLowerCase().endsWith('progress.md')).path) : '';
  const trackingLive = /\[[ x]\]|✅|done|complete/i.test(todoText + progressText);
  evidence.taskManagement = { ...tracking, live: trackingLive };
  const taskManagement = clamp(Object.values(tracking).filter(Boolean).length * 20 + (trackingLive ? 20 : 0));

  // ── 4. Development quality ───────────────────────────────────────────────
  const stack = {
    next: anyContent(/"next"\s*:/) || has(paths, /next\.config/),
    backend: anyContent(/"express"\s*:|"fastify"\s*:|@nestjs\/core/) || has(paths, /(^|\/)(server|backend)\//),
    postgres: anyContent(/postgres|"pg"|prisma|typeorm|knex|drizzle/),
    typescript: has(paths, /\.tsx?$/) || anyContent(/"typescript"\s*:/),
  };
  evidence.development = { stack, files: files.length, codeFiles: codeFiles.length, loc };
  const development = clamp(
    (stack.next ? 15 : 0) +
      (stack.backend ? 15 : 0) +
      (stack.postgres ? 10 : 0) +
      (stack.typescript ? 10 : 0) +
      step(codeFiles.length, [[10, 5], [20, 10], [40, 15]]) +
      step(loc, [[500, 8], [1500, 15], [3000, 25]]),
  );

  // ── 5. Problem solving ───────────────────────────────────────────────────
  //
  // An error boundary is EITHER the Express-shaped middleware this used to look
  // for, OR the framework's own boundary. The first version was Express-only and
  // scored agent-nuvira 70 on 2026-10-25 while its repo carried
  // `src/server/errors.ts` (an AppError hierarchy carrying status codes) and a
  // `fail()` mapper in every route handler — a Next.js App Router project has no
  // `app.use((err`. Under-counting a real boundary is the same error as inventing
  // one, so the evidence records which form was found.
  const tryCatch = (allText.match(/try\s*\{/g) ?? []).length;
  const errorBoundaryFile = paths.some((p) => /(^|\/)error\.(tsx|jsx|ts|js)$/.test(p));
  const errorMapper = /(toerrorresponse|errorresponse|senderror|handleerror|maperror|\bfail)\s*\(/.test(allText);
  const statusMapping = /status\s*[:=]\s*[45]\d\d/.test(allText) || /class [a-z_]*error\b/.test(allText);
  const expressMiddleware = anyContent(/errorhandler|error handler|next\(err\)|app\.use\(\(err/);
  const frameworkBoundary = (errorBoundaryFile || errorMapper) && statusMapping;
  const errorMiddleware = expressMiddleware || frameworkBoundary;
  // A RECOVERY is visible in either log: a retry narrated in the console, or the
  // same tool failing and later succeeding (the debug log records `ok` per call).
  const failedTools = new Set(
    [...log.matchAll(/tool\.end \{"tool":"([\w_-]+)","ok":false\}/g)].map((m) => m[1]),
  );
  const laterFixed = [...log.matchAll(/tool\.end \{"tool":"([\w_-]+)","ok":true\}/g)].some((m) =>
    failedTools.has(m[1]),
  );
  const recovery = laterFixed || /retry|retrying|recovered|fixed the|resolved the/i.test(log);
  evidence.problemSolving = { tryCatch, errorMiddleware, recoveryInLog: recovery, expressMiddleware, frameworkBoundary, errorBoundaryFile };
  const problemSolving = clamp((errorMiddleware ? 30 : 0) + step(tryCatch, [[5, 10], [20, 20]]) + (recovery ? 25 : 0) + (codeFiles.length > 0 ? 25 : 0));

  // ── 6. Testing ───────────────────────────────────────────────────────────
  const testFiles = files.filter((f) => /(\.test\.|\.spec\.|__tests__|\/tests?\/)/i.test(f.path));
  const testText = testFiles.map((f) => read(f.abs)).join('\n');
  const assertions = (testText.match(/\b(expect|assert)\s*\(/g) ?? []).length;
  const kinds = {
    unit: /(\.test\.|\.spec\.)/i.test(lowerPaths('test').join(' ')) || testFiles.some((f) => /\.test\./i.test(f.path)),
    integration: /integration/i.test(paths.join(' ')) || /integration/i.test(testText),
    e2e: /e2e|playwright|cypress/i.test(paths.join(' ') + testText),
  };
  evidence.testing = { testFiles: testFiles.length, assertions, kinds };
  const testing = clamp(
    step(testFiles.length, [[3, 10], [8, 20], [15, 30]]) +
      step(assertions, [[5, 5], [30, 15], [100, 25]]) +
      (kinds.unit ? 10 : 0) +
      (kinds.integration ? 10 : 0) +
      (kinds.e2e ? 10 : 0) +
      (anyContent(/coverage/) || lowerPaths('vitest.config').length > 0 || lowerPaths('jest.config').length > 0 ? 15 : 0),
  );

  // ── 7. Documentation ─────────────────────────────────────────────────────
  const readme = files.find((f) => /^readme\.md$/i.test(f.path));
  const readmeBytes = readme?.size ?? 0;
  const docs = {
    readme: readmeBytes >= 2000 ? 30 : readmeBytes > 0 ? 15 : 0,
    api: lowerPaths('api').length > 0 ? 25 : 0,
    deployment: /deploy|docker|k8s|kubernetes/i.test(paths.join(' ')) ? 25 : 0,
    architecture: planDocs.architecture ? 20 : 0,
  };
  evidence.documentation = { readmeBytes, docs: Object.keys(docs).filter((k) => docs[k] > 0) };
  const documentation = clamp(Object.values(docs).reduce((a, b) => a + b, 0));

  // ── 8. Security ──────────────────────────────────────────────────────────
  const security = {
    jwt: anyContent(/jsonwebtoken|jwt\.sign|\bjwt\b/) && anyContent(/refresh/),
    hashing: anyContent(/bcrypt|argon2|scrypt/),
    rateLimit: anyContent(/rate.?limit/),
    validation: anyContent(/zod|joi|express-validator|class-validator/),
    parameterized: anyContent(/\$\d|\?:|prisma\.|knex\(|query\(.*\$/),
    hardening: anyContent(/helmet|csurf|csrf|sanitize|xss/),
  };
  evidence.security = security;
  const securityScore = clamp(
    (security.jwt ? 20 : 0) +
      (security.hashing ? 15 : 0) +
      (security.rateLimit ? 15 : 0) +
      (security.validation ? 15 : 0) +
      (security.parameterized ? 15 : 0) +
      (security.hardening ? 20 : 0),
  );

  // ── 9. Performance ───────────────────────────────────────────────────────
  const performance = {
    indexes: anyContent(/create\s+(unique\s+)?index/i),
    pagination: anyContent(/(limit|offset|cursor|page).{0,20}(take|page|limit)/),
    caching: anyContent(/redis|lru-cache|memory cache|cache\.set|suspense cache/),
    lazyLoading: anyContent(/next\/dynamic|lazy\(|React\.lazy|dynamic\(/),
    bundle: anyContent(/analyze|webpack|turbopack|swc|compress/),
  };
  evidence.performance = performance;
  const performanceScore = clamp(
    (performance.indexes ? 25 : 0) +
      (performance.pagination ? 25 : 0) +
      (performance.caching ? 25 : 0) +
      (performance.lazyLoading ? 15 : 0) +
      (performance.bundle ? 10 : 0),
  );

  // ── 10. Adaptability (only if a change event was DELIVERED) ──────────────
  //
  // An event is delivered as CHANGE_REQUEST.md (see inject-events.mjs). Credit is
  // then per-event, and only for evidence IN THE CODE — rewriting the prompt into a
  // doc is not adapting. A run with no delivery is excluded from the score, not
  // scored zero: nobody exercised the aspect.
  // Delivery is an EVENT (a logged change request or the CHANGE_REQUEST.md the
  // harness writes), never a word in the code: a product that happens to model
  // "teams" from the start did not adapt to a late change.
  const changeRequestFile = paths.some((p) => /change[-_]request\.md$/.test(p));
  const eventDelivered =
    changeRequestFile || /change request|requirement change|switched to sqlite|now use teams/i.test(log);
  const adaptDetail = {
    teams: /\bteams?\b/i.test(allText) && /(model team|create table teams|team_id|teamid)/i.test(allText),
    sqlite: /sqlite/i.test(allText + ' ' + paths.join(' ')),
    auditLog: /audit/i.test(allText),
    httpOnlyCookie: /httponly/i.test(allText),
  };
  const adapted = Object.values(adaptDetail).filter(Boolean).length;
  evidence.adaptability = { eventDelivered, adaptDetail };

  const aspects = {
    planning,
    toolUsage,
    taskManagement,
    development,
    problemSolving,
    testing,
    documentation,
    adaptability: eventDelivered ? clamp(adapted * 25) : 0,
  };
  const subScores = { security: securityScore, performance: performanceScore };

  // An aspect that was NOT MEASURED leaves the denominator entirely: scoring it as 0
  // would silently punish an agent for a limitation of the log format.
  const exercised = Object.entries(WEIGHTS).filter(
    ([name]) => aspects[name] !== null && (name !== 'adaptability' || eventDelivered),
  );
  const weightSum = exercised.reduce((sum, [, w]) => sum + w, 0);
  const overall = Math.round(
    exercised.reduce((sum, [name, w]) => sum + aspects[name] * w, 0) / (weightSum || 1),
  );

  return { workspace: basename(workspace), aspects, subScores, overall, evidence, counts: { files: files.length, codeFiles: codeFiles.length, loc, testFiles: testFiles.length } };
}

function bar(score) {
  const filled = Math.round(score / 5);
  return `${'█'.repeat(filled)}${'░'.repeat(20 - filled)}`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.dir) {
    console.error('score-platform: --dir is required');
    process.exit(2);
  }
  const workspace = String(args.dir);
  if (!existsSync(workspace)) {
    console.error(`score-platform: no such directory: ${workspace}`);
    process.exit(2);
  }
  const log = args.log ? read(join(workspace, String(args.log))) || read(String(args.log)) : '';
  const result = scorePlatform({ workspace, log });

  if (args.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  console.log(`\n# ${result.workspace}`);
  console.log(`overall ${result.overall}/100 · ${result.counts.files} files · ${result.counts.loc} lines · ${result.counts.testFiles} test files\n`);
  for (const [name, score] of Object.entries(result.aspects)) {
    if (score === null) {
      console.log(`${name.padEnd(16)}  —   not measured`);
      continue;
    }
    console.log(`${name.padEnd(16)} ${String(score).padStart(3)}  ${bar(score)}`);
  }
  for (const [name, score] of Object.entries(result.subScores)) {
    console.log(`${name.padEnd(16)} ${String(score).padStart(3)}  ${bar(score)}  (reported, not weighted)`);
  }
  console.log(`\nevidence: ${JSON.stringify(result.evidence)}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
