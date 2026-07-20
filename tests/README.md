# 🧪 Agent-Nuvira Test Suite

This directory contains the full test suite for Agent-Nuvira. The suite runs via [Vitest](https://vitest.dev/) and currently spans **50 test files** with **1,688 tests** (61s runtime).

---

## 📦 MCP (Model Context Protocol) Tests

The MCP test suite validates the Model Context Protocol integration — client connections, manager orchestration, tool discovery, and end-to-end subprocess communication. Three complementary test files provide layered coverage:

| File | Type | Tests | Approach | Runtime |
|---|---|---|---|---|
| `mcp-client.test.ts` | Unit (mocked) | **30** | Mocks `child_process.spawn` + `readline` — fast, deterministic | ~200ms |
| `mcp-manager.test.ts` | Unit (mocked) | **31** | Mocks `MCPClient` class — config discovery, connection pooling, tool management | ~150ms |
| `mcp-e2e.test.ts` | Integration (real I/O) | **7** | Spawns a real Node.js subprocess — full stdio JSON-RPC lifecycle | ~2s |
| **Total** | | **68** | | **~2.5s** |

### 1. `mcp-client.test.ts` — MCPClient (Unit Tests)

**File:** `tests/mcp/mcp-client.test.ts`  
**Source:** `src/mcp/client.ts`

Mocks `child_process.spawn` and `readline.createInterface` to test the MCP client's internal logic — JSON-RPC messaging, state machine, and lifecycle events — without spawning real subprocesses.

#### Key Design

- **Hoisted mock state** via `vi.hoisted()` to avoid temporal-dead-zone errors with module-level mock factories.
- **`connectWithMock(client)` helper** — steps through the 4-phase handshake (initialize → listTools → listResources → listPrompts) by deferring responses with `setTimeout(fn, 0)`, one macrotask per phase.
- **`respondLater(id, result)` helper** — sends deferred responses for post-connect requests (tool calls, resource reads, etc.).
- **`simulateResponse(id, result)`** — pushes a JSON-RPC response through the mocked `readline` `'line'` callback.

#### Test Groups (8)

| Group | Tests | Coverage |
|---|---|---|
| **Constructor & Basic Properties** | 3 | Name, timeout, initial state |
| **stdio Connection** | 5 | Handshake, missing command, no-op reconnect, disconnect + pending rejection, lifecycle events |
| **Tool Discovery & Invocation** | 6 | listTools, callTool, tools cache update, listResources, listPrompts, pre-connect rejection |
| **Timeout Handling** | 1 | 100ms timeout triggers rejection |
| **SSE Transport** | 2 | Unreachable endpoint, missing URL |
| **Edge Cases** | 3 | Safe disconnect before connect, multiple disconnect calls, empty pre-connect state |
| **JSON-RPC Error Responses** | 3 | `-32603` internal error, `-32601` method-not-found, `-32602` invalid-params (each with `.data`) |
| **Resource Access (readResource)** | 3 | Text resource, embedded resource, pre-connect rejection |
| **Prompt Access (getPrompt)** | 3 | By name, with arguments, pre-connect rejection |
| **Error Events** | 1 | `'error'` event fires on spawn failure |

### 2. `mcp-manager.test.ts` — MCPManager (Unit Tests)

**File:** `tests/mcp/mcp-manager.test.ts`  
**Source:** `src/mcp/manager.ts`

Mocks the `MCPClient` class (imported from `../../src/mcp/client.js`) to test the manager's orchestration logic — config discovery from the filesystem, connection pooling, and unified tool routing — without real subprocess I/O.

#### Key Design

- **MockMCPClient** — a lightweight class that tracks `connected`, `tools`, `serverInfo`, and `state`. Supports a `__FAIL__` sentinel via `config.command` for partial-failure testing.
- **`createTempConfigDir()`** — creates a real temp directory with `mkdtempSync` so `discoverConfigs()` can exercise real filesystem scanning. Cleaned up in `afterEach`.
- **`writeConfig(dir, filename, config)`** — writes JSON config files into the temp directory.

#### Test Groups (4)

| Group | Tests | Coverage |
|---|---|---|
| **Constructor & Config Directory** | 3 | Default dir, custom dir, nonexistent dir returns `[]` |
| **Config Discovery** | 5 | Single JSON, multiple JSONs, `config.json` in subdirectories, ignores non-JSON files, invalid JSON gracefully |
| **Connection Management** | 9 | Connect by name, reconnect reuse, unknown server throws, connectAll, partial failure (mixed success/failure), safe unknown disconnect, disconnect specific, disconnectAll, `isConnected` for unknown |
| **Tool Management** | 11 | getAllTools across servers, getAllStates, getClient (connected/disconnected/unknown), state tracking, callTool (no match → null, delegating, isError propagation, rejection propagation), getClient after unknown disconnect |
| **Singleton** | 3 | Same instance via `getMCPManager()`, reset creates new instance, reset with no singleton |

### 3. `mcp-e2e.test.ts` — End-to-End Integration Tests

**File:** `tests/mcp/mcp-e2e.test.ts`  
**Source:** `src/mcp/client.ts`

Unlike the unit tests, these tests **do not mock** `child_process.spawn` or `readline`. They create a real Node.js subprocess that speaks the MCP JSON-RPC protocol over stdio, exercising the full connection lifecycle with real I/O, pipes, and process management.

#### Key Design

- **Self-contained mock server** — the MCP server script is defined inline as a JavaScript string (`MOCK_SERVER_SCRIPT`) and written to a temp file in `beforeAll`, cleaned up in `afterAll`. No external dependencies.
- **Temp file isolation** — the script path uses `tmpdir()` + `Date.now()` to avoid collisions across parallel test runs.
- **Generous timeouts** — 15s per test (30s for the reconnect test) to accommodate real subprocess startup and communication.

#### The Mock Server Handles

| Method | Response |
|---|---|
| `initialize` | `serverInfo: { name: 'mock-test-server', version: '1.0.0' }`, `capabilities.tools.listChanged: true` |
| `tools/list` | 2 tools: `greet` (with `name` schema) and `echo` (with `text` schema) |
| `resources/list` | `[]` (empty) |
| `prompts/list` | `[]` (empty) |
| `tools/call` | Text response: `"Mock response for tool: <name>"` |

#### Tests (7)

| # | Test | What it Verifies |
|---|---|---|
| 1 | **Connects and completes handshake** | `connected === true`, `serverInfo.name === 'mock-test-server'`, `serverInfo.version === '1.0.0'` |
| 2 | **Discovers tools after connecting** | `client.tools.length === 2`, `greet` and `echo` tools with descriptions |
| 3 | **Calls greet tool** | `callTool('greet')` returns text content containing `'greet'`, no `isError` |
| 4 | **Calls echo tool** | `callTool('echo')` returns text content containing `'echo'` |
| 5 | **Refreshes tool list with listTools** | `listTools()` returns 2 tools, names match |
| 6 | **Disconnects cleanly and reconnects** | `disconnect()` → `connected === false`, `serverInfo === null`; new client reconnects successfully |
| 7 | **Rejects tool call after disconnect** | `callTool()` after disconnect throws `/Not connected/i` |

---

## 🚀 Running the Tests

### All Tests

```bash
npm test                      # Full suite (1,688 tests, ~61s)
npx vitest run                # Same as above
npx vitest run --reporter=verbose  # Full suite with per-test names
```

### MCP Tests Only

```bash
npx vitest run tests/mcp/                     # All 68 MCP tests (~2.5s)
npx vitest run tests/mcp/mcp-client.test.ts   # Client unit tests only
npx vitest run tests/mcp/mcp-manager.test.ts  # Manager unit tests only
npx vitest run tests/mcp/mcp-e2e.test.ts      # Integration tests only
```

### Test Flags

```bash
npx vitest run --reporter=verbose  # Show each test name
npx vitest run --reporter=json     # Machine-readable output
npx vitest --coverage              # Generate coverage report
npx vitest                          # Watch mode (re-runs on changes)
npx vitest tests/mcp/ --timeout=30000  # Override default 5s timeout (useful for E2E)
```

### CI Integration

Tests run in CI via GitHub Actions (`.github/workflows/test-linux.yml` and `test-windows.yml`). The `npm test` command is the single entry point:

```yaml
- run: npm ci
- run: npm test
```

The MCP unit tests (`mcp-client.test.ts`, `mcp-manager.test.ts`) run in all CI environments.  
The E2E tests (`mcp-e2e.test.ts`) are self-contained and also run in CI — they create their own mock server, requiring no external dependencies.

---

## 🧩 Adding New MCP Tests

### When to add to each file

| File | When to add | Example |
|---|---|---|
| `mcp-client.test.ts` | Testing client API methods, JSON-RPC edge cases, or transport behavior | New transport type, new method like `subscribe()`, new error code |
| `mcp-manager.test.ts` | Testing config discovery, connection pool logic, or tool routing | New discovery pattern, new manager method, new singleton behavior |
| `mcp-e2e.test.ts` | Testing real subprocess I/O, process lifecycle, or cross-platform behavior | New stdio edge case, pipe buffering, process signal handling |

### Mock Patterns

**Client tests** — use `connectWithMock(client)` for pre-connect setup, then `respondLater(id, result)` for post-connect requests. For error scenarios, use `lineCallbackRef.current(line)` directly.

**Manager tests** — use `writeConfig(dir, filename, config)` to seed config files, then `manager.connect(name)` / `manager.connectAll()`.

**E2E tests** — modify `MOCK_SERVER_SCRIPT` to add new handlers, or extend the inline server logic. Keep the script self-contained (no imports).
