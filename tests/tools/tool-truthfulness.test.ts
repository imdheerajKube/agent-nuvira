/**
 * Tool truthfulness — a tool that cannot do its work must SAY so.
 *
 * Live incident (2026-09-27): a PDF blood report was placed in the project and
 * `read_extract` answered `{ text: '<%PDF-1.4 …raw bytes…>', success: true }`. The
 * model had no signal that extraction had failed, so the turn produced a generic
 * Markdown template, claimed to have "verified that the file was created
 * correctly", and only on the third turn told the user the file had never been read.
 *
 * This suite pins one assertion per tool fixed under workstream P0 of
 * TOOL_TRUTHFULNESS_TRACKER.md: a path that performs no work returns a typed
 * refusal (`success: false` / `ok: false` + a `code`), never an empty-but-valid
 * payload, a fabricated identifier, or fabricated data.
 *
 * All backends are absent or injected — no Ollama, no Gemini key, no NeuTTS API
 * key, no network.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

// `resolveNuviraHome()` is `join(homedir(), '.nuvira')`, and DelegationManager writes
// its task/cache files there at construction time — so a test that builds one would
// otherwise write the developer's real ~/.nuvira. Same pattern as
// tests/tools/registry.test.ts.
const testHome = vi.hoisted(() => {
  const { mkdtempSync } = require('node:fs');
  const { join } = require('node:path');
  const base = process.env.TMPDIR || process.env.TEMP || '/tmp';
  return { value: mkdtempSync(join(base, 'buff-truthfulness-home-')) };
});

vi.mock('node:os', () => ({
  homedir: () => testHome.value,
  tmpdir: () => process.env.TMPDIR || process.env.TEMP || '/tmp',
}));

import { getReadExtractManager, parseCsvRow, isReadExtractAvailable } from '../../src/tools/read-extract.js';
import { getVisionAnalyzer } from '../../src/tools/vision-tools.js';
import { MessagingManager } from '../../src/tools/messaging-tools.js';
import { NeuTTSSynthesizer } from '../../src/tools/neutts-synth.js';
import { getTool, type ToolContext } from '../../src/tools/registry.js';

const base = process.env.TMPDIR || process.env.TEMP || '/tmp';
const workDir = mkdtempSync(join(base, 'buff-truthfulness-work-'));
const outDir = join(workDir, 'out');

/** A real-neighbourhood PDF: header + a FlateDecode stream (binary, contains NULs) + trailer. */
function pdfBuffer(): Buffer {
  return Buffer.concat([
    Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Page /Filter /FlateDecode >>\nstream\n'),
    Buffer.from([0x78, 0x9c, 0x00, 0x01, 0xff, 0x7f, 0x00, 0x00, 0x03]),
    Buffer.from('\nendstream\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n'),
  ]);
}

/** A ZIP container header — what a .docx/.xlsx/.pptx actually is. */
function zipBuffer(): Buffer {
  return Buffer.concat([
    Buffer.from([0x50, 0x4b, 0x03, 0x04]),
    Buffer.from([0x00, 0x00, 0x00, 0x00, 0x08, 0x00, 0x00, 0x00]),
    Buffer.from('<w:document><w:t>BLOOD REPORT: Glucose 112</w:t></w:document>'),
  ]);
}

/** A valid minimal PNG whose IHDR carries the given pixel dimensions. */
function pngBuffer(width: number, height: number): Buffer {
  const b = Buffer.alloc(32);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0); // signature
  b.writeUInt32BE(13, 8);                                                    // IHDR length
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

beforeAll(() => {
  mkdirSync(outDir, { recursive: true });
  // Deterministic: no API key means no network path in the TTS tests.
  delete process.env.NEUTTS_API_KEY;
});

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
  rmSync(testHome.value, { recursive: true, force: true });
});

afterEach(() => {
  delete process.env.BUFF_NEUTTS_ALLOW_SILENT;
  vi.restoreAllMocks();
});

const ctx = { configManager: {} } as unknown as ToolContext;

