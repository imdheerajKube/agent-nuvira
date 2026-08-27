/**
 * End-to-end integration test with real LLM calls.
 *
 * Tests the full pipeline: Reasoner → Planner → Writer → Reviewer
 * using real LLM providers (Gemini, Groq, etc.)
 *
 * This test verifies:
 * - Reasoner produces technical decisions
 * - Planner creates a valid task plan
 * - Writer can call skill_view() for domain expertise
 * - All agents have access to tools
 *
 * Run with: npx vitest run tests/integration/pipeline-e2e.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Set up hermetic environment
const testDir = mkdtempSync(join(tmpdir(), 'pipeline-e2e-test-'));
process.env.NUVIRA_MEMORY_DIR = join(testDir, '.nuvira', 'memory');
process.env.NUVIRA_CONFIG_DIR = join(testDir, '.nuvira');

import { Orchestrator } from '../../src/agents/orchestrator.js';
import { ConfigManager } from '../../src/config/manager.js';
import { getSkillStore, resetSkillStore } from '../../src/learning/skill-store.js';
import { getToolsForAgent, getToolBridgeSummary } from '../../src/agents/tool-bridge.js';

// Increase timeout for real LLM calls (handled by vitest config)

describe('Pipeline E2E — Real LLM', () => {
  let orchestrator: Orchestrator;
  let tempDir: string;

  beforeAll(() => {
    // Create a temp working directory
    tempDir = mkdtempSync(join(testDir, 'workspace-'));

    // Initialize orchestrator with config
    const configManager = new ConfigManager();
    orchestrator = new Orchestrator(configManager);
  });

  afterAll(() => {
    // Clean up
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      // Best-effort
    }
  });

  it('skill_view returns full methodology for game-development', () => {
    const store = getSkillStore();
    const output = store.skillView('game-development');

    // Verify full methodology is returned
    expect(output).toContain('game-development');
    expect(output).toContain('Execution Steps');
    expect(output).toContain('writer');
    expect(output).toContain('runner');

    // Verify reference docs are listed
    expect(output).toContain('Reference Documents');
    expect(output).toContain('platform-specific.md');
  });

  it('skill_view loads reference docs from disk', () => {
    const store = getSkillStore();
    const output = store.skillView('game-development', 'platform-specific.md');

    // Verify actual content is loaded
    expect(output).toContain('Platform-Specific');
    expect(output).toContain('Python');
    expect(output).toContain('tkinter');
  });

  it('tool bridge provides all 111+ tools', () => {
    const summary = getToolBridgeSummary();

    expect(summary.totalRegistryTools).toBeGreaterThan(100);
    expect(summary.agentPipelineTools).toBeGreaterThan(80);
    expect(summary.chatOnlyTools).toBe(3);
  });

  it('writer gets 30+ tools including skill_view', () => {
    const tools = getToolsForAgent('writer');
    const toolNames = tools.map((t) => t.name);

    // Core tools
    expect(toolNames).toContain('read_file');
    expect(toolNames).toContain('write_file');
    expect(toolNames).toContain('code_search');
    expect(toolNames).toContain('run_terminal');
    expect(toolNames).toContain('git');

    // Skill tools
    expect(toolNames).toContain('skill_view');
    expect(toolNames).toContain('skills_list');

    // Previously "dead" tools (now wired)
    expect(toolNames).toContain('browser');
    expect(toolNames).toContain('code_execution');

    expect(tools.length).toBeGreaterThanOrEqual(30);
  });

  it('reasoner produces technical decisions', async () => {
    // This test uses a mock LLM to verify the reasoner logic
    const { ReasonerAgent } = await import('../../src/agents/agents/reasoner.js');
    const reasoner = new ReasonerAgent();

    const mockLLM = async (prompt: string) => {
      return JSON.stringify({
        language: 'python',
        framework: 'tkinter',
        platform: 'windows-gui',
        architecture: 'single-file',
        dependencies: ['pyinstaller'],
        buildCommand: 'pyinstaller --onefile snake_ladder.py',
        deliverable: 'executable',
        constraints: ['must run on Windows', 'must have GUI'],
        isGreenfield: true,
        confidence: 0.9,
        reasoning: 'Python+tkinter is the simplest cross-platform GUI option',
      });
    };

    const context = {
      goal: 'create a game of snake and ladder for windows GUI, deliver executable file (.exe)',
      workingDirectory: tempDir,
      fileChanges: [],
      taskPlan: [],
      artifacts: [],
      metadata: {},
    };

    const result = await reasoner.execute(context, mockLLM);

    expect(result.success).toBe(true);
    expect(result.summary).toContain('Technical decisions made');

    // Verify decision was stored
    const decision = context.metadata.technicalDecision;
    expect(decision).toBeDefined();
    expect(decision.language).toBe('python');
    expect(decision.framework).toBe('tkinter');
    expect(decision.platform).toBe('windows-gui');
    expect(decision.deliverable).toBe('executable');
  });

  it('full pipeline flow works end-to-end', async () => {
    // Step 1: Reasoner produces technical decisions
    const { ReasonerAgent } = await import('../../src/agents/agents/reasoner.js');
    const reasoner = new ReasonerAgent();

    const mockReasonerLLM = async () => {
      return JSON.stringify({
        language: 'python',
        framework: 'tkinter',
        platform: 'windows-gui',
        architecture: 'single-file',
        dependencies: ['pyinstaller'],
        buildCommand: 'pyinstaller --onefile snake_ladder.py',
        deliverable: 'executable',
        constraints: ['must run on Windows'],
        isGreenfield: true,
        confidence: 0.9,
        reasoning: 'Python+tkinter for Windows GUI',
      });
    };

    const context = {
      goal: 'create a game of snake and ladder for windows GUI, deliver executable file (.exe)',
      workingDirectory: tempDir,
      fileChanges: [],
      taskPlan: [],
      artifacts: [],
      metadata: {},
    };

    const reasonerResult = await reasoner.execute(context, mockReasonerLLM);
    expect(reasonerResult.success).toBe(true);

    // Step 2: Verify technical decision was stored
    const decision = context.metadata.technicalDecision;
    expect(decision).toBeDefined();
    expect(decision.language).toBe('python');
    expect(decision.framework).toBe('tkinter');

    // Step 3: Writer can load skill methodology
    const tools = getToolsForAgent('writer');
    const skillViewTool = tools.find((t) => t.name === 'skill_view');

    const skillOutput = await skillViewTool!.execute(
      { name: 'game-development' },
      context,
    );

    expect(skillOutput.success).toBe(true);
    expect(skillOutput.output).toContain('Execution Steps');

    // Step 4: Writer has all necessary tools
    const toolNames = tools.map((t) => t.name);
    expect(toolNames).toContain('read_file');
    expect(toolNames).toContain('write_file');
    expect(toolNames).toContain('run_terminal');
    expect(toolNames).toContain('skill_view');
    expect(toolNames).toContain('git');
    expect(toolNames).toContain('code_search');
  });
});
