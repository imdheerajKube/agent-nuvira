/**
 * GatewayPage — gateway ops in the GUI (GUI parity with `buff gateway`).
 *
 * Status, delivery ledger, foreground start, and cron management run the REAL
 * CLI commands through the shared TaskConsole (isolated child process + live
 * SSE console + cancel). Note: `gateway start` runs in the foreground — it
 * streams platform events until you cancel it (the console's Cancel button
 * SIGTERMs the process).
 */

import TaskConsole from './TaskConsole';

const PRESETS = [
  { label: '🌐 Gateway status', args: ['gateway', 'status'] },
  { label: '📮 Delivery ledger', args: ['gateway', 'delivery'] },
  // timeoutMs: 0 = run forever. A gateway is a server process — the default
  // 5-minute task timeout used to SIGTERM it while the user believed it was
  // still running.
  { label: '▶️ Start gateway (foreground)', args: ['gateway', 'start', '--no-events'], timeoutMs: 0 },
  { label: '⏰ Cron jobs', args: ['admin', 'cron', 'list'] },
];

export default function GatewayPage() {
  return (
    <div className="panel">
      <div className="panel-header">
        <h2>🌐 Gateway ops — run buff gateway from the GUI</h2>
      </div>

      <TaskConsole
        presets={PRESETS}
        customPlaceholder="e.g. admin cron run nightly or gateway alias add ops email:team@example.com"
        timeoutMs={300_000}
        hint={
          <>
            Each command runs as the real CLI in an isolated process (the P1 task runner) — the same engine as your
            terminal. <code>gateway start</code> runs in the foreground <strong>with no timeout</strong>: it keeps running
            even after you switch tabs (the process lives on the dashboard server, not the page) and streams platform
            events until you press <strong>Cancel</strong>. The delivery ledger also has its own view in{' '}
            <strong>Agent Hub → Channels</strong>.
          </>
        }
      />
    </div>
  );
}
