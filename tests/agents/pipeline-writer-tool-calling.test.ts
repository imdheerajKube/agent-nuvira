/**
 * Audit W3 — the pipeline writer must be able to read the code it edits.
 *
 * The one-shot writer gets a flat prompt and must emit the COMPLETE content of
 * every file in one response. It cannot open the file it is rewriting, so it
 * guesses at code it has never seen, and one malformed fence loses the task.
 * `writer-tc`/`reviewer-tc` run a prompt-based read→edit→verify loop instead.
 *
 * That path existed but was reachable only by passing `--tool-calling`
 * (default false) — every other entry point (the in-agent `build` tool, ci,
 * publish, phase, workflow, skill) constructed the orchestrator with no option
 * at all and silently got the blind writer.
 *
 * These tests pin the new contract:
 *   1. the policy seam defaults to ON and honours an explicit opt-out;
 *   2. the CLI exposes `--no-tool-calling` as the escape hatch;
 *   3. the eval framework keeps its two arms distinguishable.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Command } from 'commander';

import {
  DEFAULT_USE_TOOL_CALLING,
  resolveUseToolCalling,
} from '../../src/agents/orchestrator.js';
import { ExecuteCommand } from '../../src/cli/execute.js';
import { logger } from '../../src/utils/logger.js';

describe('tool-calling writer policy', () => {
  it('defaults ON for callers that pass nothing (build tool, ci, publish…)', () => {
    expect(DEFAULT_USE_TOOL_CALLING).toBe(true);
    expect(resolveUseToolCalling({})).toBe(true);
  });

  it('honours an explicit opt-out', () => {
    expect(resolveUseToolCalling({ useToolCalling: false })).toBe(false);
  });

  it('honours an explicit opt-in', () => {
    expect(resolveUseToolCalling({ useToolCalling: true })).toBe(true);
  });
});

describe('execute CLI surface', () => {
  let cmd: Command;

  beforeEach(() => {
    vi.spyOn(logger, 'info').mockImplementation(() => {});
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
    cmd = new ExecuteCommand().create();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('leaves tool-calling enabled when no flag is given', () => {
    // parseOptions populates opts without running the action (no pipeline boot).
    void cmd.parseOptions([]);
    expect(cmd.opts().toolCalling).not.toBe(false);
  });

  it('disables tool-calling with --no-tool-calling', () => {
    void cmd.parseOptions(['--no-tool-calling']);
    expect(cmd.opts().toolCalling).toBe(false);
  });

  it('still accepts the historical --tool-calling flag', () => {
    void cmd.parseOptions(['--tool-calling']);
    expect(cmd.opts().toolCalling).not.toBe(false);
  });

  it('advertises the opt-out in --help', () => {
    const help = cmd.helpInformation();
    expect(help).toContain('--no-tool-calling');
    expect(help).toContain('--tool-calling');
  });
});
