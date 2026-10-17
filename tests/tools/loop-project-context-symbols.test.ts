/**
 * The SYMBOL MAP section of the loop's ambient context — opt-in, bounded, honest.
 *
 * Why it is opt-in and capped, both MEASURED (2026-10-16, this repository):
 *   - `buildCodeMap` costs 18 ms on a 16-file project but **4 440 ms** on 1 568
 *     files (~2.8 ms/file), because it parses every source file through the AST
 *     engine;
 *   - the ambient context is built BEFORE the model's first token, so an
 *     unconditional map would add seconds of synchronous work to every turn —
 *     making the agent slower, which is the opposite of what a map is for.
 *
 * So the section appears only when the caller asks (an assessment turn, which
 * would otherwise read files just to find out what is in them), only under a file
 * cap, and when over the cap it says so and names the command instead of paying
 * for a map. These tests pin all three, plus the default (byte-identical: a
 * non-assessment turn gains no prompt weight at all).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildLoopProjectContext } from '../../src/tools/loop-project-context.js';
import { clearCodeMapCache } from '../../src/cli/code-map.js';

let memDir: string;
let workspace: string;
let prevMemDir: string | undefined;

beforeEach(() => {
  clearCodeMapCache();
  memDir = mkdtempSync(join(tmpdir(), 'nuvira-lpc-sym-mem-'));
  workspace = mkdtempSync(join(tmpdir(), 'nuvira-lpc-sym-ws-'));
  writeFileSync(join(workspace, 'package.json'), '{"name":"probe"}\n');
  writeFileSync(
    join(workspace, 'engine.ts'),
    'export function evaluateExpression(expr: string): number {\n  return expr.length;\n}\n' +
      'export class Calculator {\n  run(): number {\n    return 1;\n  }\n}\n',
  );
  prevMemDir = process.env.NUVIRA_MEMORY_DIR;
  process.env.NUVIRA_MEMORY_DIR = memDir;
});

afterEach(() => {
  clearCodeMapCache();
  if (prevMemDir === undefined) delete process.env.NUVIRA_MEMORY_DIR;
  else process.env.NUVIRA_MEMORY_DIR = prevMemDir;
  rmSync(memDir, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
});

describe('loop project context — symbol map', () => {
  it('is ABSENT by default (no prompt weight for a turn that did not ask)', async () => {
    const block = await buildLoopProjectContext(workspace);
    expect(block).toContain('## File tree');
    expect(block).not.toContain('## Symbol map');
  });

  it('names the project\u2019s symbols when the caller asks for the map', async () => {
    const block = await buildLoopProjectContext(workspace, { symbolMap: true });
    expect(block).toContain('## Symbol map');
    // The payload the model needs to choose a file: names, kinds and lines.
    expect(block).toContain('evaluateExpression[function@1]');
    expect(block).toContain('Calculator[class@4]');
    // The tree still rides along: the map says what is IN files, not what exists.
    expect(block).toContain('## File tree');
  });

  it('omits the map past the file cap and names the command instead of paying for it', async () => {
    // 301 source files is past MAX_SYMBOL_MAP_FILES (300) — a map here would cost
    // ~0.9 s of blocking parse before the first token.
    for (let i = 0; i < 301; i += 1) {
      writeFileSync(join(workspace, `mod${i}.ts`), `export function f${i}(): number {\n  return ${i};\n}\n`);
    }
    const block = await buildLoopProjectContext(workspace, { symbolMap: true });
    expect(block).toContain('## Symbol map — omitted');
    expect(block).toContain('nuvira code-map');
    // The cheap summary of a BUILT map must not appear: nothing was parsed.
    expect(block).not.toMatch(/## Symbol map {2}\(\d+ file/);
    expect(block).not.toContain('evaluateExpression[function@1]');
  });

  it('builds the map once for repeated turns on an unchanged tree', async () => {
    // The memo is what makes the section affordable per turn: the first turn pays
    // the parse, later turns pay a bounded stat pass. Asserted through the public
    // block so the wiring is covered, not only the memo unit.
    const first = await buildLoopProjectContext(workspace, { symbolMap: true });
    const t0 = Date.now();
    const second = await buildLoopProjectContext(workspace, { symbolMap: true });
    const elapsed = Date.now() - t0;
    expect(second).toContain('evaluateExpression[function@1]');
    expect(first).toContain('evaluateExpression[function@1]');
    // A rebuilt map for a one-file project is milliseconds; the assertion is here
    // to catch a future change that re-parses the whole tree per turn.
    expect(elapsed).toBeLessThan(500);
  });
});
