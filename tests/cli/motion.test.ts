/**
 * `nuvira motion` — the human entry point to the renderer.
 *
 * The command exists because a capability reachable only by a chat turn that
 * happens to search for it is not reachable. These tests pin the parts a user
 * hits FIRST, all of which must answer without inventing anything and without
 * needing chromium:
 *
 *   - `list` on an empty workspace teaches the next step instead of printing an
 *     empty table (that is the whole discoverability point);
 *   - `presets` names the four scenes and which ones need data;
 *   - `doctor` names the missing binary and the command that installs it;
 *   - `render` refuses a source that cannot work BEFORE launching a browser, and
 *     says which flag to add.
 *
 * Hermetic: the render history and artifacts live under a temp dir, and the
 * availability probe is the test override — no PATH, no network, no chromium.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MotionCommand } from '../../src/cli/motion.js';
import {
  saveMotionManifest,
  setFfmpegRunnerForTests,
  setFramesAvailabilityForTests,
  setMotionAvailabilityForTests,
  setRendererRunnerForTests,
  type MotionManifest,
} from '../../src/tools/modality/motion.js';

let workDir = '';
const savedEnv: Record<string, string | undefined> = {};
const savedExitCode = process.exitCode;

/** Every line a command wrote, in order. */
function capture(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const push = (...args: unknown[]) => {
    lines.push(args.map((a) => String(a)).join(' '));
  };
  const spies = [
    vi.spyOn(console, 'log').mockImplementation(push),
    vi.spyOn(console, 'error').mockImplementation(push),
    vi.spyOn(console, 'warn').mockImplementation(push),
  ];
  return {
    lines,
    restore: () => {
      for (const spy of spies) spy.mockRestore();
    },
  };
}

function manifest(over: Partial<MotionManifest> = {}): MotionManifest {
  const id = over.id ?? 'motion-20261017-abc123';
  return {
    id,
    createdAt: Date.UTC(2026, 9, 17, 9, 30),
    source: '<html></html>',
    preset: 'title-card',
    params: { title: 'Motion, from the CLI' },
    fps: 30,
    durationMs: 2500,
    width: 640,
    height: 360,
    format: 'mp4',
    artifact: join(workDir, 'artifacts', `${id}.mp4`),
    srt: null,
    narration: null,
    captions: null,
    revisions: 0,
    ...over,
  };
}

