/**
 * Motion command — the HUMAN entry point to the motion renderer.
 *
 * WHY THIS EXISTS. `motion_render` has been a real tool with a real skill since
 * the modality work, and the only way to reach it was to know that: ask a chat
 * turn for "an animated explainer", hope the model searched for the tool, and
 * watch the artifact appear in the dashboard. A capability a user cannot name
 * from the command line is a capability most users do not have. This command
 * names it.
 *
 * Two audiences, one command:
 *
 *   - `nuvira motion doctor` answers "why doesn't it work on my machine?" before
 *     a render: the renderer needs chromium (playwright) for frames and ffmpeg to
 *     encode them, and a missing binary is a fact, so it is reported as one.
 *   - `nuvira motion render` renders WITHOUT a model in the loop. A preset plus a
 *     CSV/JSON file is a deterministic render, so making one should not require a
 *     provider, a prompt, or token spend.
 *
 * `list` is the default action: a user who typed the command and does not know
 * what to do next should see what already exists and the exact next step, not a
 * usage error.
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { Command } from 'commander';

import { BaseCommand } from './commands.js';
import { logger } from '../utils/logger.js';
import {
  framesAvailability,
  listMotionManifests,
  loadMotionManifest,
  motionAvailability,
  motionHomeDir,
  type MotionFormat,
  type MotionManifest,
} from '../tools/modality/motion.js';
import {
  MOTION_PRESETS,
  isMotionPreset,
  presetNeedsData,
  type MotionPreset,
} from '../tools/modality/motion-presets.js';
import type { MotionToolArgs } from '../tools/modality/motion-tool.js';

/**
 * `2.5s` / `1m 05s` — the length, not a frame count the user has to divide.
 *
 * Short renders keep a decimal: rounding 2.5s to "3s" would misreport the file
 * that is about to be reviewed, and duration is the one number a user checks
 * against what they asked for.
 */
