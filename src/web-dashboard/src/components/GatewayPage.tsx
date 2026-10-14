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
import PageHeader from './PageHeader';

const PRESETS = [
  { label: '🌐 Gateway status', args: ['gateway', 'status'] },
  { label: '📮 Delivery ledger', args: ['gateway', 'delivery'] },
  // The console itself now runs commands to completion (0 = until finished or
  // cancelled), so this preset needs no override: a gateway is a server process
  // and the 5-minute task timeout used to SIGTERM it while the user believed it
  // was still running.
  { label: '▶️ Start gateway (foreground)', args: ['gateway', 'start', '--no-events'], timeoutMs: 0 },
  { label: '⏰ Cron jobs', args: ['admin', 'cron', 'list'] },
];

export default function GatewayPage() {
  return (
    <div className="panel">
      <PageHeader icon="🌐" title="Gateway ops — run buff gateway from the GUI" />

      <TaskConsole
        presets={PRESETS}
        customPlaceholder="e.g. admin cron run nightly or gateway alias add ops email:team@example.com"
        timeoutMs={0}
        hint={
          <>
            Each command runs as the real CLI in an isolated process (the P1 task runner) — the same engine as your
            terminal — and runs <strong>until it finishes or you press Cancel</strong> (no 5-minute cutoff). The elapsed
            time is shown beside the status, and work continues after you switch tabs (the process lives on the dashboard
            server, not the page). The delivery ledger also has its own view in{' '}
            <strong>Agent Hub → Channels</strong>.
          </>
        }
      />
    </div>
  );
}
