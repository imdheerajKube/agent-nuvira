# Contributing to Agent-Nuvira

**Welcome!** Agent-Nuvira is an open-source (MIT), multi-agent AI coding assistant built by a solo developer. Contributions of all kinds are welcome — code, docs, plugins, workflows, bug reports, and feature requests.

---

## Quick Reference — Docs Map

| Category | Document | Purpose |
|---|---|---|
| **🎯 Strategy** | [PRODUCT_STRATEGY.md](./PRODUCT_STRATEGY.md) | Product thesis, competitive landscape, positioning map, OKR framework, risk register |
| **📊 Pitch** | [PITCH_DECK.md](./PITCH_DECK.md) | 10-slide investor/stakeholder presentation outline with talking points |
| **📘 Product Guide** | [Product_Guide.md](./Product_Guide.md) | Comprehensive technical overview — architecture, features, version history, market readiness |
| **📖 User Manual** | [User_Manual.md](./User_Manual.md) | End-user documentation — installation, commands, workflows, troubleshooting |
| **🚀 README** | [README.md](./README.md) | Quick start, features, configuration, CLI commands, multi-agent orchestration, development |
| **🛣️ Roadmap** | [UPGRADE_ROADMAP.md](./UPGRADE_ROADMAP.md) | Full implementation journey — 30 phased features with status |
| **📋 Changelog** | [CHANGELOG.md](./CHANGELOG.md) | Version history (v1.0.0 → v1.17.0), organized by Keep a Changelog format |
| **🔧 SDK** | [`src/agent-sdk/README.md`](./src/agent-sdk/README.md) | `@agent-nuvira/sdk` — build custom agents with scaffolding CLI |
| **💻 VS Code Extension** | [`vscode-extension/README.md`](./vscode-extension/README.md) | VS Code extension — 9 commands, inline suggestions, diff viewer, agent panel |
| **🧪 Tests** | [`tests/README.md`](./tests/README.md) | Test suite overview — 1,830+ tests across 55 files, organized by module |
| **📦 Published SDK** | [`packages/sdk/README.md`](./packages/sdk/README.md) | Published `@agent-nuvira/sdk` npm package documentation |
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