function formatDuration(ms: number): string {
  const seconds = ms / 1000;
  if (seconds < 60) {
    const short = seconds < 10 ? seconds.toFixed(1).replace(/\.0$/, '') : String(Math.round(seconds));
    return `${short}s`;
  }
  const total = Math.round(seconds);
  const minutes = Math.floor(total / 60);
  return `${minutes}m ${String(total % 60).padStart(2, '0')}s`;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fileSize(path: string | null | undefined): number {
  if (!path) return 0;
  try {
    return existsSync(path) ? statSync(path).size : 0;
  } catch {
    return 0;
  }
}

/** What the render WAS: a preset name, or the fact that it was hand-written. */
function sourceLabel(manifest: MotionManifest): string {
  if (manifest.preset) return manifest.preset;
  // A frames render was NOT authored as HTML — calling it that tells the user the
  // opposite of where the animation actually lives (their own renderer, which is
  // what has to run again to change it).
  return manifest.framesDir ? 'your frames' : 'hand-written html';
}

/** One line per render — the id first, because that is the argument to `open`. */
function renderRow(manifest: MotionManifest): string {
  const when = new Date(manifest.createdAt).toISOString().slice(0, 16).replace('T', ' ');
  const size = formatBytes(fileSize(manifest.artifact));
  const rev = manifest.revisions > 0 ? ` · rev ${manifest.revisions}` : '';
  const audio = manifest.srt ? ' · captions' : '';
  // Whether a frames render can be revised is decided by one fact, so it is in the
  // row: a renderer command is recorded, or it is not.
  const renderer = manifest.framesDir ? (manifest.renderer ? ' · revisable' : ' · no renderer') : '';
  return `  ${manifest.id}  ${when}  ${sourceLabel(manifest).padEnd(16)} ${formatDuration(manifest.durationMs).padStart(6)}  ${size.padStart(8)}  ${manifest.width}×${manifest.height} ${manifest.format}${rev}${audio}${renderer}`;
}

/** An OS-appropriate opener, or `null` when we should just print the path. */
function opener(): { command: string; args: string[] } | null {
  if (process.platform === 'darwin') return { command: 'open', args: [] };
  if (process.platform === 'win32') return { command: 'cmd', args: ['/c', 'start', ''] };
  // On Linux there is no guaranteed opener; a headless box has none at all.
  return existsSync('/usr/bin/xdg-open') ? { command: 'xdg-open', args: [] } : null;
}

export class MotionCommand extends BaseCommand {
  create(): Command {
    const command = new Command('motion')
      .description(
        'Create and inspect animated videos — code-authored, rendered frame-accurately. ' +
          'No model is needed: a preset plus your data is a render.',
      );

    // ── list (default) ──────────────────────────────────────────────────────
    command
      .command('list', { isDefault: true })
      .description('Show the renders in this workspace (the default action)')
      .option('-n, --limit <number>', 'Maximum renders to show', parseInt, 20)
      .action((options?: { limit?: number }) => {
        this.list(options?.limit ?? 20);
      });

    // ── presets ─────────────────────────────────────────────────────────────
    command
      .command('presets')
      .description('List the ready-made scenes and what data each one needs')
      .action(() => {
        this.presets();
      });

    // ── doctor ──────────────────────────────────────────────────────────────
    command
      .command('doctor')
      .description('Check that this machine can render (chromium for frames, ffmpeg to encode)')
      .action(() => {
        this.doctor();
      });

    // ── render ──────────────────────────────────────────────────────────────
    command
      .command('render')
      .description('Render a video now — from a preset, your own HTML animation, or your own renderer\'s frames')
      .option('-p, --preset <name>', `scene to render (${MOTION_PRESETS.join(', ')})`)
      .option('-d, --data <path>', 'CSV or JSON file to animate (required by chart presets)')
      .option('-H, --html <path>', 'a self-contained HTML animation file instead of a preset')
      .option('-F, --frames <dir>', 'frames YOUR renderer already wrote (python/PIL, Manim, Blender, Three.js…) — encoded here, no browser needed')
      .option('--frames-pattern <glob>', "glob over the frame filenames, e.g. 'f_*.png' (a '/' in it selects across subdirectories, e.g. '**/*.png')")
      .option('--renderer <command>', "record the command that made --frames (e.g. 'python render.py') so `motion revise` can re-run it")
      .option('--renderer-cwd <dir>', 'directory --renderer runs in')
      .option('-a, --audio <file>', 'music, SFX or a voice-over file to mux onto the video')
      .option('-o, --out <name>', 'filename prefix for the artifact')
      .option('-t, --title <text>', 'title shown in the scene')
      .option('-s, --subtitle <text>', 'subtitle shown under the title')
      .option('-k, --kicker <text>', 'small label above the title')
      .option('--accent <colour>', 'accent colour for the moving parts')
      .option('--unit <suffix>', "suffix for chart values, e.g. '%' or 'ms'")
      .option('--aspect <ratio>', "shape instead of a size, e.g. 16:9, 9:16, 1:1")
      .option('--duration <ms>', 'length in milliseconds', parseInt)
      .option('--fps <number>', 'frames per second', parseInt)
      .option('--width <px>', 'frame width', parseInt)
      .option('--height <px>', 'frame height', parseInt)
      .option('-f, --format <format>', 'mp4, webm or gif', 'mp4')
      .option('--narration <text>', 'narration, synthesized locally and muxed onto the video')
      .option('--voice <id>', 'TTS voice for the narration')
      .action(async (options: Record<string, unknown>) => {
        await this.render(options);
      });

    // ── revise ──────────────────────────────────────────────────────────────
    command
      .command('revise <id>')
      .description('Re-render an existing render (re-runs the recorded renderer for a frame sequence)')
      .option('--renderer <command>', 'the command that made the frames — records it on this render so future revisions can re-run it')
      .option('--renderer-cwd <dir>', 'directory --renderer runs in')
      .option('--allow-renderer-change', 'revise even though the recorded renderer changed since the render was made')
      .option('-n, --preview', 'show what would run, and change nothing')
      .option('--fps <number>', 'frames per second', parseInt)
      .option('--duration <ms>', 'length in milliseconds', parseInt)
      .option('-f, --format <format>', 'mp4, webm or gif', 'mp4')
      .option('-a, --audio <file>', 'music, SFX or a voice-over file to mux onto the video')
      .option('--narration <text>', 'narration, synthesized locally and muxed onto the video')
      .action(async (id: string, options: Record<string, unknown>) => {
        await this.revise(id, options);
      });

    // ── inspect ─────────────────────────────────────────────────────────────
    command
      .command('inspect')
      .description('Render a contact sheet of keyframes — one image you can look at before delivering')
      .option('-H, --html <path>', 'a self-contained HTML animation file to sample')
      .option('-F, --frames <dir>', 'a frame sequence to sample')
      .option('--frames-pattern <glob>', "glob over the frame filenames, e.g. 'f_*.png'")
      .option('-n, --tiles <number>', 'keyframes on the sheet (default 12)', parseInt)
      .option('--tile-width <px>', 'pixels per tile (default 480)', parseInt)
      .option('-d, --duration <ms>', 'length of an HTML animation in milliseconds', parseInt)
      .option('--fps <number>', 'frames per second of a frame sequence', parseInt)
      .option('-o, --out <name>', 'filename prefix for the sheet')
      .action(async (options: Record<string, unknown>) => {
        await this.inspect(options);
      });

    // ── open ────────────────────────────────────────────────────────────────
    command
      .command('open [id]')
      .description('Open a render in the OS viewer (the latest one when no id is given)')
      .action(async (id?: string) => {
        await this.open(id);
      });

    return command;
  }

  private list(limit: number): void {
    const renders = listMotionManifests();
    if (renders.length === 0) {
      logger.info('  No motion renders in this workspace yet.');
      this.nextSteps();
      return;
    }

    logger.highlight(`  🎬 Motion renders — ${renders.length} in ${motionHomeDir()}`);
    logger.info('  id                      created            source           length      size  frame');
    for (const manifest of renders.slice(0, limit)) {
      logger.info(renderRow(manifest));
    }
    if (renders.length > limit) {
      logger.info(`  … ${renders.length - limit} more (use --limit)`);
    }
    console.log('');
    logger.info(`  Open one:  nuvira motion open ${renders[0]!.id}`);
  }

  private presets(): void {
    logger.highlight('  🎬 Ready-made scenes');
    const help: Record<string, string> = {
      'title-card': 'a kinetic title — a kicker, title and subtitle',
      'bar-race': 'bars growing to their values, from a CSV or JSON file',
      'line-reveal': 'a line drawn left to right through your data points',
      'code-walkthrough': 'code revealed line by line, for a walkthrough video',
    };
    for (const preset of MOTION_PRESETS) {
      const data = presetNeedsData(preset) ? 'needs --data' : 'no data needed';
      logger.info(`  ${preset.padEnd(16)} ${help[preset] ?? ''}  (${data})`);
    }
    console.log('');
    logger.info('  Example: nuvira motion render --preset title-card --title "Hello" --duration 5000');
    logger.info('  Example: nuvira motion render --preset bar-race --data stars.csv --aspect 9:16');
  }

  private doctor(): void {
    const availability = motionAvailability();
    // Two routes, two dependency sets: an HTML/preset render captures frames in a
    // browser AND encodes them, while a frames render only encodes what YOUR
    // renderer already wrote. Reporting one missing chromium as "cannot render"
    // would be wrong for the route that never opens a browser.
    const frames = framesAvailability();
    const renders = listMotionManifests().length;

    if (availability.ok) {
      logger.success('  ✅ This machine can render every route: chromium (HTML/preset frames) and ffmpeg (encode).');
    } else if (frames.ok) {
      logger.warn(`  ⚠️  HTML and preset renders are unavailable — missing: ${availability.missing.join(', ')}`);
      if (availability.hint) logger.info(`     ${availability.hint}`);
      logger.info('     ✅ The frames route still works: pass --frames <dir> with your own renderer\'s PNGs.');
    } else {
      logger.warn(`  ⚠️  Cannot render yet — missing: ${availability.missing.join(', ')}`);
      if (availability.hint) logger.info(`     ${availability.hint}`);
      logger.info('     Until then `list`, `presets` and `open` still work; only `render` needs them.');
    }
    logger.info(`  📁 Renders live in ${motionHomeDir()}`);
    logger.info(`  🎬 ${renders} render(s) in this workspace`);
    this.nextSteps();
  }

  private async render(options: Record<string, unknown>): Promise<void> {
    const presetName = typeof options.preset === 'string' ? options.preset : undefined;
    const htmlPath = typeof options.html === 'string' ? options.html : undefined;
    const dataPath = typeof options.data === 'string' ? options.data : undefined;
    const framesDir = typeof options.frames === 'string' ? options.frames : undefined;
    const audioPath = typeof options.audio === 'string' ? options.audio : undefined;

    // Validate the SOURCE here, where the user is, rather than letting the tool
    // refuse after a chromium launch.
    if (!presetName && !htmlPath && !framesDir) {
      logger.error('  ❌ A render needs a source: --preset <name>, --html <file>, or --frames <dir>.');
      logger.info('     Run `nuvira motion presets` to see the ready-made scenes.');
      process.exitCode = 1;
      return;
    }
    if (framesDir && (presetName || htmlPath)) {
      logger.error('  ❌ Pass either --frames (your own renderer) or --preset/--html — not both.');
      process.exitCode = 1;
      return;
    }
    if (framesDir && !existsSync(framesDir)) {
      logger.error(`  ❌ No such frames directory: ${framesDir}`);
      process.exitCode = 1;
      return;
    }
    if (typeof options.renderer === 'string' && !framesDir) {
      logger.error('  ❌ --renderer records the command that made --frames, so it needs --frames too.');
      process.exitCode = 1;
      return;
    }
    if (audioPath && !existsSync(audioPath)) {
      logger.error(`  ❌ No such audio file: ${audioPath}`);
      process.exitCode = 1;
      return;
    }

    let preset: MotionPreset | undefined;
    if (presetName) {
      if (!isMotionPreset(presetName)) {
        logger.error(`  ❌ Unknown preset '${presetName}'. One of: ${MOTION_PRESETS.join(', ')}.`);
        process.exitCode = 1;
        return;
      }
      preset = presetName;
    }
    if (preset && presetNeedsData(preset) && !dataPath) {
      logger.error(`  ❌ '${preset}' animates YOUR data — pass --data <csv-or-json-file>.`);
      process.exitCode = 1;
      return;
    }
    if (dataPath && !existsSync(dataPath)) {
      logger.error(`  ❌ No such data file: ${dataPath}`);
      process.exitCode = 1;
      return;
    }

    // A frame sequence needs ffmpeg and no browser — the user already rendered it.
    const availability = framesDir ? framesAvailability() : motionAvailability();
    if (!availability.ok) {
      logger.error(`  ❌ Cannot render — missing: ${availability.missing.join(', ')}`);
      if (availability.hint) logger.info(`     ${availability.hint}`);
      process.exitCode = 1;
      return;
    }

    const params: Record<string, unknown> = {};
    if (typeof options.title === 'string') params.title = options.title;
    if (typeof options.subtitle === 'string') params.subtitle = options.subtitle;
    if (typeof options.kicker === 'string') params.kicker = options.kicker;
    if (typeof options.accent === 'string') params.accent = options.accent;
    if (typeof options.unit === 'string') params.unit = options.unit;

    const args: MotionToolArgs = {
      action: 'render',
      ...(preset ? { preset } : {}),
      ...(htmlPath ? { html_path: htmlPath } : {}),
      ...(framesDir ? { frames_dir: framesDir } : {}),
      ...(typeof options['framesPattern'] === 'string' ? { frames_pattern: options['framesPattern'] } : {}),
      ...(typeof options.renderer === 'string' ? { renderer_command: options.renderer } : {}),
      ...(typeof options['rendererCwd'] === 'string' ? { renderer_cwd: options['rendererCwd'] } : {}),
      ...(audioPath ? { audio_path: audioPath } : {}),
      ...(dataPath ? { data_path: dataPath } : {}),
      ...(Object.keys(params).length > 0 ? { params } : {}),
      ...(typeof options.out === 'string' ? { out_name: options.out } : {}),
      ...(typeof options.aspect === 'string' ? { aspect_ratio: options.aspect } : {}),
      ...(typeof options.duration === 'number' ? { duration_ms: options.duration } : {}),
      ...(typeof options.fps === 'number' ? { fps: options.fps } : {}),
      ...(typeof options.width === 'number' ? { width: options.width } : {}),
      ...(typeof options.height === 'number' ? { height: options.height } : {}),
      ...(typeof options.format === 'string' ? { format: options.format as MotionFormat } : {}),
      ...(typeof options.narration === 'string' ? { narration: options.narration } : {}),
      ...(typeof options.voice === 'string' ? { voice: options.voice } : {}),
    };

    const { runMotionTool } = await import('../tools/modality/motion-tool.js');
    try {
      const result = await runMotionTool(args, { configManager: this.configManager });
      logger.info(`  ${result.text.split('\n').join('\n  ')}`);
      if (result.media) {
        logger.success(`  ✅ ${result.media.path}`);
        logger.info(`     Open it:  nuvira motion open`);
      } else if (result.text.startsWith('Error:')) {
        // A render that produced nothing must not exit 0: a script that chains a
        // render into an upload would treat "no video" as success.
        process.exitCode = 1;
      }
    } catch (err) {
      // The tool reports refusals as text; this catches the unexpected, and says
      // what to do rather than only what broke.
      logger.error(`  ❌ Render failed: ${err instanceof Error ? err.message : String(err)}`);
      logger.info('     Check the machine with `nuvira motion doctor`.');
      process.exitCode = 1;
    }
  }

  /**
   * `nuvira motion revise <id>` — the same revision the tool performs, from the
   * terminal.
   *
   * Worth having as a command for one reason: a frames revision RE-RUNS the
   * renderer, so it is the one action a person wants to watch happen (and to
   * re-run with a different fps) without a model in the loop.
   */
  private async revise(id: string, options: Record<string, unknown>): Promise<void> {
    const audioPath = typeof options.audio === 'string' ? options.audio : undefined;
    if (audioPath && !existsSync(audioPath)) {
      logger.error(`  ❌ No such audio file: ${audioPath}`);
      process.exitCode = 1;
      return;
    }

    const args: MotionToolArgs = {
      action: 'revise',
      source_id: id,
      ...(typeof options.renderer === 'string' ? { renderer_command: options.renderer } : {}),
      ...(typeof options['rendererCwd'] === 'string' ? { renderer_cwd: options['rendererCwd'] } : {}),
      ...(options['allowRendererChange'] ? { allow_renderer_change: true } : {}),
      ...(options.preview ? { preview: true } : {}),
      ...(typeof options.fps === 'number' ? { fps: options.fps } : {}),
      ...(typeof options.duration === 'number' ? { duration_ms: options.duration } : {}),
      ...(typeof options.format === 'string' ? { format: options.format as MotionFormat } : {}),
      ...(audioPath ? { audio_path: audioPath } : {}),
      ...(typeof options.narration === 'string' ? { narration: options.narration } : {}),
    };

    const { runMotionTool } = await import('../tools/modality/motion-tool.js');
    try {
      const result = await runMotionTool(args, { configManager: this.configManager });
      logger.info(`  ${result.text.split('\n').join('\n  ')}`);
      if (result.media) logger.success(`  ✅ ${result.media.path}`);
      // A refusal is the tool's normal, honest answer here (no recorded renderer, or
      // a changed one) — so it sets the exit code rather than looking like success.
      else if (result.text.startsWith('Error:')) process.exitCode = 1;
    } catch (err) {
      logger.error(`  ❌ Revise failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    }
  }

  /**
   * `nuvira motion inspect` — the contact sheet.
   *
   * Here for the same reason `render` is: the loop is author → LOOK → fix, and a
   * person reviewing someone else's animation needs the same dozen keyframes a
   * model does.
   */
  private async inspect(options: Record<string, unknown>): Promise<void> {
    const htmlPath = typeof options.html === 'string' ? options.html : undefined;
    const framesDir = typeof options.frames === 'string' ? options.frames : undefined;
    if (!htmlPath && !framesDir) {
      logger.error('  ❌ inspect needs a source: --html <file> or --frames <dir>.');
      process.exitCode = 1;
      return;
    }
    if (htmlPath && !existsSync(htmlPath)) {
      logger.error(`  ❌ No such html file: ${htmlPath}`);
      process.exitCode = 1;
      return;
    }
    if (framesDir && !existsSync(framesDir)) {
      logger.error(`  ❌ No such frames directory: ${framesDir}`);
      process.exitCode = 1;
      return;
    }

    const availability = framesDir ? framesAvailability() : motionAvailability();
    if (!availability.ok) {
      logger.error(`  ❌ Cannot inspect — missing: ${availability.missing.join(', ')}`);
      if (availability.hint) logger.info(`     ${availability.hint}`);
      process.exitCode = 1;
      return;
    }

    const { inspectMotion } = await import('../tools/modality/motion.js');
    // Static import, never an inline `require` — that form threw at runtime in
    // the published build once already (see publish-tool.ts).
    const result = await inspectMotion({
      ...(framesDir ? { framesDir } : { html: readFileSync(htmlPath!, 'utf-8') }),
      ...(typeof options.tiles === 'number' ? { tiles: options.tiles } : {}),
      ...(typeof options['tileWidth'] === 'number' ? { tile_width: options['tileWidth'] } : {}),
      ...(typeof options.duration === 'number' ? { duration_ms: options.duration } : {}),
      ...(typeof options.fps === 'number' ? { fps: options.fps } : {}),
      ...(typeof options.out === 'string' ? { out_name: options.out } : {}),
    });

    if (!result.ok) {
      logger.error(`  ❌ ${result.error}`);
      if (result.hint) logger.info(`     ${result.hint}`);
      process.exitCode = 1;
      return;
    }
    logger.success(`  ✅ ${result.file}`);
    logger.info(
      `     ${result.tiles} keyframes, ${result.cols}×${result.rows} grid, ${result.secondsPerTile.toFixed(1)}s apart, ` +
        `from a ${result.width}×${result.height} ${result.frameSource === 'frames' ? 'frame sequence' : 'animation'}`,
    );
    for (const warning of result.warnings) logger.warn(`     ${warning}`);
  }

  private async open(id?: string): Promise<void> {
    const renders = listMotionManifests();
    if (renders.length === 0) {
      logger.warn('  No motion renders in this workspace yet.');
      this.nextSteps();
      return;
    }

    const manifest = id ? loadMotionManifest(id) : renders[0]!;
    if (!manifest) {
      logger.error(`  ❌ No render with id '${id}'. Run \`nuvira motion list\`.`);
      process.exitCode = 1;
      return;
    }
    if (!manifest.artifact || !existsSync(manifest.artifact)) {
      logger.error(`  ❌ ${manifest.id} recorded ${manifest.artifact || 'no artifact'}, which is gone.`);
      logger.info('     Re-render it from the stored source, or pick another with `nuvira motion list`.');
      process.exitCode = 1;
      return;
    }

    logger.info(`  📁 ${manifest.artifact}`);
    const launch = opener();
    if (!launch) {
      logger.info('     No viewer opener found on this machine — the path above is the artifact.');
      return;
    }
    try {
      spawn(launch.command, [...launch.args, manifest.artifact], { stdio: 'ignore', detached: true }).unref();
      logger.success('  ▶️  Opened in the system viewer.');
    } catch (err) {
      logger.warn(`  ⚠️  Could not open a viewer (${err instanceof Error ? err.message : String(err)}).`);
      logger.info('     The path above is the artifact.');
    }
  }

  /** The one thing a user with no renders needs: how to get one, both ways. */
  private nextSteps(): void {
    console.log('');
    logger.highlight('  Make one');
    logger.info('  • Without a model:  nuvira motion render --preset title-card --title "Hello"');
    logger.info('  • From your data:   nuvira motion render --preset bar-race --data numbers.csv');
    logger.info('  • Your own frames:  nuvira motion render --frames ./frames --fps 30 --renderer "python render.py"');
    logger.info('  • Re-render one:    nuvira motion revise <id> --fps 30');
    logger.info('  • In a chat turn:   "turn README.md into a 20s animated explainer with captions"');
    logger.info('  • In the dashboard: the Motion page plays every render inline.');
  }
}