// ─── read_extract ───────────────────────────────────────────────────────────

describe('read_extract — an unimplemented format refuses, it does not return bytes as text', () => {
  const mgr = getReadExtractManager();

  it('refuses a corrupt PDF without leaking its raw bytes into `text`', async () => {
    // A file that announces itself as a PDF but is not parseable. Before P1 this
    // path returned the bytes as `text` with `success: true` — the 2026-09-27 incident.
    const pdf = join(workDir, 'blood-report.pdf');
    writeFileSync(pdf, pdfBuffer());

    const r = await mgr.extract(pdf);

    expect(r.success).toBe(false);
    expect(r.text).toBe('');
    expect(r.code).toBeTruthy();
    // The regression that matters: raw PDF bytes must never become "document text".
    expect(JSON.stringify(r)).not.toContain('%PDF');
    expect(JSON.stringify(r)).not.toContain('FlateDecode');
    expect(r.alternatives?.length ?? 0).toBeGreaterThan(0);
  });

  it('refuses a corrupt DOCX instead of stripping its XML tags as if it were HTML', async () => {
    const docx = join(workDir, 'report.docx');
    writeFileSync(docx, zipBuffer());

    const r = await mgr.extract(docx);

    expect(r.success).toBe(false);
    expect(r.text).toBe('');
    expect(r.code).toBeTruthy();
    expect(JSON.stringify(r)).not.toContain('BLOOD REPORT');
  });

  it('refuses the legacy binary Office formats with a reason and alternatives', async () => {
    for (const name of ['old.doc', 'old.xls', 'old.ppt', 'notes.rtf', 'doc.odt']) {
      const p = join(workDir, name);
      writeFileSync(p, Buffer.from('legacy container bytes'));
      const r = await mgr.extract(p);
      expect(r.success, name).toBe(false);
      expect(r.code, name).toBe('unsupported_format');
      expect(r.alternatives?.length ?? 0, name).toBeGreaterThan(0);
    }
  });

  it('refuses a path that does not exist with code no_data', async () => {
    const r = await mgr.extract(join(workDir, 'not-here.txt'));
    expect(r.success).toBe(false);
    expect(r.code).toBe('no_data');
  });

  it('still extracts the formats it really supports', async () => {
    const txt = join(workDir, 'notes.txt');
    writeFileSync(txt, 'Glucose 112 mg/dL\nLDL-C 145 mg/dL\n');

    const r = await mgr.extract(txt);

    expect(r.success).toBe(true);
    expect(r.text).toContain('Glucose 112');
    expect(r.metadata?.words).toBeGreaterThan(0);
  });

  it('does not silently corrupt a quoted CSV comma', async () => {
    // The naive `split(',')` turned the reference range into a separate column and
    // destroyed the value/range pairing while still reporting success.
    const csv = join(workDir, 'labs.csv');
    writeFileSync(csv, 'Marker,Value,Reference\nGlucose,112,"HIGH, range 70-99"\n');

    const r = await mgr.extract(csv);

    expect(r.success).toBe(true);
    expect(r.text).toContain('HIGH, range 70-99'); // one intact cell
    expect(r.text).not.toContain('HIGH | range');  // not torn across columns
    expect(r.metadata?.rows).toBe(2);
  });

  it('refuses a "text" file whose bytes are binary', async () => {
    const fake = join(workDir, 'actually-binary.md');
    writeFileSync(fake, Buffer.from([0x23, 0x20, 0x00, 0x01, 0x62, 0x69, 0x6e]));

    const r = await mgr.extract(fake);

    expect(r.success).toBe(false);
    expect(r.code).toBe('unsupported_format');
  });

  it('reports only implemented formats as supported, and probes per file', () => {
    const formats = mgr.getSupportedFormats();
    // Implemented under P1.
    for (const f of ['.pdf', '.docx', '.xlsx', '.pptx']) {
      expect(formats, f).toContain(f);
    }
    // Still unimplemented, and advertised as such.
    for (const f of ['.doc', '.xls', '.ppt', '.rtf', '.odt']) {
      expect(formats, f).not.toContain(f);
    }
    expect(mgr.getPendingFormats().map((p) => p.format)).toEqual(
      expect.arrayContaining(['.doc', '.xls', '.ppt', '.rtf']),
    );

    expect(isReadExtractAvailable('report.pdf')).toBe(true);
    expect(isReadExtractAvailable('notes.txt')).toBe(true);
    expect(isReadExtractAvailable('legacy.doc')).toBe(false);
  });

  it('caps a huge text file and says it truncated', async () => {
    const big = join(workDir, 'big.txt');
    writeFileSync(big, 'x'.repeat(45_000));

    const r = await mgr.extract(big);

    expect(r.success).toBe(true);
    expect(r.metadata?.truncated).toBe(true);
    // The truncation is stated IN THE TEXT the model reads (not only in
    // metadata) — a model that read a silently-cut document assessed it as if
    // it were complete.
    expect(r.text).toContain('TRUNCATED');
    expect(r.text).toContain('NUVIRA_EXTRACT_MAX_CHARS');
    // Body capped at the budget; the notice is appended after it, so the total
    // is the budget plus the notice — still far short of the 45,000-char file.
    expect(r.text.length).toBeLessThan(42_000);
  });

  it('parses CSV quoting rules directly', () => {
    expect(parseCsvRow('a,b,c')).toEqual(['a', 'b', 'c']);
    expect(parseCsvRow('a,"b,with,commas",c')).toEqual(['a', 'b,with,commas', 'c']);
    expect(parseCsvRow('a,"say ""hi""",c')).toEqual(['a', 'say "hi"', 'c']);
  });
});

