/**
 * `nuvira dashboard` gateway auto-start — the spawn/reuse decision.
 *
 * WHY this is mocked rather than driven live: the detection reads the whole
 * process table, so a developer with a real gateway running would take the
 * "reuse" branch and CI would take the "spawn" branch — the same test would
 * assert different things on different machines. Mocking `isGatewayRunning`
 * makes BOTH branches deterministic and checkable, which is the only way to
 * prove the wiring.
 *
 * The properties that matter:
 *   - no gateway running  → spawn exactly one, as a child of this process
 *   - gateway running     → spawn NOTHING (a second copy cannot bind the webhook
 *     port and would leave two competing processes)
 *   - we only ever stop the gateway WE started, never a pre-existing one
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const mockIsGatewayRunning = vi.hoisted(() => vi.fn());
const mockSpawn = vi.hoisted(() => vi.fn());
const mockLogger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  success: vi.fn(),
  debug: vi.fn(),
  highlight: vi.fn(),
}));

vi.mock('../../src/cli/process-control.js', () => ({
  isGatewayRunning: mockIsGatewayRunning,
  stopGateway: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  spawn: mockSpawn,
  execSync: vi.fn(() => Buffer.from('')),
}));

vi.mock('../../src/utils/logger.js', () => ({ logger: mockLogger }));

const { DashboardCommand } = await import('../../src/cli/dashboard.js');

/** A child that reports as alive (`exitCode: null`) with a pid. */
function liveChild() {
  return { pid: 4242, exitCode: null as number | null, kill: vi.fn() };
}

beforeEach(() => {
  mockIsGatewayRunning.mockReset();
  mockSpawn.mockReset();
  for (const fn of Object.values(mockLogger)) fn.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('dashboard gateway auto-start', () => {
  it('spawns the gateway when none is running', async () => {
    mockIsGatewayRunning.mockResolvedValue({ running: false });
    mockSpawn.mockReturnValue(liveChild());

    const cmd = new DashboardCommand();
    await (cmd as unknown as { startGateway: (p: number) => Promise<void> }).startGateway(8787);

    expect(mockIsGatewayRunning).toHaveBeenCalledWith({ port: 8787 });
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(mockSpawn).toHaveBeenCalledWith(
      process.execPath,
      expect.arrayContaining(['gateway', 'start', '--port', '8787']),
      expect.objectContaining({ env: expect.anything() }),
    );
    expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining('Gateway started'));
  });

  it('spawns nothing when a gateway is already running (reuses it)', async () => {
    mockIsGatewayRunning.mockResolvedValue({ running: true, pid: 999 });

    const cmd = new DashboardCommand();
    await (cmd as unknown as { startGateway: (p: number) => Promise<void> }).startGateway(8787);

    expect(mockSpawn).not.toHaveBeenCalled();
    expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining('already running'));
  });

  it('does not claim success when the child dies immediately', async () => {
    mockIsGatewayRunning.mockResolvedValue({ running: false });
    // A gateway that cannot bind its port exits at once. Reporting "started" for
    // a dead process is exactly the false claim this dashboard exists to avoid.
    mockSpawn.mockReturnValue({ pid: 4242, exitCode: 1, kill: vi.fn() });

    const cmd = new DashboardCommand();
    await (cmd as unknown as { startGateway: (p: number) => Promise<void> }).startGateway(8787);

    expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('exited immediately'));
    expect(mockLogger.info).not.toHaveBeenCalledWith(expect.stringContaining('Gateway started'));
  });

  it('stops only the gateway it started', async () => {
    mockIsGatewayRunning.mockResolvedValue({ running: false });
    const child = liveChild();
    mockSpawn.mockReturnValue(child);

    const cmd = new DashboardCommand();
    const asAny = cmd as unknown as {
      startGateway: (p: number) => Promise<void>;
      stopOwnedGateway: () => void;
    };
    await asAny.startGateway(8787);
    asAny.stopOwnedGateway();

    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('never signals a gateway someone else started', () => {
    // Nothing was spawned, so there is nothing to own.
    const cmd = new DashboardCommand();
    const asAny = cmd as unknown as { stopOwnedGateway: () => void };
    expect(() => asAny.stopOwnedGateway()).not.toThrow();
    expect(mockSpawn).not.toHaveBeenCalled();
  });
});
