import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ContextParser } from '../../src/context/parser.js';

describe('ContextParser', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'buff-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('parseFromString', () => {
    it('should return a single chunk for short text', () => {
      const parser = new ContextParser({ maxTokens: 1000 });
      const chunks = parser.parseFromString('Hello world', 'input');

      expect(chunks).toHaveLength(1);
      expect(chunks[0].filePath).toBe('input');
      expect(chunks[0].content).toBe('Hello world');
      expect(chunks[0].priority).toBe(1);
    });

    it('should chunk text that exceeds token limit', () => {
      // Create text with multiple paragraphs that exceeds maxTokens
      const shortMax = 10; // ~40 chars total
      const paragraphs = [];
      for (let i = 0; i < 5; i++) {
        paragraphs.push('A'.repeat(30)); // 30 chars each, ~7-8 tokens
      }
      const longText = paragraphs.join('\n\n'); // 5 paragraphs = 150+ chars
      const parser = new ContextParser({ maxTokens: shortMax });

      const chunks = parser.parseFromString(longText, 'long-input');

      expect(chunks.length).toBeGreaterThan(1);
      chunks.forEach((chunk) => {
        expect(chunk.tokenCount).toBeLessThanOrEqual(shortMax + 1); // allow slight rounding
      });
    });

    it('should handle empty string', () => {
      const parser = new ContextParser();
      const chunks = parser.parseFromString('', 'empty');

      expect(chunks).toHaveLength(1);
      expect(chunks[0].content).toBe('');
      expect(chunks[0].tokenCount).toBe(0);
    });
  });

  describe('parseFromFiles', () => {
    it('should parse existing files', () => {
      const filePath = join(tmpDir, 'test.ts');
      writeFileSync(filePath, 'const x = 1;', 'utf-8');

      const parser = new ContextParser();
      const chunks = parser.parseFromFiles([filePath]);

      expect(chunks).toHaveLength(1);
      expect(chunks[0].filePath).toBe(filePath);
      expect(chunks[0].content).toBe('const x = 1;');
    });

    it('should skip non-existent files', () => {
      const parser = new ContextParser();
      const chunks = parser.parseFromFiles(['/nonexistent/file.ts']);

      expect(chunks).toHaveLength(0);
    });

    it('should prioritize files matching priority patterns', () => {
      const regularFile = join(tmpDir, 'helper.ts');
      writeFileSync(regularFile, 'const helper = () => {};', 'utf-8');

      const priorityFile = join(tmpDir, 'index.ts');
      writeFileSync(priorityFile, 'export const main = () => {};', 'utf-8');

      const parser = new ContextParser({
        maxTokens: 1000,
        priorityPatterns: ['index.ts'],
      });

      const chunks = parser.parseFromFiles([regularFile, priorityFile]);

      // The priority file should come first (higher priority, sorted desc)
      expect(chunks[0].filePath).toBe(priorityFile);
      expect(chunks[0].priority).toBe(2);
      expect(chunks[1].filePath).toBe(regularFile);
      expect(chunks[1].priority).toBe(1);
    });
  });

  describe('parseFromDirectory', () => {
    it('should walk directory recursively and parse files', async () => {
      // Create files in nested directories
      mkdirSync(join(tmpDir, 'src'), { recursive: true });
      mkdirSync(join(tmpDir, 'tests'), { recursive: true });
      writeFileSync(join(tmpDir, 'src', 'index.ts'), 'export const main = () => {};', 'utf-8');
      writeFileSync(join(tmpDir, 'tests', 'index.test.ts'), 'describe("test", () => {});', 'utf-8');
      writeFileSync(join(tmpDir, 'README.md'), '# Project', 'utf-8');

      const parser = new ContextParser({ maxTokens: 5000 });
      const chunks = await parser.parseFromDirectory(tmpDir);

      // Should find 3 files with .ts, .md extensions
      expect(chunks).toHaveLength(3);
      const filePaths = chunks.map((c) => c.filePath);
      expect(filePaths).toContain('src/index.ts');
      expect(filePaths).toContain('tests/index.test.ts');
      expect(filePaths).toContain('README.md');
    });

    it('should ignore node_modules and .git directories', async () => {
      mkdirSync(join(tmpDir, 'node_modules'), { recursive: true });
      mkdirSync(join(tmpDir, '.git'), { recursive: true });
      writeFileSync(join(tmpDir, 'node_modules', 'lodash.ts'), 'export const _ = {};', 'utf-8');
      writeFileSync(join(tmpDir, '.git', 'config'), 'some config', 'utf-8');
      writeFileSync(join(tmpDir, 'app.ts'), 'export const app = {};', 'utf-8');

      const parser = new ContextParser({ maxTokens: 5000 });
      const chunks = await parser.parseFromDirectory(tmpDir);

      expect(chunks).toHaveLength(1);
      expect(chunks[0].filePath).toBe('app.ts');
    });
  });

  describe('formatContext', () => {
    it('should format chunks into a string with separators', () => {
      const chunks = [
        { filePath: 'file1.ts', content: 'const a = 1;', priority: 1, tokenCount: 3 },
        { filePath: 'file2.ts', content: 'const b = 2;', priority: 2, tokenCount: 3 },
      ];

      const result = ContextParser.formatContext(chunks);
      expect(result).toContain('--- file1.ts ---');
      expect(result).toContain('const a = 1;');
      expect(result).toContain('--- file2.ts ---');
      expect(result).toContain('const b = 2;');
    });

    it('should return empty string for empty chunks', () => {
      expect(ContextParser.formatContext([])).toBe('');
    });
  });

  describe('pruneToTokenLimit', () => {
    it('should prioritize higher priority chunks', () => {
      const parser = new ContextParser({ maxTokens: 10 });
      // Access private method via prototype
      const prune = (parser as any).pruneToTokenLimit.bind(parser);

      const chunks = [
        { filePath: 'low.ts', content: 'small', priority: 1, tokenCount: 15 },
        { filePath: 'high.ts', content: 'small', priority: 2, tokenCount: 5 },
      ];

      const result = prune(chunks);
      expect(result).toHaveLength(1);
      expect(result[0].filePath).toBe('high.ts');
    });

    it('should truncate content if no chunk fits', () => {
      const parser = new ContextParser({ maxTokens: 2}); // ~8 chars max
      const prune = (parser as any).pruneToTokenLimit.bind(parser);

      const chunks = [
        { filePath: 'large.ts', content: 'A'.repeat(100), priority: 1, tokenCount: 25 },
      ];

      const result = prune(chunks);
      expect(result).toHaveLength(1);
      expect(result[0].content).toContain('[...truncated...]');
    });
  });
});
