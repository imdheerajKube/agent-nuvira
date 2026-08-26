import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WriterToolCallingAgent } from '../../src/agents/agents/writer-tool-calling.js';
import { ReviewerToolCallingAgent } from '../../src/agents/agents/reviewer-tool-calling.js';
import type { AgentContext, LLMCallFn } from '../../src/agents/agent.js';
import type { FileChange } from '../../src/agents/agent.js';

function makeContext(overrides: Partial<AgentContext> = {}): AgentContext {
  return {
    goal: 'create a snake and ladder game',
    workingDirectory: '/tmp/test-project',
    taskPlan: [
      {
        id: 'step-1',
        description: 'Create the game',
        agentType: 'writer',
        dependsOn: [],
        status: 'running',
      },
    ],
    artifacts: [],
    conversations: [],
    fileChanges: [],
    metadata: {},
    ...overrides,
  };
}

describe('WriterToolCallingAgent', () => {
  let agent: WriterToolCallingAgent;

  beforeEach(() => {
    agent = new WriterToolCallingAgent();
  });

  it('should have correct name and description', () => {
    expect(agent.name).toBe('Writer');
    expect(agent.description).toContain('iterative tool calls');
  });

  it('should parse JSON tool calls from code blocks', () => {
    const response = '```json\n{"tool": "read_file", "args": {"path": "src/index.ts"}}\n```';
    const parsed = (agent as any).parseResponse(response);
    expect(parsed.done).toBe(false);
    expect(parsed.toolCalls).toHaveLength(1);
    expect(parsed.toolCalls[0].name).toBe('read_file');
    expect(parsed.toolCalls[0].arguments.path).toBe('src/index.ts');
  });

  it('should parse inline JSON tool calls', () => {
    const response = '{"tool": "propose_change", "args": {"path": "test.py", "content": "print(1)"}}';
    const parsed = (agent as any).parseResponse(response);
    expect(parsed.done).toBe(false);
    expect(parsed.toolCalls).toHaveLength(1);
    expect(parsed.toolCalls[0].name).toBe('propose_change');
  });

  it('should detect final response (no tool calls)', () => {
    const response = 'I have created the snake and ladder game. The files have been proposed.';
    const parsed = (agent as any).parseResponse(response);
    expect(parsed.done).toBe(true);
    expect(parsed.text).toContain('snake and ladder');
  });

  it('should handle empty tool call gracefully', () => {
    const response = '```json\n{"tool": "unknown_tool", "args": {}}\n```';
    const parsed = (agent as any).parseResponse(response);
    expect(parsed.done).toBe(false);
    expect(parsed.toolCalls[0].name).toBe('unknown_tool');
  });
});

describe('ReviewerToolCallingAgent', () => {
  let agent: ReviewerToolCallingAgent;

  beforeEach(() => {
    agent = new ReviewerToolCallingAgent();
  });

  it('should have correct name and description', () => {
    expect(agent.name).toBe('Reviewer');
    expect(agent.description).toContain('iterative tool calls');
  });

  it('should parse tool calls', () => {
    const response = '```json\n{"tool": "read_file", "args": {"path": "src/index.ts"}}\n```';
    const parsed = (agent as any).parseResponse(response);
    expect(parsed.done).toBe(false);
    expect(parsed.toolCalls).toHaveLength(1);
  });

  it('should detect clean review (no tool calls)', () => {
    const response = '✅ Review passed. No issues found.';
    const parsed = (agent as any).parseResponse(response);
    expect(parsed.done).toBe(true);
    expect(parsed.text).toContain('Review passed');
  });
});

describe('ToolCallingAgent — propose_change tool', () => {
  it('should add FileChange to context.fileChanges', async () => {
    const agent = new WriterToolCallingAgent();
    const context = makeContext();

    // Get the tools and find propose_change
    const tools = (agent as any).getTools(context);
    const proposeChange = tools.find((t: any) => t.name === 'propose_change');

    expect(proposeChange).toBeDefined();

    // Execute the tool
    const result = await proposeChange.execute(
      { path: 'test.py', content: 'print("hello")' },
      context,
    );

    expect(result.success).toBe(true);
    expect(context.fileChanges).toHaveLength(1);
    expect(context.fileChanges[0].path).toBe('test.py');
    expect(context.fileChanges[0].newContent).toBe('print("hello")');
    expect(context.fileChanges[0].status).toBe('created');
  });

  it('should deduplicate by path', async () => {
    const agent = new WriterToolCallingAgent();
    const context = makeContext();

    const tools = (agent as any).getTools(context);
    const proposeChange = tools.find((t: any) => t.name === 'propose_change');

    // Propose twice to same path
    await proposeChange.execute({ path: 'test.py', content: 'v1' }, context);
    await proposeChange.execute({ path: 'test.py', content: 'v2' }, context);

    expect(context.fileChanges).toHaveLength(1);
    expect(context.fileChanges[0].newContent).toBe('v2');
  });
});

describe('ToolCallingAgent — list_files tool', () => {
  it('should list files in a directory', async () => {
    const agent = new WriterToolCallingAgent();
    const context = makeContext({ workingDirectory: process.cwd() });

    const tools = (agent as any).getTools(context);
    const listFiles = tools.find((t: any) => t.name === 'list_files');

    expect(listFiles).toBeDefined();

    const result = await listFiles.execute({ path: 'src', maxDepth: 1 }, context);
    expect(result.success).toBe(true);
    expect(result.output).toContain('agents');
  });
});
