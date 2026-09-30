# Building custom agents with `@agent-nuvira/sdk`

> **What this page is for:** everything you need to go from `npm i` to a tested,
> registered custom agent — plus an honest statement of what the SDK gives you
> and what it deliberately does not. If you only read one section, read
> [What depth you actually get](#what-depth-you-actually-get).

The SDK is a **types-and-base-class package with zero runtime dependency on the
Agent-Nuvira internals**. That is a design decision, not an accident: a custom
agent can be built, type-checked, unit-tested and published without pulling in
the CLI, a provider, an API key or the network. A compatibility test in this
repository keeps its type surface structurally identical to the orchestrator's,
so "it compiles against the SDK" and "the orchestrator can run it" are the same
statement.

- **Package:** `@agent-nuvira/sdk`
- **Runtime:** Node.js `>= 18.18.0`
- **Module format:** ESM only (`"type": "module"`, `NodeNext` resolution)
- **Peer dependency:** TypeScript `>= 5.0.0`
- **Guide version:** the SDK ships on the same version number as the CLI
  (`3.3.5`), so `nuvira --version` and the SDK version always tell you the same
  number. A mismatch between the SDK you built against and the CLI running your
  agent is the single most common reason a custom agent fails to load; check
  both with `nuvira sdk info`.

---

## 1. Install

```bash
npm install @agent-nuvira/sdk
```

Or scaffold a project that already depends on it (recommended — see §3):

```bash
npx agent-nuvira sdk scaffold my-agent CodeFormatter "Formats source code"
```

---

## 2. The 5-minute path

```bash
# 1. Generate a complete project (config, source, tests, vitest)
npx agent-nuvira sdk scaffold code-formatter CodeFormatter "Formats source code"

# 2. Install, build, test — it works before you change a line
cd code-formatter
npm install
npm run build
npm test

# 3. Make it yours
$EDITOR src/codeFormatter.ts

# 4. Wire it into your install (see §8)
npx agent-nuvira sdk register CodeFormatter code-formatter ./agents/code-formatter.js --icon 🎨
```

`nuvira sdk templates` lists the three starting points:

| Template | What you get | When to use it |
|---|---|---|
| `full-agent` (default) | Agent class, package.json, tsconfig, vitest config, a passing test file | You are building one agent and want tests from the first minute |
| `basic-agent` | Agent class, package.json, tsconfig — no test runner | You will wire testing in yourself |
| `agent-pack` | A multi-agent package skeleton with a re-export entry point | You are shipping several agents together |

---

## 3. Scaffold in detail

```
nuvira sdk scaffold <outDir> <agentName> [description] [-t <template>] [--agent-type <type>]
```

| Argument / flag | Meaning |
|---|---|
| `<outDir>` | Directory to create (it is created for you) |
| `<agentName>` | Class name in **PascalCase** — `CodeFormatter`, not `code-formatter` |
| `[description]` | What the agent does. Defaults to `A custom agent` and is what the planner reads |
| `-t, --template <template>` | `basic-agent` \| `full-agent` \| `agent-pack` (default `full-agent`) |
| `--agent-type <type>` | Plan identifier. Defaults to the kebab-case of `agentName` |

An unknown `--template` is refused with the valid list rather than silently
falling back to a default — a template typo that produced a different project
than asked for would be discovered much later, at plan time.

```bash
nuvira sdk templates   # list templates
nuvira sdk info        # the SDK version this CLI expects
```

---

## 4. Write the agent

Every agent extends `Agent` and implements `execute`. Three members matter, two
are optional:

| Member | Required | Contract |
|---|---|---|
| `readonly name` | yes | Human-readable identity, read by planners and logs |
| `readonly description` | yes | One line explaining what it does — this is what the planner reasons over |
| `execute(context, callLLM)` | yes | Your logic; returns `AgentResult` |
| `validate(context)` | no | Return `true` to proceed, or a **string** to refuse the run with that reason |
| `cleanup()` | no | Release resources. Runs after `execute` **even if `execute` throws** |

A complete, realistic agent — this is the shape, not a toy:

```ts
import {
  Agent,
  defineAgent,
  type AgentContext,
  type AgentResult,
  type LLMCallFn,
} from '@agent-nuvira/sdk';

export class ConventionalCommit extends Agent {
  readonly name = 'ConventionalCommit';
  readonly description = 'Drafts a Conventional Commits message from a change description or diff';

  // A precondition is cheaper than a model call. Returning a string refuses the
  // step with that message instead of spending tokens on a goal you can already
  // tell is unanswerable.
  validate(context: AgentContext): true | string {
    const hasDiff = context.artifacts.some((a) => a.path.endsWith('.diff'));
    if (!hasDiff && context.goal.trim().length < 10) {
      return 'Give me either a diff artifact or a change description of at least 10 characters.';
    }
    return true;
  }

  async execute(context: AgentContext, callLLM: LLMCallFn): Promise<AgentResult> {
    const diff = context.artifacts.find((a) => a.path.endsWith('.diff'));

    const prompt = [
      'You write Conventional Commits messages.',
      'Reply with the message only — no preamble, no markdown fence.',
      `Change description: ${context.goal}`,
      diff ? `--- diff ---\n${diff.content}` : '',
    ].filter(Boolean).join('\n\n');

    const raw = await callLLM(prompt, { temperature: 0.2, maxTokens: 256 });
    const message = raw.trim();

    // Validate the MODEL's output, not just your own. A malformed message that
    // is returned as success is a claim the caller cannot check.
    if (!/^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\(.+\))?: .+/.test(message)) {
      return {
        success: false,
        summary: 'The model did not return a Conventional Commits message',
        error: `Unrecognised output: ${message.slice(0, 120)}`,
      };
    }

    // Outputs go on the shared context bus, so later steps can see them.
    context.metadata.conventionalCommit = message;

    return { success: true, summary: message, details: message };
  }

  cleanup(): void {
    // Nothing to release here. Override when you open a socket or a temp file.
  }
}

/** The descriptor the registry reads. Derives agentType: 'conventional-commit'. */
export const agentDescriptor = defineAgent({
  AgentClass: ConventionalCommit,
  tags: 'git, commit, release-notes',
  icon: '📝',
});
```

A runnable version of this agent — plus its tests and its own README — lives in
the repository at `examples/sdk/`.

### 4.1 Why `defineAgent()` instead of a hand-written descriptor

Hand-writing the descriptor object is where custom agents most often go subtly
wrong: `agentType` drifts from the class name, or a kebab-case typo silently
never matches a plan step (no error, the step just never dispatches). `defineAgent()`
reads `name` and `description` off the class, derives `agentType`, and **validates
at definition time** so a broken descriptor throws where you wrote it:

| It throws when | Example |
|---|---|
| `AgentClass` is missing or not a constructor | `defineAgent({} as any)` |
| The class cannot be instantiated with no arguments | a class whose constructor requires a config object |
| `name` or `description` is empty/whitespace | `readonly name = ''` |
| An explicit `agentType` is not kebab-case | `agentType: 'CodeFormatter'` |

`agentType` must match `/^[a-z][a-z0-9-]*$/`. `toKebabCase('HTTPClient')` is
`'http-client'` — the helper is exported if you need it directly.

### 4.2 The context bus (`AgentContext`)

One object, read and written by every agent in the run. This is how agents
communicate — there is no agent-to-agent channel.

| Field | Type | Read or write |
|---|---|---|
| `goal` | `string` | Read — the original user ask |
| `workingDirectory` | `string` | Read — project root |
| `taskPlan` | `TaskStep[]` | Read — the ordered plan |
| `artifacts` | `Artifact[]` | Read inputs / append outputs |
| `conversations` | `AgentMessage[]` | Append — inter-agent log |
| `fileChanges` | `FileChange[]` | **Append to propose a file edit** |
| `metadata` | `Record<string, unknown>` | Free-form store for your own values |
| `onRateLimit?` | `OnRateLimit` | Read — set by the orchestrator |

```ts
// Propose a change instead of writing one. The orchestrator decides whether to
// apply it (and honours --dry-run / review mode for you).
context.fileChanges.push({
  path: 'src/index.ts',
  originalContent: previous,
  newContent: next,
  status: 'modified', // 'created' | 'modified' | 'deleted'
});
```

`AgentResult` is `{ success, summary, details?, error? }` — `summary` is
required and is what a reader sees in the pipeline output, so make it the
sentence you would want in a report.

### 4.3 Calling the model

```ts
type LLMCallFn = (prompt: string, options?: InferenceOptions) => Promise<string>;

interface InferenceOptions {
  temperature?: number;  // 0.0–2.0
  maxTokens?: number;
  model?: string;        // override for this call
  stop?: string[];
  topP?: number;
}
```

Two deliberate properties of this signature tell you the depth of the
integration:

- **You never choose a provider.** The orchestrator injects `callLLM`, so
  routing, failover, quota accounting and the model-substitution repairs all
  apply to your agent exactly as they apply to the built-in 17. Do not import a
  provider SDK.
- **The return is a `string`.** Your agent does not see usage, finish reasoning
  or rate-limit metadata — handle those through `context.onRateLimit` if you
  need to react to a 429.

---

## 5. Test it without a provider

`@agent-nuvira/sdk/testing` is why a custom agent can be fully tested in CI with
no key, no network and no flakiness. Real signatures, all verified against the
source:

| Export | Signature | Note |
|---|---|---|
| `createMockContext` | `(options?: MockContextOptions) => AgentContext` | Accepts `goal`, `workingDirectory`, `taskPlan`, `artifacts`, `fileChanges`, `conversations`, `metadata`, `onRateLimit` |
| `createMockLLM` | `(response?, options?) => LLMCallFn & { prompts }` | Records every prompt on `.prompts` unless `{ trackPrompts: false }` |
| `createFailingMockLLM` | `(error?) => LLMCallFn` | Throws — for your error paths |
| `createSequentialMockLLM` | `(responses: string[]) => LLMCallFn` | Throws when exhausted, so an unexpected extra call fails loudly |
| `runAgentTest` | `(agent, context, callLLM?) => Promise<AgentResult>` | Calls `validate()` first, then `execute()`, then `cleanup()` — including when `execute` throws |
| `assertAgentSuccess` | `(result) => asserts result is …{success:true}` | Prints the summary **and** the error when it fails |
| `assertAgentFailure` | `(result, expectedErrorSubstring?) => asserts …` | Optional case-insensitive substring match on `error` |
| `addArtifact` | `(ctx, path, content, description) => void` | |
| `addTaskStep` | `(ctx, id, agentType, description, dependsOn?, status?) => void` | |
| `addFileChange` | `(ctx, path, newContent, originalContent?, status?) => void` | |

`runAgentTest` mirroring the real lifecycle is the point: a `validate()`
refusal or a `cleanup()` leak shows up in tests instead of in production.
Every import in the example below is a real export of
`@agent-nuvira/sdk/testing` — if it is not in the table above, it does not exist.

```ts
import { describe, it, expect } from 'vitest';
import { ConventionalCommit } from '../src/conventionalCommit.js';
import {
  createMockContext,
  createMockLLM,
  createFailingMockLLM,
  addArtifact,
  runAgentTest,
  assertAgentSuccess,
  assertAgentFailure,
} from '@agent-nuvira/sdk/testing';

describe('ConventionalCommit', () => {
  const agent = new ConventionalCommit();

  it('prompts the model with the goal and the diff', async () => {
    const ctx = createMockContext({ goal: 'add a login route' });
    addArtifact(ctx, 'change.diff', 'diff --git a/x.ts b/x.ts', 'the change');
    const llm = createMockLLM('feat(auth): add login route');

    const result = await runAgentTest(agent, ctx, llm);

    assertAgentSuccess(result);
    expect(llm.prompts[0].prompt).toContain('add a login route');
    expect(llm.prompts[0].prompt).toContain('diff --git');
    expect(result.summary).toBe('feat(auth): add login route');
  });

  it('refuses a goal it cannot answer, without calling the model', async () => {
    const ctx = createMockContext({ goal: 'x' });
    const llm = createMockLLM('should not be reached');

    const result = await runAgentTest(agent, ctx, llm);

    assertAgentFailure(result, 'at least 10 characters');
    expect(llm.prompts).toHaveLength(0);   // the precondition saved a model call
  });

  it('reports bad model output as a failure, not a success', async () => {
    const ctx = createMockContext({ goal: 'add a login route' });
    addArtifact(ctx, 'change.diff', 'diff --git a/x.ts b/x.ts', 'the change');

    const result = await runAgentTest(agent, ctx, createMockLLM('I updated the login route.'));

    assertAgentFailure(result, 'did not return a Conventional Commits message');
  });

  it('survives a provider failure', async () => {
    const ctx = createMockContext({ goal: 'add a login route' });
    addArtifact(ctx, 'change.diff', 'diff --git a/x.ts b/x.ts', 'the change');

    const result = await runAgentTest(agent, ctx, createFailingMockLLM(new Error('API error')));

    assertAgentFailure(result, 'API error');
  });
});
```

---

## 6. Module reference

Each sub-path exists so you can import only what you need — this matters when a
plain type import would otherwise drag a Node-only module into a browser bundle.

| Entry point | Exports |
|---|---|
| `@agent-nuvira/sdk` | `Agent`, `defineAgent`, `toKebabCase`, `registerAgent`, `unregisterAgent`, `scaffold`, `listTemplates`, all core types |
| `@agent-nuvira/sdk/agent` | `Agent`, `AgentDescriptor` |
| `@agent-nuvira/sdk/types` | Types only, no runtime values |
| `@agent-nuvira/sdk/testing` | The ten helpers in §5 |
| `@agent-nuvira/sdk/register` | `registerAgent`, `unregisterAgent`, `RegisterOptions`, `RegisterResult` |
| `@agent-nuvira/sdk/scaffold` | `scaffold`, `listTemplates`, `ScaffoldOptions`, `ScaffoldTemplate` |
| `@agent-nuvira/sdk/define` | `defineAgent`, `toKebabCase`, `DefineAgentInput`, `DefinedAgent` |

Types: `TaskStatus`, `TaskStep`, `Artifact`, `FileChange`, `AgentMessage`,
`LLMCallFn`, `InferenceOptions`, `RateLimitInfo`, `RateLimitAction`,
`OnRateLimit`, `AgentContext`, `AgentResult`, `OrchestratorOptions`,
`OrchestrationResult`.

---

## 7. Registering it (and what registering really means)

`registerAgent()` is a **source-tree edit**, not a runtime registry call. It
opens an `orchestrator.ts` file and makes three insertions: an `import`, a `case`
in the `createAgent()` switch, and an entry in the `AGENT_ICONS` map. Calling it
twice is a no-op, and it reports what it changed:

```ts
import { registerAgent } from '@agent-nuvira/sdk/register';

const result = registerAgent({
  sourceModule: './agents/conventional-commit.js', // relative to orchestrator.ts
  className: 'ConventionalCommit',
  agentType: 'conventional-commit',
  icon: '📝',
});

console.log(result.success, result.message, result.modifiedFiles);
// true, "Registered agent 'conventional-commit' (ConventionalCommit) with the
//  orchestrator. Added: import, switch case, icon.", ['/…/src/agents/orchestrator.ts']
```

| Option | Required | Default |
|---|---|---|
| `sourceModule` | yes | — import path **relative to `orchestrator.ts`** |
| `className` | yes | — the exported class name |
| `agentType` | yes | — the string plan steps will name |
| `icon` | no | `🧩` |
| `name` | no | `className` |
| `orchestratorPath` | no | `resolve(process.cwd(), 'src/agents/orchestrator.ts')` |

`unregisterAgent({ agentType, className? })` reverses it. Passing `className`
enables safe import removal — the match is the exact `import { ClassName } from '…';`
pattern, so a built-in import can never be removed by accident.

> **The honest limitation, and the reason this matters:** with the default path,
> registration requires a **checkout of the Agent-Nuvira source tree**, because
> that is where `orchestrator.ts` lives. If you installed the CLI from npm there
> is no `orchestrator.ts` on your machine, and `registerAgent` returns
> `Orchestrator file not found at: …` rather than pretending. Point
> `--orchestrator-path` at a source checkout, or distribute your agent as a
> plugin file (the path `examples/sdk` documents: build it, copy the built `.js`
> into your agents directory, then confirm with `nuvira plugins list`).

CLI equivalents:

```bash
nuvira sdk register <className> <agentType> <sourceModule> [-i <icon>] [--orchestrator-path <path>]
nuvira sdk unregister <agentType> [--orchestrator-path <path>]
```

---

## 8. What depth you actually get

This is the section to read before promising your team something.

**You get:**

- A **stable, versioned contract** for an agent: identity, a pre-flight check, an
  execution body, and a guaranteed cleanup — implemented once and compatible
  with the orchestrator's own agent interface (enforced by an in-repo test, not
  by convention).
