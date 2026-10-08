#!/usr/bin/env node
/**
 * Measure what a rejection does to the router bandit.
 *
 * WHY THIS EXISTS. Bundle 36 made an EXPLICIT verdict (`nuvira rate bad`, the
 * dashboard 👎) correct the arm that served that turn — the same deferred
 * `userAccepted: false` delta the DERIVED correction already applied. "The score
 * drops" is a claim; this script measures it, turn by turn, on the REAL bandit
 * maths (it imports the built `RouterBandit`, not a copy).
 *
 * IT IS A CONTROLLED SIMULATION, NOT LIVE DATA. It does NOT read your own store
 * (inspect that with `nuvira model bandit`), and it never writes to it — each run
 * uses a temp state dir that is deleted on exit.
 *
 * Two measurements, because they answer different questions:
 *   PART 1 — the DROP. An arm with warm success history, then a backlog of
 *     rejections and NO new credit. This is rating turns after the fact
 *     (`nuvira rate bad -t <id>`), or a derived rejection arriving late: each
 *     correction lowers the arm, which is the effect the user asked to see.
 *   PART 2 — the BRAKE. Every turn credited AND rejected. The arm still rises
 *     (the model did answer), but slower than an identical arm with no
 *     rejections — this is what stops a bad arm from looking good forever.
 *
 * Usage:
 *   npm run build:cli                                     # once, so dist/ exists
 *   node scripts/measure-bandit-correction.mjs [count]     # default 13
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const distDir = join(here, '..', 'dist');
const banditModule = join(distDir, 'learning', 'router-bandit.js');
if (!existsSync(banditModule)) {
  console.error('measure-bandit-correction: dist/ not built — run `npm run build:cli` first.');
  process.exit(1);
}

const { RouterBandit, USER_REJECTION_DELTA } = await import(pathToFileURL(banditModule).href);

const count = Math.max(1, Math.min(60, Number(process.argv[2]) || 13));

// The arm under test — one provider/model at one complexity and intent.
const PROVIDER = 'groq';
const MODEL = 'llama-3.3-70b-versatile';
const COMPLEXITY = 'moderate';
const INTENT = 'coding';
const COST_SCORE = 1.0; // cheapest tier → the largest success reward (0.9 α-bump)
const WARM_TURNS = 3; // successes before the backlog starts

const SAMPLES = 4000; // Thompson draws averaged, to show the MEAN is what moved

/** A fresh bandit on its own temp state dir (never the user's store). */
function freshBandit() {
  const memDir = mkdtempSync(join(tmpdir(), 'buff-bandit-measure-'));
  process.env.NUVIRA_MEMORY_DIR = memDir;
  const bandit = new RouterBandit();
  return {
    bandit,
    cleanup: () => {
      delete process.env.NUVIRA_MEMORY_DIR;
      rmSync(memDir, { recursive: true, force: true });
    },
  };
}

const meanOf = (bandit) => {
  const p = bandit.getPrior(PROVIDER, COMPLEXITY, INTENT);
  return p.alpha / (p.alpha + p.beta);
};
const sampledOf = (bandit) => {
  let sum = 0;
  for (let i = 0; i < SAMPLES; i++) sum += bandit.sampleScore(PROVIDER, COMPLEXITY, 1.0, INTENT);
  return sum / SAMPLES;
};
const snap = (bandit, turn, label) => {
  const p = bandit.getPrior(PROVIDER, COMPLEXITY, INTENT);
  return { turn, label, alpha: p.alpha, beta: p.beta, mean: meanOf(bandit), sampled: sampledOf(bandit) };
};
const warm = (bandit) => {
  for (let i = 0; i < WARM_TURNS; i++) {
    bandit.recordOutcome(PROVIDER, 'implement a login form', 'success', COST_SCORE, { verificationPassed: true }, INTENT);
  }
};
const reject = (bandit, id) =>
  bandit.recordExplicitVerdict({
    traceId: id,
    provider: PROVIDER,
    complexity: COMPLEXITY,
    taskIntent: INTENT,
    model: MODEL,
    outcome: 'success',
  });

/** PART 1 — warm arm, then a backlog of rejections with NO new credit. */
function measureDrop() {
  const { bandit, cleanup } = freshBandit();
  warm(bandit);
  const rows = [snap(bandit, 0, `warm (${WARM_TURNS} success(es))`)];
  for (let i = 1; i <= count; i++) {
    const res = reject(bandit, `sim-backlog-${i}`);
    rows.push(snap(bandit, i, res.applied && res.moved > 0 ? 'rejected → corrected' : `rejected → ${res.reason}`));
  }
  cleanup();
  return rows;
}

