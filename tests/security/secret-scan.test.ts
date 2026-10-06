/**
 * secret-scan — the local, dependency-free secret detector.
 *
 * The scanner is a LINT, so the tests pin both directions:
 *  - it FINDS the shapes that matter (and masks them), and
 *  - it does NOT flag the placeholders that would make it noise and get it
 *    switched off (`.env.example`, `${VAR}` interpolation, the bare prefixes
 *    that appear as string literals in this very repo).
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  scanText,
  scanDirectory,
  shouldSkipPath,
  looksLikePlaceholder,
  formatSecretScan,
  MAX_FILE_BYTES,
} from '../../src/security/secret-scan.js';

/** Fake values, shaped like the real thing (never real credentials). */
const FAKE = {
  github: 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8',
  openai: 'sk-' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6',
  awsId: 'AKIA' + 'IOSFODNN7EXAMPLE'.slice(0, 16),
  groq: 'gsk_' + 'Xy9Za8Bc7De6Fg5Hi4Jk3Lm2No1Pq0Rs',
  jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk',
};

describe('scanText — detection', () => {
  it('finds a GitHub token and reports its location', () => {
    const text = ['// header', `const token = "${FAKE.github}";`].join('\n');
    const hits = scanText(text, 'src/config.ts');
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ path: 'src/config.ts', line: 2, id: 'github-pat', severity: 'critical' });
    expect(hits[0].column).toBeGreaterThan(1);
  });

  it('finds an assignment-shaped secret and attributes it to the VALUE, not the whole line', () => {
    const hits = scanText(`api_key = "${FAKE.openai}"`, 'a.env');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((h) => h.id === 'openai-key' || h.id === 'assigned-secret')).toBe(true);
  });

  it('finds an AWS access key id, a JWT, and credentials inside a URL', () => {
    expect(scanText(`aws=${FAKE.awsId}`)[0].id).toBe('aws-access-key-id');
    expect(scanText(`Authorization: Bearer ${FAKE.jwt}`).some((h) => h.id === 'jwt')).toBe(true);
    expect(scanText('postgres://admin:hunter2secret@db.internal:5432/app').some((h) => h.id === 'url-credentials')).toBe(true);
  });

  it('finds a private key block', () => {
    const hits = scanText('-----BEGIN RSA PRIVATE KEY-----\nMIIE...');
    expect(hits[0]).toMatchObject({ id: 'private-key', severity: 'critical' });
  });

  it('NEVER returns the raw value — only a masked form', () => {
    const hits = scanText(`token=${FAKE.groq}`);
    expect(hits).toHaveLength(1);
    expect(hits[0].masked).not.toBe(FAKE.groq);
    expect(hits[0].masked).toContain('…');
    expect(JSON.stringify(hits)).not.toContain(FAKE.groq);
  });
});

describe('scanText — noise control (the part that keeps the lint usable)', () => {
  it('ignores placeholders and template interpolation', () => {
    const noise = [
      'API_KEY=your-api-key-here',
      'API_KEY=${OPENAI_API_KEY}',
      'apiKey: "example-token-value"',
      'token: "<YOUR_TOKEN>"',
      'secret = "changeme"',
      'password: "aaaaaaaaaaaaaaaa"',
    ].join('\n');
    expect(scanText(noise)).toEqual([]);
  });

  it('does not flag the bare key PREFIXES that appear as literals in this repo', () => {
    // src/enterprise/secrets.ts lists exactly these strings.
    const src = ["const KNOWN = ['gsk_', 'sk-', 'nvapi-', 'AIza', 'xai-', 'hf_', 'ghp_'];"];
    expect(scanText(src.join('\n'))).toEqual([]);
  });

  it('reports at most one finding per pattern per line', () => {
    const line = `a=${FAKE.github} b=${FAKE.github}`;
    const hits = scanText(line).filter((h) => h.id === 'github-pat');
    expect(hits).toHaveLength(1);
  });

  it('looksLikePlaceholder is the single judgement used for that filtering', () => {
    expect(looksLikePlaceholder('your-api-key')).toBe(true);
    expect(looksLikePlaceholder('${VAR}')).toBe(true);
    expect(looksLikePlaceholder('aaaaaaaaaaaaaaaa')).toBe(true);
    expect(looksLikePlaceholder('short')).toBe(true);
    expect(looksLikePlaceholder(FAKE.github)).toBe(false);
  });
});