// ─── registry descriptions ──────────────────────────────────────────────────

describe('registry — descriptions do not advertise unimplemented capability', () => {
  it('read_extract advertises the formats that work and the codes for the rest', () => {
    const d = getTool('read_extract')?.description ?? '';
    expect(d).toContain('WORKS for PDF');
    expect(d).toContain('no_data');
    expect(d).toContain('scanned PDF');
  });

  it('the vision tool says which actions have no backend', () => {
    const d = getTool('vision')?.description ?? '';
    expect(d).toContain('not_configured');
    expect(d).toContain('describe_image');
  });

  it('delegate_system states that it needs an executor and points at `delegate`', () => {
    const d = getTool('delegate_system')?.description ?? '';
    expect(d).toContain('not_configured');
    expect(d).toContain('delegate');
  });

  it('the messaging tool is marked NOT CONNECTED and points at gateway_send', () => {
    const d = getTool('messaging')?.description ?? '';
    expect(d).toContain('NOT CONNECTED');
    expect(d).toContain('gateway_send');
  });

  it('messaging react returns a refusal through the registry — never the word "Reacted"', async () => {
    const tool = getTool('messaging');
    expect(tool).toBeTruthy();

    const out = await tool!.run(
      { action: 'react', service: 'slack', channel: 'C1', emoji: '+' } as never,
      ctx,
    );

    expect(out).not.toBe('Reacted');
    const parsed = JSON.parse(String(out));
    expect(parsed.success).toBe(false);
    expect(parsed.code).toBe('not_configured');
  });

  it('messaging send returns a refusal through the registry too', async () => {
    const tool = getTool('messaging')!;
    const out = await tool.run(
      { action: 'send', service: 'telegram', channel: 'C1', message: 'hello' } as never,
      ctx,
    );

    const parsed = JSON.parse(String(out));
    expect(parsed.success).toBe(false);
    expect(parsed.messageId).toBeUndefined();
  });
});

// ─── messaging manager ──────────────────────────────────────────────────────

