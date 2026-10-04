/**
 * Inbound media hydration tests (`src/gateway/inbound-media.ts`).
 *
 * A document that rode in on a chat message must become TEXT before the turn is
 * routed — otherwise the message has nothing to answer. These exercise the
 * hydration contract: extract what read_extract can read, report a sender-facing
 * failure when it cannot, save images for describe_image, never throw, and sweep
 * the artifact sandbox on a schedule.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// The voice pack's whisper backend is a real binary — mock the module so the
// transcription seam is exercised hermetically (no whisper on PATH).
import { isTranscribeAvailable, transcribe } from '../../src/tools/modality/voice.js';
vi.mock('../../src/tools/modality/voice.js', () => ({
  isTranscribeAvailable: vi.fn(() => true),
  transcribe: vi.fn(async () => ({ ok: true, text: 'remember to buy milk' })),
}));

import {
  hydrateInboundMedia,
  formatMediaFailureReply,
  pruneInboundMedia,
  inboundAttachmentPolicy,
  safeInboundName,
  sniffExtension,
  MAX_INBOUND_MEDIA_BYTES,
  INBOUND_MEDIA_TTL_MS,
  type InboundMedia,
} from '../../src/gateway/inbound-media.js';

const dirs: string[] = [];
let priorArtifacts: string | undefined;

beforeEach(() => {
  // Keep the artifact sandbox inside a throwaway tmpdir (never the project tree).
  const dir = mkdtempSync(join(tmpdir(), 'buff-inbound-media-'));
  dirs.push(dir);
  priorArtifacts = process.env.NUVIRA_ARTIFACTS_DIR;
  process.env.NUVIRA_ARTIFACTS_DIR = dir;
});

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  if (priorArtifacts === undefined) delete process.env.NUVIRA_ARTIFACTS_DIR;
  else process.env.NUVIRA_ARTIFACTS_DIR = priorArtifacts;
});

function doc(filename: string, text: string, type: InboundMedia['type'] = 'document'): InboundMedia {
  return { type, filename, data: new TextEncoder().encode(text) };
}

/**
 * A structurally valid single-page PDF that draws `text` as real text (WinAnsi
 * Helvetica), with a correct xref table so pdf.js parses it. Mirrors the builder
 * in `tests/tools/document-extract.test.ts` — kept local so this suite stays
 * self-contained.
 */
function buildPdf(text: string): Uint8Array {
  const ops = `BT /F1 11 Tf 72 720 Td (${text.replace(/([()\\])/g, '\\$1')}) Tj ET\n`;
  const stream = Buffer.from(ops, 'latin1');
  const bodies = [
    Buffer.from('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n', 'latin1'),
    Buffer.from('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n', 'latin1'),
    Buffer.from(
      '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] '
      + '/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n',
      'latin1',
    ),
    Buffer.from(
      '4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>\nendobj\n',
      'latin1',
    ),
    Buffer.concat([
      Buffer.from(`5 0 obj\n<< /Length ${stream.length} >>\nstream\n`, 'latin1'),
      stream,
      Buffer.from('endstream\nendobj\n', 'latin1'),
    ]),
  ];
  const chunks: Buffer[] = [Buffer.from('%PDF-1.4\n', 'latin1')];
  const offsets: number[] = [];
  let pos = chunks[0].length;
  bodies.forEach((b, i) => {
    offsets[i + 1] = pos;
    pos += b.length;
    chunks.push(b);
  });
  const xref = ['xref', '0 6', '0000000000 65535 f '];
  for (let i = 1; i <= 5; i++) xref.push(`${String(offsets[i]).padStart(10, '0')} 00000 n `);
  chunks.push(Buffer.from(
    `${xref.join('\n')}\ntrailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${pos}\n%%EOF\n`,
    'latin1',
  ));
  return new Uint8Array(Buffer.concat(chunks));
}

