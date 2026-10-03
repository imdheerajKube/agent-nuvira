# Contributing to Agent-Nuvira

**Welcome!** Agent-Nuvira is an open-source (MIT), multi-agent AI coding assistant built by a solo developer. Contributions of all kinds are welcome — code, docs, plugins, workflows, bug reports, and feature requests.

---

## Quick Reference — Docs Map

| Category | Document | Purpose |
|---|---|---|
| **🎯 Strategy** | [PRODUCT_STRATEGY.md](./PRODUCT_STRATEGY.md) | Product thesis, competitive landscape, positioning map, OKR framework, risk register |
| **🏗️ Architecture** | [ARCHITECTURE.md](./ARCHITECTURE.md), [ARCHITECTURE_DIAGRAMS.md](./ARCHITECTURE_DIAGRAMS.md) | Modular execution engine design — 7 module specs, extensibility system, observability bus, migration plan + Mermaid visual diagrams |
| **📊 Pitch** | [PITCH_DECK.md](./PITCH_DECK.md) | 10-slide investor/stakeholder presentation outline with talking points |
| **📘 Product Guide** | [Product_Guide.md](./Product_Guide.md) | Comprehensive technical overview — architecture, features, version history, market readiness |
| **📖 User Manual** | [User_Manual.md](./User_Manual.md) | End-user documentation — installation, commands, workflows, troubleshooting |
| **🚀 README** | [README.md](./README.md) | Quick start, features, configuration, CLI commands, multi-agent orchestration, development |
| **🛣️ Roadmap** | [UPGRADE_ROADMAP.md](./UPGRADE_ROADMAP.md) | Full implementation journey — 30 phased features with status |
| **📋 Changelog** | [CHANGELOG.md](./CHANGELOG.md) | Version history (v1.0.0 → v1.17.0), organized by Keep a Changelog format |
| **🔧 SDK** | [`docs/AGENT_SDK.md`](./docs/AGENT_SDK.md) | `@agent-nuvira/sdk` — build, test and register custom agents: install, full agent contract, the ten testing helpers, scaffolding, and what depth the SDK offers |
| **💻 VS Code Extension** | [`docs/VSCODE_EXTENSION.md`](./docs/VSCODE_EXTENSION.md) | The editor surface — all 13 commands mapped to the CLI verb they run, settings, keybindings, the three language-model tools, the programmatic API, and what depth it offers |
| **🧪 Tests** | [`tests/README.md`](./tests/README.md) | Test suite overview — 1,830+ tests across 55 files, organized by module |
| **📋 Capability Ledger** | [`docs/CAPABILITY_LEDGER.md`](./docs/CAPABILITY_LEDGER.md) | Honest status of every capability — real, partial, approximation, or not built — with the evidence for each |
| **📦 SDK package README** | [`src/agent-sdk/README.md`](./src/agent-sdk/README.md) | The npm package landing page for `@agent-nuvira/sdk` (the fuller guide is `docs/AGENT_SDK.md` above) |
| **🔌 MCP Examples** | [`examples/mcp/README.md`](./examples/mcp/README.md) | MCP server configuration examples (filesystem, GitHub, Exa) |

---

## Development Setup

```bash
# Clone and install
git clone https://github.com/imdheerajKube/agent-nuvira.git
cd agent-nuvira
npm install

# Build TypeScript
npm run build

# Development mode (fast rebuild with tsx)
npm run dev
```

**Prerequisites:** Node.js 20+, npm

---

## Testing

```bash
# Run all tests (1,830+)
npm test

# Watch mode
npm run test:watch

# With coverage
npm run test:coverage

# Type-check only
npx tsc --noEmit
```

**Test structure:** Tests mirror `src/` structure under `tests/`. Each module has a corresponding test file using Vitest 4.1. We maintain **zero flaky tests** — every test must be deterministic and reliable.

---

## Contribution Workflow

1. **Fork the repo** and create a branch from `main`
2. **Make your changes** following existing code conventions (TypeScript strict mode)
3. **Add tests** for new functionality — match the existing test patterns
4. **Run the full test suite** — `npm test` must pass with zero failures
5. **Run the regression gate** — `bash scripts/ci/regression-gate.sh` must pass
   with zero failures (routing guard + failover E2E + full root + dashboard
   suites). It is the canonical no-regression guard for the routing/learning
   subsystem; any failure is a regression that must be fixed before merge
