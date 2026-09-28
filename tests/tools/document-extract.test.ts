/**
 * P1 — real document extraction (PDF / DOCX / XLSX / PPTX).
 *
 * Every fixture is BUILT IN-TEST rather than committed as a binary: a hand-assembled
 * PDF with a real text layer, an OOXML .docx assembled with fflate, a workbook written
 * by SheetJS, and a .pptx assembled with fflate. That keeps the suite hermetic and
 * makes what each fixture contains explicit and reviewable.
 *
 * The claims under test are the ones this workstream exists to make true:
 *   - a PDF's text is actually read (not its bytes);
 *   - table rows survive, so a VALUE stays paired with its COLUMN — the whole point
 *     of reading a lab report;
 *   - a scanned PDF (no text layer) is a typed refusal, never an empty success;
 *   - spreadsheet dates come out as dates, not Excel serials;
 *   - the character budget is reported, never silent.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { getReadExtractManager, MAX_EXTRACT_CHARS } from '../../src/tools/read-extract.js';
import { joinLine } from '../../src/tools/extract/pdf.js';
import { htmlToText } from '../../src/tools/extract/html-text.js';
import { slideText } from '../../src/tools/extract/pptx.js';

const base = process.env.TMPDIR || process.env.TEMP || '/tmp';
const dir = mkdtempSync(join(base, 'buff-docextract-'));
const mgr = getReadExtractManager();

afterAll(() => rmSync(dir, { recursive: true, force: true }));

function put(name: string, data: Buffer | Uint8Array): string {
  const p = join(dir, name);
  writeFileSync(p, data);
  return p;
}

// ─── Fixture builders ───────────────────────────────────────────────────────

/**
 * A structurally valid single-page PDF whose content stream draws `lines` as real
 * text (WinAnsi Helvetica), with a correct xref table so pdf.js parses it normally.
 */
function buildPdf(lines: string[][]): Buffer {
  const ops = lines
    .map((runs, row) => {
      let x = 72;
      return runs
        .map((run) => {
          const op = `BT /F1 11 Tf ${x} ${720 - row * 18} Td (${run.replace(/([()\\])/g, '\\$1')}) Tj ET`;
          // Space each run by its rough width so a 3-column row keeps its geometry.
          x += run.length * 5.5 + 12;
          return op;
        })
        .join('\n');
    })
    .join('\n');

  return assemblePdf(`${ops}\n`);
}

/**
 * A PDF whose page draws only graphics — no text operators. This is what a scanned
 * report looks like to a text extractor: a real page, zero text items.
 */
function buildScannedPdf(): Buffer {
  return assemblePdf('0.2 0.2 0.8 RG 1 w 40 40 520 700 re S\n');
}

function assemblePdf(content: string): Buffer {
  const stream = Buffer.from(content, 'latin1');
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
  return Buffer.concat(chunks);
}