describe('messaging — no adapter means no fabricated delivery', () => {
  it('never returns success or a synthetic messageId for any platform', async () => {
    const mgr = new MessagingManager();

    for (const platform of ['discord', 'slack', 'telegram', 'whatsapp', 'feishu', 'webhook'] as const) {
      const r = await mgr.sendMessage({ platform, channelId: 'c1' }, { content: 'hi' });
      expect(r.success, platform).toBe(false);
      expect(r.messageId, platform).toBeUndefined();
      expect(r.code, platform).toBe('not_configured');
      expect(r.error, platform).toBeTruthy();
      expect(r.error, platform).toContain('gateway_send');
    }
  });

  it('keeps history empty — an undelivered message is never recorded as sent', async () => {
    const mgr = new MessagingManager();
    await mgr.sendMessage({ platform: 'telegram', channelId: 'c1' }, { content: 'hi' });
    expect(mgr.getHistory()).toEqual([]);
  });

  it('refuses reactions instead of claiming one was applied', async () => {
    const mgr = new MessagingManager();
    const r = await mgr.reactToMessage('slack', 'C1', 'latest', '👍');
    expect(r.success).toBe(false);
    expect(r.code).toBe('not_configured');
  });
});

// ─── neutts_synth ───────────────────────────────────────────────────────────

describe('neutts_synth — silence is never reported as speech', () => {
  it('refuses when no backend is configured, and writes no audio file', async () => {
    const synth = new NeuTTSSynthesizer({ outputDir: outDir });

    const r = await synth.synthesize('hello world');

    expect(r.ok).toBe(false);
    expect(r.code).toBe('not_configured');
    expect(r.audioPath).toBe('');
    expect(r.silent).toBeUndefined();
    expect(r.error).toBeTruthy();
  });

  it('writes a silent placeholder ONLY behind the explicit opt-in, and flags it', async () => {
    process.env.BUFF_NEUTTS_ALLOW_SILENT = '1';
    const synth = new NeuTTSSynthesizer({ outputDir: outDir });

    const r = await synth.synthesize('hello world');

    expect(r.ok).toBe(true);
    expect(r.silent).toBe(true);
    expect(r.audioPath).not.toBe('');
    expect(existsSync(r.audioPath)).toBe(true);
  });

  it('lists no voices when no backend is configured', async () => {
    const synth = new NeuTTSSynthesizer({ outputDir: outDir });
    expect(await synth.listVoices()).toEqual([]);
  });
});

// ─── vision ─────────────────────────────────────────────────────────────────

describe('vision — a missing backend is a refusal, not an empty result', () => {
  const analyzer = getVisionAnalyzer();
  const noBackend = { probe: async () => false };
  const scan = () => join(workDir, 'scan.png');

  it('refuses OCR when no vision backend is configured', async () => {
    const r = await analyzer.ocr(scan(), noBackend);

    expect(r.ok).toBe(false);
    expect(r.code).toBe('not_configured');
    expect(r.text).toBe('');
    expect(r.via).toBeUndefined();
    expect(r.alternatives?.length ?? 0).toBeGreaterThan(0);
  });

  it('refuses element detection instead of returning [] as success', async () => {
    const r = await analyzer.detectUIElements(scan());

    expect(r.ok).toBe(false);
    expect(r.code).toBe('not_configured');
    expect(r.elements).toEqual([]); // empty list is a refusal, not "found nothing"
    expect(r.error).toBeTruthy();
  });

  it('refuses comparison instead of reporting 0 similarity as a result', async () => {
    const r = await analyzer.compare('a.png', 'b.png');

    expect(r.ok).toBe(false);
    expect(r.code).toBe('not_configured');
    expect(r.similarity).toBeUndefined();
  });

  it('still reads REAL pixel dimensions, and says only metadata was read', async () => {
    const png = join(workDir, 'tiny.png');
    writeFileSync(png, pngBuffer(3, 2));

    const r = await analyzer.analyze(png, noBackend);

    expect(r.ok).toBe(true);
    expect(r.dimensions).toEqual({ width: 3, height: 2 });
    expect(r.via).toBe('metadata');
    expect(r.note).toContain('No vision backend');
  });

  it('a failed read is ok:false with a typed code, not a blank analysis', async () => {
    const r = await analyzer.analyze(join(workDir, 'does-not-exist.png'), noBackend);

    expect(r.ok).toBe(false);
    expect(r.code).toBe('no_data');
    expect(r.error).toBeTruthy();
  });
});

