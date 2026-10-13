# @agent-nuvira/sdk

> Build, test, and register custom agents for the [Agent-Nuvira](https://www.agent-nuvira.com) multi-agent coding assistant.

The SDK is a clean-room types + base-class package: it has **no runtime dependency on the Agent-Nuvira internals**, so a custom agent can be built, unit-tested, and published without pulling in the whole CLI. Its type surface is kept structurally compatible with the main package by an in-repo compatibility test.

**Version:** the SDK ships on the **same version number as the CLI** — `3.5.1` — so `nuvira --version` and the SDK version always tell you the same number. A custom agent built against a mismatched SDK is the usual reason one fails to load, so check that first. (`nuvira sdk scaffold` pins this automatically; a test fails the release if the constant and this package's version disagree.)

> **📖 The guides.** [`docs/AGENT_SDK.md`](../../docs/AGENT_SDK.md) is the API manual — the
complete agent contract, `defineAgent()`'s failure modes, the context bus field by field, the
ten testing helpers with their real signatures, registration (including what registering
genuinely edits), troubleshooting, and a section stating **what depth the SDK offers and what
it deliberately does not** (no tool calling, no direct filesystem writes, no runtime agent
registry).
>
> [`docs/SDK_PLUGIN_GUIDE.md`](../../docs/SDK_PLUGIN_GUIDE.md) is the task-oriented guide:
which of the three shipping paths to take (plugin file vs source checkout vs embedded), the
rate-limit contract, where the model belongs versus where code must, publishing a plugin
package, and three worked examples with tests. This README is the npm landing page.

A runnable example agent with its own tests lives in `examples/sdk/`; verify it against
the SDK source with `npm run examples:verify` from the repository root.

## Installation

```bash
npm install @agent-nuvira/sdk
```

Node.js >= 18.18.0.

## Quick Start

### 1. Scaffold a project

```bash
npx agent-nuvira sdk scaffold my-agent CodeFormatter "Formats source code"
cd my-agent && npm install && npm run build && npm test
```

Templates: `full-agent` (default — config, source, vitest, tests), `basic-agent` (no test runner), `agent-pack` (multi-agent package skeleton).

### 2. Implement an agent

```ts
import { Agent, defineAgent, type AgentContext, type AgentResult, type LLMCallFn } from '@agent-nuvira/sdk';

export class CodeFormatter extends Agent {
  readonly name = 'CodeFormatter';
  readonly description = 'Formats source code according to project conventions';

  async execute(context: AgentContext, callLLM: LLMCallFn): Promise<AgentResult> {
    const prompt = [
      `You are the CodeFormatter agent.`,
      `Goal: ${context.goal}`,
      ...context.artifacts.map((f) => `--- ${f.path} ---\n${f.content}`),
    ].join('\n');

    const response = await callLLM(prompt, { temperature: 0.3, maxTokens: 2048 });

    return { success: true, summary: `Formatted ${context.artifacts.length} file(s)`, details: response };
  }
}

// Registers the agent under agentType 'code-formatter', derived from the name.
export const agentDescriptor = defineAgent({ AgentClass: CodeFormatter, tags: 'code, format' });
```

`defineAgent()` reads `name`/`description` off the class, derives a kebab-case `agentType`, and validates the result at definition time — so a typo fails where it is written, not when a plan step silently fails to match.

### 3. Test it

```ts
import { describe, it } from 'vitest';
import { CodeFormatter } from '../src/codeFormatter.js';
import { createMockContext, createMockLLM, runAgentTest, assertAgentSuccess } from '@agent-nuvira/sdk/testing';

describe('CodeFormatter', () => {
  it('formats files', async () => {
    const ctx = createMockContext({
      goal: 'Format all TypeScript files',
      artifacts: [{ path: 'src/index.ts', content: 'const x=1', description: 'Source' }],
    });

    const result = await runAgentTest(new CodeFormatter(), ctx, createMockLLM('Formatted content'));

    assertAgentSuccess(result);
  });
});
```

### 4. Register it with the orchestrator

> Registration edits a **source checkout**, and it adapts to the layout it finds: on a
> current checkout it adds an import plus a `registry.registerOrOverride(...)` call inside
> `createWithBuiltins()` in `src/agents/module-registry.ts`; on a checkout that still has the
> old hardcoded switch it edits `src/agents/orchestrator.ts` instead. With the CLI installed
> from npm there is no source tree, and the call reports `Orchestrator file not found at: …`
> rather than pretending.
>
> **To add an agent to a normal CLI install, ship a plugin file** into `~/.nuvira/agents/`:
> a compiled ESM module with a `default` export carrying `metadata` (including `agentTypes`)
> and `execute`. Discovery registers it under each declared agent type, so a plan step whose
> `agentType` matches will run it — no fork, no rebuild. See
> [`docs/SDK_PLUGIN_GUIDE.md`](../../docs/SDK_PLUGIN_GUIDE.md) §3, and check what loaded with
> `nuvira plugins list`.

```ts
import { registerAgent } from '@agent-nuvira/sdk/register';

registerAgent({
  sourceModule: './agents/code-formatter.js',
  className: 'CodeFormatter',
  agentType: 'code-formatter',
  icon: '🎨',
});
```

Or from the CLI:

```bash
npx agent-nuvira sdk register CodeFormatter code-formatter ./agents/code-formatter.js --icon 🎨
npx agent-nuvira sdk unregister code-formatter
```

## Module reference

| Entry point | Exports |
|---|---|
| `@agent-nuvira/sdk` | `Agent`, `defineAgent`, `registerAgent`/`unregisterAgent`, `scaffold`/`listTemplates`, all core types |
| `@agent-nuvira/sdk/agent` | `Agent`, `AgentDescriptor` |
| `@agent-nuvira/sdk/types` | Type definitions only (no runtime) |
| `@agent-nuvira/sdk/testing` | `createMockContext`, `createMockLLM`, `createFailingMockLLM`, `createSequentialMockLLM`, `runAgentTest`, `assertAgentSuccess`, `assertAgentFailure`, `addArtifact`, `addTaskStep`, `addFileChange` |
| `@agent-nuvira/sdk/register` | `registerAgent`, `unregisterAgent`, `RegisterOptions`, `RegisterResult` |
| `@agent-nuvira/sdk/scaffold` | `scaffold`, `listTemplates`, `ScaffoldOptions`, `ScaffoldTemplate` |
| `@agent-nuvira/sdk/define` | `defineAgent`, `toKebabCase`, `DefineAgentInput`, `DefinedAgent` |

## API

### `Agent` (abstract base class)

| Member | Description |
|---|---|
| `abstract name` / `abstract description` | Identity, read by planners and logs |
| `abstract execute(context, callLLM)` | Main logic — implement this |
| `validate(context)` | Optional pre-execution check; returns `true` or an error string |
| `cleanup()` | Optional post-execution cleanup; runs even if `execute` throws |

### Core types

`AgentContext` (the shared context bus), `AgentResult`, `TaskStep`, `FileChange`, `Artifact`, `AgentMessage`, `LLMCallFn`, `InferenceOptions`, `RateLimitInfo`, `RateLimitAction`, `OnRateLimit`, `OrchestratorOptions`, `OrchestrationResult`.

## Development

The SDK lives in `src/agent-sdk`. Its tests live in the repository's root suite under `tests/agent-sdk/` and run with the rest of the project:

```bash
npm run build:sdk        # build the SDK
npx vitest run tests/agent-sdk   # or: cd src/agent-sdk && npm test
```

## Publishing

CI publishes the SDK on an `sdk-v*` tag (`.github/workflows/publish-sdk.yml`). The workflow builds, runs the SDK tests, asserts every declared export resolves to a built file, then publishes with an idempotency guard. To publish manually:

```bash
npm run build:sdk
cd src/agent-sdk && npm publish
```

## License

MIT
