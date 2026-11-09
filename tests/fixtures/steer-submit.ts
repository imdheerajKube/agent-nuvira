/**
 * A real second process for the multi-process test.
 *
 * It only uses the public inbox API and the environment it inherits
 * (`NUVIRA_MEMORY_DIR` points at the test file's hermetic store), so it exercises
 * exactly what `nuvira steer` does: persist a change record without touching the
 * plan. The run owner picks it up at its next safe point.
 */

import { submitGuidance } from '../../src/steering/index.js';

const [runId, text, idempotencyKey] = process.argv.slice(2);
if (!runId || !text) {
  process.stderr.write('usage: steer-submit.ts <runId> <text> <idempotencyKey>\n');
  process.exit(2);
}

const result = submitGuidance({
  runId,
  text,
  source: 'cli',
  author: 'child-process',
  ...(idempotencyKey ? { idempotencyKey } : {}),
});

if (!result.ok || !result.change) {
  process.stderr.write(`${result.error ?? 'submission failed'}\n`);
  process.exit(3);
}

process.stdout.write(result.change.id);