/** A minimal but valid OOXML .docx: a paragraph plus a 1×3 table. */
async function buildDocx(): Promise<Buffer> {
  const { zipSync, strToU8 } = await import('fflate');
  const cell = (t: string) =>
    `<w:tc><w:tcPr><w:tcW w:w="2000" w:type="dxa"/></w:tcPr><w:p><w:r><w:t>${t}</w:t></w:r></w:p></w:tc>`;
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
<w:p><w:r><w:t>HEALTH CHECKUP - BLOOD REPORT</w:t></w:r></w:p>
<w:tbl>
<w:tr>${cell('Marker')}${cell('Result')}${cell('Reference')}</w:tr>
<w:tr>${cell('Glucose')}${cell('112 mg/dL')}${cell('70-99')}</w:tr>
</w:tbl>
<w:p><w:r><w:t>Discuss these results with a physician.</w:t></w:r></w:p>
</w:body></w:document>`;

  return Buffer.from(zipSync({
    '[Content_Types].xml': strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
      + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
      + '<Default Extension="xml" ContentType="application/xml"/>'
      + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
      + '</Types>',
    ),
    '_rels/.rels': strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
      + '</Relationships>',
    ),
    'word/document.xml': strToU8(document),
  }));
}

/** A workbook with text, a number and a real date — written by SheetJS itself. */
async function buildXlsx(): Promise<Buffer> {
  const mod = await import('@e965/xlsx');
  const XLSX = ((mod as { default?: unknown }).default ?? mod) as {
    utils: { book_new: () => unknown; aoa_to_sheet: (rows: unknown[][], o?: unknown) => Record<string, unknown>; book_append_sheet: (wb: unknown, ws: unknown, name: string) => void };
    write: (wb: unknown, o: unknown) => Buffer;
  };

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([
    ['Marker', 'Result', 'Reference'],
    ['Glucose', 112, '70-99'],
    ['Collected', new Date(2026, 2, 15, 12, 0, 0), ''],
  ], { cellDates: true });

  XLSX.utils.book_append_sheet(wb, ws, 'Labs');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

/** A .pptx whose slides carry two paragraphs each. */
async function buildPptx(slides: { title: string; bullets: string[] }[]): Promise<Buffer> {
  const { zipSync, strToU8 } = await import('fflate');
  const entries: Record<string, Uint8Array> = {};
  slides.forEach((s, i) => {
    const para = (t: string) => `<a:p><a:r><a:t>${t}</a:t></a:r></a:p>`;
    entries[`ppt/slides/slide${i + 1}.xml`] =
      strToU8(`<?xml version="1.0" encoding="UTF-8"?><p:sld xmlns:a="x" xmlns:p="y">`
        + para(s.title) + s.bullets.map(para).join('')
        + '</p:sld>');
  });
  return Buffer.from(zipSync(entries));
}

// ─── PDF ────────────────────────────────────────────────────────────────────

describe('PDF — the text layer is read, and table rows survive', () => {
  let pdfPath: string;

  beforeAll(() => {
    pdfPath = put('blood-report.pdf', buildPdf([
      ['HEALTH CHECKUP - BLOOD REPORT'],
      ['Marker', 'Result', 'Reference'],
      ['Glucose', '112 mg/dL', '70-99'],
      ['LDL-C', '145 mg/dL', '<100'],
      ['Vitamin D', '22 ng/mL', '30-100'],
    ]));
  });

  it('extracts the report text (not the file bytes)', async () => {
    const r = await mgr.extract(pdfPath);

    expect(r.success).toBe(true);
    expect(r.format).toBe('pdf');
    expect(r.text).toContain('HEALTH CHECKUP');
    expect(r.text).toContain('Glucose');
    expect(r.text).toContain('112 mg/dL');
    expect(r.text).not.toContain('%PDF');
    expect(r.text).not.toContain('FlateDecode');
  });

  it('keeps each value on the SAME LINE as its column and reference range', async () => {
    const r = await mgr.extract(pdfPath);

    const row = r.text.split('\n').find((l) => l.includes('Glucose'));
    expect(row).toBeTruthy();
    // The pairing that makes the report readable: marker + value + range together.
    expect(row).toContain('112');
    expect(row).toContain('70-99');
  });

  it('reports page counts so a caller can tell a 1-page summary from a 12-page panel', async () => {
    const r = await mgr.extract(pdfPath);
    expect(r.metadata?.pages).toBe(1);
    expect(r.metadata?.pagesWithText).toBe(1);
    expect(r.metadata?.truncated).toBe(false);
    expect(r.metadata?.words).toBeGreaterThan(5);
  });

  it('refuses a scanned PDF with code no_data instead of returning empty text', async () => {
    const scanned = put('scanned.pdf', buildScannedPdf());

    const r = await mgr.extract(scanned);

    expect(r.success).toBe(false);
    expect(r.code).toBe('no_data');
    expect(r.text).toBe('');
    expect(String(r.error)).toContain('no text layer');
    expect(r.metadata?.pagesWithText).toBe(0);
    // And it says what to do instead, including how to ask for OCR.
    const alts = (r.alternatives ?? []).join(' ');
    expect(alts).toContain('describe_image');
    expect(alts).toContain('ocr:true');
  });

  it('reconstructs runs from geometry: no separator inside a word, | between columns', () => {
    const word = [
      { str: 'Glu', x: 10, y: 100, width: 18, size: 10 },
      { str: 'cose', x: 28.2, y: 100, width: 22, size: 10 },   // kerning split: joined
    ];
    expect(joinLine(word)).toBe('Glucose');

    const phrase = [
      { str: 'LDL-C', x: 10, y: 100, width: 28, size: 10 },
      { str: '145', x: 43, y: 100, width: 15, size: 10 },      // one space width
    ];
    expect(joinLine(phrase)).toBe('LDL-C 145');

    const columns = [
      { str: 'LDL-C', x: 10, y: 100, width: 28, size: 10 },
      { str: '145 mg/dL', x: 120, y: 100, width: 55, size: 10 }, // far apart: a column
    ];
    expect(joinLine(columns)).toBe('LDL-C | 145 mg/dL');
  });
});

// ─── DOCX ───────────────────────────────────────────────────────────────────

describe('DOCX — parsed as OOXML, with table cells kept on one line', () => {
  let docxPath: string;

  beforeAll(async () => {
    docxPath = put('report.docx', await buildDocx());
  });

  it('extracts paragraphs and table text', async () => {
    const r = await mgr.extract(docxPath);

    expect(r.success).toBe(true);
    expect(r.format).toBe('docx');
    expect(r.text).toContain('HEALTH CHECKUP');
    expect(r.text).toContain('Discuss these results');
    // The container's own bytes must not appear.
    expect(r.text).not.toContain('w:document');
    expect(r.text).not.toContain('PK');
  });

  it('keeps a table row on one line so columns stay paired', async () => {
    const r = await mgr.extract(docxPath);

    const row = r.text.split('\n').find((l) => l.includes('Glucose'));
    expect(row).toBeTruthy();
    expect(row).toContain('112 mg/dL');
    expect(row).toContain('70-99');
  });
});

// ─── XLSX ───────────────────────────────────────────────────────────────────

describe('XLSX — cells formatted, dates not serials', () => {
  let xlsxPath: string;

  beforeAll(async () => {
    xlsxPath = put('labs.xlsx', await buildXlsx());
  });

  it('extracts a labelled sheet with one row per line', async () => {
    const r = await mgr.extract(xlsxPath);

    expect(r.success).toBe(true);
    expect(r.format).toBe('xlsx');
    expect(r.text).toContain('## Sheet: Labs');
    expect(r.metadata?.sheets).toEqual(['Labs']);

    const row = r.text.split('\n').find((l) => l.includes('Glucose'));
    expect(row).toContain('112');
    expect(row).toContain('70-99');
  });

  it('applies the cell format so a date is an ISO date, not an Excel serial', async () => {
    const r = await mgr.extract(xlsxPath);

    // ISO, not the sheet's locale format (`3/15/26` is ambiguous about month/day)
    // and not the underlying serial.
    expect(r.text).toContain('2026-03-15');
    // A raw serial for that date is ~46096 — a leaked serial is the silent wrongness
    // this reader exists to avoid.
    expect(r.text).not.toMatch(/\b46\d{3}\b/);
  });

  it('refuses a spreadsheet with no non-empty cells with code no_data', async () => {
    const mod = await import('@e965/xlsx');
    const XLSX = ((mod as { default?: unknown }).default ?? mod) as any;
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([[null, null]]), 'Empty');
    const p = put('empty.xlsx', XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));

    const r = await mgr.extract(p);

    expect(r.success).toBe(false);
    expect(r.code).toBe('no_data');
  });
});

// ─── PPTX ───────────────────────────────────────────────────────────────────

describe('PPTX — slide text read from the package', () => {
  let pptxPath: string;

  beforeAll(async () => {
    pptxPath = put('deck.pptx', await buildPptx([
      { title: 'Blood Panel', bullets: ['Glucose 112 mg/dL', 'LDL-C 145 mg/dL'] },
      { title: 'Next Steps', bullets: ['Repeat in 3 months'] },
    ]));
  });

  it('extracts each slide with a header, bullets on their own lines', async () => {
    const r = await mgr.extract(pptxPath);

    expect(r.success).toBe(true);
    expect(r.format).toBe('pptx');
    expect(r.text).toContain('## Slide 1');
    expect(r.text).toContain('## Slide 2');
    expect(r.text).toContain('Glucose 112 mg/dL');
    expect(r.text).toContain('Repeat in 3 months');
    expect(r.metadata?.slides).toBe(2);

    // Bullet lines must not collapse into one blob.
    const lines = r.text.split('\n').filter((l) => l.includes('mg/dL'));
    expect(lines.length).toBe(2);
  });

  it('keeps paragraphs apart when reading one slide', () => {
    const xml = '<p:sld><a:p><a:r><a:t>Line one</a:t></a:r></a:p><a:p><a:r><a:t>A &amp; B</a:t></a:r></a:p></p:sld>';
    expect(slideText(xml)).toBe('Line one\nA & B');
  });

  it('refuses a pptx whose slides are all images with code no_data', async () => {
    const { zipSync, strToU8 } = await import('fflate');
    const p = put('images-only.pptx', Buffer.from(zipSync({
      'ppt/slides/slide1.xml': strToU8('<p:sld><p:pic/></p:sld>'),
    })));

    const r = await mgr.extract(p);

    expect(r.success).toBe(false);
    expect(r.code).toBe('no_data');
    expect(String(r.error)).toContain('text-free');
  });

  it('refuses a zip that is not a presentation', async () => {
    const { zipSync, strToU8 } = await import('fflate');
    const p = put('not-a-deck.pptx', Buffer.from(zipSync({ 'readme.txt': strToU8('hello') })));

    const r = await mgr.extract(p);

    expect(r.success).toBe(false);
    expect(r.code).toBe('unavailable');
    expect(String(r.error)).toContain('does not look like');
  });
});

// ─── P1.4 — the OCR route for scans ─────────────────────────────────────────

describe('scanned-PDF OCR route — available, or a refusal that names the missing piece', () => {
  const noRenderer = () => false;
  const anyRenderer = () => true;

  it('reports the route unavailable when no rasteriser exists', async () => {
    const { isPdfOcrAvailable } = await import('../../src/tools/extract/pdf-ocr.js');
    expect(await isPdfOcrAvailable({ renderProbe: noRenderer, vision: { probe: async () => true } })).toBe(false);
  });

  it('names Poppler when the rasteriser is the missing piece', async () => {
    const { ocrScannedPdf, PdfOcrError } = await import('../../src/tools/extract/pdf-ocr.js');

    const err = await ocrScannedPdf(join(dir, 'scanned.pdf'), 1, {
      renderProbe: noRenderer,
      vision: { probe: async () => true },
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(PdfOcrError);
    expect((err as InstanceType<typeof PdfOcrError>).code).toBe('not_configured');
    expect(String((err as Error).message)).toContain('Poppler');
  });

  it('names the vision backend when a rasteriser exists but no model does', async () => {
    const { ocrScannedPdf, PdfOcrError } = await import('../../src/tools/extract/pdf-ocr.js');

    const err = await ocrScannedPdf(join(dir, 'scanned.pdf'), 1, {
      renderProbe: anyRenderer,
      vision: { probe: async () => false },
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(PdfOcrError);
    expect((err as InstanceType<typeof PdfOcrError>).code).toBe('not_configured');
    expect(String((err as Error).message)).toContain('vision backend');
  });

  it('returns a typed refusal (never a crash) when OCR was requested but cannot run', async () => {
    const scanned = put('scanned-ocr.pdf', buildScannedPdf());

    const r = await mgr.extract(scanned, { ocr: true, ocrOptions: { renderProbe: noRenderer } });

    expect(r.success).toBe(false);
    expect(r.code).toBe('not_configured');
    expect(r.text).toBe('');
    expect(String(r.error)).toContain('Poppler');
    expect(r.metadata?.pages).toBe(1);
  });

  it('never returns a text-layer-free PDF as a success, with or without OCR', async () => {
    const scanned = put('scanned-2.pdf', buildScannedPdf());

    for (const ocr of [false, true]) {
      const r = await mgr.extract(scanned, { ocr, ocrOptions: { renderProbe: noRenderer } });
      expect(r.success, `ocr=${ocr}`).toBe(false);
      expect(r.code, `ocr=${ocr}`).toBeTruthy();
    }
  });
});

// ─── Budgets and structure sharing ──────────────────────────────────────────

describe('extraction budgets and shared structure handling', () => {
  it('caps extraction and says so rather than silently cutting a document', async () => {
    const huge = put('huge.txt', Buffer.from('y'.repeat(MAX_EXTRACT_CHARS + 5_000)));
    const r = await mgr.extract(huge);

    expect(r.success).toBe(true);
    expect(r.metadata?.truncated).toBe(true);
    expect(r.text).toContain('…[truncated]');
  });

  it('htmlToText keeps a cell on its line and decodes entities', () => {
    const html = '<table><tr><td><p>Glucose</p></td><td><p>112</p></td><td><p>70&ndash;99</p></td></tr>'
      + '<tr><td><p>LDL-C</p></td><td><p>145</p></td><td><p>&lt;100</p></td></tr></table>';

    const lines = htmlToText(html).split('\n').filter(Boolean);

    expect(lines[0]).toContain('Glucose');
    expect(lines[0]).toContain('112');
    expect(lines[0]).toContain('70–99');
    expect(lines[1]).toContain('<100');
  });

  it('reports the container formats as needing an on-demand reader', () => {
    expect(mgr.isContainerFormat('a.pdf')).toBe(true);
    expect(mgr.isContainerFormat('a.docx')).toBe(true);
    expect(mgr.isContainerFormat('a.txt')).toBe(false);
  });
});
