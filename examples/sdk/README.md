# Example: a custom agent with `@agent-nuvira/sdk`

A complete, runnable example of building a custom agent for Agent-Nuvira.

`ConventionalCommitAgent` drafts a [Conventional Commits](https://www.conventionalcommits.org)
message from a change description or a diff. It demonstrates the full agent
contract: a `validate()` precondition, an `execute()` that calls the injected
LLM, and result validation so bad model output is reported rather than silently
accepted.

## Layout

```
examples/sdk/
├── src/
│   ├── conventional-commit.ts   # the agent + its descriptor (defineAgent)
│   └── index.ts                 # package entry point
├── tests/
│   └── conventional-commit.test.ts
├── package.json
├── tsconfig.json                # standalone build config
├── tsconfig.verify.json         # in-repo config (resolves the SDK from source)
└── vitest.config.ts             # in-repo test config (SDK aliased to source)
```

## Use it

```bash
cd examples/sdk
npm install
npm run build
npm test
```

Then register the built agent with your Agent-Nuvira install:

```bash
cp dist/conventional-commit.js ~/.nuvira/agents/conventional-commit.js
nuvira plugins list
```

## Try it from the repo

The example is exercised by the project's own test suite and by CI — no install
required (the SDK specifier is aliased to the local source):

```bash
# from the repository root
npm run examples:verify
```

## The key ideas

- **Extend `Agent`** and implement `execute(context, callLLM)`. The orchestrator
  supplies the context and the LLM function, so the agent never chooses a
  provider itself.
- **Declare a descriptor with `defineAgent({ AgentClass })`.** It reads
  `name`/`description` from the class and derives `agentType: 'conventional-commit'`,
  validating it at definition time.
- **Assert preconditions in `validate()`** — returning a string refuses the run
  with that message.
- **Test with `@agent-nuvira/sdk/testing`** — `createMockContext`, `createMockLLM`,
  `runAgentTest`, `assertAgentSuccess` / `assertAgentFailure`.

See [`@agent-nuvira/sdk`](../../src/agent-sdk/README.md) for the full API.

## License

MIT
