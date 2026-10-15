/**
 * Runtime Tools — the software the agent uses but does not ship.
 *
 * WHY THIS PANEL EXISTS. `nuvira doctor` has always been able to say "ffmpeg is
 * not installed", and the System page already lists those rows as checks. What
 * neither did was put the user in a position to ACT: the command for THEIR
 * machine, whether the tool is recommended or merely optional, what it unlocks,
 * and the caveat that actually bites (macOS needs `ffmpeg-full`, not `ffmpeg`,
 * or burned captions silently fall back to a `.srt`).
 *
 * So this renders one row per tool with a copy button, and it is deliberately
 * NOT a second source of truth: the payload comes from
 * `learning/runtime-dependencies.ts` — the same declaration `nuvira doctor`,
 * `nuvira doctor --fix` and the one-command setup scripts read — so the page
 * cannot recommend a command the CLI would not run.
 *
 * WHAT IT REFUSES TO DO. A missing tool is not an error: the agent degrades and
 * says which capability it skipped, so the row reads as "not installed", not as
 * a failure, and nothing here is red. A tool with no one-line installer on this
 * OS says so and points at DEPENDENCIES.md instead of inventing a command. And a
 * server too old to report the list gets its own sentence rather than an empty
 * panel that reads as "everything is installed".
 */

import { useState } from 'react';
import type { RuntimeTool } from '../types';

/**
 * Copy-to-clipboard button — the pattern the markdown blocks and chat cards use,
 * with one correction: it reports "Copied" only when a clipboard actually wrote.
 * `navigator.clipboard?.writeText` resolves to `undefined` where the API is
 * absent (a non-secure context, jsdom), which is not a copy — claiming one would
 * be the exact kind of quiet lie this panel is written against.
 */
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    const clipboard = navigator.clipboard;
    if (!clipboard?.writeText) return; // no clipboard here — claim nothing
    try {
      await clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* permission denied — claim nothing */
    }
  };
  return (
    <button
      type="button"
      className="admin-refresh-btn"
      title="Copy this install command"
      onClick={() => void copy()}
      data-testid={`copy-${text.slice(0, 12)}`}
    >
      {copied ? '✓ Copied' : '⧉ Copy'}
    </button>
  );
}

export default function RuntimeToolsPanel({
  tools,
  summary,
}: {
  tools: RuntimeTool[] | undefined;
  summary: string | undefined;
}) {
  // A server that does not report the list is stated, not rendered as empty:
  // an empty panel would read as "nothing is missing", which is the opposite of
  // "we did not ask".
  if (!tools) {
    return (
      <section style={{ marginBottom: 18 }} data-testid="runtime-tools">
        <h2 className="section-subtitle">Runtime Tools</h2>
        <p style={{ fontSize: 11, color: 'var(--text-secondary)', margin: '4px 0 10px' }}>
          This dashboard server did not report the runtime tools — restart it (<code>nuvira dashboard stop</code>,
          then start it again) and reload this page.
        </p>
      </section>
    );
  }

  const missing = tools.filter((t) => !t.present);
  const recommendedMissing = missing.filter((t) => t.need === 'recommended');
  const installed = tools.length - missing.length;

  return (
    <section style={{ marginBottom: 18 }} data-testid="runtime-tools">
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
        <h2 className="section-subtitle" style={{ margin: 0 }}>
          Runtime Tools
        </h2>
        <span
          style={{
            fontSize: 12,
            color: missing.length === 0 ? 'var(--accent-green)' : 'var(--text-secondary)',
          }}
          data-testid="runtime-tools-summary"
        >
          {summary ?? `${installed} of ${tools.length} installed`}
        </span>
      </div>
      <p style={{ fontSize: 11, color: 'var(--text-secondary)', margin: '4px 0 10px' }}>
        Software the agent uses but does not ship. A missing one is not a fault — the feature that needs it reports
        itself as skipped — and the command below is the one for the machine this dashboard is running on. The whole
        list, with manual steps, is in <code>docs/DEPENDENCIES.md</code>.
      </p>

      {tools.map((tool) => (
        <div
          key={tool.id}
          className="admin-check-row"
          data-status={tool.present ? 'pass' : 'warn'}
          data-testid={`runtime-tool-${tool.id}`}
        >
          <span className={`admin-check-badge admin-check-${tool.present ? 'pass' : 'warn'}`}>
            {tool.present ? '✅ INSTALLED' : '⚠️ NOT INSTALLED'}
          </span>
          <div className="admin-check-body">
            <div className="admin-check-name">
              {tool.label}{' '}
              <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
                {tool.need === 'recommended' ? '· recommended' : '· optional'}
              </span>
            </div>
            <div className="admin-check-message">{tool.enables}</div>
            {tool.present ? (
              <div className="admin-check-detail">Needed by: {tool.neededBy.join(', ')}</div>
            ) : (
              <div className="admin-check-fix" data-testid={`install-${tool.id}`}>
                {tool.installCommand ? (
                  <>
                    💡 Install:{' '}
                    <code>{tool.installCommand}</code> <CopyButton text={tool.installCommand} />
                    {tool.needsHumanInput ? (
                      <div style={{ marginTop: 4 }}>
                        Needs your password or a GUI installer — run it yourself; <code>nuvira doctor --fix</code> will
                        print it for you rather than driving it.
                      </div>
                    ) : (
                      <div style={{ marginTop: 4 }}>
                        Or let the agent do it: <code>nuvira doctor --fix</code>
                      </div>
                    )}
                  </>
                ) : (
                  <>💡 No one-line installer on this OS — see docs/DEPENDENCIES.md</>
                )}
                {tool.note ? <div style={{ marginTop: 4 }}>ℹ️ {tool.note}</div> : null}
              </div>
            )}
          </div>
        </div>
      ))}

      {recommendedMissing.length > 0 ? (
        <p style={{ fontSize: 11, color: 'var(--text-secondary)', margin: '8px 0 0' }} data-testid="runtime-tools-hint">
          {recommendedMissing.length} recommended tool{recommendedMissing.length === 1 ? '' : 's'} missing:{' '}
          {recommendedMissing.map((t) => t.label).join(', ')}. <code>nuvira doctor --fix</code> installs them all,
          asking before each one.
        </p>
      ) : null}
    </section>
  );
}
