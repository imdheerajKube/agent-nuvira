/**
 * H1 — `buff tools` command tests.
 *
 * The H1 acceptance surface: every registered tool is visible via
 * `buff tools list`, a tool's schema via `buff tools show <name>`, and an
 * unknown tool name gets a clear error.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { ToolsCommand } from '../../src/cli/tools.js';
import { logger } from '../../src/utils/logger.js';

describe('buff tools', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function run(args: string[]): Promise<{ stdout: string; stderr: string }> {
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => logs.push(a.map(String).join(' ')));
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => logs.push('ERR: ' + a.map(String).join(' ')));
    vi.spyOn(logger, 'highlight').mockImplementation((...a: unknown[]) => logs.push(a.map(String).join(' ')));
    vi.spyOn(logger, 'info').mockImplementation((...a: unknown[]) => logs.push(a.map(String).join(' ')));
    vi.spyOn(logger, 'error').mockImplementation((...a: unknown[]) => logs.push(a.map(String).join(' ')));
    await new ToolsCommand().create().parseAsync(['node', 'buff', ...args]);
    const text = logs.join('\n');
    return { stdout: text, stderr: '' };
  }

  it('lists every registered tool with its description', async () => {
    // Commander quirk (feedback.test.ts pattern): parseAsync on the command
    // object itself — the args exclude the 'tools' prefix.
    const { stdout } = await run(['list']);
    expect(stdout).toContain('Tool registry');
    for (const name of [
      'build', 'resume', 'repair',
      // E3c model-decides task tools
      'document', 'website', 'analyze', 'test', 'publish',
      'ask_user', 'suggest_followups', 'verify_requirement',
    ]) {
      expect(stdout).toContain(name);
    }
  });

  it('shows a tool input schema', async () => {
    const { stdout } = await run(['show', 'ask_user']);
    expect(stdout).toContain('ask_user');
    expect(stdout).toContain('question');
    expect(stdout).toContain('choices');
  });

  it('shows the publish tool schema (irreversible safety flags)', async () => {
    const { stdout } = await run(['show', 'publish']);
    expect(stdout).toContain('publish');
    expect(stdout).toContain('bump');
    expect(stdout).toContain('dry_run');
  });

  it('errors clearly on an unknown tool name', async () => {
    const { stdout } = await run(['show', 'not_a_tool']);
    expect(stdout.toLowerCase()).toContain('unknown tool');
  });
});