- **Provider-agnostic LLM access.** Your agent inherits the host's routing,
  failover, quota ledger, model-substitution repairs and telemetry, because it
  never learns which provider it is on.
- **A complete test story with no provider, no key, no network** — including the
  two failure shapes that are easy to get wrong (a precondition refusal, and a
  provider throw).
- **Scaffolding** that produces a project which builds and passes on the first
  run, in three shapes.
- **Descriptor validation at definition time**, so the most common class of
  silent bug (an `agentType` that never matches a plan step) becomes a throw at
  the line that caused it.
- **Publication as a normal npm package**, because the SDK has no runtime
  dependencies and no peer on the CLI.

**You do not get:**

- **Tool calling.** `callLLM` takes a prompt and returns text. There is no
  function-call surface, no tool schema registration and no way for a custom
  agent to invoke `read_file`, `run_terminal` or any other built-in tool. If your
  agent needs to inspect the workspace, it reads `context.artifacts` — which the
  orchestrator populates.
- **Direct filesystem writes** as a supported path. Propose edits via
  `context.fileChanges` and let the orchestrator apply them, so dry-run and
  review mode keep working.
- **A runtime agent registry.** `registerAgent` edits source; it is not a
  `register()` call at boot. (A separately distributed agent is installed as a
  plugin file.)