/** PART 2 — each turn credited AND rejected, vs an identical control. */
function measureBrake() {
  // Run the two arms SEQUENTIALLY, each on its own temp state dir, so neither
  // can write over the other's persisted state. The measurements are in-memory
  // either way, but a shared file would make the script's own store a lie.
  const controlRows = [];
  {
    const { bandit, cleanup } = freshBandit();
    for (let i = 0; i <= count; i++) {
      if (i > 0) {
        bandit.recordOutcome(PROVIDER, 'implement a login form', 'success', COST_SCORE, { verificationPassed: true }, INTENT);
      }
      controlRows.push(snap(bandit, i, i === 0 ? 'cold' : 'recorded (success)'));
    }
    cleanup();
  }
  const rejectedRows = [];
  {
    const { bandit, cleanup } = freshBandit();
    for (let i = 0; i <= count; i++) {
      if (i > 0) {
        bandit.recordOutcome(PROVIDER, 'implement a login form', 'success', COST_SCORE, { verificationPassed: true }, INTENT);
        reject(bandit, `sim-brake-${i}`);
      }
      rejectedRows.push(snap(bandit, i, i === 0 ? 'cold' : 'recorded → rejected'));
    }
    cleanup();
  }
  return { rejectedRows, controlRows };
}

const fmt = (n, w = 6) => n.toFixed(w);
function table(rows) {
  const lines = [' turn  event                     α        β        mean θ    sampled θ'];
  lines.push(' ' + '─'.repeat(72));
  for (const r of rows) {
    lines.push(
      ` ${String(r.turn).padStart(4)}  ${r.label.padEnd(24)} ${fmt(r.alpha, 3).padStart(6)}   ${fmt(r.beta, 3).padStart(6)}   ${fmt(r.mean, 4)}    ${fmt(r.sampled, 4)}`,
    );
  }
  return lines.join('\n');
}

console.log('');
console.log("Bandit correction — a rejected arm's sampling score, turn by turn");
console.log('='.repeat(74));
console.log('');
console.log(`Arm: ${PROVIDER}/${MODEL} · complexity '${COMPLEXITY}' · intent '${INTENT}'`);
console.log(`The correction is the deferred userAccepted:false delta:  α −${USER_REJECTION_DELTA}, β +${USER_REJECTION_DELTA}.`);
console.log('θ is the Beta mean (α/(α+β)); the routed score is the deterministic score × θ, so θ is the learning.');

const drop = measureDrop();
console.log('');
console.log(`PART 1 — the DROP (warm arm, then ${count} rejection(s), no new credit)`);
console.log(table(drop));

const { rejectedRows, controlRows } = measureBrake();
console.log('');
console.log(`PART 2 — the BRAKE (every turn credited THEN rejected, vs an identical control)`);
console.log(table(rejectedRows));
console.log('');
console.log('  control (no rejections):');
console.log(table(controlRows));

const dropFirst = drop[0].mean;
const dropLast = drop[drop.length - 1].mean;
const belowHalf = drop.findIndex((r) => r.turn > 0 && r.mean < 0.5);
const brakeGap = controlRows[controlRows.length - 1].mean - rejectedRows[rejectedRows.length - 1].mean;
console.log('');
console.log('Effect');
console.log('─'.repeat(74));
console.log(`  PART 1  θ ${fmt(dropFirst, 4)} → ${fmt(dropLast, 4)}  (Δ ${fmt(dropLast - dropFirst, 4)} over ${count} rejection(s))`);
console.log(
  belowHalf > 0
    ? `          the arm drops below a coin flip (θ < 0.5) after ${belowHalf} rejection(s)`
    : `          still above θ 0.5 after ${count} rejection(s) — the delta is deliberately small, so it takes many`,
);
console.log(`  PART 2  after ${count} turn(s): rejected θ ${fmt(rejectedRows[rejectedRows.length - 1].mean, 4)} vs control θ ${fmt(controlRows[controlRows.length - 1].mean, 4)}`);
console.log(`          the rejection holds the arm down by ${fmt(brakeGap, 4)} against the same work un-rejected`);
console.log('');
console.log(`  sampled θ tracks the mean (avg of ${SAMPLES} Thompson draws): the MEAN is what moved, so`);
console.log('  the effect is deterministic and does not depend on a lucky draw.');
console.log('');
console.log('Honest limits: this is the REAL RouterBandit maths on a controlled sequence — it is not');
console.log('your live store (inspect that with `nuvira model bandit`). A verdict is applied once per');
console.log('trace, and only for a turn that was recorded as a success; an ACCEPTANCE moves nothing.');
console.log('');