describe('safeInboundName', () => {
  it('strips path separators so an untrusted name cannot escape the sandbox', () => {
    expect(safeInboundName({ type: 'document', data: new Uint8Array(), filename: '../../etc/evil.pdf' }))
      .toBe('evil.pdf');
    expect(safeInboundName({ type: 'document', data: new Uint8Array(), filename: 'C:\\Users\\a\\report.docx' }))
      .toBe('report.docx');
  });

  it('falls back to the MIME type when the sender sent no filename', () => {
    expect(safeInboundName({ type: 'document', data: new Uint8Array(), mimetype: 'application/pdf' }))
      .toBe('inbound-document.pdf');
  });

  /**
   * An EXTENSIONLESS sender name must still get a readable extension.
   *
   * Live (2026-10-03): WhatsApp delivered a real 8 MB / 28-page PDF named
   * `Divya Sharma_report` (no extension). It persisted as-is, `read_extract`
   * refused it with `unsupported_format: (no extension)`, and the gateway told
   * the user "I couldn't read your document … re-send it as PDF" — advice that
   * named the exact format that had just been rejected.
   */
  it('appends an extension to an extensionless name (MIME first)', () => {
    expect(safeInboundName({
      type: 'document',
      filename: 'Divya Sharma_report',
      mimetype: 'application/pdf',
      data: new TextEncoder().encode('%PDF-1.4\n'),
    })).toBe('Divya Sharma_report.pdf');
  });

  it('appends an extension sniffed from the MAGIC BYTES when the MIME is absent', () => {
    // The exact live case: no MIME, no extension, but the bytes are a PDF.
    expect(safeInboundName({
      type: 'document',
      filename: 'Divya Sharma_report',
      data: new TextEncoder().encode('%PDF-1.4\n3 0 obj\n'),
    })).toBe('Divya Sharma_report.pdf');
  });

  it('never double-appends an extension a name already has', () => {
    expect(safeInboundName({ type: 'document', filename: 'report.pdf', mimetype: 'application/pdf', data: new TextEncoder().encode('%PDF') }))
      .toBe('report.pdf');
    // An UNKNOWN extension is left alone (read_extract gives its honest refusal).
    expect(safeInboundName({ type: 'document', filename: 'mystery.bin', data: new Uint8Array([0, 1, 2, 3]) }))
      .toBe('mystery.bin');
  });
});

