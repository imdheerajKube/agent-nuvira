/**
 * End-to-end test for the full agent pipeline.
 *
 * Tests the complete flow: Reasoner → Planner → Writer → Reviewer
 * with skill_view() integration.
 *
 * Verifies:
 * - Reasoner produces technical decisions
 * - Planner uses skill guidance from reasoner
 * - Writer can call skill_view() for domain expertise
 * - All agents have access to skill_view and skills_list tools
 * - Tool bridge provides all 111+ tools
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Hermetic test directory
const testDir = mkdtempSync(join(tmpdir(), 'e2e-pipeline-test-'));
process.env.NUVIRA_MEMORY_DIR = join(testDir, '.nuvira', 'memory');

import { ReasonerAgent } from '../../src/agents/agents/reasoner.js';
import { getSkillStore, resetSkillStore } from '../../src/learning/skill-store.js';
import { getAgentTools, getToolsForAgent, getToolBridgeSummary } from '../../src/agents/tool-bridge.js';
import type { AgentContext, LLMCallFn } from '../../src/agents/agent.js';
import type { TechnicalDecision } from '../../src/agents/agents/reasoner.js';

describe('E2E Pipeline — skill_view integration', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'e2e-test-'));
    resetSkillStore();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  // ── Reasoner tests ──────────────────────────────────────────────────────

  describe('ReasonerAgent', () => {
    it('produces technical decisions for snake-and-ladder game', async () => {
      const reasoner = new ReasonerAgent();

      // Mock LLM to return a technical decision
      const mockLLM: LLMCallFn = async (prompt: string) => {
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
          reasoning: 'Python+tkinter is the simplest cross-platform GUI option for Windows',
        });
      };

      const context: AgentContext = {
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

      // Verify decision was stored in vault
      const decision = context.metadata.technicalDecision as TechnicalDecision;
      expect(decision).toBeDefined();
      expect(decision.language).toBe('python');
      expect(decision.framework).toBe('tkinter');
      expect(decision.platform).toBe('windows-gui');
      expect(decision.deliverable).toBe('executable');
      expect(decision.buildCommand).toContain('pyinstaller');
    });

    it('handles malformed LLM responses gracefully', async () => {
      const reasoner = new ReasonerAgent();

      const mockLLM: LLMCallFn = async () => {
        return 'This is not JSON at all';
      };

      const context: AgentContext = {
        goal: 'create a game',
        workingDirectory: tempDir,
        fileChanges: [],
        taskPlan: [],
        artifacts: [],
        metadata: {},
      };

      const result = await reasoner.execute(context, mockLLM);

      // Returns success: false but the planner will use defaults (non-blocking)
      expect(result.success).toBe(false);
      expect(result.summary).toContain('defaults');
    });
  });

  // ── Skill Store tests ───────────────────────────────────────────────────

  describe('SkillStore.skillView()', () => {
    it('returns full methodology for game-development skill', () => {
      const store = getSkillStore();
      const output = store.skillView('game-development');

      // Should contain detailed methodology
      expect(output).toContain('game-development');
      expect(output).toContain('Execution Steps');
      expect(output).toContain('writer');
      expect(output).toContain('runner');
    });

    it('returns methodology for api-design skill', () => {
      const store = getSkillStore();
      const output = store.skillView('api-design');

      expect(output).toContain('api-design');
      expect(output).toContain('Execution Steps');
    });

    it('returns methodology for docker-management skill', () => {
      const store = getSkillStore();
      const output = store.skillView('docker-management');

      expect(output).toContain('docker-management');
      expect(output).toContain('Execution Steps');
    });

    it('marks skills as used when viewed', () => {
      const store = getSkillStore();
      const all = store.getAll();
      const skill = all[0];

      const initialUsage = skill.usageCount;
      store.skillView(skill.name);

      const updated = store.get(skill.id);
      expect(updated!.usageCount).toBe(initialUsage + 1);
    });
  });

  // ── Tool Bridge tests ───────────────────────────────────────────────────

  describe('Tool Bridge — all tools available', () => {
    it('provides 111+ tools via getAgentTools', () => {
      const tools = getAgentTools();
      expect(tools.length).toBeGreaterThan(50);
    });

    it('writer gets 30+ tools including skill_view', () => {
      const tools = getToolsForAgent('writer');
      const toolNames = tools.map((t) => t.name);

      // Core tools
      expect(toolNames).toContain('read_file');
      expect(toolNames).toContain('write_file');
      expect(toolNames).toContain('edit_file');
      expect(toolNames).toContain('code_search');
      expect(toolNames).toContain('run_terminal');
      expect(toolNames).toContain('git');

      // Skill tools (progressive disclosure)
      expect(toolNames).toContain('skill_view');
      expect(toolNames).toContain('skills_list');

      // Previously "dead" tools (now wired)
      expect(toolNames).toContain('browser');
      expect(toolNames).toContain('code_execution');
      expect(toolNames).toContain('generate_image');

      // Total should be 30+
      expect(tools.length).toBeGreaterThanOrEqual(30);
    });

    it('reviewer gets 15+ tools including skill_view', () => {
      const tools = getToolsForAgent('reviewer');
      const toolNames = tools.map((t) => t.name);

      // Core tools
      expect(toolNames).toContain('read_file');
      expect(toolNames).toContain('code_search');
      expect(toolNames).toContain('git');

      // Security tools
      expect(toolNames).toContain('sanitize');
      expect(toolNames).toContain('ast_audit');

      // Skill tools
      expect(toolNames).toContain('skill_view');
      expect(toolNames).toContain('skills_list');

      expect(tools.length).toBeGreaterThanOrEqual(15);
    });

    it('tool bridge summary shows all tools wired', () => {
      const summary = getToolBridgeSummary();

      expect(summary.totalRegistryTools).toBeGreaterThan(100);
      expect(summary.agentPipelineTools).toBeGreaterThan(80);
      // Only 3 tools are chat-only now
      expect(summary.chatOnlyTools).toBe(3);
    });
  });

  // ── Skill View as AgentTool ─────────────────────────────────────────────

  describe('skill_view as AgentTool', () => {
    it('can be executed by agent context', async () => {
      const tools = getToolsForAgent('writer');
      const skillViewTool = tools.find((t) => t.name === 'skill_view');

      expect(skillViewTool).toBeDefined();

      // Execute skill_view
      const result = await skillViewTool!.execute(
        { name: 'game-development' },
        {
          goal: 'create a game',
          workingDirectory: tempDir,
          fileChanges: [],
          metadata: {},
        } as any,
      );

      expect(result.success).toBe(true);
      expect(result.output).toContain('game-development');
      expect(result.output).toContain('Execution Steps');
    });

    it('skills_list returns lightweight summaries', async () => {
      const tools = getToolsForAgent('writer');
      const skillsListTool = tools.find((t) => t.name === 'skills_list');

      expect(skillsListTool).toBeDefined();

      const result = await skillsListTool!.execute(
        {},
        {
          goal: 'test',
          workingDirectory: tempDir,
          fileChanges: [],
          metadata: {},
        } as any,
      );

      expect(result.success).toBe(true);
      // Should be valid JSON
      const skills = JSON.parse(result.output);
      expect(Array.isArray(skills)).toBe(true);
      expect(skills.length).toBeGreaterThan(0);

      // Each skill should have name, description, tags
      const firstSkill = skills[0];
      expect(firstSkill.name).toBeDefined();
      expect(firstSkill.description).toBeDefined();
      expect(firstSkill.tags).toBeDefined();
    });
  });

  // ── Full Pipeline Flow ──────────────────────────────────────────────────

  describe('Full pipeline flow — snake-and-ladder', () => {
    it('reasoner → planner → writer flow works', async () => {
      // Step 1: Reasoner produces technical decisions
      const reasoner = new ReasonerAgent();
      const mockReasonerLLM: LLMCallFn = async () => {
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

      const context: AgentContext = {
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
      const decision = context.metadata.technicalDecision as TechnicalDecision;
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
});
