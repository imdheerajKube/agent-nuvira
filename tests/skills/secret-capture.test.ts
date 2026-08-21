import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('secret-capture', () => {
  let testDir: string;
  let origEnvFile: string | undefined;
  let origEnvVars: Record<string, string | undefined>;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'secret-capture-test-'));
    origEnvFile = process.env.BUFF_ENV_FILE;
    origEnvVars = {};
    // Save and clear relevant env vars
    for (const key of ['TEST_API_KEY', 'TEST_TOKEN', 'DB_URL']) {
      origEnvVars[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    // Restore env file path
    if (origEnvFile === undefined) {
      delete process.env.BUFF_ENV_FILE;
    } else {
      process.env.BUFF_ENV_FILE = origEnvFile;
    }
    // Restore env vars
    for (const [key, value] of Object.entries(origEnvVars)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    rmSync(testDir, { recursive: true, force: true });
  });

  it('loadEnvFile reads .env correctly', async () => {
    const envPath = join(testDir, '.env');
    writeFileSync(envPath, 'TEST_API_KEY=sk-test-123\nDB_URL=postgres://localhost/mydb\n# comment\nTEST_TOKEN=tok-abc\n', 'utf-8');
    process.env.BUFF_ENV_FILE = envPath;

    const { loadEnvFile } = await import('../../src/skills/secret-capture.js');
    const vars = loadEnvFile();
    expect(vars.TEST_API_KEY).toBe('sk-test-123');
    expect(vars.DB_URL).toBe('postgres://localhost/mydb');
    expect(vars.TEST_TOKEN).toBe('tok-abc');
  });

  it('loadEnvFile handles quoted values', async () => {
    const envPath = join(testDir, '.env');
    writeFileSync(envPath, 'TEST_API_KEY="sk-test-123"\nDB_URL=\'postgres://localhost/mydb\'\n', 'utf-8');
    process.env.BUFF_ENV_FILE = envPath;

    const { loadEnvFile } = await import('../../src/skills/secret-capture.js');
    const vars = loadEnvFile();
    expect(vars.TEST_API_KEY).toBe('sk-test-123');
    expect(vars.DB_URL).toBe('postgres://localhost/mydb');
  });

  it('isEnvVarPersisted returns true for set vars', async () => {
    const envPath = join(testDir, '.env');
    writeFileSync(envPath, 'TEST_API_KEY=sk-test-123\n', 'utf-8');
    process.env.BUFF_ENV_FILE = envPath;

    const { isEnvVarPersisted } = await import('../../src/skills/secret-capture.js');
    expect(isEnvVarPersisted('TEST_API_KEY')).toBe(true);
    expect(isEnvVarPersisted('NONEXISTENT_VAR')).toBe(false);
  });

  it('isEnvVarPersisted checks process.env fallback', async () => {
    const envPath = join(testDir, '.env');
    writeFileSync(envPath, '', 'utf-8');
    process.env.BUFF_ENV_FILE = envPath;
    process.env.TEST_API_KEY = 'from-process-env';

    const { isEnvVarPersisted } = await import('../../src/skills/secret-capture.js');
    expect(isEnvVarPersisted('TEST_API_KEY')).toBe(true);
  });

  it('saveEnvValue writes to .env without overwriting other vars', async () => {
    const envPath = join(testDir, '.env');
    writeFileSync(envPath, 'EXISTING=value1\n', 'utf-8');
    process.env.BUFF_ENV_FILE = envPath;

    const { saveEnvValue } = await import('../../src/skills/secret-capture.js');
    const result = saveEnvValue('NEW_KEY', 'new-value');
    expect(result.success).toBe(true);

    const content = readFileSync(envPath, 'utf-8');
    expect(content).toContain('EXISTING=value1');
    expect(content).toContain('NEW_KEY=new-value');
  });

  it('saveEnvValue updates existing key', async () => {
    const envPath = join(testDir, '.env');
    writeFileSync(envPath, 'TEST_API_KEY=old-value\n', 'utf-8');
    process.env.BUFF_ENV_FILE = envPath;

    const { saveEnvValue } = await import('../../src/skills/secret-capture.js');
    saveEnvValue('TEST_API_KEY', 'new-value');

    const content = readFileSync(envPath, 'utf-8');
    expect(content).toContain('TEST_API_KEY=new-value');
    expect(content).not.toContain('old-value');
  });

  it('saveEnvValue creates directory if needed', async () => {
    const nestedEnv = join(testDir, 'nested', '.env');
    process.env.BUFF_ENV_FILE = nestedEnv;

    const { saveEnvValue } = await import('../../src/skills/secret-capture.js');
    const result = saveEnvValue('TEST_API_KEY', 'value');
    expect(result.success).toBe(true);

    const content = readFileSync(nestedEnv, 'utf-8');
    expect(content).toContain('TEST_API_KEY=value');
  });

  it('findMissingEnvVars returns entries for unset vars', async () => {
    const envPath = join(testDir, '.env');
    writeFileSync(envPath, 'TEST_API_KEY=sk-test-123\n', 'utf-8');
    process.env.BUFF_ENV_FILE = envPath;

    const { findMissingEnvVars } = await import('../../src/skills/secret-capture.js');
    const missing = findMissingEnvVars(['TEST_API_KEY', 'DB_URL', 'TEST_TOKEN']);
    expect(missing).toHaveLength(2);
    expect(missing[0].name).toBe('DB_URL');
    expect(missing[1].name).toBe('TEST_TOKEN');
  });

  it('findMissingEnvVars handles object format', async () => {
    const envPath = join(testDir, '.env');
    writeFileSync(envPath, '', 'utf-8');
    process.env.BUFF_ENV_FILE = envPath;

    const { findMissingEnvVars } = await import('../../src/skills/secret-capture.js');
    const missing = findMissingEnvVars([
      { name: 'API_KEY', prompt: 'Enter API key:', help: 'https://example.com/keys' },
      { name: 'OPTIONAL_VAR', prompt: 'Optional:', optional: true },
    ]);
    expect(missing).toHaveLength(2);
    expect(missing[0].help).toBe('https://example.com/keys');
    expect(missing[1].optional).toBe(true);
  });

  it('getEnvVarStatus returns correct status', async () => {
    const envPath = join(testDir, '.env');
    writeFileSync(envPath, 'TEST_API_KEY=sk-test-123\n', 'utf-8');
    process.env.BUFF_ENV_FILE = envPath;

    const { getEnvVarStatus } = await import('../../src/skills/secret-capture.js');
    const status = getEnvVarStatus(['TEST_API_KEY', 'DB_URL']);
    expect(status).toHaveLength(2);
    expect(status[0].name).toBe('TEST_API_KEY');
    expect(status[0].set).toBe(true);
    expect(status[0].maskedValue).toBeDefined();
    expect(status[1]).toEqual({ name: 'DB_URL', set: false, maskedValue: undefined });
  });

  it('captureSecrets returns empty result when no missing vars', async () => {
    const { captureSecrets } = await import('../../src/skills/secret-capture.js');
    const result = await captureSecrets('test-skill', [], 'cli');
    expect(result.missingNames).toHaveLength(0);
    expect(result.setupSkipped).toBe(false);
    expect(result.storedVars).toHaveLength(0);
  });
});
