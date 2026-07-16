# @agent-nuvira/sdk

Build, test, and publish custom agents for the [agent-nuvira](https://github.com/imdheerajKube/agent-nuvira) multi-agent AI platform.

## Installation

```bash
npm install @agent-nuvira/sdk
```

## Quick Start — Creating Your First Agent

### 1. Scaffold a new agent project

```bash
npx agent-nuvira sdk scaffold my-awesome-agent MyAgent "Description"
cd my-awesome-agent
```

### 2. Implement your agent

Open `src/agent.ts` and extend the `Agent` base class:

```ts
import { Agent, type AgentContext, type AgentResult, type LLMCallFn } from '@agent-nuvira/sdk';

export class CodeReviewerAgent extends Agent {
  readonly name = 'CodeReviewer';
  readonly description = 'Reviews code for bugs, security issues, and best practices';

  async execute(context: AgentContext, callLLM: LLMCallFn): Promise<AgentResult> {
    // Read files from the context
    const filesToReview = context.artifacts
      .map((a) => `--- ${a.path} ---\n${a.content}`)
      .join('\n\n');

    const prompt = `Review the following code for bugs, security vulnerabilities,
and violations of best practices. For each issue found, provide:
- Severity (high/medium/low)
- The specific problem
- A suggested fix

Code to review:
${filesToReview || '(No files provided — describe what needs review)'}`;

    const review = await callLLM(prompt, {
      temperature: 0.3,  // Low temp for analytical work
      maxTokens: 4096,
    });

    return {
      success: true,
      summary: `Reviewed ${context.artifacts.length} file(s)`,
      details: review,
    };
  }
}
```

### 3. Test your agent

```ts
// tests/agent.test.ts
import { describe, it, expect } from 'vitest';
import {
  createTestContext,
  createMockCallLLM,
  assertAgentResult,
} from '@agent-nuvira/sdk/testing';
import { CodeReviewerAgent } from '../src/agent.js';

describe('CodeReviewerAgent', () => {
  it('should review files successfully', async () => {
    const agent = new CodeReviewerAgent();
    const ctx = createTestContext('Review the auth module');
    ctx.artifacts.push({
      path: 'auth.ts',
      content: 'const password = "secret123";',
      description: 'Authentication module',
    });

    const callLLM = createMockCallLLM(
      'HIGH: Hardcoded password found in auth.ts. Use environment variables instead.'
    );

    const result = await agent.execute(ctx, callLLM);
    assertAgentResult(result);
    expect(result.summary).toContain('Reviewed');
  });
});
```

### 4. Publish as a plugin

Build your agent, then place it in `~/.buff/agents/`:

```bash
npm run build
cp dist/agent.js ~/.buff/agents/my-code-reviewer.js
```

Now run `buff plugins list` to see it auto-discovered!

---

## API Reference

### `Agent` (abstract base class)

Extend this class to create a custom agent.

```ts
abstract class Agent {
  abstract readonly name: string;
  abstract readonly description: string;
  abstract execute(context: AgentContext, callLLM: LLMCallFn): Promise<AgentResult>;
}
```

### `AgentContext`

The shared context bus that all agents read from and write to.

| Field | Type | Description |
|---|---|---|
| `goal` | `string` | The original user goal |
| `workingDirectory` | `string` | Absolute path to the project root |
| `taskPlan` | `TaskStep[]` | Ordered execution plan |
| `artifacts` | `Artifact[]` | File artifacts (read inputs, write outputs) |
| `conversations` | `AgentMessage[]` | Agent-to-agent message log |
| `fileChanges` | `FileChange[]` | Proposed file changes |
| `metadata` | `Record<string, unknown>` | Arbitrary metadata |

### `AgentResult`

Returned by an agent after execution.

| Field | Type | Description |
|---|---|---|
| `success` | `boolean` | Whether the agent succeeded |
| `summary` | `string` | One-line summary of what was done |
| `details?` | `string` | Detailed output (shown in verbose mode) |
| `error?` | `string` | Error message if failed |

### `LLMCallFn`

The function agents use to call the LLM. Injected by the orchestrator.

```ts
type LLMCallFn = (prompt: string, options?: {
  model?: string;
  temperature?: number;
  maxTokens?: number;
}) => Promise<string>;
```

---

## Testing Utilities (`@agent-nuvira/sdk/testing`)

| Export | Description |
|---|---|
| `MockLLM` | Class that returns canned responses and records prompts |
| `createTestContext(goal?, dir?)` | Creates a minimal `AgentContext` |
| `createMockCallLLM(response)` | Creates a simple mock LLM call function |
| `createFailingCallLLM(error)` | Creates an LLM call function that always rejects |
| `assertAgentResult(result, success?)` | Asserts `AgentResult` shape and success |
| `createMockResult(overrides?)` | Creates a mock `AgentResult` with defaults |
| `addFileChange(ctx, path, content, status)` | Adds a file change to a context |
| `getFileChangeSummary(ctx)` | Gets human-readable change summaries |

---

## Publishing to the Community

1. Create a GitHub repo for your agent
2. Publish your agent package to npm:
   ```bash
   npm publish
   ```
3. Add your agent to the community registry:
   - Open a PR at: https://github.com/imdheerajKube/agent-nuvira
   - Or submit via: https://github.com/imdheerajKube/agent-nuvira/issues

---

## Resources

- [agent-nuvira GitHub](https://github.com/imdheerajKube/agent-nuvira)
- [Report Issues](https://github.com/imdheerajKube/agent-nuvira/issues)
