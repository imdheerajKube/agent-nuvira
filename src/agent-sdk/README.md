# @agent-nuvira/sdk

> Build custom agents for the Agent-Nuvira multi-agent orchestration system.

## Installation

```bash
npm install @agent-nuvira/sdk
```

## Quick Start

Create a custom agent in three steps:

### 1. Scaffold the project

```bash
# From the agent-nuvira project root
npx tsx src/index.ts sdk scaffold my-agent CodeFormatter "Formats source code"

# Or manually create the files (see examples below)
```

### 2. Implement your agent

```ts
// src/code-formatter.ts
import { Agent, type AgentContext, type AgentResult, type LLMCallFn } from '@agent-nuvira/sdk';

export class CodeFormatter extends Agent {
  readonly name = 'CodeFormatter';
  readonly description = 'Formats source code according to project conventions';

  async execute(context: AgentContext, callLLM: LLMCallFn): Promise<AgentResult> {
    // Read files from the context
    const files = context.artifacts;

    // Build a prompt
    const prompt = [
      `You are the CodeFormatter agent.`,
      `Goal: ${context.goal}`,
      '',
      `Files to format:`,
      ...files.map(f => `- ${f.path}`),
    ].join('\n');

    // Call the LLM
    const response = await callLLM(prompt);

    return {
      success: true,
      summary: `Formatted ${files.length} file(s)`,
      details: response,
    };
  }
}

// Required: export a descriptor for automatic registration
export const agentDescriptor = {
  AgentClass: CodeFormatter,
  name: 'CodeFormatter',
  description: 'Formats source code according to project conventions',
  agentType: 'code-formatter',
  tags: 'code, format',
};
```

### 3. Test your agent

```ts
// tests/code-formatter.test.ts
import { describe, it } from 'vitest';
import { CodeFormatter } from '../src/code-formatter.js';
import {
  createMockContext,
  createMockLLM,
  createFailingMockLLM,
  runAgentTest,
  assertAgentSuccess,
  assertAgentFailure,
} from '@agent-nuvira/sdk/testing';

describe('CodeFormatter', () => {
  const agent = new CodeFormatter();

  it('should format files', async () => {
    const ctx = createMockContext({
      goal: 'Format all TypeScript files',
      artifacts: [{ path: 'src/index.ts', content: 'const x=1', description: 'Source' }],
    });
    const llm = createMockLLM('Formatted content');

    const result = await runAgentTest(agent, ctx, llm);

    assertAgentSuccess(result);
  });
});
```

## API Reference

### `Agent` (base class)

| Method | Description |
|---|---|
| `abstract execute(context, callLLM)` | Main logic — implement this |
| `validate(context)` | Optional pre-execution check |
| `cleanup()` | Optional post-execution cleanup |

### Core Types

| Type | Description |
|---|---|
| `AgentContext` | Shared context bus — read inputs, write outputs |
| `AgentResult` | Success/failure result with summary and details |
| `TaskStep` | A single step in the execution plan |
| `FileChange` | A proposed file modification |
| `Artifact` | A file artifact (input or output) |
| `LLMCallFn` | Function signature for LLM calls |
| `InferenceOptions` | LLM generation parameters |

### Testing Utilities (`@agent-nuvira/sdk/testing`)

| Function | Description |
|---|---|
| `createMockContext(options)` | Build a fully typed mock AgentContext |
| `createMockLLM(response)` | Mock LLM that returns a fixed response |
| `createFailingMockLLM(error)` | Mock LLM that throws an error |
| `createSequentialMockLLM(responses)` | Mock LLM with sequenced responses |
| `runAgentTest(agent, context, callLLM)` | Execute agent with validate + cleanup |
| `assertAgentSuccess(result)` | Assert result indicates success |
| `assertAgentFailure(result, errorSubstring?)` | Assert result indicates failure |
| `addArtifact(context, path, content, description)` | Add a file artifact |
| `addTaskStep(context, id, agentType, description, dependsOn)` | Add a task step |
| `addFileChange(context, path, newContent, ...)` | Add a file change |

## Scaffolding

Generate a new agent project:

```bash
agent-nuvira sdk scaffold my-agent CodeFormatter "Formats source code"
agent-nuvira sdk scaffold --template basic-agent my-minimal-agent MinimalAgent "Minimal example"
agent-nuvira sdk scaffold --template agent-pack my-agent-pack AgentPack "Collection of agents"
```

List available templates:

```bash
agent-nuvira sdk templates
```

## Publishing

```bash
# Build the SDK
npm run build:sdk

# Publish to npm
cd src/agent-sdk && npm publish
```

## License

MIT
