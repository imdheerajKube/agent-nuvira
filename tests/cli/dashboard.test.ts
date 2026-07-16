/**
 * DashboardCommand — Unit tests for the CLI dashboard command.
 *
 * Tests cover:
 * 1. Default behavior (port 3030, host 127.0.0.1, browser opens on macOS)
 * 2. --build flag (calls execSync with npm run build:dashboard)
 * 3. Build failure (logs error, no server start)
 * 4. --port flag (custom port)
 * 5. --host flag (custom host)
 * 6. --no-open flag (browser NOT opened)
 * 7. Combined flags (--build --port 9090 --host 0.0.0.0 --no-open)
 * 8. Platform-specific browser commands (darwin/win32/linux)
 * 9. Browser open failure (spawn throws → logger.warn)
 * 10. Server creation failure → logger.error with hint
 * 11. Commander option registration
 *
 * Uses the same mock patterns as model-picker.test.ts (vi.hoisted, vi.mock).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ─── Hoisted mocks (instantiated before vi.mock is hoisted) ────────────────

const mockCreateDashboardServer = vi.hoisted(() =>
  vi.fn(() => ({
    server: { close: vi.fn() },
  })),
);

const mockExecSync = vi.hoisted(() => vi.fn(() => Buffer.from('')));
const mockSpawn = vi.hoisted(() => vi.fn(() => ({ unref: vi.fn() })));

const mockLogger = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  success: vi.fn(),
  warn: vi.fn(),
  highlight: vi.fn(),
}));

// ─── Module-level mocks (hoisted by vitest) ─────────────────────────────────

vi.mock('node:child_process', () => ({
  execSync: mockExecSync,
  spawn: mockSpawn,
}));

vi.mock('../../src/web-dashboard/server.js', () => ({
  createDashboardServer: mockCreateDashboardServer,
}));

vi.mock('../../src/utils/logger.js', () => ({
  logger: mockLogger,
}));

// ─── Test helper ────────────────────────────────────────────────────────────

/**
 * Execute a dashboard action test.
 *
 * The launchDashboard method blocks on `await new Promise<void>` until SIGINT.
 * This helper:
 * 1. Starts launchDashboard (which awaits on the promise)
 * 2. Yields to the event loop so the sync setup code runs (env, server, browser)
 * 3. Emits SIGINT to trigger shutdown → resolves the internal promise
 * 4. Awaits launchDashboard to complete
 * 5. Returns control to the test for assertions
 *
 * This avoids race conditions with auto-triggering mocks because we control
 * exactly when SIGINT fires — after the setup has run but before the test
 * assertions or afterEach cleanup.
 */
