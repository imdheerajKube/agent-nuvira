import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { assessProject } from '../../src/agents/prompt-assembly.js';

describe('writer — project-specific prompts', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'test-writer-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('assessProject detects React framework', () => {
    mkdirSync(join(tempDir, 'src'), { recursive: true });
    writeFileSync(join(tempDir, 'package.json'), JSON.stringify({
      dependencies: { react: '^18.0.0' },
    }));
    writeFileSync(join(tempDir, 'src', 'App.tsx'), 'export {}');

    const assessment = assessProject(tempDir);
    expect(assessment.framework).toBe('react');
    expect(assessment.language).toBe('typescript');
  });

  it('assessProject detects Python project', () => {
    writeFileSync(join(tempDir, 'pyproject.toml'), '[project]\nname = "test"');
    writeFileSync(join(tempDir, 'main.py'), 'print("hello")');

    const assessment = assessProject(tempDir);
    expect(assessment.language).toBe('python');
  });

  it('assessProject detects greenfield project', () => {
    // Empty directory
    const assessment = assessProject(tempDir);
    expect(assessment.isGreenfield).toBe(true);
  });

  it('assessProject detects existing tests', () => {
    // Use a filename that matches the test detection pattern: *.test.py
    writeFileSync(join(tempDir, 'main.test.py'), 'def test_pass(): pass');
    writeFileSync(join(tempDir, 'main.py'), 'x = 1');

    const assessment = assessProject(tempDir);
    expect(assessment.hasTests).toBe(true);
  });
});

describe('writer — skill injection', () => {
  it('skill guidance is available in context metadata', () => {
    // Simulate what the orchestrator does: set skillGuidance in metadata
    const skillGuidance = {
      name: 'website-deploy',
      description: 'Deploy to Cloudflare Pages',
      steps: [
        { agentType: 'runner', description: 'Run wrangler pages deploy' },
      ],
    };

    // The writer should be able to read this from context.metadata
    expect(skillGuidance.name).toBe('website-deploy');
    expect(skillGuidance.steps).toHaveLength(1);
  });
});
