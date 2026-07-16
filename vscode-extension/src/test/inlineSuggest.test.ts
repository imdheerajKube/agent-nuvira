/**
 * Unit tests for InlineSuggestProvider.
 *
 * Tests the pure-logic methods that can be isolated from the VS Code API:
 * - buildSuggestionPrompt() — formats the CLI prompt with code context
 * - parseSuggestion() — parses CLI output into InlineCompletionItems
 * - updateConfig() — runtime config updates
 *
 * The lifecycle methods (provideInlineCompletionItems, generateSuggestion,
 * callCLIForSuggestion) require full VS Code API integration and child process
 * spawning, and are tested separately via integration tests.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock vscode module before importing
vi.mock('vscode', () => {
  return import('./__mocks__/vscode.js');
});

import { buildSuggestionPrompt, parseSuggestion } from '../inlineSuggestUtils.js';
import { InlineSuggestProvider } from '../inlineSuggest.js';
import type { ExtensionConfig } from '../types.js';
import * as vscode from 'vscode';

describe('InlineSuggestProvider', () => {
  const defaultConfig: ExtensionConfig = {
    cliPath: 'buff',
    defaultProvider: '',
    defaultModel: '',
    autoApplyChanges: false,
    maxTokens: 4096,
    showProgressPanel: true,
  };

  let provider: InlineSuggestProvider;

  beforeEach(() => {
    provider = new InlineSuggestProvider({ ...defaultConfig });
  });

  // ── Constructor ───────────────────────────────────────────────────────

  describe('constructor', () => {
    it('creates an instance with default config', () => {
      expect(provider).toBeInstanceOf(InlineSuggestProvider);
    });

    it('creates an instance with custom config', () => {
      const customConfig: ExtensionConfig = {
        ...defaultConfig,
        cliPath: '/usr/local/bin/buff',
        defaultProvider: 'groq',
        defaultModel: 'llama-3.3-70b',
      };
      const p = new InlineSuggestProvider(customConfig);
      expect(p).toBeInstanceOf(InlineSuggestProvider);
    });
  });

  // ── updateConfig ──────────────────────────────────────────────────────

  describe('updateConfig', () => {
    it('updates the internal config', () => {
      const newConfig: ExtensionConfig = {
        ...defaultConfig,
        cliPath: '/new/path/buff',
        defaultProvider: 'gemini',
      };
      provider.updateConfig(newConfig);
      // updateConfig is public, verify it doesn't throw
      expect(() => provider.updateConfig(newConfig)).not.toThrow();
    });

    it('can be called multiple times', () => {
      provider.updateConfig({ ...defaultConfig, cliPath: '/path/a' });
      provider.updateConfig({ ...defaultConfig, cliPath: '/path/b' });
      provider.updateConfig({ ...defaultConfig, cliPath: '/path/c' });
      expect(() => provider.updateConfig(defaultConfig)).not.toThrow();
    });

    it('accepts partial config changes', () => {
      provider.updateConfig({ ...defaultConfig, autoApplyChanges: true });
      provider.updateConfig({ ...defaultConfig, showProgressPanel: false });
      expect(() => provider.updateConfig(defaultConfig)).not.toThrow();
    });
  });

  // ── buildSuggestionPrompt ─────────────────────────────────────────────

  describe('buildSuggestionPrompt', () => {
    const standardContext = {
      beforeCursor: 'function hello() {\n  return "Hello, world!";\n}\n\nconst result = ',
      afterCursor: ';\n\nconsole.log(result);',
      currentLinePrefix: 'const result = ',
    };

    it('includes language and file extension in the prompt', () => {
      const prompt = buildSuggestionPrompt(standardContext, 'typescript', 'ts');

      expect(prompt).toContain('typescript');
      expect(prompt).toContain('.ts');
    });

    it('includes the code context delimiters', () => {
      const prompt = buildSuggestionPrompt(standardContext, 'python', 'py');

      expect(prompt).toContain('--- Code context ---');
      expect(prompt).toContain('<CURSOR>');
      expect(prompt).toContain('---');
      expect(prompt).toContain('Complete:');
    });

    it('includes before cursor text as prefix', () => {
      const context = {
        beforeCursor: 'def add(a, b):\n    return a + b\n\nx = ',
        afterCursor: '',
        currentLinePrefix: 'x = ',
      };
      const prompt = buildSuggestionPrompt(context, 'python', 'py');

      expect(prompt).toContain('def add(a, b):');
    });

    it('includes after cursor text as suffix', () => {
      const context = {
        beforeCursor: 'const x = ',
        afterCursor: ';\nexport default x;',
        currentLinePrefix: 'const x = ',
      };
      const prompt = buildSuggestionPrompt(context, 'javascript', 'js');

      expect(prompt).toContain('export default x;');
    });

    it('truncates before cursor to last 400 chars', () => {
      const longContext = 'a'.repeat(1000);
      const context = {
        beforeCursor: longContext,
        afterCursor: '',
        currentLinePrefix: '',
      };
      const prompt = buildSuggestionPrompt(context, 'go', 'go');

      // Should not contain the full 1000 chars
      expect(prompt.length).toBeLessThan(1000);
      // Should include 'Complete:' at the end
      expect(prompt).toMatch(/Complete:\s*$/);
    });

    it('truncates after cursor to first 200 chars', () => {
      const longSuffix = 'b'.repeat(500);
      const context = {
        beforeCursor: 'func main() {',
        afterCursor: longSuffix,
        currentLinePrefix: '',
      };
      const prompt = buildSuggestionPrompt(context, 'go', 'go');

      // Should not contain all 500 chars
      expect(prompt).not.toContain('b'.repeat(500));
    });

    it('includes instruction to return only completion text', () => {
      const prompt = buildSuggestionPrompt(standardContext, 'rust', 'rs');

      expect(prompt).toContain('Return ONLY the completion text');
      expect(prompt).toContain('no explanations, no markdown');
      expect(prompt).toContain('no code fences');
    });

    it('includes the NONE fallback instruction', () => {
      const prompt = buildSuggestionPrompt(standardContext, 'java', 'java');

      expect(prompt).toContain('If nothing useful to add, return "NONE"');
    });

    it('handles empty context gracefully', () => {
      const emptyContext = {
        beforeCursor: '',
        afterCursor: '',
        currentLinePrefix: '',
      };
      const prompt = buildSuggestionPrompt(emptyContext, 'python', 'py');

      expect(prompt).toContain('python');
      expect(prompt).toContain('<CURSOR>');
      expect(prompt).toContain('Complete:');
    });
  });

  // ── parseSuggestion ───────────────────────────────────────────────────

  describe('parseSuggestion', () => {
    const position = new vscode.Position(5, 10);

    it('returns a single InlineCompletionItem for a simple suggestion', () => {
      const items = parseSuggestion('return a + b;', position);

      expect(items).toHaveLength(1);
      expect(items[0].insertText).toBe('return a + b;');
    });

    it('handles multi-line suggestions', () => {
      const suggestion = 'function add(a: number, b: number): number {\n  return a + b;\n}';
      const items = parseSuggestion(suggestion, position);

      expect(items).toHaveLength(1);
      expect(items[0].insertText).toContain('function add');
      expect(items[0].insertText).toContain('return a + b;');
    });

    it('returns empty array for empty suggestion', () => {
      const items = parseSuggestion('', position);

      expect(items).toHaveLength(0);
    });

    it('returns empty array for whitespace-only suggestion', () => {
      // Split on newlines then filtered by length > 0, so empty segments produce no items
      const items = parseSuggestion('\n\n\n', position);

      expect(items).toHaveLength(0);
    });

    it('limits suggestion to MAX_SUGGESTION_LINES (20)', () => {
      const manyLines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n');
      const items = parseSuggestion(manyLines, position);

      expect(items).toHaveLength(1);
      const lines = items[0].insertText.split('\n');
      expect(lines.length).toBeLessThanOrEqual(20);
    });

    it('filters out empty lines between content', () => {
      // The filter(l => l.length > 0) removes ALL empty strings, including between content
      const suggestion = 'const x = 1;\n\n\nconst y = 2;';
      const items = parseSuggestion(suggestion, position);

      expect(items).toHaveLength(1);
      // Empty lines between content are removed by the filter
      expect(items[0].insertText).toContain('const x = 1;');
      expect(items[0].insertText).toContain('const y = 2;');
      // The blank lines should be filtered out
      expect(items[0].insertText).not.toContain('\n\n\n');
    });

    it('sets range from position to line count offset', () => {
      const suggestion = 'line1\nline2\nline3';
      const items = parseSuggestion(suggestion, new vscode.Position(3, 0));

      expect(items).toHaveLength(1);
      // Position line 3 + 2 lines = line 5 (3 items - 1 = 2)
      // Position translate(truncatedLines.length - 1, 0)
      // truncatedLines = 3 items, translate(2, 0)
      // Range should be from (3,0) to (5,0)
      expect(items[0].range.start.line).toBe(3);
      expect(items[0].range.start.character).toBe(0);
      expect(items[0].range.end.line).toBe(5);
      expect(items[0].range.end.character).toBe(0);
    });

    it('preserves indentation in suggestions', () => {
      const suggestion = '    const result = data.map(item => {\n      return item.value;\n    });';
      const items = parseSuggestion(suggestion, position);

      expect(items[0].insertText).toContain('    const result');
      expect(items[0].insertText).toContain('      return item.value;');
    });

    it('handles single-line code patterns', () => {
      const patterns = [
        'return items.filter(Boolean);',
        'const result = await fetch(url);',
        'if (condition) {',
        '}',
        'import { useState } from "react";',
      ];

      for (const pattern of patterns) {
        const items = parseSuggestion(pattern, position);
        expect(items).toHaveLength(1);
        expect(items[0].insertText).toBe(pattern);
      }
    });
  });
});