5. **Run type-check** — `npx tsc --noEmit` must pass
6. **Submit a PR** with a clear description of the change

### Commit Messages

We follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add provider fallback circuit breaker
fix: handle Windows path separator in sandbox
docs: update architecture diagram with MCP agent
test: add skill compiler parameter resolution tests
chore: bump version to v1.17.0
```

---

## Adding or changing a CLI command — the central registry

The CLI surface has ONE source of truth and two derived artifacts. When you add,
rename, or change a command, keep all three in step:

| Artifact | Role |
|---|---|
| `src/cli/cli-program.ts` (`createCLI`) | **Source of truth** — every command class is registered here |
| `docs/COMMANDS_SURFACE.md` | **Generated** from the live command tree — the authoritative list of what EXISTS |
| `src/web-dashboard/src/generated/commands.json` | **Generated** — the dashboard Command Console picker catalogue (bundled) |
| `docs/COMMANDS.md` | **Curated prose** — objective + command + copy-pasteable example per entry (hand-maintained) |

The generator emits BOTH the surface doc and the dashboard catalogue from one
traversal, so they cannot disagree. After adding a command (and a class in
`src/cli/` that extends `BaseCommand`, registered in `cli-program.ts`):

```bash
npm run build:cli          # the generator imports the BUILT dist/cli/cli-program.js
npm run docs:commands      # regenerate COMMANDS_SURFACE.md + commands.json
# then hand-update docs/COMMANDS.md (objective + example), and add its row to the appendix
npm run docs:commands:check   # CI drift guard: exit 1 if the surface or catalogue is stale
npm run build:dashboard       # rebuild the bundle so the picker picks up the new catalogue
node scripts/verify-commands.mjs   # every surface command must actually resolve (`--help`)
```

`tests/docs/commands-surface.test.ts` enforces both: the generated surface must
match the live tree, and every command must appear somewhere in the curated
`docs/COMMANDS.md`. Forgetting the curated doc is a test failure, not a silent
drift.

---

## Changing the provider wire — the golden fixture guard

Every other test asserts on a RESPONSE (what the engine did). The provider wire
is the one contract that is asserted on the REQUEST — the exact bytes the core
loop puts on the provider wire: message ordering, `tool_calls` / `tool`-result
serialization, tool schemas, model/temperature/max_tokens. Nothing else catches a
change to that shape, which is why it is pinned in golden fixtures under
`tests/fixtures/provider-wire/`.

The capture runs the REAL loop against the REAL adapter pointed at a loopback
recorder — no network, no model, no test seam in production code. When a wire
change is INTENDED:

```bash
npm run build:cli            # the check imports the built module
npm run docs:wire:update     # rewrite the golden fixtures
git diff tests/fixtures/provider-wire/   # review the diff — this review IS the guard
```

`npm run docs:wire:check` (run in CI) fails with the exact JSON path that drifted
(e.g. `$[0].messages[2].tool_calls[0].function.name`).

---

## What to Contribute

| Area | Ideas | Skill Level |
|---|---|---|
| **New provider adapters** | OpenAI, Anthropic, Mistral, Cohere, etc. | Intermediate |
| **Plugin ecosystem** | Custom agents as plugins | Intermediate |
| **Workflow templates** | Reusable YAML templates for common tasks | Beginner |
| **Documentation** | Fix typos, add examples, improve clarity | Beginner |
| **Bug fixes** | Browse [GitHub Issues](https://github.com/imdheerajKube/agent-nuvira/issues) | Any |
| **Test coverage** | Add tests for untested modules | Beginner |
| **VS Code extension** | New commands, improved UX | Intermediate |
| **Dashboard widgets** | New React components for the web dashboard | Intermediate |

---

## Questions?

- **GitHub Issues:** [github.com/imdheerajKube/agent-nuvira/issues](https://github.com/imdheerajKube/agent-nuvira/issues)
- **Discussions:** [github.com/imdheerajKube/agent-nuvira/discussions](https://github.com/imdheerajKube/agent-nuvira/discussions)
- **npm:** [npmjs.com/package/agent-nuvira](https://npmjs.com/package/agent-nuvira)

---

## License

MIT — see [LICENSE](./LICENSE). By contributing, you agree that your contributions will be licensed under the MIT license.