async function run(argv: string[]): Promise<void> {
  await new MotionCommand().create().parseAsync(['node', 'motion', ...argv]);
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'nuvira-motion-cli-'));
  mkdirSync(join(workDir, 'artifacts'), { recursive: true });
  for (const key of ['NUVIRA_MOTION_HOME', 'NUVIRA_ARTIFACTS_DIR']) {
    savedEnv[key] = process.env[key];
    process.env[key] = join(workDir, key === 'NUVIRA_MOTION_HOME' ? 'motion' : 'artifacts');
  }
  setMotionAvailabilityForTests({ ok: true, missing: [], hint: '' });
  // Default the frames route to "ffmpeg present" so a test that only pins the
  // browser probe still describes a machine, not this machine.
  setFramesAvailabilityForTests({ ok: true, missing: [], hint: '' });
  process.exitCode = undefined;
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  setMotionAvailabilityForTests(null);
  setFramesAvailabilityForTests(null);
  process.exitCode = savedExitCode;
  rmSync(workDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('nuvira motion list', () => {
  it('teaches the next step when the workspace has no renders', async () => {
    const out = capture();
    await run(['list']);
    out.restore();

    const text = out.lines.join('\n');
    expect(text).toContain('No motion renders');
    expect(text).toContain('nuvira motion render --preset title-card');
    expect(text).toContain('turn README.md into a 20s animated explainer');
  });

  it('is the DEFAULT action — a bare `nuvira motion` lists', async () => {
    const entry = manifest();
    writeFileSync(entry.artifact, 'video');
    saveMotionManifest(entry, workDir);

    const out = capture();
    await run([]);
    out.restore();

    expect(out.lines.join('\n')).toContain(entry.id);
  });

  it('shows the length, size and source of each render', async () => {
    const entry = manifest({ srt: '/tmp/captions.srt', revisions: 1 });
    writeFileSync(entry.artifact, 'x'.repeat(2048));
    saveMotionManifest(entry, workDir);

    const out = capture();
    await run(['list']);
    out.restore();

    const text = out.lines.join('\n');
    expect(text).toContain('title-card');
    expect(text).toContain('2.5s');
    expect(text).toContain('2.0 KB');
    expect(text).toContain('640×360');
    expect(text).toContain('rev 1');
  });

  it('says whether a frames render can actually be revised', async () => {
    // The one fact that decides whether `revise` will work — so it is in the list,
    // not only in the refusal the user hits afterwards.
    const revisable = manifest({
      id: 'motion-20261017-frames1',
      preset: null,
      framesDir: '/tmp/frames',
      renderer: { command: 'python render.py', cwd: '/tmp', files: [], capturedAt: 1 },
    });
    const orphan = manifest({ id: 'motion-20261017-frames2', preset: null, framesDir: '/tmp/frames' });
    for (const entry of [revisable, orphan]) writeFileSync(entry.artifact, 'video');
    saveMotionManifest(revisable, workDir);
    saveMotionManifest(orphan, workDir);

    const out = capture();
    await run(['list']);
    out.restore();

    const text = out.lines.join('\n');
    expect(text).toContain('your frames');
    expect(text).toContain('revisable');
    expect(text).toContain('no renderer');
  });
});

describe('nuvira motion render --frames --renderer', () => {
  it('refuses --renderer without --frames, because it records the frame producer', async () => {
    const out = capture();
    await run(['render', '--preset', 'title-card', '--renderer', 'python render.py']);
    out.restore();

    expect(out.lines.join('\n')).toContain('needs --frames too');
    expect(process.exitCode).toBe(1);
  });
});

describe('nuvira motion revise', () => {
  it('hands a frames render with no recorded renderer to the refusal, and fails', async () => {
    // The exit code matters: a refusal that exits 0 reads as success in a script.
    const dir = mkdtempSync(join(tmpdir(), 'nuvira-motion-cli-frames-'));
    writeFileSync(join(dir, 'f_0001.png'), Buffer.from('png'));
    const entry = manifest({ id: 'motion-20261017-frames3', preset: null, framesDir: dir });
    writeFileSync(entry.artifact, 'video');
    saveMotionManifest(entry, workDir);

    const out = capture();
    await run(['revise', entry.id]);
    out.restore();

    const text = out.lines.join('\n');
    expect(text).toContain('NO renderer command was recorded');
    expect(text).toContain('renderer_command');
    expect(process.exitCode).toBe(1);
    rmSync(dir, { recursive: true, force: true });
  });

  it('re-runs the recorded renderer and re-encodes the fresh frames', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nuvira-motion-cli-frames-'));
    for (let i = 1; i <= 2; i += 1) writeFileSync(join(dir, `f_${i}.png`), Buffer.from('png'));
    const script = join(workDir, 'render.py');
    writeFileSync(script, 'print(1)\n', 'utf-8');

    const entry = manifest({
      id: 'motion-20261017-frames4',
      preset: null,
      framesDir: dir,
      renderer: { command: 'python render.py', cwd: workDir, files: [], capturedAt: 1 },
    });
    saveMotionManifest(entry, workDir);

    let ran = 0;
    setRendererRunnerForTests(async () => {
      ran += 1;
      return { ok: true, code: 0, output: 'rendered', timedOut: false };
    });
    setFfmpegRunnerForTests(async (args) => {
      writeFileSync(args[args.length - 1]!, Buffer.from('video'));
      return { code: 0, stderr: '' };
    });

    const out = capture();
    await run(['revise', entry.id, '--fps', '30']);
    out.restore();

    const text = out.lines.join('\n');
    expect(ran).toBe(1);
    expect(text).toContain('Re-ran your renderer');
    expect(text).not.toContain('Error:');
    expect(process.exitCode).toBeUndefined();
    setRendererRunnerForTests(null);
    setFfmpegRunnerForTests(null);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('nuvira motion presets', () => {
  it('names every scene and which ones need data', async () => {
    const out = capture();
    await run(['presets']);
    out.restore();

    const text = out.lines.join('\n');
    for (const preset of ['title-card', 'bar-race', 'line-reveal', 'code-walkthrough']) {
      expect(text).toContain(preset);
    }
    expect(text).toContain('(no data needed)');
    expect(text).toContain('(needs --data)');
  });
});

describe('nuvira motion doctor', () => {
  it('names the missing binary and the command that installs it', async () => {
    setMotionAvailabilityForTests({
      ok: false,
      missing: ['chromium (playwright)', 'ffmpeg'],
      hint: 'npx playwright install chromium ; brew install ffmpeg',
    });
    // Both routes are down, so nothing can render — the frames probe has to be
    // pinned too, or this test would pass or fail on whether the machine running
    // it happens to have ffmpeg.
    setFramesAvailabilityForTests({ ok: false, missing: ['ffmpeg'], hint: 'brew install ffmpeg' });
    const out = capture();
    await run(['doctor']);
    out.restore();

    const text = out.lines.join('\n');
    expect(text).toContain('missing: chromium (playwright), ffmpeg');
    expect(text).toContain('npx playwright install chromium');
    // The other actions still work without a renderer — say so.
    expect(text).toContain('only `render` needs them');
  });

  it('offers the frames route when only chromium is missing', async () => {
    // The whole point of the frames path: 600 PNGs on disk are a render that is
    // ready to run, so reporting "cannot render" for a missing browser would be
    // a lie about the route that never opens one.
    setMotionAvailabilityForTests({
      ok: false,
      missing: ['chromium (playwright)'],
      hint: 'npx playwright install chromium',
    });
    setFramesAvailabilityForTests({ ok: true, missing: [], hint: '' });
    const out = capture();
    await run(['doctor']);
    out.restore();

    const text = out.lines.join('\n');
    expect(text).toContain('HTML and preset renders are unavailable');
    expect(text).toContain('The frames route still works');
    expect(text).toContain('--frames');
    expect(text).not.toContain('Cannot render yet');
  });

  it('confirms a machine that can render', async () => {
    const out = capture();
    await run(['doctor']);
    out.restore();
    expect(out.lines.join('\n')).toContain('This machine can render');
  });
});

describe('nuvira motion render — refuses an impossible source before rendering', () => {
  it('asks for a source when neither --preset nor --html was given', async () => {
    const out = capture();
    await run(['render']);
    out.restore();

    expect(out.lines.join('\n')).toContain('needs a source');
    expect(process.exitCode).toBe(1);
  });

  it('rejects an unknown preset and lists the real ones', async () => {
    const out = capture();
    await run(['render', '--preset', 'carousel']);
    out.restore();

    const text = out.lines.join('\n');
    expect(text).toContain("Unknown preset 'carousel'");
    expect(text).toContain('bar-race');
    expect(process.exitCode).toBe(1);
  });

  it('will not render a data preset with no data file', async () => {
    const out = capture();
    await run(['render', '--preset', 'bar-race']);
    out.restore();

    expect(out.lines.join('\n')).toContain('pass --data');
    expect(process.exitCode).toBe(1);
  });

  it('rejects a data file that does not exist, rather than rendering an empty chart', async () => {
    const out = capture();
    await run(['render', '--preset', 'bar-race', '--data', join(workDir, 'nope.csv')]);
    out.restore();

    expect(out.lines.join('\n')).toContain('No such data file');
    expect(process.exitCode).toBe(1);
  });

  it('stops when the machine cannot render, naming the fix', async () => {
    setMotionAvailabilityForTests({
      ok: false,
      missing: ['ffmpeg'],
      hint: 'brew install ffmpeg',
    });
    const out = capture();
    await run(['render', '--preset', 'title-card']);
    out.restore();

    const text = out.lines.join('\n');
    expect(text).toContain('Cannot render — missing: ffmpeg');
    expect(text).toContain('brew install ffmpeg');
    expect(process.exitCode).toBe(1);
  });
});
