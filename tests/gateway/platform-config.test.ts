/**
 * Platform transport config — ~/.nuvira/.env reader/writer + status helpers.
 * NUVIRA_ENV_FILE redirects the env file to a temp path for hermetic tests.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  applyEnvToProcess,
  configurablePlatforms,
  envFilePath,
  envVarState,
  platformConfigStatus,
  platformEnvVarMeta,
  redactValue,
  writeEnvFile,
} from '../../src/gateway/platform-config.js';

let envDir = '';
let envFile = '';
const envBackup = process.env.NUVIRA_ENV_FILE;

beforeEach(() => {
  envDir = mkdtempSync(join(tmpdir(), 'buff-platcfg-'));
  envFile = join(envDir, 'test.env');
  process.env.NUVIRA_ENV_FILE = envFile;
});

afterEach(() => {
  if (envBackup === undefined) delete process.env.NUVIRA_ENV_FILE;
  else process.env.NUVIRA_ENV_FILE = envBackup;
  rmSync(envDir, { recursive: true, force: true });
});

describe('envFilePath', () => {
  it('honors NUVIRA_ENV_FILE', () => {
    expect(envFilePath()).toBe(envFile);
  });
});

describe('writeEnvFile (line-preserving merge)', () => {
  it('updates existing keys in place, appends new ones, preserves comments and unrelated keys', () => {
    writeFileSync(
      envFile,
      [
        '# gateway transports',
        'NUVIRA_TELEGRAM_TOKEN=old-token',
        'NUVIRA_SMTP_HOST=smtp.gmail.com:587 # relay',
        'UNRELATED=stays',
        '',
      ].join('\n'),
      'utf-8',
    );
    const { wrote } = writeEnvFile({
      NUVIRA_TELEGRAM_TOKEN: 'new-token',
      NUVIRA_MATRIX_HOMESERVER: 'https://matrix.org',
    });
    expect(wrote.sort()).toEqual(['NUVIRA_MATRIX_HOMESERVER', 'NUVIRA_TELEGRAM_TOKEN']);
    const content = readFileSync(envFile, 'utf-8');
    expect(content).toContain('# gateway transports');
    expect(content).toContain('NUVIRA_TELEGRAM_TOKEN=new-token');
    expect(content).toContain('NUVIRA_SMTP_HOST=smtp.gmail.com:587');
    expect(content).toContain('UNRELATED=stays');
    expect(content).toContain('NUVIRA_MATRIX_HOMESERVER=https://matrix.org');
  });

  it('quotes values containing spaces or hashes', () => {
    const { wrote } = writeEnvFile({ NUVIRA_TELEGRAM_TOKEN: 'abc def#123' });
    expect(wrote).toEqual(['NUVIRA_TELEGRAM_TOKEN']);
    expect(readFileSync(envFile, 'utf-8')).toContain('NUVIRA_TELEGRAM_TOKEN="abc def#123"');
  });

  it('removes keys while keeping everything else', () => {
    writeFileSync(envFile, 'NUVIRA_TELEGRAM_TOKEN=a\nNUVIRA_SMTP_HOST=b\nKEEP=c\n', 'utf-8');
    const { removed } = writeEnvFile({}, ['NUVIRA_TELEGRAM_TOKEN', 'NUVIRA_SMTP_HOST']);
    expect(removed.sort()).toEqual(['NUVIRA_SMTP_HOST', 'NUVIRA_TELEGRAM_TOKEN']);
    const content = readFileSync(envFile, 'utf-8');
    expect(content).not.toContain('NUVIRA_TELEGRAM_TOKEN');
    expect(content).not.toContain('NUVIRA_SMTP_HOST');
    expect(content).toContain('KEEP=c');
  });

  it('creates the file when missing', () => {
    const { wrote } = writeEnvFile({ NUVIRA_NTFY_TOPIC: 'ops' });
    expect(wrote).toEqual(['NUVIRA_NTFY_TOPIC']);
    expect(readFileSync(envFile, 'utf-8')).toContain('NUVIRA_NTFY_TOPIC=ops');
  });
});

describe('envVarState', () => {
  it('reads the file value, preferring it over process.env', () => {
    writeFileSync(envFile, 'NUVIRA_TELEGRAM_TOKEN=from-file\n', 'utf-8');
    process.env.NUVIRA_TELEGRAM_TOKEN = 'from-process';
    const st = envVarState('NUVIRA_TELEGRAM_TOKEN');
    expect(st.set).toBe(true);
    expect(st.value).toBe('from-file');
    delete process.env.NUVIRA_TELEGRAM_TOKEN;
  });

  it('falls back to process.env when the file has no value', () => {
    process.env.NUVIRA_TELEGRAM_TOKEN = 'env-only';
    const st = envVarState('NUVIRA_TELEGRAM_TOKEN');
    expect(st.set).toBe(true);
    expect(st.value).toBe('env-only');
    delete process.env.NUVIRA_TELEGRAM_TOKEN;
  });
});

describe('platformConfigStatus + metadata', () => {
  it('reports configured=false with per-var state when nothing is set', () => {
    const st = platformConfigStatus('matrix');
    expect(st.platform).toBe('matrix');
    expect(st.configured).toBe(false);
    expect(st.envVars.map((v) => v.varName)).toEqual(['NUVIRA_MATRIX_HOMESERVER', 'NUVIRA_MATRIX_ACCESS_TOKEN']);
    expect(st.envVars.every((v) => !v.set)).toBe(true);
  });

  it('reports configured=true once every required var is present', () => {
    writeFileSync(envFile, 'NUVIRA_MATRIX_HOMESERVER=https://matrix.org\nNUVIRA_MATRIX_ACCESS_TOKEN=tok\n', 'utf-8');
    expect(platformConfigStatus('matrix').configured).toBe(true);
  });

  it('marks tokens/passwords as secrets and keeps URLs/hosts non-secret', () => {
    const matrix = platformEnvVarMeta('matrix');
    expect(matrix.find((m) => m.varName === 'NUVIRA_MATRIX_ACCESS_TOKEN')?.secret).toBe(true);
    expect(matrix.find((m) => m.varName === 'NUVIRA_MATRIX_HOMESERVER')?.secret).toBe(false);
  });

  it('configurablePlatforms excludes whatsapp and mock', () => {
    const list = configurablePlatforms();
    expect(list).toContain('telegram');
    expect(list).not.toContain('whatsapp');
    expect(list).not.toContain('mock');
  });
});

describe('applyEnvToProcess + redactValue', () => {
  it('applies values to process.env and deletes removed keys', () => {
    process.env.NUVIRA_TELEGRAM_TOKEN = 'old';
    applyEnvToProcess({ NUVIRA_MATRIX_HOMESERVER: 'https://matrix.org' }, ['NUVIRA_TELEGRAM_TOKEN']);
    expect(process.env.NUVIRA_MATRIX_HOMESERVER).toBe('https://matrix.org');
    expect(process.env.NUVIRA_TELEGRAM_TOKEN).toBeUndefined();
    delete process.env.NUVIRA_MATRIX_HOMESERVER;
  });

  it('redacts values and reports <unset>', () => {
    expect(redactValue('')).toBe('<unset>');
    expect(redactValue('short')).toBe('••••');
    expect(redactValue('abcdefghijkl')).toMatch(/^abcd/);
    expect(redactValue('abcdefghijkl')).not.toContain('efghijkl');
  });
});
