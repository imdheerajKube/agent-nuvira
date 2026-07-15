import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, writeFileSync, unlinkSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Import the function directly from the source
import { loadEnv } from '../../src/utils/env.js';

// We need access to the private parseEnvFile. We'll test via loadEnv with
// controlled .env files in temp directories, but first let's test the
// internal behavior by reading the exported loadEnv.

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Create a temporary directory with a .env file and return loadEnv() result
 * scoped to that directory. Then clean up.
 */
function withTempEnv(
  envContent: string,
  fn: (env: Record<string, string | undefined>) => void,
): void {
  const tmpDir = join(tmpdir(), `buff-env-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpDir, { recursive: true });

  const envPath = join(tmpDir, '.env');
  writeFileSync(envPath, envContent, 'utf-8');

  // Save original cwd and change to temp dir
  const origCwd = process.cwd();
  process.chdir(tmpDir);

  try {
    const env = loadEnv();
    fn(env);
  } finally {
    process.chdir(origCwd);
    // Cleanup
    try { unlinkSync(envPath); } catch { /* best-effort */ }
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('loadEnv — enhanced .env parsing', () => {

  // ── Basic parsing ────────────────────────────────────────────────────

  it('should parse simple KEY=value pairs', () => {
    withTempEnv('FOO=bar\nBAZ=qux', (env) => {
      expect(env.FOO).toBe('bar');
      expect(env.BAZ).toBe('qux');
    });
  });

  it('should parse KEY=value with spaces around =', () => {
    withTempEnv('FOO = bar', (env) => {
      expect(env.FOO).toBe('bar');
    });
  });

  // ── Comments ─────────────────────────────────────────────────────────

  it('should skip full-line comments', () => {
    withTempEnv('# This is a comment\nFOO=bar\n# Another comment\nBAZ=qux', (env) => {
      expect(env.FOO).toBe('bar');
      expect(env.BAZ).toBe('qux');
    });
  });

  it('should strip inline comments from unquoted values', () => {
    withTempEnv('FOO=bar # this is a comment', (env) => {
      expect(env.FOO).toBe('bar');
    });
  });

  it('should handle inline comment with leading spaces', () => {
    withTempEnv('FOO=value  # comment here', (env) => {
      expect(env.FOO).toBe('value');
    });
  });

  it('should not treat # inside quoted strings as comment', () => {
    withTempEnv("FOO='val#ue'", (env) => {
      expect(env.FOO).toBe('val#ue');
    });
  });

  it('should not treat # inside double-quoted strings as comment', () => {
    withTempEnv('FOO="val#ue"', (env) => {
      expect(env.FOO).toBe('val#ue');
    });
  });

  // ── export prefix ────────────────────────────────────────────────────

  it('should strip export prefix', () => {
    withTempEnv('export FOO=bar\nexport BAZ=qux', (env) => {
      expect(env.FOO).toBe('bar');
      expect(env.BAZ).toBe('qux');
    });
  });

  it('should handle mixed export and non-export lines', () => {
    withTempEnv('export FOO=bar\nBAZ=qux', (env) => {
      expect(env.FOO).toBe('bar');
      expect(env.BAZ).toBe('qux');
    });
  });

  // ── Quoting ──────────────────────────────────────────────────────────

  it('should unquote single-quoted values', () => {
    withTempEnv("FOO='bar'", (env) => {
      expect(env.FOO).toBe('bar');
    });
  });

  it('should unquote double-quoted values', () => {
    withTempEnv('FOO="bar"', (env) => {
      expect(env.FOO).toBe('bar');
    });
  });

  it('should NOT expand variables inside single quotes', () => {
    withTempEnv("HOGE=meme\nFOO='$HOGE'", (env) => {
      expect(env.FOO).toBe('$HOGE');
    });
  });

  it('should expand variables inside double quotes', () => {
    withTempEnv('HOGE=meme\nFOO="$HOGE"', (env) => {
      expect(env.FOO).toBe('meme');
    });
  });

  // ── Variable expansion ──────────────────────────────────────────────

  it('should expand $VAR references', () => {
    withTempEnv('HOGE=meme\nFOO=$HOGE', (env) => {
      expect(env.FOO).toBe('meme');
    });
  });

  it('should expand ${VAR} references', () => {
    withTempEnv('HOGE=meme\nFOO=${HOGE}', (env) => {
      expect(env.FOO).toBe('meme');
    });
  });

  it('should expand multiple variables in one value', () => {
    withTempEnv('A=hello\nB=world\nC=${A} ${B}', (env) => {
      expect(env.C).toBe('hello world');
    });
  });

  it('should expand cascading references', () => {
    withTempEnv('A=hello\nB=${A} world\nC=${B}!', (env) => {
      expect(env.C).toBe('hello world!');
    });
  });

  it('should use ${VAR:-default} when variable is not set', () => {
    withTempEnv('FOO=${UNDEFINED:-default_val}', (env) => {
      expect(env.FOO).toBe('default_val');
    });
  });

  it('should use ${VAR:-default} when variable is empty', () => {
    withTempEnv('EMPTY=\nFOO=${EMPTY:-fallback}', (env) => {
      expect(env.FOO).toBe('fallback');
    });
  });

  it('should use actual value when ${VAR:-default} and VAR is set', () => {
    withTempEnv('ACTUAL=real\nFOO=${ACTUAL:-fallback}', (env) => {
      expect(env.FOO).toBe('real');
    });
  });

  it('should leave unset $VAR as empty string', () => {
    withTempEnv('FOO=$UNDEFINED_VAR', (env) => {
      expect(env.FOO).toBe('');
    });
  });

  it('should expand $VAR from process.env fallback', () => {
    // Set a process env var
    process.env.TEST_BUFF_PROCESS_VAR = 'from_process';
    withTempEnv('FOO=$TEST_BUFF_PROCESS_VAR', (env) => {
      expect(env.FOO).toBe('from_process');
    });
    delete process.env.TEST_BUFF_PROCESS_VAR;
  });

  // ── CRLF support ─────────────────────────────────────────────────---

  it('should handle CRLF (\\r\\n) line endings', () => {
    withTempEnv('FOO=bar\r\nBAZ=qux', (env) => {
      expect(env.FOO).toBe('bar');
      expect(env.BAZ).toBe('qux');
    });
  });

  it('should handle mixed line endings', () => {
    withTempEnv('FOO=bar\nBAZ=qux\r\nHOGE=fuga', (env) => {
      expect(env.FOO).toBe('bar');
      expect(env.BAZ).toBe('qux');
      expect(env.HOGE).toBe('fuga');
    });
  });

  // ── Edge cases ──────────────────────────────────────────────────────

  it('should handle empty values', () => {
    withTempEnv('FOO=', (env) => {
      expect(env.FOO).toBe('');
    });
  });

  it('should handle values with spaces', () => {
    withTempEnv('FOO=hello world', (env) => {
      expect(env.FOO).toBe('hello world');
    });
  });

  it('should handle blank lines', () => {
    withTempEnv('FOO=bar\n\n\nBAZ=qux', (env) => {
      expect(env.FOO).toBe('bar');
      expect(env.BAZ).toBe('qux');
    });
  });

  it('should handle lines with only comments', () => {
    withTempEnv('# only a comment\n  # another\nFOO=bar', (env) => {
      expect(env.FOO).toBe('bar');
    });
  });

  it('should handle real-world API key file', () => {
    const content = [
      '# Agent-Baba-D API Keys',
      '',
      'GROQ_API_KEY=gsk_example_key',
      'export NVIDIA_NIM_API_KEY=nvapi-example',
      '',
      "# Gemini uses the free tier",
      'GEMINI_API_KEY=AIzaSy_example_key',
      '',
      '# OpenRouter with fallback from process',
      'OPENROUTER_API_KEY=${OPENROUTER_API_KEY:-sk-or-v1-default}',
    ].join('\n');

    withTempEnv(content, (env) => {
      expect(env.GROQ_API_KEY).toBe('gsk_example_key');
      expect(env.NVIDIA_NIM_API_KEY).toBe('nvapi-example');
      expect(env.GEMINI_API_KEY).toBe('AIzaSy_example_key');
      // OPENROUTER should use default since not set in process
      expect(env.OPENROUTER_API_KEY).toBe('sk-or-v1-default');
    });
  });
});
