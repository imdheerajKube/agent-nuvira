/**
 * Tests for the ToolBridge — converts registry Tools to AgentTool format.
 *
 * Verifies:
 * - Bridge loads tools from the registry
 * - Chat-only tools are excluded
 * - Agent-relevant tools are included
 * - Tool conversion (ZodType → JSON Schema, run → execute)
 * - Agent-specific tool selection
 * - Deduplication works
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getAgentTools, getToolsForAgent, isAgentTool, getToolBridgeSummary } from '../../src/agents/tool-bridge.js';

describe('ToolBridge', () => {
  describe('getAgentTools', () => {
    it('returns an array of AgentTool instances', () => {
      const tools = getAgentTools();
      expect(Array.isArray(tools)).toBe(true);
      expect(tools.length).toBeGreaterThan(0);
    });

    it('each tool has name, description, parameters, and execute', () => {
      const tools = getAgentTools();
      for (const tool of tools) {
        expect(tool.name).toBeDefined();
        expect(typeof tool.name).toBe('string');
        expect(tool.description).toBeDefined();
        expect(typeof tool.description).toBe('string');
        expect(tool.parameters).toBeDefined();
        expect(typeof tool.parameters).toBe('object');
        expect(typeof tool.execute).toBe('function');
      }
    });

    it('excludes only pure UX tools', () => {
      const tools = getAgentTools();
      const toolNames = tools.map((t) => t.name);

      // Only truly UX-only tools are excluded
      expect(toolNames).not.toContain('ask_user');
      expect(toolNames).not.toContain('suggest_followups');

      // These are NOW available (previously chat-only, now wired)
      expect(toolNames).toContain('discord');
      expect(toolNames).toContain('homeassistant');
      expect(toolNames).toContain('kanban');
      expect(toolNames).toContain('voice_mode');
      expect(toolNames).toContain('generate_image');
    });

    it('includes agent-relevant tools', () => {
      const tools = getAgentTools();
      const toolNames = tools.map((t) => t.name);

      // These should be available for agents
      expect(toolNames).toContain('code_search');
      expect(toolNames).toContain('read_file');
      expect(toolNames).toContain('edit_file');
      expect(toolNames).toContain('write_file');
      expect(toolNames).toContain('run_terminal');
      expect(toolNames).toContain('list_dir');
      expect(toolNames).toContain('glob');
      expect(toolNames).toContain('git');
    });

    it('respects maxTools limit', () => {
      const tools = getAgentTools({ maxTools: 5 });
      expect(tools.length).toBeLessThanOrEqual(5);
    });

    it('respects excludeTools option', () => {
      const tools = getAgentTools({ excludeTools: ['code_search', 'git'] });
      const toolNames = tools.map((t) => t.name);
      expect(toolNames).not.toContain('code_search');
      expect(toolNames).not.toContain('git');
    });

    it('respects includeTools option', () => {
      const tools = getAgentTools({ includeTools: ['code_search', 'git'] });
      const toolNames = tools.map((t) => t.name);
      expect(toolNames).toContain('code_search');
      expect(toolNames).toContain('git');
      // Should not include other registry tools, but skill_view and skills_list are always added
      expect(tools.length).toBe(4); // 2 requested + 2 skill tools
    });
  });

  describe('getToolsForAgent', () => {
    it('returns tools for writer agent', () => {
      const tools = getToolsForAgent('writer');
      const toolNames = tools.map((t) => t.name);

      // Writer needs file ops, search, terminal, git
      expect(toolNames).toContain('code_search');
      expect(toolNames).toContain('read_file');
      expect(toolNames).toContain('edit_file');
      expect(toolNames).toContain('write_file');
      expect(toolNames).toContain('run_terminal');
      expect(toolNames).toContain('git');
    });

    it('returns tools for reviewer agent', () => {
      const tools = getToolsForAgent('reviewer');
      const toolNames = tools.map((t) => t.name);

      // Reviewer needs file ops, search, git (no terminal)
      expect(toolNames).toContain('code_search');
      expect(toolNames).toContain('read_file');
      expect(toolNames).toContain('git');
    });

    it('returns tools for context-gatherer agent', () => {
      const tools = getToolsForAgent('context-gatherer');
      const toolNames = tools.map((t) => t.name);

      // Context-gatherer needs file ops and search
      expect(toolNames).toContain('code_search');
      expect(toolNames).toContain('read_file');
      expect(toolNames).toContain('list_dir');
      expect(toolNames).toContain('glob');
    });

    it('returns tools for unknown agent type (fallback)', () => {
      const tools = getToolsForAgent('unknown-agent');
      // Should return default set
      expect(tools.length).toBeGreaterThan(0);
    });
  });

  describe('isAgentTool', () => {
    it('returns true for agent-relevant tools', () => {
      expect(isAgentTool('code_search')).toBe(true);
      expect(isAgentTool('read_file')).toBe(true);
      expect(isAgentTool('edit_file')).toBe(true);
      expect(isAgentTool('git')).toBe(true);
      expect(isAgentTool('web_search')).toBe(true);
    });

    it('returns false only for pure UX tools', () => {
      expect(isAgentTool('ask_user')).toBe(false);
      expect(isAgentTool('suggest_followups')).toBe(false);

      // These are NOW available (previously dead, now wired)
      expect(isAgentTool('discord')).toBe(true);
      expect(isAgentTool('kanban')).toBe(true);
      expect(isAgentTool('voice_mode')).toBe(true);
      expect(isAgentTool('generate_image')).toBe(true);
    });
  });

  describe('getToolBridgeSummary', () => {
    it('returns a summary with counts', () => {
      const summary = getToolBridgeSummary();
      expect(summary.totalRegistryTools).toBeGreaterThan(0);
      expect(summary.agentPipelineTools).toBeGreaterThan(0);
      // Only 3 tools are chat-only now (ask_user, suggest_followups, verify_requirement)
      expect(summary.chatOnlyTools).toBe(3);
      expect(summary.excludedTools).toBeGreaterThanOrEqual(0);
    });

    it('agent pipeline tools + chat only tools + excluded = total', () => {
      const summary = getToolBridgeSummary();
      expect(
        summary.agentPipelineTools + summary.chatOnlyTools + summary.excludedTools,
      ).toBe(summary.totalRegistryTools);
    });
  });

  describe('tool conversion', () => {
    it('converted tools have JSON Schema parameters', () => {
      const tools = getAgentTools({ includeTools: ['code_search'] });
      // +2 because skill_view and skills_list are always added
      expect(tools.length).toBe(3);

      const codeSearchTool = tools.find((t) => t.name === 'code_search');
      expect(codeSearchTool).toBeDefined();
      expect(codeSearchTool!.parameters.type).toBe('object');
      expect(codeSearchTool!.parameters.properties).toBeDefined();
    });

    it('converted tools can be executed', async () => {
      const tools = getAgentTools({ includeTools: ['list_dir'] });
      // +2 because skill_view and skills_list are always added
      expect(tools.length).toBe(3);

      const tool = tools.find((t) => t.name === 'list_dir');
      expect(tool).toBeDefined();
      // Execute with a real directory
      const result = await tool!.execute(
        { path: '.' },
        {
          goal: 'test',
          workingDirectory: process.cwd(),
          fileChanges: [],
          metadata: {},
        } as any,
      );

      expect(result).toBeDefined();
      expect(typeof result.success).toBe('boolean');
      expect(typeof result.output).toBe('string');
    });
  });
});