- **Replacement of the built-in agents.** The SDK is for *adding* agents. The
  planner/writer/reviewer set is part of the CLI, not a set of SDK slots.
- **Control over planning.** Your agent does not decide when it runs; the plan
  does. `validate()` can refuse a step, and that is the extent of your influence
  over dispatch.
- **Usage/cost reporting** from an individual call, or token-level streaming.
- **A stable serialization contract for `metadata`.** It is a
  `Record<string, unknown>` for your own bookkeeping.

---

## 9. Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `defineAgent: agentType "CodeFormatter" must be kebab-case` | Pass `agentType: 'code-formatter'`, or drop the option and let it derive from `name` |
| `defineAgent: could not instantiate X — …` | Your class constructor requires arguments. Agents are constructed with `new AgentClass()` |
| `defineAgent: agent 'X' must declare a non-empty \`description\`` | The planner reads it; an empty one produces a step nothing can match |
| `Orchestrator file not found at: …` | You are running outside a source checkout — see §7 |
| Agent compiles but a plan step never runs it | `agentType` in the plan ≠ the descriptor's. Print `agentDescriptor.agentType` and compare |
| `Cannot find module '@agent-nuvira/sdk/…'` | ESM-only package: use `module: "NodeNext"` and keep the `.js` extension on your own relative imports (the scaffolded tsconfig does both) |
| Tests pass locally, `assertAgentFailure` fails in CI | The mock LLM threw where you expected a returned failure. `runAgentTest` converts a throw into `{ success: false, error }` — assert on `error` |
| Custom agent loads but every call fails on a model id | SDK/CLI version mismatch. Compare `nuvira sdk info` with the CLI's `nuvira --version` — they ship on one version number |

---

## 10. Developing the SDK itself

The SDK source lives in `src/agent-sdk`; its tests live in the repository's root
suite under `tests/agent-sdk/`.

```bash
npm run build:sdk                 # tsc, emits src/agent-sdk/dist
npx vitest run tests/agent-sdk    # root suite
npm run examples:verify           # typecheck + test examples/sdk against source
```

Its tests are the record of what is actually guaranteed: `define.test.ts`
(the validation rules), `register.test.ts` (insertions, idempotency, safe
uninstall), `scaffold.test.ts` (every template, every file) and
`type-compatibility.test.ts` (the structural match against the orchestrator).

**Publishing** is automated on an `sdk-v*` tag
(`.github/workflows/publish-sdk.yml`): it builds, runs `tests/agent-sdk`, asserts
every path declared in `exports` resolves to a built file (a published package
with a missing entry point fails at the *consumer*), then publishes with an
idempotency guard. Manual path:

```bash
npm run build:sdk
cd src/agent-sdk && npm publish
```

## License

MIT