describe('shouldSkipPath', () => {
  it('skips dependency/build dirs and binary files, keeps source', () => {
    expect(shouldSkipPath('node_modules/pkg/index.js')).toBe(true);
    expect(shouldSkipPath('dist/bundle.js')).toBe(true);
    expect(shouldSkipPath('.git/config')).toBe(true);
    expect(shouldSkipPath('assets/logo.png')).toBe(true);
    expect(shouldSkipPath('src/index.ts')).toBe(false);
    expect(shouldSkipPath('.env')).toBe(false); // where keys actually live
  });
});

describe('scanDirectory', () => {
  it('walks a tree, reports WORKSPACE-RELATIVE paths, and skips node_modules', () => {
    const root = mkdtempSync(join(tmpdir(), 'secret-scan-'));
    try {
      mkdirSync(join(root, 'src'));
      mkdirSync(join(root, 'node_modules', 'dep'), { recursive: true });
      writeFileSync(join(root, 'src', 'leak.ts'), `export const t = "${FAKE.github}";\n`);
      writeFileSync(join(root, 'src', 'clean.ts'), 'export const x = 1;\n');
      writeFileSync(join(root, 'node_modules', 'dep', 'leak.js'), `x="${FAKE.github}"`);

      const result = scanDirectory(root);
      expect(result.findings).toHaveLength(1);
      expect(result.findings[0].path).toBe('src/leak.ts');
      expect(result.findings[0].line).toBe(1);
      // Relative paths only — a report must not leak the operator's home dir.
      expect(JSON.stringify(result.findings)).not.toContain(root);
      expect(result.bySeverity.critical).toBe(1);
      expect(result.filesScanned).toBe(2);
      expect(result.summary).toMatch(/1 finding/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('honours subdir and reports a clean scan honestly (a lint, not a guarantee)', () => {
    const root = mkdtempSync(join(tmpdir(), 'secret-scan-'));
    try {
      mkdirSync(join(root, 'app'));
      writeFileSync(join(root, 'app', 'ok.ts'), 'export const x = 1;\n');
      const result = scanDirectory(root, { subdir: 'app' });
      expect(result.findings).toEqual([]);
      expect(result.summary).toMatch(/nothing matched/);
      expect(result.summary).toMatch(/not a guarantee/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('is bounded: the file cap stops the walk and says coverage is partial', () => {
    const root = mkdtempSync(join(tmpdir(), 'secret-scan-'));
    try {
      for (let i = 0; i < 5; i += 1) writeFileSync(join(root, `f${i}.txt`), 'x\n');
      const result = scanDirectory(root, { maxFiles: 2 });
      expect(result.truncated).toBe(true);
      expect(result.summary).toMatch(/partial/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('skips oversized files rather than reading them', () => {
    const root = mkdtempSync(join(tmpdir(), 'secret-scan-'));
    try {
      writeFileSync(join(root, 'big.txt'), 'a'.repeat(64));
      const result = scanDirectory(root, { maxFileBytes: 16 });
      expect(result.filesScanned).toBe(0);
      expect(result.filesSkipped).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('formatSecretScan', () => {
  it('lists findings with masked values and a truthful headline', () => {
    const out = formatSecretScan(scanDirectory(process.cwd(), { subdir: '__does_not_exist__' }));
    expect(out).toMatch(/nothing matched/);
    const withHits = formatSecretScan({
      root: '/x',
      filesScanned: 1,
      filesSkipped: 0,
      truncated: false,
      bySeverity: { critical: 1, high: 0, medium: 0 },
      summary: 'Scanned 1 file(s): 1 finding(s) — 1 critical, 0 high, 0 medium.',
      findings: [{ path: 'a.ts', line: 2, column: 1, id: 'github-pat', label: 'GitHub token', severity: 'critical', masked: 'ghp_…Q7r8', preview: 'x' }],
    });
    expect(withHits).toContain('a.ts:2');
    expect(withHits).toContain('ghp_…Q7r8');
  });

  it('exposes a sane per-file cap constant', () => {
    expect(MAX_FILE_BYTES).toBe(1_000_000);
  });
});