// ─── delegate_system ────────────────────────────────────────────────────────

describe('delegate_system — a task that never ran is not reported as completed', () => {
  it('refuses a delegation with no executor, and never echoes the goal back as a result', async () => {
    const { getDelegationManager } = await import('../../src/tools/delegation-system.js');
    const mgr = getDelegationManager();
    mgr.clearExecutor();

    const task = await mgr.delegate('summarise the blood report');
    const res = await mgr.waitForCompletion(task.id);

    expect(res.success).toBe(false);
    expect(res.code).toBe('not_configured');
    expect(res.result).toBeUndefined();
    expect(String(res.summary)).not.toContain('Task completed:');
    expect(String(res.error)).toContain('did NOT run');
    expect(res.alternatives?.length ?? 0).toBeGreaterThan(0);
  });

  it('names only WORKING alternatives — each one can actually run', async () => {
    // P4.1: `subagent` was listed here while its spawn path could not run at all
    // (fork target CJS under `type: module`, never emitted to dist), so it was
    // removed. It is back now that a child really forks and really refuses
    // instead of faking output — the test holds the rule, not the names: any
    // alternative listed must be a path that executes.
    const { getDelegationManager } = await import('../../src/tools/delegation-system.js');
    const mgr = getDelegationManager();
    mgr.clearExecutor();

    const task = await mgr.delegate('summarise the blood report');
    const res = await mgr.waitForCompletion(task.id);

    const alternatives = (res.alternatives ?? []).join(' | ');
    expect(alternatives).toContain('delegate');
    expect(alternatives).toContain('subagent');
  });

  it('runs a real executor when one is wired, and returns its output verbatim', async () => {
    const { getDelegationManager } = await import('../../src/tools/delegation-system.js');
    const mgr = getDelegationManager();
    mgr.setExecutor(async () => 'REAL-CHILD-OUTPUT');

    try {
      const task = await mgr.delegate('do the thing');
      const res = await mgr.waitForCompletion(task.id);

      expect(res.success).toBe(true);
      expect(res.result).toBe('REAL-CHILD-OUTPUT');
      expect(mgr.hasExecutor()).toBe(true);
    } finally {
      mgr.clearExecutor();
    }
  });
});

// ─── subagent (P4.1) ────────────────────────────────────────────────────────

describe('subagent — a child that reported nothing is not a completed task', () => {
  it('classifies an exit with no result as a failure, never a fabricated success', async () => {
    const { classifyChildExit } = await import('../../src/tools/subagent-spawner.js');

    // The defect: a child exiting 0 with no `result` message became `completed`
    // with 'Task completed successfully', so `subagent wait` returned success
    // for a run whose output never existed.
    const silent = classifyChildExit(undefined, 0, null);
    expect(silent.status).toBe('failed');
    expect(silent.error).toContain('without reporting a result');

    // A child that DID report a result is still a success.
    expect(classifyChildExit('REAL-OUTPUT', 0, null).status).toBe('completed');

    // A crash keeps its reason.
    const crashed = classifyChildExit(undefined, 1, null);
    expect(crashed.status).toBe('failed');
    expect(crashed.error).toBe('Exit code 1');
  });

  it('advertises a real run that refuses rather than one that fabricates', () => {
    // It was NOT CONNECTED while its forked entry could not execute. Now it
    // advertises what it actually does — including that it refuses.
    const d = getTool('subagent')?.description ?? '';
    expect(d).not.toContain('NOT CONNECTED');
    expect(d).toContain('REFUSES');
    expect(d).toContain('own process');
    // And the entry it forks is shipped by the build (compiled, or the source
    // the tsx loader runs) — the thing that made the old path dead.
    const dir = resolve(__dirname, '..', '..', 'src', 'tools');
    expect(existsSync(join(dir, 'child-agent-entry.ts'))).toBe(true);
  });
});