async function runDashboard(
  cmd: import('../../src/cli/dashboard.js').DashboardCommand,
  options: Record<string, unknown> = {},
): Promise<void> {
  const launchPromise = (cmd as any).launchDashboard(options);

  // Yield to let the sync setup run (env vars, server creation, browser open)
  await new Promise<void>((resolve) => setImmediate(resolve));

  // Trigger shutdown to resolve the internal promise
  process.emit('SIGINT');

  // Wait for launchDashboard to fully complete
  await launchPromise;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('DashboardCommand', () => {
  let cmd: import('../../src/cli/dashboard.js').DashboardCommand;
  let processExitSpy: ReturnType<typeof vi.spyOn>;
  let originalPlatform: string | undefined;

  beforeEach(async () => {
    vi.clearAllMocks();

    // Prevent process.exit from killing the test runner
    processExitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as any);

    // Suppress incidental console noise
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    // Stash the real platform so we can restore after each test
    originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });

    const { DashboardCommand } = await import('../../src/cli/dashboard.js');
    cmd = new DashboardCommand();
  });

  afterEach(() => {
    // Remove leftover SIGINT/SIGTERM listeners that persist from launchDashboard's
    // process.on('SIGINT', shutdown) registration. Without this, old handlers can
    // double-fire during the next test's process.emit('SIGINT') in runDashboard.
    process.removeAllListeners('SIGINT');
    process.removeAllListeners('SIGTERM');

    vi.restoreAllMocks();
    Object.defineProperty(process, 'platform', { value: originalPlatform!, configurable: true });
    delete process.env.BUFF_DASHBOARD_PORT;
    delete process.env.BUFF_DASHBOARD_HOST;
  });

  // ── Default behavior ───────────────────────────────────────────────────

  it('should use default port 3030 and host 127.0.0.1 when no options provided', async () => {
    await runDashboard(cmd, {});

    expect(process.env.BUFF_DASHBOARD_PORT).toBe('3030');
    expect(process.env.BUFF_DASHBOARD_HOST).toBe('127.0.0.1');
    expect(mockCreateDashboardServer).toHaveBeenCalledOnce();
  });

  it('should auto-open the browser by default on macOS', async () => {
    await runDashboard(cmd, {});

    expect(mockSpawn).toHaveBeenCalledWith(
      'open',
      ['http://localhost:3030'],
      expect.objectContaining({ stdio: 'ignore', detached: true }),
    );
    expect(mockSpawn).toHaveBeenCalledOnce();
  });

  it('should log the success message and dashboard URL', async () => {
    await runDashboard(cmd, {});

    expect(mockLogger.success).toHaveBeenCalledWith(expect.stringContaining('http://localhost:3030'));
  });

  // ── --build flag ──────────────────────────────────────────────────────

  it('should call execSync with build command when --build is set', async () => {
    await runDashboard(cmd, { build: true });

    expect(mockExecSync).toHaveBeenCalledWith(
      'npm run build:dashboard',
      expect.objectContaining({
        cwd: expect.any(String),
        stdio: 'inherit',
        timeout: 120_000,
      }),
    );
    expect(mockLogger.success).toHaveBeenCalledWith(expect.stringContaining('Dashboard built'));
  });

  it('should not call execSync when --build is not set', async () => {
    await runDashboard(cmd, {});

    expect(mockExecSync).not.toHaveBeenCalled();
  });

  // ── Build failure ─────────────────────────────────────────────────────

  it('should log an error and abort when build fails', async () => {
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('npm ERR! build failed');
    });

    // launchDashboard returns early (via return; in catch block), no blocking await
    await (cmd as any).launchDashboard({ build: true });

    expect(mockLogger.error).toHaveBeenCalledWith(expect.stringContaining('npm ERR! build failed'));
    expect(mockCreateDashboardServer).not.toHaveBeenCalled();
    expect(process.env.BUFF_DASHBOARD_PORT).toBeUndefined();
    expect(process.env.BUFF_DASHBOARD_HOST).toBeUndefined();
  });

  // ── --port flag ───────────────────────────────────────────────────────

  it('should use custom port when --port is provided', async () => {
    await runDashboard(cmd, { port: 8080 });

    expect(process.env.BUFF_DASHBOARD_PORT).toBe('8080');
    expect(mockLogger.success).toHaveBeenCalledWith(expect.stringContaining('http://localhost:8080'));
  });

  // ── --host flag ───────────────────────────────────────────────────────

  it('should use custom host when --host is provided', async () => {
    await runDashboard(cmd, { host: '0.0.0.0' });

    expect(process.env.BUFF_DASHBOARD_HOST).toBe('0.0.0.0');
  });

  it('should fall back to 127.0.0.1 when host is empty string', async () => {
    await runDashboard(cmd, { host: '' });

    expect(process.env.BUFF_DASHBOARD_HOST).toBe('127.0.0.1');
  });

  // ── --no-open flag ────────────────────────────────────────────────────

  it('should NOT open browser when --no-open is set', async () => {
    await runDashboard(cmd, { open: false });

    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('should open browser when open is explicitly true', async () => {
    await runDashboard(cmd, { open: true });

    expect(mockSpawn).toHaveBeenCalledOnce();
  });

  // ── Combined flags ────────────────────────────────────────────────────

  it('should handle --build --port 9090 --host 0.0.0.0 --no-open together', async () => {
    await runDashboard(cmd, {
      build: true,
      port: 9090,
      host: '0.0.0.0',
      open: false,
    });

    expect(mockExecSync).toHaveBeenCalledWith('npm run build:dashboard', expect.any(Object));
    expect(process.env.BUFF_DASHBOARD_PORT).toBe('9090');
    expect(process.env.BUFF_DASHBOARD_HOST).toBe('0.0.0.0');
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(mockCreateDashboardServer).toHaveBeenCalledOnce();
  });

  // ── Platform-specific browser commands ────────────────────────────────

  it('should use open on macOS (darwin)', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    await runDashboard(cmd, {});

    expect(mockSpawn).toHaveBeenCalledWith('open', expect.any(Array), expect.any(Object));
  });

  it('should use xdg-open on Linux', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    const { DashboardCommand } = await import('../../src/cli/dashboard.js');
    const linuxCmd = new DashboardCommand();

    await runDashboard(linuxCmd, {});

    expect(mockSpawn).toHaveBeenCalledWith('xdg-open', expect.any(Array), expect.any(Object));
  });

  it('should use start on Windows (win32)', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    const { DashboardCommand } = await import('../../src/cli/dashboard.js');
    const winCmd = new DashboardCommand();

    await runDashboard(winCmd, {});

    expect(mockSpawn).toHaveBeenCalledWith('start', expect.any(Array), expect.any(Object));
  });

  // ── Browser open failure ──────────────────────────────────────────────

  it('should log a warning when browser spawn fails', async () => {
    mockSpawn.mockImplementationOnce(() => {
      throw new Error('ENOENT: browser not found');
    });

    await runDashboard(cmd, {});

    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Could not auto-open browser'),
    );
    expect(mockCreateDashboardServer).toHaveBeenCalledOnce();
  });

  // ── Server creation failure ───────────────────────────────────────────

  it('should log error and hint when createDashboardServer throws', async () => {
    mockCreateDashboardServer.mockImplementationOnce(() => {
      throw new Error('Module not found');
    });

    await runDashboard(cmd, {});

    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.stringContaining('Failed to start dashboard'),
    );
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.stringContaining('dashboard module is available'),
    );
  });

  // ── Commander action wiring ───────────────────────────────────────────

  it('should register the correct command with commander', async () => {
    const command = cmd.create();

    expect(command.name()).toBe('dashboard');
    expect(command.description()).toContain('web-based dashboard');

    const opts = command.options;
    expect(opts.find((o) => o.long === '--port')).toBeTruthy();
    expect(opts.find((o) => o.long === '--host')).toBeTruthy();
    expect(opts.find((o) => o.long === '--no-open')).toBeTruthy();
    expect(opts.find((o) => o.long === '--build')).toBeTruthy();
  });

  // ── Edge case: SIGTERM (not just SIGINT) ──────────────────────────────

  it('should also handle SIGTERM shutdown', async () => {
    const launchPromise = (cmd as any).launchDashboard({});
    await new Promise<void>((resolve) => setImmediate(resolve));

    process.emit('SIGTERM');

    await launchPromise;
    // Should not throw — the shutdown handler works for both SIGINT and SIGTERM
    expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining('Shutting down'));
  });
});