describe('sniffExtension', () => {
  it('recognizes the common document/image magics', () => {
    expect(sniffExtension(new TextEncoder().encode('%PDF-1.4'))).toBe('.pdf');
    expect(sniffExtension(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('.png');
    expect(sniffExtension(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('.jpg');
    expect(sniffExtension(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))).toBe('.gif');
    expect(sniffExtension(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]))).toBe('.docx');
  });

  it('returns null for unrecognized or too-short data (never a guess)', () => {
    expect(sniffExtension(new Uint8Array([0, 1, 2, 3]))).toBeNull();
    expect(sniffExtension(new Uint8Array([0x25]))).toBeNull();
    expect(sniffExtension(new Uint8Array())).toBeNull();
    expect(sniffExtension(undefined)).toBeNull();
  });
});

describe('hydrateInboundMedia', () => {
  it('extracts an extractable document into a labelled section with its text', async () => {
    const { section, failure } = await hydrateInboundMedia(doc('notes.md', '# Title\n\nDeployment is on Friday.\n'));
    expect(section).toContain('[Document: notes.md');
    expect(section).toContain('Deployment is on Friday.');
    expect(section).toContain('saved at');
    expect(failure).toBeUndefined();
  });

  it('refuses an unsupported document with the typed code and a sender-facing failure', async () => {
    const { section, failure } = await hydrateInboundMedia(doc('mystery.bin', '\u0000\u0001raw'));
    expect(section).toContain('[Document: mystery.bin');
    expect(section).toContain('could not be extracted');
    expect(section).toContain('unsupported_format');
    // The failure is what the registry auto-replies with — it must name a reason.
    expect(failure?.type).toBe('document');
    expect(failure?.name).toBe('mystery.bin');
    expect(failure?.reason).toContain('Unsupported format');
  });

  /**
   * END-TO-END: an extensionless PDF must actually reach the PDF reader.
   *
   * This is the whole point of the filename fix — the bytes are a real PDF, the
   * name carries no extension, and the turn must still get the extracted text
   * rather than an `unsupported_format` refusal.
   */
  it('extracts an extensionless PDF whose bytes are a real PDF (live WhatsApp case)', async () => {
    const { section, failure } = await hydrateInboundMedia({
      type: 'document',
      filename: 'Divya Sharma_report',
      data: buildPdf('HbA1c 6.1 percent HDL 33.4 mg/dL'),
    });
    expect(failure).toBeUndefined();
    // The sender's display name is kept verbatim in the heading; the SAVED path
    // is what must carry the extension (that is what read_extract dispatches on).
    expect(section).toContain('[Document: Divya Sharma_report');
    expect(section).toMatch(/saved at .*Divya Sharma_report\.pdf/);
    expect(section).not.toContain('could not be extracted');
    expect(section).toContain('HbA1c 6.1');
  });

  it('saves an image and points the model at describe_image', async () => {
    const { section, failure } = await hydrateInboundMedia({
      type: 'image',
      filename: 'photo.png',
      data: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    });
    expect(section).toContain('[Image: photo.png');
    expect(section).toContain('describe_image');
    // An image is expected to need the vision tool — no "could not extract" reply.
    expect(failure).toBeUndefined();
  });

  it('reports an empty attachment instead of writing a zero-byte file', async () => {
    const { section, failure } = await hydrateInboundMedia({ type: 'document', filename: 'empty.pdf', data: new Uint8Array() });
    expect(section).toContain('empty (zero bytes)');
    expect(failure?.reason).toContain('empty (zero bytes)');
  });

  it('reports an oversized attachment without extracting it', async () => {
    const { section, failure } = await hydrateInboundMedia({
      type: 'document',
      filename: 'huge.pdf',
      data: new Uint8Array(MAX_INBOUND_MEDIA_BYTES + 1),
    });
    expect(section).toContain('larger than');
    expect(failure).toBeDefined();
  });

  it('honors a configured maxBytes cap', async () => {
    const { section, failure } = await hydrateInboundMedia(
      { type: 'document', filename: 'small.md', data: new TextEncoder().encode('hello') },
      { maxBytes: 2 },
    );
    expect(section).toContain('larger than the 2 B limit');
    expect(failure).toBeDefined();
  });

  it('does NOT raise a sender failure for a video (not an extraction job)', async () => {
    const { failure } = await hydrateInboundMedia({
      type: 'video',
      filename: 'clip.mp4',
      data: new Uint8Array([1, 2, 3]),
    });
    expect(failure).toBeUndefined();
  });
});

describe('hydrateInboundMedia — voice notes', () => {
  it('transcribes an inbound voice note through the existing whisper path', async () => {
    vi.mocked(isTranscribeAvailable).mockReturnValue(true);
    vi.mocked(transcribe).mockResolvedValue({ ok: true, text: 'remember to buy milk' });
    const { section, failure } = await hydrateInboundMedia({
      type: 'audio',
      filename: 'note.ogg',
      data: new Uint8Array([1, 2, 3]),
    });
    expect(section).toContain('[Voice note: note.ogg — transcript]');
    expect(section).toContain('remember to buy milk');
    expect(failure).toBeUndefined();
    // It routed to the transcription path, not read_extract.
    expect(vi.mocked(transcribe)).toHaveBeenCalledOnce();
  });

  it('reports a sender-facing failure when transcription is not set up', async () => {
    vi.mocked(isTranscribeAvailable).mockReturnValue(false);
    const { section, failure } = await hydrateInboundMedia({
      type: 'audio',
      filename: 'note.ogg',
      data: new Uint8Array([1, 2, 3]),
    });
    expect(section).toContain('could not be transcribed');
    expect(failure?.type).toBe('audio');
    expect(failure?.reason).toContain('not set up');
    const reply = formatMediaFailureReply(failure!);
    expect(reply).toContain('voice note');
    expect(reply).toContain('text message');
  });

  it('reports a failure when the transcription run itself fails', async () => {
    vi.mocked(isTranscribeAvailable).mockReturnValue(true);
    vi.mocked(transcribe).mockResolvedValue({ ok: false, error: 'whisper crashed' });
    const { section, failure } = await hydrateInboundMedia({
      type: 'audio',
      filename: 'note.ogg',
      data: new Uint8Array([1, 2, 3]),
    });
    expect(section).toContain('could not be transcribed');
    expect(failure?.reason).toContain('could not be transcribed');
  });
});

describe('formatMediaFailureReply', () => {
  it('names the file and the reason, and leaks neither a path nor tool jargon', () => {
    const reply = formatMediaFailureReply({
      name: 'report.pdf',
      type: 'document',
      reason: 'The PDF has 3 page(s) but no text layer — it is a scan/image.',
    });
    expect(reply).toContain('report.pdf');
    expect(reply).toContain('no text layer');
    expect(reply).toContain('re-send it as PDF');
    expect(reply).not.toContain('read_extract');
    expect(reply).not.toContain('saved at');
  });
});

describe('inboundAttachmentPolicy', () => {
  it('defaults to enabled with the module cap', () => {
    expect(inboundAttachmentPolicy()).toEqual({ enabled: true, maxBytes: MAX_INBOUND_MEDIA_BYTES });
    expect(inboundAttachmentPolicy({ getAll: () => ({}) })).toEqual({ enabled: true, maxBytes: MAX_INBOUND_MEDIA_BYTES });
  });

  it('honors enabled:false and a custom maxBytes', () => {
    expect(
      inboundAttachmentPolicy({ getAll: () => ({ gateway: { inboundAttachments: { enabled: false, maxBytes: 1024 } } }) }),
    ).toEqual({ enabled: false, maxBytes: 1024 });
  });

  it('ignores an invalid maxBytes and treats a throwing config as enabled', () => {
    expect(
      inboundAttachmentPolicy({ getAll: () => ({ gateway: { inboundAttachments: { maxBytes: -5 } } }) }).maxBytes,
    ).toBe(MAX_INBOUND_MEDIA_BYTES);
    expect(inboundAttachmentPolicy({ getAll: () => { throw new Error('boom'); } })).toEqual({
      enabled: true,
      maxBytes: MAX_INBOUND_MEDIA_BYTES,
    });
  });
});

describe('pruneInboundMedia', () => {
  const inboundDir = (): string => join(process.env.NUVIRA_ARTIFACTS_DIR!, 'inbound');

  it('removes files past the TTL and keeps recent ones', () => {
    const dir = inboundDir();
    mkdirSync(dir, { recursive: true });
    const oldFile = join(dir, 'old.pdf');
    const newFile = join(dir, 'new.pdf');
    writeFileSync(oldFile, 'old');
    writeFileSync(newFile, 'new');
    const now = Date.now();
    const stale = new Date(now - INBOUND_MEDIA_TTL_MS - 1000);
    utimesSync(oldFile, stale, stale);

    const res = pruneInboundMedia({ now });
    expect(res.removed).toBe(1);
    expect(existsSync(oldFile)).toBe(false);
    expect(existsSync(newFile)).toBe(true);
    expect(res.kept).toBe(1);
  });

  it('sweeps the oldest files when the sandbox is over the size cap', () => {
    const dir = inboundDir();
    mkdirSync(dir, { recursive: true });
    const older = join(dir, 'a.bin');
    const newer = join(dir, 'b.bin');
    writeFileSync(older, Buffer.alloc(10));
    writeFileSync(newer, Buffer.alloc(10));
    const now = Date.now();
    utimesSync(older, new Date(now - 2000), new Date(now - 2000));
    utimesSync(newer, new Date(now), new Date(now));

    const res = pruneInboundMedia({ now, maxBytes: 12 });
    expect(res.removed).toBe(1);
    expect(existsSync(older)).toBe(false);
    expect(existsSync(newer)).toBe(true);
  });
});
