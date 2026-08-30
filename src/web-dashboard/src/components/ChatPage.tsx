/**
 * ChatPage — P3 dashboard chat console (GUI parity with `buff chat "<prompt>"`).
 *
 * Each message runs ONE tool-loop turn through the real agent engine in the
 * dashboard process (ChatCommand.answerOnce — the exact engine behind the
 * CLI's single-shot chat), with the conversation threaded server-side per
 * session. The reply comes back as data, and the model's suggested follow-ups
 * render as clickable chips that send their prompt as the next message.
 *
 * Chat executes the agent, so the page is gated behind the same admin session
 * + routing.operate as the other action surfaces.
 *
 * P8 — smart-rail history + real composer: the sessions sidebar collapses to
 * a rail while the agent works (results own the full window), and the
 * composer accepts file / paste / drag-drop attachments that ride into the
 * turn as [Attachment: <name>] context.
 */

// P8 — attachment caps (composer). Files are read client-side and travel
// inline; pasted text beyond the threshold is offered as an attachment so the
// input box stays a message box, not a document.
const MAX_ATTACHMENT_BYTES = 300_000; // ~300 KB per attachment, 10 max
const PASTE_ATTACH_THRESHOLD = 2_000; // chars — larger pastes are offered as a chip

import { useCallback, useEffect, useRef, useState } from 'react';
import { dashboardAPI } from '../api';
import Markdown from './Markdown';
// P2 — structured artifacts extracted from the answer TEXT (```diff blocks,
// test/build output, deploy URLs) rendered as cards, not raw markdown.
import { extractArtifacts, type ExtractedArtifacts } from '../artifacts';
import { stripAnsi } from '../ansi';
import type { TaskLogLine, TaskStatus } from '../types';

interface AuthState {
  configured: boolean;
  authenticated: boolean;
  role: string | null;
}

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  error?: boolean;
  followups?: Array<{ prompt: string; label?: string }>;
  /** The agent's live working steps that produced this answer (P3 streaming). */
  steps?: string[];
  /** P0.6 — the tool calls that produced this answer (rendered as cards). */
  tools?: ToolStep[];
  /** P0.7 — the plan this turn worked through (rendered as a checklist card). */
  plan?: PlanView | null;
  /** P3b — the git diff this turn produced (rendered as a diff card). */
  diff?: DiffView | null;
  /** P6a — the skill draft this turn produced (rendered as the /learn preview card). */
  draft?: SkillDraftView | null;
  /** P8 — attachments that rode into this turn (rendered as expandable chips). */
  attachments?: AttachmentChip[];
  /**
   * P2 — artifacts extracted from the answer TEXT (diff/result/deploy cards).
   * Distinct from the live `diff`/`plan`/`tool` events, which are snapshotted
   * into their own fields; this covers blocks the model wrote directly.
   */
  artifacts?: ExtractedArtifacts;
  /** P2 — a CLI command run as an inline execution card (the ⚡ Run path). */
  task?: TaskRunView;
}

/** P2 — a running CLI task rendered as a live execution card in the thread. */
interface TaskRunView {
  id: string;
  command: string;
  status: TaskStatus;
  exitCode: number | null;
  durationMs: number | null;
  logs: TaskLogLine[];
}

/** P8 — one composer attachment (file / paste / drop). */
interface AttachmentChip {
  name: string;
  content: string;
  kind: 'file' | 'paste' | 'drop';
}

/** P0.7 — the plan checklist as rendered (goal + steps with statuses). */
interface PlanView {
  goal: string;
  steps: Array<{ id: string; description: string; status: 'pending' | 'running' | 'done' | 'blocked' }>;
  revision: number;
}

/** P3b — a git diff payload as rendered (per-file +/− sections). */
interface DiffView {
  files: Array<{ path: string; body: string }>;
  summary: string;
}

/** P6a — a skill draft as rendered (the /learn preview card). */
interface SkillDraftView {
  name: string;
  description: string;
  markdown: string;
  updatedAt: number;
  /** Local card state: 'pending' | 'saving' | 'saved' | 'rejected' | 'error'. */
  status?: 'pending' | 'saving' | 'saved' | 'rejected' | 'error';
}

/** P0.6 — one tool-call lifecycle step, rendered as a card (started → called). */
interface ToolStep {
  /** Stable per-call id (e.g. `call_1`) — matches started→called. */
  id: string;
  tool: string;
  phase: 'started' | 'called';
  /** One-line args preview, e.g. `{path: 'src/foo.ts'}`. */
  args?: string;
  ok?: boolean;
  result?: string;
  error?: string;
  durationMs?: number;
}

/** Small icon per tool family for the card header. */
function toolIcon(tool: string): string {
  if (tool === 'read_file' || tool === 'glob' || tool === 'list_dir') return '📖';
  if (tool === 'edit_file' || tool === 'write_file') return '✏️';
  if (tool === 'run_terminal' || tool === 'run_cli') return '⚙️';
  if (tool === 'web_search' || tool === 'read_page') return '🌐';
  if (tool === 'delegate' || tool === 'spawn_subagents') return '👥';
  if (tool === 'ask_user') return '🤔';
  return '🔧';
}

/** A CLI command the intent router resolved for a chat message. */
interface ResolvedCommand {
  intent: string;
  summary: string;
  command?: string;
  example?: string;
  ambiguous?: boolean;
  options?: Array<{ when: string; command: string; example: string; summary: string }>;
  confirmation?: boolean;
  score: number;
}

/** A plain-English ask that maps to CLI command(s) — shown as a confirm card. */
interface PendingResolve {
  ask: string;
  top: ResolvedCommand | null;
}

/** P2 — status label for one inline command-run card. */
const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  running: '⏳ running',
  done: '✅ done',
  failed: '❌ failed',
  cancelled: '⏹ cancelled',
  timeout: '⏰ timed out',
  error: '💥 error',
};

/**
 * P3b — render a git diff card: per-file sections with +/− colored lines
 * and a change-count summary. Snapshotted into the reply so the committed
 * change stays visible.
 *
 * P2 — `selectable` adds per-file accept/reject (✓/✗ toggles, all accepted
 * by default) + a "Commit accepted" action. The engine's git tool already
 * implements the accepted-subset contract (commit with files=[...]) — this
 * card surfaces the selection and sends it back as a chat turn; it does NOT
 * re-implement diff application.
 *
 * P2 — `lockedHint` renders when the card is deliberately NOT selectable
 * (extracted text diffs without an attached project): the diff is prose, not
 * a known working tree, so there is nothing safe to commit against — the hint
 * tells the user why the accept/reject affordance is absent.
 */
function DiffCard({
  diff,
  selectable = false,
  onCommitAccepted,
  lockedHint,
}: {
  diff: DiffView;
  selectable?: boolean;
  onCommitAccepted?: (paths: string[]) => void;
  lockedHint?: string;
}) {
  // P2 — per-file accept/reject is CARD-LOCAL (all accepted by default). The
  // caller only learns the final selection via onCommitAccepted.
  const [accepted, setAccepted] = useState<string[] | null>(null);
  const acceptedSet = new Set(accepted ?? diff.files.map((f) => f.path));
  const toggleFile = (path: string) => {
    setAccepted((prev) => {
      const base = prev ?? diff.files.map((f) => f.path);
      return base.includes(path) ? base.filter((p) => p !== path) : [...base, path];
    });
  };
  const added = diff.files.reduce((s, f) => s + (f.body.match(/^\+/gm)?.length ?? 0), 0);
  const removed = diff.files.reduce((s, f) => s + (f.body.match(/^-/gm)?.length ?? 0), 0);
  return (
    <div className="chat-diff-card">
      <div className="chat-diff-head">
        <span className="chat-diff-icon">🔧</span>
        <span className="chat-diff-title">git diff</span>
        <span className="chat-diff-meta">
          {diff.files.length} file{diff.files.length === 1 ? '' : 's'} · +{added} −{removed}
        </span>
      </div>
      <div className="chat-diff-files">
        {diff.files.map((f) => {
          const isAccepted = acceptedSet.has(f.path);
          return (
            <details key={f.path} className={`chat-diff-file${!isAccepted ? ' chat-diff-file-rejected' : ''}`} open={diff.files.length === 1}>
              <summary className="chat-diff-file-path">
                {selectable ? (
                  <button
                    type="button"
                    className={`chat-diff-toggle${isAccepted ? ' chat-diff-toggle-on' : ''}`}
                    title={isAccepted ? 'Accepted — click to reject' : 'Rejected — click to accept'}
                    onClick={(e) => { e.preventDefault(); e.stopPropagation(); toggleFile(f.path); }}
                  >
                    {isAccepted ? '✓' : '✗'}
                  </button>
                ) : null}
                {f.path}
              </summary>
              <pre className="chat-diff-body">
                {f.body.split('\n').map((line, i) => {
                  const cls = line.startsWith('+') ? 'diff-add' : line.startsWith('-') ? 'diff-del' : line.startsWith('@@') ? 'diff-hunk' : '';
                  return (
                    <div key={i} className={`chat-diff-line ${cls}`}>
                      {line || ' '}
                    </div>
                  );
                })}
              </pre>
            </details>
          );
        })}
      </div>
      {selectable && onCommitAccepted ? (
        <div className="chat-diff-actions">
          <button
            className="admin-refresh-btn"
            type="button"
            disabled={acceptedSet.size === 0}
            onClick={() => onCommitAccepted([...acceptedSet])}
          >
            Commit accepted ({acceptedSet.size})
          </button>
          <span className="admin-hint">Only accepted files are committed — the agent re-confirms with a question card.</span>
        </div>
      ) : lockedHint ? (
        <div className="chat-diff-actions">
          <span className="admin-hint chat-diff-locked">🔒 {lockedHint}</span>
        </div>
      ) : null}
    </div>
  );
}

/** P2 — copy-to-clipboard button (⧉ Copy → ✓ Copied), same pattern as the
 *  markdown code blocks. Clipboard may be unavailable (non-secure context /
 *  jsdom) — the button no-ops instead of throwing. */
function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard?.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable — button no-ops */
    }
  };
  return (
    <button type="button" className="chat-card-copy" title={`Copy ${label}`} onClick={() => void copy()}>
      {copied ? '✓ Copied' : '⧉ Copy'}
    </button>
  );
}

/** P2 — a test/build result extracted from the answer text (✅ / ❌ card). */
function ResultCard({ result }: { result: { verdict: 'pass' | 'fail' | 'unknown'; title: string; body: string } }) {
  const icon = result.verdict === 'pass' ? '✅' : result.verdict === 'fail' ? '❌' : '📋';
  return (
    <div className={`chat-result-card chat-result-${result.verdict}`}>
      <div className="chat-result-head">
        <span className="chat-result-icon">{icon}</span>
        <span className="chat-result-title">{result.title}</span>
        <span className="chat-result-meta">{result.verdict}</span>
        <CopyButton text={result.body} label="result output" />
      </div>
      <pre className="chat-result-body">{result.body}</pre>
    </div>
  );
}

/** P2 — a deploy URL extracted from the answer text (🚀 card with a link). */
function DeployCard({ deploy }: { deploy: { url: string; title: string } }) {
  return (
    <div className="chat-deploy-card">
      <div className="chat-deploy-head">
        <span className="chat-deploy-icon">🚀</span>
        <span className="chat-deploy-title">{deploy.title || 'Deployment'}</span>
        <CopyButton text={deploy.url} label="deployment URL" />
      </div>
      <a className="chat-deploy-url" href={deploy.url} target="_blank" rel="noopener noreferrer">
        {deploy.url}
      </a>
    </div>
  );
}

/**
 * P2 — roving-focus keyboard navigation for the artifact card stack. Cards
 * inside carry `data-artifact-card`; ↑/↓ move focus between them (wrapping at
 * the ends), Home/End jump to the first/last. Native Tab still reaches each
 * card's controls (copy button, toggles, links) — this adds list navigation
 * on top, so a keyboard user can scan every artifact without tabbing through
 * every control.
 */
function ArtifactNav({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!ref.current) return;
    const cards = Array.from(ref.current.querySelectorAll<HTMLElement>('[data-artifact-card]'));
    if (cards.length === 0) return;
    const current = cards.indexOf(document.activeElement as HTMLElement);
    let next = -1;
    if (e.key === 'ArrowDown') next = current + 1 >= cards.length ? 0 : current + 1;
    else if (e.key === 'ArrowUp') next = current - 1 < 0 ? cards.length - 1 : current - 1;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = cards.length - 1;
    if (next >= 0 && next !== current) {
      e.preventDefault();
      cards[next].focus();
    }
  };
  return (
    <div className="chat-artifacts" ref={ref} role="group" aria-label="Artifacts" onKeyDown={onKeyDown}>
      {children}
    </div>
  );
}

/**
 * P2 — an inline command-run execution card (the ⚡ Run path). Shows the
 * command, a live status badge, streamed logs, exit code + duration when
 * settled, and a Cancel button while running. Reuses the P1 task runner
 * (the REAL CLI as a child process) exactly like TaskConsole.
 */
function TaskRunCard({ task, onCancel }: { task: TaskRunView; onCancel?: () => void }) {
  const running = task.status === 'running';
  // P2 — the copy button captures the FULL output, ANSI-stripped, so what
  // lands on the clipboard is the clean text the user sees (no color codes).
  const outputText = task.logs.map((l) => stripAnsi(l.text)).join('\n');
  return (
    <div className={`chat-task-card${running ? ' chat-task-running' : task.status === 'done' ? ' chat-task-ok' : ' chat-task-err'}`}>
      <div className="chat-task-head">
        <span className="chat-task-icon">⚙️</span>
        <code className="chat-task-cmd">{task.command}</code>
        <span className="chat-task-status" title={task.status}>{TASK_STATUS_LABEL[task.status]}</span>
        {!running && task.exitCode !== null ? <span className="chat-task-exit">exit {task.exitCode}</span> : null}
        {!running && task.durationMs !== null ? <span className="chat-task-dur">{task.durationMs}ms</span> : null}
        {outputText ? <CopyButton text={outputText} label="task output" /> : null}
        {running && onCancel ? (
          <button className="admin-mini-btn" type="button" onClick={onCancel}>⏹ Cancel</button>
        ) : null}
      </div>
      <pre className="chat-task-logs" role="log">
        {task.logs.length > 0 ? (
          task.logs.map((l, i) => {
            // Stream separation: a divider marks where the output switched
            // streams (stdout → stderr → system), and each line is styled by
            // its stream. ANSI escapes (chalk colors, progress-bar cursor
            // control) are stripped so the card shows clean text.
            const prev = task.logs[i - 1];
            const switched = prev && prev.stream !== l.stream;
            const text = stripAnsi(l.text) || ' ';
            return (
              <div key={i}>
                {switched ? (
                  <div className={`chat-task-log-sep chat-task-log-sep-${l.stream}`} aria-hidden="true">
                    {l.stream}
                  </div>
                ) : null}
                <div className={`chat-task-log chat-task-log-${l.stream}`}>{text}</div>
              </div>
            );
          })
        ) : (
          <div className="admin-hint">{running ? 'Waiting for output…' : '(no output)'}</div>
        )}
      </pre>
    </div>
  );
}

  /**
   * P6a — the /learn preview card: the agent drafted a skill; the user
   * decides ✅ accept (saves it to the live stores), ✏️ edit (asks the agent
   * to revise — a chat turn re-drafts), ↩ reject (discards the draft).
   */
  function SkillDraftCard({ draft, onAccept, onReject, onEdit }: {
    draft: SkillDraftView;
    onAccept: (name: string) => void;
    onReject: (name: string) => void;
    onEdit: (name: string) => void;
  }) {
    const status = draft.status ?? 'pending';
    const lines = draft.markdown.split('\n');
    const bodyStart = lines.findIndex((l) => l.startsWith('# ')) >= 0 ? lines.findIndex((l) => l.startsWith('# ')) : 0;
    const preview = lines.slice(bodyStart, bodyStart + 14).join('\n');
    return (
      <div className={`chat-draft-card${status === 'saved' ? ' chat-draft-saved' : ''}${status === 'rejected' ? ' chat-draft-rejected' : ''}`}>
        <div className="chat-draft-head">
          <span className="chat-draft-icon">🧠</span>
          <span className="chat-draft-title">New skill draft: {draft.name}</span>
          <span className="chat-draft-meta">pending your review</span>
        </div>
        <p className="chat-draft-desc">{draft.description}</p>
        <pre className="chat-draft-body">{preview}</pre>
        {status === 'saving' ? (
          <div className="admin-hint">Saving…</div>
        ) : status === 'saved' ? (
          <div className="admin-hint">✅ Saved — the skill is live: load it in chat or see it in the Agent Hub Skills tab.</div>
        ) : status === 'rejected' ? (
          <div className="admin-hint">🗑️ Rejected — the draft was discarded, nothing was saved.</div>
        ) : (
          <div className="chat-draft-actions">
            <button className="admin-refresh-btn" type="button" onClick={() => onAccept(draft.name)}>
              ✅ Accept
            </button>
            <button className="admin-mini-btn" type="button" onClick={() => onEdit(draft.name)}>
              ✏️ Edit
            </button>
            <button className="admin-mini-btn" type="button" onClick={() => onReject(draft.name)}>
              ↩ Reject
            </button>
          </div>
        )}
      </div>
    );
  }

  /**
   * PA4 — notification card for skill env-var requirements.
   * Non-blocking: shows which env vars a loaded skill needs and whether
   * they are already persisted. Each var gets an input field so the user
   * can set them directly from the dashboard.
   */
  function SecretRequestCard({ request, onSave }: {
    request: { skillName: string; missing: string[]; persisted: Record<string, boolean> };
    onSave: (vars: Record<string, string>) => void;
  }) {
    const [values, setValues] = useState<Record<string, string>>({});
    const [saved, setSaved] = useState(false);
    const allSet = request.missing.every((k) => values[k]?.trim());
    const alreadyPersisted = request.missing.filter((k) => request.persisted[k]);
    const stillNeeded = request.missing.filter((k) => !request.persisted[k]);
    return (
      <div className="chat-secret-card">
        <div className="chat-secret-head">
          <span className="chat-secret-icon">🔐</span>
          <span className="chat-secret-title">{request.skillName} needs environment variables</span>
        </div>
        {alreadyPersisted.length > 0 ? (
          <div className="chat-secret-persisted">
            Already configured: {alreadyPersisted.map((k) => <code key={k}>{k}</code>).join(', ')}
          </div>
        ) : null}
        {stillNeeded.length > 0 && !saved ? (
          <div className="chat-secret-fields">
            {stillNeeded.map((k) => (
              <div key={k} className="chat-secret-row">
                <label className="chat-secret-label" htmlFor={`secret-${k}`}>{k}:</label>
                <input
                  id={`secret-${k}`}
                  className="chat-secret-input"
                  type="password"
                  placeholder={`Enter ${k} value…`}
                  value={values[k] ?? ''}
                  onChange={(e) => setValues((v) => ({ ...v, [k]: e.target.value }))}
                />
              </div>
            ))}
            <button
              className="admin-refresh-btn"
              type="button"
              disabled={!allSet}
              onClick={() => { onSave(values); setSaved(true); }}
            >
              💾 Save to ~/.buff/.env
            </button>
          </div>
        ) : saved ? (
          <div className="admin-hint">✅ Saved — the skill will pick up these values on next load.</div>
        ) : (
          <div className="admin-hint">All required env vars are already configured.</div>
        )}
      </div>
    );
  }

  /**
   * Execution Result Card — shows the outcome of a skill execution.
   * Displays runtime, duration, exit code, stdout/stderr, and status.
   */
  function ExecutionResultCard({ result }: {
    result: {
      skillName: string;
      runtime: string;
      success: boolean;
      durationMs: number;
      exitCode: number;
      stdout: string;
      stderr: string;
      timestamp: number;
    };
  }) {
    const [expanded, setExpanded] = useState(false);
    const statusIcon = result.success ? '✅' : '❌';
    const statusText = result.success ? 'Success' : `Failed (exit ${result.exitCode})`;
    const statusClass = result.success ? 'chat-exec-success' : 'chat-exec-failure';
    const timeStr = new Date(result.timestamp).toLocaleTimeString();
    return (
      <div className={`chat-exec-card ${statusClass}`}>
        <div className="chat-exec-head" onClick={() => setExpanded(!expanded)} style={{ cursor: 'pointer' }}>
          <span className="chat-exec-icon">📜</span>
          <span className="chat-exec-title">{result.skillName}</span>
          <span className="chat-exec-status">{statusIcon} {statusText}</span>
          <span className="chat-exec-meta">{result.runtime} · {result.durationMs}ms · {timeStr}</span>
          <span className="chat-exec-expand">{expanded ? '▼' : '▶'}</span>
        </div>
        {expanded && (
          <div className="chat-exec-body">
            {result.stdout && (
              <div className="chat-exec-section">
                <div className="chat-exec-section-title">stdout</div>
                <pre className="chat-exec-output">{result.stdout}</pre>
              </div>
            )}
            {result.stderr && (
              <div className="chat-exec-section chat-exec-stderr">
                <div className="chat-exec-section-title">stderr</div>
                <pre className="chat-exec-output">{result.stderr}</pre>
              </div>
            )}
            <div className="chat-exec-details">
              <span>Runtime: {result.runtime}</span>
              <span>Exit code: {result.exitCode}</span>
              <span>Duration: {result.durationMs}ms</span>
            </div>
          </div>
        )}
      </div>
    );
  }

  /** P0.7 — status icon for one checklist step. */
  function planStepIcon(status: string): string {
  if (status === 'done') return '✅';
  if (status === 'running') return '🔄';
  if (status === 'blocked') return '⛔';
  return '⬜';
}

/**
 * P0.7 — render the plan checklist card: goal header + per-step status + a
 * progress count ("3/5 done"). Updates in place as `plan` events arrive
 * (each new revision replaces the card content).
 */
function PlanCard({ plan }: { plan: PlanView }) {
  const done = plan.steps.filter((s) => s.status === 'done').length;
  return (
    <div className="chat-plan-card">
      <div className="chat-plan-head">
        <span className="chat-plan-icon">🗂️</span>
        <span className="chat-plan-goal">{plan.goal}</span>
        <span className="chat-plan-count">{done}/{plan.steps.length} done</span>
      </div>
      <div className="chat-plan-steps">
        {plan.steps.map((s) => (
          <div key={s.id} className={`chat-plan-step chat-plan-step-${s.status}`}>
            <span className="chat-plan-step-icon">{planStepIcon(s.status)}</span>
            <span className="chat-plan-step-text">{s.description}</span>
            <span className="chat-plan-step-status">{s.status}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * P0.6 — render a tool-call as a card: icon + name + one-line args, a status
 * badge (⏳ running / ✓ ok / ✗ error), duration when finished, and a
 * collapsible result/error body. `live` renders the running state (phase
 * 'started' still spinning); snapshotted message cards are always settled.
 */
function ToolCards({ tools, live }: { tools: ToolStep[]; live?: boolean }) {
  if (!tools || tools.length === 0) return null;
  return (
    <div className={`chat-tool-cards${live ? ' chat-tool-cards-live' : ''}`}>
      {tools.map((t) => {
        const running = t.phase === 'started' || t.ok === undefined;
        const failed = t.ok === false;
        return (
          <div key={t.id} className={`chat-tool-card${running ? ' chat-tool-running' : failed ? ' chat-tool-err' : ' chat-tool-ok'}`}>
            <div className="chat-tool-head">
              <span className="chat-tool-icon">{toolIcon(t.tool)}</span>
              <span className="chat-tool-name">{t.tool}</span>
              {t.args ? <code className="chat-tool-args">{t.args}</code> : null}
              <span className="chat-tool-status" title={running ? 'running' : failed ? 'failed' : 'done'}>
                {running ? '⏳' : failed ? '✗' : '✓'}
              </span>
              {t.durationMs !== undefined && !running ? <span className="chat-tool-dur">{t.durationMs}ms</span> : null}
            </div>
            {t.error || t.result ? (
              <details className="chat-tool-detail">
                <summary>{failed ? 'Error' : 'Result'}</summary>
                <pre className="chat-tool-body">{t.error || t.result}</pre>
              </details>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function newSessionId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  } catch { /* fall through */ }
  return `chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** P8 — group sessions by recency (Today / Yesterday / This week / Older)
 *  and filter by the sidebar search box (title / preview / first message). */
function groupSessions(
  sessions: Array<{ id: string; title: string; turnCount: number; createdAt: number; updatedAt: number; preview: string; firstUser: string }>,
  query: string,
): Array<{ label: string; items: Array<{ id: string; title: string; turnCount: number; createdAt: number; updatedAt: number; preview: string; firstUser: string }> }> {
  const q = query.trim().toLowerCase();
  const filtered = q
    ? sessions.filter((s) => `${s.title} ${s.preview} ${s.firstUser}`.toLowerCase().includes(q))
    : sessions;
  const groups: Array<{ label: string; items: typeof filtered }> = [];
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const dayMs = 86_400_000;
  const buckets: Array<{ label: string; match: (t: number) => boolean }> = [
    { label: 'Today', match: (t) => t >= startOfToday },
    { label: 'Yesterday', match: (t) => t >= startOfToday - dayMs && t < startOfToday },
    { label: 'This week', match: (t) => t >= startOfToday - 7 * dayMs && t < startOfToday - dayMs },
    { label: 'Older', match: () => true },
  ];
  for (const b of buckets) {
    const items = filtered.filter((s) => b.match(s.updatedAt));
    if (items.length > 0) groups.push({ label: b.label, items });
  }
  return groups;
}

export default function ChatPage() {
  const [auth, setAuth] = useState<AuthState | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [meta, setMeta] = useState<string | null>(null);
  const [liveSteps, setLiveSteps] = useState<string[]>([]);
  // P0.6 — live tool-call cards (upserted by id: started creates, called completes).
  const [liveTools, setLiveTools] = useState<ToolStep[]>([]);
  // P0.7 — the live plan checklist (updates in place on each plan:changed).
  const [livePlan, setLivePlan] = useState<PlanView | null>(null);
  // P3b — the latest git diff payload (rendered as a diff card).
  const [liveDiff, setLiveDiff] = useState<DiffView | null>(null);
  // P6a — the /learn preview card (skill_manage create/patch emits it).
  const [liveDraft, setLiveDraft] = useState<SkillDraftView | null>(null);
  // PA4 — skill env-var notification card (non-blocking: shows missing vars).
  const [secretRequests, setSecretRequests] = useState<Array<{ skillName: string; missing: string[]; persisted: Record<string, boolean> }>>([]);
  const [executionResults, setExecutionResults] = useState<Array<{ skillName: string; runtime: string; success: boolean; durationMs: number; exitCode: number; stdout: string; stderr: string; timestamp: number }>>([]);
  // Plain-English → CLI short-circuit: a confident command match shows a
  // confirm card instead of burning a model turn; ambiguous asks show choices.
  const [pendingResolve, setPendingResolve] = useState<PendingResolve | null>(null);
  // Mirrors liveSteps/liveTools for the async send callback (state would be
  // stale in the closure when the POST resolves) — the final message snapshots
  // every step.
  const liveStepsRef = useRef<string[]>([]);
  const liveToolsRef = useRef<ToolStep[]>([]);
  const livePlanRef = useRef<PlanView | null>(null);
  const liveDiffRef = useRef<DiffView | null>(null);
  const liveDraftRef = useRef<SkillDraftView | null>(null);
  // P4 — the live answer typewriter: tokens stream in via SSE while the POST
  // is in flight. The POST response is AUTHORITATIVE (the engine's S1
  // longest-substantive logic may pick an earlier, longer answer) — the
  // streamed text is replaced, not merged, when the turn resolves.
  const [streamingText, setStreamingText] = useState('');
  const streamingRef = useRef('');
  // P4 — the in-flight turn's AbortController (the Cancel button aborts the
  // POST fetch; the server then cancels the turn server-side).
  const abortRef = useRef<AbortController | null>(null);
  // P4 — the last message whose turn FAILED, for the Retry affordance (null
  // when nothing to retry).
  const [retryAsk, setRetryAsk] = useState<string | null>(null);
  const sessionIdRef = useRef<string>(newSessionId());
  // Phase 6 — the last sent message (↑ recalls it into the box).
  const lastSentRef = useRef<string>('');
  // P4 — the session sidebar: past conversations, click to resume.
  const [sessions, setSessions] = useState<Array<{ id: string; title: string; turnCount: number; createdAt: number; updatedAt: number; preview: string; firstUser: string; projectPath?: string }>>([]);
  // P8 — smart rail: the sidebar collapses to a rail while the agent works and
  // returns when the turn finishes (results own the full window mid-task).
  const [railOpen, setRailOpen] = useState(true);
  // P8 — sidebar search filter (title / preview / first message).
  const [sessionQuery, setSessionQuery] = useState('');
  // P8 — the session being renamed (inline input in the sidebar).
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  // P8 — composer attachments (file picker / paste-as-attachment / drag-drop).
  const [attachments, setAttachments] = useState<AttachmentChip[]>([]);
  const [pasteOffer, setPasteOffer] = useState<{ text: string } | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const pastePosRef = useRef<{ start: number; end: number } | null>(null);
  // P3 — the attached project (its bounded context rides into every turn).
  const [attachedProject, setAttachedProject] = useState<{ path: string; name: string; fileCount: number; symbolCount: number; truncated: boolean } | null>(null);
  // P4b — the project path from a resumed session (used to show a mismatch banner).
  const [sessionProjectPath, setSessionProjectPath] = useState<string | null>(null);
  const [projectPick, setProjectPick] = useState<Array<{ path: string; name: string; kind: string }>>([]);
  const [projectPathInput, setProjectPathInput] = useState('');
  const [projectError, setProjectError] = useState('');
  // Folder browser popover for the project picker.
  const [browseOpen, setBrowseOpen] = useState(false);
  const [browsePath, setBrowsePath] = useState('');
  const [browseEntries, setBrowseEntries] = useState<Array<{ name: string; path: string; isDir?: boolean; modified?: number }>>([]);
  const [browseParent, setBrowseParent] = useState<string | null>(null);
  const [browseLoading, setBrowseLoading] = useState(false);
  const [browseDrives, setBrowseDrives] = useState<Array<{ name: string; path: string; type: string }>>([]);
  const [browseBreadcrumbs, setBrowseBreadcrumbs] = useState<Array<{ name: string; path: string }>>([]);
  const [browseFilter, setBrowseFilter] = useState('');
  const browseRefreshRef = useRef<NodeJS.Timeout | null>(null);
  const subRef = useRef<(() => void) | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  // P4b — ref to break the circular dependency between resumeSession and attachProject.
  const attachProjectRef = useRef<((path: string) => Promise<void>) | null>(null);
  // P0.1 — a pending ask_user question from the agent (choice card).
  const [pendingQuestion, setPendingQuestion] = useState<{
    questionId: string;
    question: string;
    choices: Array<{ label: string; description?: string }>;
    multiSelect: boolean;
  } | null>(null);
  const [questionSel, setQuestionSel] = useState<Set<number>>(new Set());

  useEffect(() => {
    void dashboardAPI.fetchAdminAuthStatus().then((s) => {
      setAuth(
        s
          ? { configured: s.configured, authenticated: s.authenticated, role: s.role }
          : { configured: false, authenticated: false, role: null },
      );
    });
  }, []);

  // Auto-scroll the thread to the newest message.
  useEffect(() => {
    try {
      listRef.current?.scrollTo?.({ top: listRef.current.scrollHeight });
    } catch {
      /* jsdom / non-DOM environments */
    }
  }, [messages, busy, liveSteps]);

  // Tear down the SSE subscription on unmount.
  useEffect(() => {
    return () => {
      subRef.current?.();
      subRef.current = null;
    };
  }, []);

  /** P4 — resume a past session: load its transcript into the thread. */
  const resumeSession = useCallback(async (id: string) => {
    subRef.current?.();
    subRef.current = null;
    const rec = await dashboardAPI.getChatSession(id);
    if (!rec) return;
    sessionIdRef.current = id;
    setMessages(
      rec.turns.map((t) => ({
        role: t.role,
        content: t.content,
        ...(t.role === 'assistant' ? { followups: [], artifacts: extractArtifacts(t.content) } : {}),
      })),
    );
    setLiveSteps([]);
    liveStepsRef.current = [];
    setLiveTools([]);
    liveToolsRef.current = [];
    setLivePlan(null);
    livePlanRef.current = null;
    setLiveDiff(null);
    liveDiffRef.current = null;
    setLiveDraft(null);
    liveDraftRef.current = null;
    streamingRef.current = '';
    setStreamingText('');
    setRetryAsk(null);
    setError('');
    setMeta(null);
    setPendingResolve(null);
    setPendingQuestion(null);
    setRailOpen(true);
    // P4b — auto-restore the attached project from the session's stored path.
    const storedPath = rec.projectPath;
    if (storedPath) {
      setSessionProjectPath(storedPath);
      // If the project is already attached and matches, no action needed.
      if (attachedProject?.path === storedPath) return;
      // Try to re-attach: the server will build the context bundle if the dir exists.
      void attachProjectRef.current?.(storedPath);
    } else {
      setSessionProjectPath(null);
    }
  }, [attachedProject]);

  /** P8 — start a fresh session (sidebar + New chat button). */
  const newChat = useCallback(() => {
    subRef.current?.();
    subRef.current = null;
    sessionIdRef.current = newSessionId();
    setSessionProjectPath(null);
    setMessages([]);
    setLiveSteps([]);
    liveStepsRef.current = [];
    setLiveTools([]);
    liveToolsRef.current = [];
    setLivePlan(null);
    livePlanRef.current = null;
    setLiveDiff(null);
    liveDiffRef.current = null;
    setLiveDraft(null);
    liveDraftRef.current = null;
    streamingRef.current = '';
    setStreamingText('');
    setRetryAsk(null);
    setError('');
    setMeta(null);
    setPendingResolve(null);
    setPendingQuestion(null);
    setAttachments([]);
    setPasteOffer(null);
    setInput('');
    setRailOpen(true);
  }, []);

  /** P8 — add an attachment chip (file picker / drag-drop / paste-as-text). */
  const addAttachment = useCallback((chip: AttachmentChip) => {
    setAttachments((a) => [...a, chip].slice(-10));
  }, []);

  const removeAttachment = useCallback((index: number) => {
    setAttachments((a) => a.filter((_, i) => i !== index));
  }, []);

  /** P8 — file picker: read the file as text and chip it. */
  const pickFile = useCallback(async (file: File) => {
    if (!file) return;
    if (file.size > MAX_ATTACHMENT_BYTES) {
      setError(`Attachment "${file.name}" is too large (max ${Math.round(MAX_ATTACHMENT_BYTES / 1024)} KB).`);
      return;
    }
    const text = await file.text();
    addAttachment({ name: file.name, content: text, kind: 'file' });
  }, [addAttachment]);

  /** P8 — the textarea's paste handler: remember the cursor so the offer can
   *  strip exactly the pasted text when accepted. */
  const handlePaste = useCallback((e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const el = e.currentTarget;
    const pasted = e.clipboardData.getData('text') || '';
    if (pasted.length >= PASTE_ATTACH_THRESHOLD) {
      pastePosRef.current = { start: el.selectionStart, end: el.selectionEnd };
      setPasteOffer({ text: pasted });
    }
  }, []);

  /** P8 — accept the paste offer: strip the pasted text out of the box and
   *  turn it into an attachment chip. */
  const acceptPasteOffer = useCallback(() => {
    const offer = pasteOffer;
    if (!offer) return;
    const pos = pastePosRef.current;
    setInput((prev) => {
      if (!pos) return prev;
      return prev.slice(0, pos.start) + prev.slice(pos.end);
    });
    addAttachment({ name: `pasted-text.txt`, content: offer.text, kind: 'paste' });
    setPasteOffer(null);
    pastePosRef.current = null;
  }, [pasteOffer, addAttachment]);

  /** P8 — rename a session (sidebar pencil). */
  const startRename = useCallback((s: { id: string; title: string }) => {
    setRenamingId(s.id);
    setRenameValue(s.title === '(untitled conversation)' ? '' : s.title);
  }, []);

  const commitRename = useCallback(async (id: string) => {
    const r = await dashboardAPI.renameChatSession(id, renameValue);
    if (r.ok) {
      setSessions((list) =>
        list.map((s) => (s.id === id ? { ...s, title: renameValue.trim() || s.title } : s)),
      );
    } else {
      setError(r.error || 'Could not rename the session.');
    }
    setRenamingId(null);
    setRenameValue('');
  }, [renameValue]);

  /** P8 — delete a session (sidebar trash). */
  const deleteSession = useCallback(async (id: string) => {
    const r = await dashboardAPI.deleteChatSession(id);
    if (r.ok) {
      setSessions((list) => list.filter((s) => s.id !== id));
      if (sessionIdRef.current === id) newChat();
    } else {
      setError(r.error || 'Could not delete the session.');
    }
  }, [newChat]);

  const canChat = auth?.authenticated === true && (auth.role === 'admin' || auth.role === 'operator');

  // P4 — load the session sidebar once authenticated (admin/operator only).
  useEffect(() => {
    if (!canChat) return;
    void dashboardAPI.listChatSessions().then((s) => {
      if (Array.isArray(s)) setSessions(s);
    });
    // P3 — load the project picker (dashboard cwd + recently attached).
    void dashboardAPI.listProjects().then((p) => {
      if (Array.isArray(p)) setProjectPick(p);
    });
  }, [canChat]);

  /** P3 — attach a project directory (its context rides into chat turns). */
  const attachProject = useCallback(async (path: string) => {
    const clean = path.trim();
    if (!clean) return;
    setProjectError('');
    const r = await dashboardAPI.attachProject(clean);
    if (r.ok && r.project) {
      setAttachedProject(r.project);
      setProjectPathInput('');
      const p = await dashboardAPI.listProjects();
      if (Array.isArray(p)) setProjectPick(p);
    } else {
      setProjectError(r.error || 'Could not attach that directory.');
    }
  }, []);
  // P4b — keep the ref in sync so resumeSession can call attachProject without a direct dependency.
  attachProjectRef.current = attachProject;

  /** Browse directories for the folder picker. */
  const openBrowse = useCallback(async (startPath?: string) => {
    setBrowseOpen(true);
    setBrowseLoading(true);
    setBrowseFilter('');
    const r = await dashboardAPI.browseDirectories(startPath, { showDrives: !startPath });
    if (r.ok) {
      setBrowsePath(r.path);
      setBrowseEntries(r.entries);
      setBrowseParent(r.parent);
      if (r.drives) setBrowseDrives(r.drives);
      if (r.breadcrumbs) setBrowseBreadcrumbs(r.breadcrumbs);
    }
    setBrowseLoading(false);
  }, []);

  const browseTo = useCallback(async (dirPath: string) => {
    setBrowseLoading(true);
    setBrowseFilter('');
    const r = await dashboardAPI.browseDirectories(dirPath);
    if (r.ok) {
      setBrowsePath(r.path);
      setBrowseEntries(r.entries);
      setBrowseParent(r.parent);
      if (r.breadcrumbs) setBrowseBreadcrumbs(r.breadcrumbs);
    }
    setBrowseLoading(false);
  }, []);

  /** Refresh the current browse directory (auto-refresh or manual). */
  const refreshBrowse = useCallback(async () => {
    if (!browsePath) return;
    const r = await dashboardAPI.browseDirectories(browsePath);
    if (r.ok) {
      setBrowseEntries(r.entries);
    }
  }, [browsePath]);

  /** Auto-refresh browse every 5 seconds when open. */
  useEffect(() => {
    if (browseOpen && browsePath) {
      browseRefreshRef.current = setInterval(() => { void refreshBrowse(); }, 5000);
    }
    return () => {
      if (browseRefreshRef.current) clearInterval(browseRefreshRef.current);
    };
  }, [browseOpen, browsePath, refreshBrowse]);

  /** Native folder picker using the File System Access API.
   *  Opens a TRUE native folder picker (not a file picker).
   *  Falls back to the custom popover on unsupported browsers. */
  const openNativeFolderPicker = useCallback(async () => {
    // showDirectoryPicker() opens a native OS folder selection dialog.
    // Supported in Chrome, Edge, Electron (Chromium-based).
    const w = window as Record<string, unknown>;
    if (typeof w.showDirectoryPicker === 'function') {
      try {
        const dirHandle = await (w.showDirectoryPicker as () => Promise<FileSystemDirectoryHandle>)();
        const folderName = dirHandle.name;
        if (!folderName) {
          void openBrowse();
          return;
        }
        setProjectError('');
        setBusy(true);
        const r = await dashboardAPI.resolveFolder(folderName);
        setBusy(false);
        if (r.ok && r.path) {
          // Show the resolved path in the input field for transparency.
          setProjectPathInput(r.path);
          void attachProject(r.path);
        } else {
          setProjectError((r.error || 'Could not find folder.') + ' Opening manual browser...');
          void openBrowse();
        }
        return;
      } catch (err: unknown) {
        // User cancelled the picker — no action needed.
        if (err instanceof DOMException && err.name === 'AbortError') return;
        // Other errors — fall through to custom popover.
      }
    }
    // Fallback: custom directory browser popover.
    void openBrowse();
  }, [openBrowse, attachProject]);

  const send = useCallback(
    async (text: string, withAttachments?: AttachmentChip[] | { skipResolve: boolean }) => {
      const clean = text.trim();
      const chipList = Array.isArray(withAttachments) ? withAttachments : attachments;
      const skipResolve = !Array.isArray(withAttachments) && withAttachments?.skipResolve === true;
      if ((!clean && chipList.length === 0) || busy) return;
      setError('');
      setMeta(null);
      setLiveSteps([]);
      liveStepsRef.current = [];
      setLiveTools([]);
      liveToolsRef.current = [];
      setLivePlan(null);
      livePlanRef.current = null;
      setLiveDiff(null);
      liveDiffRef.current = null;
      setLiveDraft(null);
      liveDraftRef.current = null;
      setMessages((m) => [...m, { role: 'user', content: clean, attachments: chipList.length > 0 ? chipList : undefined }]);
      setInput('');
      setAttachments([]);
      setPasteOffer(null);
      lastSentRef.current = clean || `[${chipList.length} attachment(s)]`;
      setBusy(true);
      // P8 — smart rail: while the agent works, the results own the window.
      setRailOpen(false);

      // Pre-resolve the ask against the command manifest. A confident match
      // short-circuits to a confirm card (deterministic commands like "stop
      // the dashboard" shouldn't need a model turn); ambiguous asks show
      // their options as choices; everything else falls through to the agent.
      // skipResolve: when the user already declined a resolved command
      // ("No — ask the agent"), skip re-resolution and go straight to the
      // agent — prevents the loop where declining re-shows the same card.
      if (!skipResolve) {
        const resolved = await dashboardAPI.chatResolve(clean);
        const matches = (resolved.matches ?? []) as ResolvedCommand[];
        const top = matches[0] ?? null;
        if (top && top.command && !top.ambiguous && top.score >= 0.6) {
          setPendingResolve({ ask: clean, top });
          setBusy(false);
          return;
        }
        if (top && top.ambiguous && !pendingResolve) {
          setPendingResolve({ ask: clean, top });
          setBusy(false);
          return;
        }
      }

      const sessionId = sessionIdRef.current;
      // P4 — arm the abort controller for this turn (the Cancel button fires
      // it; the server cancels the turn when the aborted fetch closes).
      const controller = new AbortController();
      abortRef.current = controller;
      setRetryAsk(null);
      // Subscribe to LIVE progress BEFORE the turn starts so no step is missed
      // (EventSource auto-reconnects; the final answer arrives via the POST).
      subRef.current?.();
      subRef.current = dashboardAPI.subscribeChat(sessionId, {
        // P4 — answer tokens typewrite into the live bubble; the POST response
        // replaces them with the authoritative final content.
        onToken: (text) => {
          streamingRef.current += text;
          setStreamingText(streamingRef.current);
        },
        onProgress: (line) => {
          liveStepsRef.current = [...liveStepsRef.current, line];
          setLiveSteps(liveStepsRef.current);
        },
        // P0.1 — the agent asked a clarifying question; show the choice card.
        onQuestion: (q) => {
          setPendingQuestion(q);
          setQuestionSel(new Set());
        },
        // P0.6 — live tool card: `started` creates/updates the card, `called`
        // completes it with ok/error + duration. Keyed by the stable call id.
        onTool: (t) => {
          const next = [...liveToolsRef.current];
          const idx = next.findIndex((c) => c.id === t.id);
          const card: ToolStep = { id: t.id, tool: t.tool, phase: t.phase, args: t.args, ok: t.ok, result: t.result, error: t.error, durationMs: t.durationMs };
          if (idx >= 0) next[idx] = card;
          else next.push(card);
          liveToolsRef.current = next;
          setLiveTools(next);
        },
        // P0.7 — live checklist: each plan_todo mutation replaces the card
        // (revision-ordered, in place). Snapshot into the final message.
        onPlan: (p) => {
          const view: PlanView = { goal: p.goal, steps: p.steps, revision: p.revision };
          livePlanRef.current = view;
          setLivePlan(view);
        },
        // P3b — the git tool emitted a diff; render it as a card (latest wins
        // — a turn may diff several times, each replaces the card).
        onDiff: (d) => {
          const view: DiffView = { files: d.files, summary: d.summary };
          liveDiffRef.current = view;
          setLiveDiff(view);
        },
        // P6a — skill_manage create/patch emitted a draft; render the /learn
        // preview card (accept saves, edit re-drafts, reject discards).
        onSkillDraft: (d) => {
          const view: SkillDraftView = { name: d.name, description: d.description, markdown: d.markdown, updatedAt: d.updatedAt, status: 'pending' };
          liveDraftRef.current = view;
          setLiveDraft(view);
        },
        // PA4 — a skill loaded but needs env vars; show notification card.
        onSecretRequest: (d) => {
          setSecretRequests((prev) => {
            const idx = prev.findIndex((r) => r.skillName === d.skillName);
            if (idx >= 0) {
              const next = [...prev];
              next[idx] = d;
              return next;
            }
            return [...prev, d];
          });
        },
        // Execution result from skill execution engine.
        onExecutionResult: (d) => {
          setExecutionResults((prev) => [...prev, d]);
        },
      });
      const r = await dashboardAPI.chatSend(
        sessionId,
        clean || `(see ${chipList.length} attachment${chipList.length === 1 ? '' : 's'})`,
        {
          projectPath: attachedProject?.path,
          attachments: chipList.map((c) => ({ name: c.name, content: c.content, kind: c.kind })),
        },
        controller.signal,
      );
      abortRef.current = null;
      subRef.current?.();
      subRef.current = null;
      // P4 — the turn resolved: the streamed typewriter is replaced by the
      // authoritative content (which the final message below renders).
      streamingRef.current = '';
      setStreamingText('');
      if (r.ok) {
        setMeta(r.generationFailed ? null : `${r.provider ?? 'provider'}${r.model ? ` / ${r.model}` : ' (auto-routed)'}`);
        // P4 — a failed generation (no usable answer) offers Retry too.
        setRetryAsk(r.generationFailed ? clean : null);
        const replyContent = r.content || '(the agent produced no text — try rephrasing)';
        setMessages((m) => [
          ...m,
          {
            role: 'assistant',
            content: replyContent,
            error: r.generationFailed,
            followups: r.followups,
            steps: liveStepsRef.current,
            tools: liveToolsRef.current,
            plan: livePlanRef.current,
            diff: liveDiffRef.current,
            draft: liveDraftRef.current,
            // P2 — extract artifact cards from the answer TEXT (diff/result/
            // deploy blocks the model wrote directly, beyond the live events).
            artifacts: extractArtifacts(replyContent),
          },
        ]);
      } else {
        if (controller.signal.aborted) {
          // P4 — the user pressed Cancel: silent cleanup. The user bubble stays
          // (the message was sent), no error banner, nothing persisted
          // server-side (the console discards cancelled turns).
          setError('');
          setRetryAsk(null);
        } else if (r.unauthorized) {
          setAuth((a) => (a ? { ...a, authenticated: false } : a));
          setError('Session expired — log in again to chat.');
        } else {
          setError(r.error || 'The agent could not answer — check that a provider API key is set for the dashboard process.');
          // P4 — retry on failed turn: keep the user bubble and offer to
          // re-send the same message (previous behavior dropped it).
          setRetryAsk(clean);
        }
      }
      setBusy(false);
      // P8 — the turn resolved: bring the history rail back.
      setRailOpen(true);
    },
    [busy, attachedProject, attachments],
  );

  /** P4 — cancel the in-flight turn (aborts the POST; the server cancels it). */
  const cancelTurn = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  /**
   * P6a — the preview card's actions:
   *   ✅ accept → POST /api/skills/drafts/<name>/accept (promotes to live).
   *   ↩ reject → DELETE the draft (discarded, nothing saved).
   *   ✏️ edit   → send a chat turn asking the agent to revise the draft (the
   *               agent re-drafts via skill_manage create → a fresh card).
   */
  const acceptDraft = useCallback(async (name: string) => {
    setLiveDraft((d) => (d ? { ...d, status: 'saving' } : d));
    const r = await dashboardAPI.skillDraftAccept(name);
    setLiveDraft((d) => (d ? { ...d, status: r.ok ? 'saved' : 'error' } : d));
    if (!r.ok) setError(r.error || 'Could not accept the draft.');
  }, []);

  const rejectDraft = useCallback(async (name: string) => {
    const r = await dashboardAPI.skillDraftReject(name);
    if (r.ok) {
      setLiveDraft((d) => (d ? { ...d, status: 'rejected' } : d));
    } else {
      setError(r.error || 'Could not reject the draft.');
    }
  }, []);

  const editDraft = useCallback((name: string) => {
    // Ask the agent to revise — the draft is still pending; the agent's next
    // skill_manage create/patch emits an updated preview card.
    void send(`Revise the skill draft "${name}" — improve it per your best judgment and present it again.`);
  }, [send]);

  /** PA4 — save skill env vars from the secret request card. */
  const saveSecrets = useCallback(async (vars: Record<string, string>) => {
    const r = await dashboardAPI.saveSecrets(vars);
    if (!r.ok) setError(r.error || 'Could not save secrets.');
  }, []);

  /**
   * Run the resolved CLI command directly (the user confirmed the card).
   * P2 — instead of polling then appending plain text, this renders a LIVE
   * execution card in the thread (command, streamed logs, status, exit code,
   * cancel) via the same P1 task runner + SSE the Command Console uses.
   */
  const runResolvedCommand = useCallback(async (ask: string) => {
    const resolved = await dashboardAPI.chatResolve(ask);
    const matches = (resolved.matches ?? []) as ResolvedCommand[];
    const top = matches[0] ?? null;
    if (!top?.command) {
      setPendingResolve(null);
      return;
    }
    setPendingResolve(null);
    setBusy(true);
    // Execute via the real CLI as a task (same runner as the Command Console)
    // — deterministic, no model turn, RBAC-gated by the dashboard session.
    const argv = top.command.split(/\s+/);
    const started = await dashboardAPI.startTask(argv, 60_000);
    if (!started.ok || !started.task) {
      setError(started.error || 'The command could not be started.');
      setBusy(false);
      return;
    }
    const id = started.task.id;
    const initial: TaskRunView = {
      id,
      command: top.command,
      status: started.task.status,
      exitCode: started.task.exitCode,
      durationMs: started.task.durationMs,
      logs: started.task.logs ?? [],
    };
    // Insert the execution card into the thread; it updates in place as
    // log/status events stream in (patched by matching task id).
    setMessages((m) => [...m, { role: 'assistant', content: '', task: initial }]);
    const patch = (p: Partial<TaskRunView>) =>
      setMessages((m) => m.map((msg) => (msg.task && msg.task.id === id ? { ...msg, task: { ...msg.task, ...p } } : msg)));
    let unsub: (() => void) | null = null;
    unsub = dashboardAPI.subscribeTask(id, {
      onLog: (line) =>
        setMessages((m) =>
          m.map((msg) => (msg.task && msg.task.id === id ? { ...msg, task: { ...msg.task, logs: [...msg.task.logs, line] } } : msg)),
        ),
      onStatus: (status) => {
        patch({ status });
        if (status !== 'running') {
          // The status event carries no exit code/duration — grab one final
          // snapshot so the settled card shows them.
          void dashboardAPI.getTask(id).then((t) => {
            if (t?.task) patch({ exitCode: t.task.exitCode, durationMs: t.task.durationMs, logs: t.task.logs ?? [] });
          });
          unsub?.();
          setBusy(false);
        }
      },
    });
    // Seed with the full log snapshot (the start response may lag the run).
    const init = await dashboardAPI.getTask(id);
    if (init?.task) {
      patch({ status: init.task.status, exitCode: init.task.exitCode, durationMs: init.task.durationMs, logs: init.task.logs ?? [] });
    }
    // The task may already have settled (short command) — close the stream.
    const settled = await dashboardAPI.getTask(id);
    if (settled?.task && settled.task.status !== 'running') {
      unsub?.();
      patch({ status: settled.task.status, exitCode: settled.task.exitCode, durationMs: settled.task.durationMs, logs: settled.task.logs ?? [] });
      setBusy(false);
    }
  }, []);

  /** User declined the command card — ask the agent normally instead. */
  const declineResolvedCommand = useCallback((ask: string) => {
    setPendingResolve(null);
    void send(ask, { skipResolve: true });
  }, [send]);

  /**
   * P2 — the diff card's "Commit accepted" action. Sends the accepted file
   * subset back as a chat turn; the agent commits exactly those files via the
   * git tool's accepted-subset contract (commit with files=[...], re-confirmed
   * through ask_user) — the dashboard never re-implements diff application.
   */
  const commitAcceptedDiff = useCallback(
    (paths: string[]) => {
      if (paths.length === 0) return;
      // P2 — extracted text diffs are only selectable with an attached
      // project; name that project so the agent commits in ITS working tree
      // (not the dashboard's cwd). The engine's git tool runs in ctx.cwd.
      const where = attachedProject ? ` in the attached project ${attachedProject.path}` : '';
      void send(
        `Commit exactly these files that I accepted on the diff card (and nothing else)${where}: ${paths.join(', ')}. ` +
        `Show me a short confirmation before finishing.`,
      );
    },
    [send, attachedProject],
  );

  /** P2 — cancel a running inline command-run card. */
  const cancelTaskRun = useCallback(async (id: string) => {
    await dashboardAPI.cancelTask(id);
  }, []);

  /** P0.1 — submit the agent's clarifying-question answer; the turn resumes. */
  const answerQuestion = useCallback(
    async (selection: { index?: number | number[]; custom?: string }) => {
      const q = pendingQuestion;
      if (!q) return;
      setPendingQuestion(null);
      const r = await dashboardAPI.chatRespond(sessionIdRef.current, q.questionId, selection);
      if (!r.ok) {
        setError(r.error || 'The question could not be answered — try sending your message again.');
      }
    },
    [pendingQuestion],
  );

  const submitQuestion = useCallback(() => {
    if (!pendingQuestion) return;
    const idx = pendingQuestion.multiSelect ? [...questionSel] : [...questionSel][0];
    if (pendingQuestion.multiSelect) {
      void answerQuestion({ index: [...questionSel] });
    } else if (idx !== undefined) {
      void answerQuestion({ index: idx });
    } else {
      // No selection — skip (agent proceeds on best judgment).
      void answerQuestion({ index: -1 });
    }
  }, [pendingQuestion, questionSel, answerQuestion]);

  const skipQuestion = useCallback(() => {
    if (!pendingQuestion) return;
    void answerQuestion({ index: -1 });
  }, [pendingQuestion, answerQuestion]);

  const toggleQuestionChoice = useCallback((i: number) => {
    setQuestionSel((prev) => {
      const next = new Set(prev);
      if (pendingQuestion?.multiSelect) {
        if (next.has(i)) next.delete(i);
        else next.add(i);
      } else {
        next.clear();
        next.add(i);
      }
      return next;
    });
  }, [pendingQuestion]);

  const resetConversation = useCallback(async () => {
    // P4 — "New conversation" starts a fresh id; the CURRENT thread stays
    // persisted server-side and appears in the sidebar (resumable).
    subRef.current?.();
    subRef.current = null;
    sessionIdRef.current = newSessionId();
    setMessages([]);
    setLiveSteps([]);
    liveStepsRef.current = [];
    setLiveTools([]);
    liveToolsRef.current = [];
    setLivePlan(null);
    livePlanRef.current = null;
    setLiveDiff(null);
    liveDiffRef.current = null;
    setLiveDraft(null);
    liveDraftRef.current = null;
    streamingRef.current = '';
    setStreamingText('');
    setRetryAsk(null);
    setError('');
    setMeta(null);
    setPendingResolve(null);
    setPendingQuestion(null);
    // Refresh the sidebar (the just-abandoned session is now in it).
    const s = await dashboardAPI.listChatSessions();
    if (Array.isArray(s)) setSessions(s);
  }, []);

  const latestFollowups = [...messages].reverse().find((m) => m.role === 'assistant' && !m.error && (m.followups?.length ?? 0) > 0)?.followups ?? [];

  return (
    <div className="panel">
      <div className="panel-header">
        <h2>💬 Chat with the agent</h2>
        <div className="chat-head-actions">
          {meta ? <span className="admin-hint">{meta}</span> : null}
          <button className="admin-refresh-btn" type="button" onClick={() => void resetConversation()} disabled={busy || messages.length === 0}>
            🗑 New conversation
          </button>
        </div>
      </div>

      {!auth?.authenticated ? (
        <div className="admin-login-hint">
          <p>Log in (admin or operator) to chat with the agent. Configure the dashboard admin credential first if this is a fresh setup.</p>
          {auth?.configured === false ? (
            <p className="admin-hint">
              Run <code>buff dashboard</code> once, or set <code>BUFF_DASHBOARD_ADMIN_USER</code> / <code>BUFF_DASHBOARD_ADMIN_PASSWORD</code>.
            </p>
          ) : null}
        </div>
      ) : !canChat ? (
        <div className="admin-login-hint">
          <p>Your role can view the dashboard but not chat (requires admin or operator).</p>
        </div>
      ) : (
        <>
          <div className="chat-project-bar">
            {attachedProject ? (
              <div className="chat-project-attached">
                <span className="chat-project-icon">📁</span>
                <span className="chat-project-name">{attachedProject.name}</span>
                <span className="chat-project-meta">
                  {attachedProject.fileCount} files · {attachedProject.symbolCount} symbols{attachedProject.truncated ? ' · truncated map' : ''}
                </span>
                <span className="chat-project-path" title={attachedProject.path}>{attachedProject.path}</span>
                <button type="button" className="admin-mini-btn" onClick={() => setAttachedProject(null)}>✕ detach</button>
              </div>
            ) : (
              <div className="chat-project-pick">
                <span className="chat-project-icon">📁</span>
                <span className="chat-project-hint">Select Project Folder</span>
                {projectPick.length > 0 ? (
                  <span className="chat-project-chips">
                    {projectPick.filter((p) => p.kind !== 'cwd').slice(0, 3).map((p) => (
                      <button key={p.path} type="button" className="chat-chip" onClick={() => void attachProject(p.path)}>
                        {p.name}
                      </button>
                    ))}
                  </span>
                ) : null}
                <input
                  className="chat-project-input"
                  value={projectPathInput}
                  onChange={(e) => setProjectPathInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void attachProject(projectPathInput); } }}
                  placeholder="or type a path, e.g. ~/code/my-app"
                  disabled={busy}
                />
                <button type="button" className="admin-refresh-btn" onClick={() => void attachProject(projectPathInput)} disabled={busy || !projectPathInput.trim()}>
                  Attach
                </button>
                <button type="button" className="admin-mini-btn" onClick={() => void openNativeFolderPicker()} title="Pick a project folder using your system's folder picker (Finder / Explorer)">
                  🗂️ Browse
                </button>
                {projectError ? <span className="chat-project-error">{projectError}</span> : null}
                {browseOpen ? (
                  <div className="chat-browse-popover">
                    <div className="chat-browse-head">
                      <button type="button" className="admin-mini-btn" onClick={() => setBrowseOpen(false)} title="Close">✕</button>
                      {/* Breadcrumbs */}
                      <div className="chat-browse-breadcrumbs">
                        {browseDrives.length > 0 && !browsePath ? (
                          <span className="admin-hint">Select a drive or home folder:</span>
                        ) : (
                          <>
                            <button type="button" className="chat-breadcrumb" onClick={() => void openBrowse()}>🏠</button>
                            {browseBreadcrumbs.map((b, i) => (
                              <span key={b.path}>
                                <span className="chat-breadcrumb-sep">/</span>
                                <button type="button" className="chat-breadcrumb" onClick={() => void browseTo(b.path)}>{b.name}</button>
                              </span>
                            ))}
                          </>
                        )}
                      </div>
                    </div>
                    {/* Drive bar (Windows / Mac) */}
                    {browseDrives.length > 0 && !browsePath ? (
                      <div className="chat-browse-drives">
                        {browseDrives.map((d) => (
                          <button key={d.path} type="button" className="chat-browse-drive" onClick={() => void browseTo(d.path)}>
                            {d.name}
                          </button>
                        ))}
                      </div>
                    ) : null}
                    {/* Search filter */}
                    {browseEntries.length > 5 ? (
                      <div className="chat-browse-search">
                        <input
                          type="text"
                          className="chat-browse-filter"
                          placeholder="🔍 Filter folders…"
                          value={browseFilter}
                          onChange={(e) => setBrowseFilter(e.target.value)}
                          autoFocus
                        />
                      </div>
                    ) : null}
                    {/* Folder list */}
                    <div className="chat-browse-list">
                      {browseLoading ? (
                        <span className="admin-hint">Loading…</span>
                      ) : browseEntries.length === 0 ? (
                        <span className="admin-hint">No subdirectories found</span>
                      ) : (
                        browseEntries
                          .filter((e) => !browseFilter || e.name.toLowerCase().includes(browseFilter.toLowerCase()))
                          .map((e) => (
                            <button key={e.path} type="button" className="chat-browse-entry" onClick={() => void browseTo(e.path)}>
                              <span className="chat-browse-entry-icon">📁</span>
                              <span className="chat-browse-entry-name">{e.name}</span>
                              {e.modified ? (
                                <span className="chat-browse-entry-date">
                                  {new Date(e.modified).toLocaleDateString()}
                                </span>
                              ) : null}
                            </button>
                          ))
                      )}
                    </div>
                    <div className="chat-browse-foot">
                      <button type="button" className="admin-mini-btn" onClick={() => void refreshBrowse()} title="Refresh folder list">
                        🔄
                      </button>
                      <button type="button" className="admin-refresh-btn" onClick={() => { setBrowseOpen(false); void attachProject(browsePath); }} disabled={!browsePath}>
                        📁 Select this folder
                      </button>
                    </div>
                  </div>
                ) : null}
              </div>
            )}
          </div>
          {/* P4b — show a banner when the resumed session's project doesn't match the attached project. */}
          {sessionProjectPath && (!attachedProject || attachedProject.path !== sessionProjectPath) ? (
            <div className="chat-session-project-banner">
              <span>⚠️ This conversation was working in <code>{sessionProjectPath}</code></span>
              {!attachedProject ? (
                <button type="button" className="admin-refresh-btn" onClick={() => void attachProject(sessionProjectPath)}>
                  📁 Attach it
                </button>
              ) : (
                <button type="button" className="admin-refresh-btn" onClick={() => void attachProject(sessionProjectPath)}>
                  📁 Switch to it
                </button>
              )}
            </div>
          ) : null}
          <div className="chat-layout">
          {!railOpen ? (
            <div className="chat-rail">
              <button type="button" className="chat-rail-btn" onClick={() => setRailOpen(true)} title="Show history">
                📁
              </button>
            </div>
          ) : (
          <div className="chat-sidebar">
            <div className="chat-sidebar-head">
              <span>📁 Sessions</span>
              <div className="chat-sidebar-head-actions">
                <button type="button" className="chat-mini-action" title="New chat" onClick={newChat}>＋ New</button>
                <button type="button" className="chat-mini-action" title="Collapse history" onClick={() => setRailOpen(false)}>▸</button>
              </div>
            </div>
            <input
              className="chat-session-search"
              placeholder="Search conversations…"
              value={sessionQuery}
              onChange={(e) => setSessionQuery(e.target.value)}
            />
            {sessions.length === 0 ? (
              <div className="chat-sidebar-empty">No past conversations yet.</div>
            ) : (
              <div className="chat-sidebar-list">
                {groupSessions(sessions, sessionQuery).map(({ label, items }) => (
                  <div key={label} className="chat-session-group">
                    <div className="chat-session-group-label">{label}</div>
                    {items.map((s) => (
                      <div key={s.id} className={`chat-session-item${s.id === sessionIdRef.current ? ' chat-session-active' : ''}`}>
                        {renamingId === s.id ? (
                          <div className="chat-session-rename">
                            <input
                              autoFocus
                              value={renameValue}
                              onChange={(e) => setRenameValue(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') void commitRename(s.id);
                                if (e.key === 'Escape') setRenamingId(null);
                              }}
                              placeholder="Session title"
                            />
                            <button type="button" className="chat-mini-action" onClick={() => void commitRename(s.id)}>✓</button>
                          </div>
                        ) : (
                          <>
                            <button
                              type="button"
                              className="chat-session-main"
                              onClick={() => void resumeSession(s.id)}
                              title={s.preview || s.title}
                            >
                              <span className="chat-session-title">{s.title}</span>
                              <span className="chat-session-preview">{s.firstUser || s.preview}</span>
                              <span className="chat-session-meta">
                                {s.projectPath ? `📁 ${s.projectPath.split('/').pop()} · ` : ''}{s.turnCount} msg{s.turnCount === 1 ? '' : 's'} · {new Date(s.updatedAt).toLocaleString()}
                              </span>
                            </button>
                            <span className="chat-session-actions">
                              <button type="button" className="chat-mini-action" title="Rename" onClick={() => startRename(s)}>✏️</button>
                              <button type="button" className="chat-mini-action" title="Delete" onClick={() => void deleteSession(s.id)}>🗑</button>
                            </span>
                          </>
                        )}
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            )}
          </div>
          )}
          <div className="chat-main">
          <div className="chat-thread" ref={listRef} role="log" aria-live="polite">
            {messages.length === 0 ? (
              <div className="empty-state">
                <p className="empty-state-title">Say anything — the agent decides what to do (answer, fix code, plan, run the pipeline).</p>
                <div className="empty-state-chips">
                  <button type="button" className="chat-chip" onClick={() => void send("what's the state of this project?")}>
                    📋 assess this project
                  </button>
                  <button type="button" className="chat-chip" onClick={() => void send('run the test suite')}>
                    🧪 run the tests
                  </button>
                  <button type="button" className="chat-chip" onClick={() => void send('stop the gateway')}>
                    ⏹ stop the gateway
                  </button>
                  {/* P6e — the shipable first-party batch is the entry point: a
                      new user sees the skill suggestions in the empty state. */}
                  <button type="button" className="chat-chip" onClick={() => void send('load the code-assessment skill and assess this project')}>
                    🧠 load the code-assessment skill
                  </button>
                  <button type="button" className="chat-chip" onClick={() => void send('learn the workflow I just did as a skill')}>
                    📚 learn a workflow as a skill
                  </button>
                  <button type="button" className="chat-chip" onClick={() => void send('publish the current version')}>
                    🚀 publish the release
                  </button>
                </div>
              </div>
            ) : (
              messages.map((m, i) => (
                <div key={i} className={`chat-bubble chat-${m.role}${m.error ? ' chat-error' : ''}`}>
                  <div className="chat-bubble-role">{m.role === 'user' ? 'You' : '🤖 Agent'}</div>
                  {m.role === 'assistant' ? (
                    <div className="chat-bubble-text"><Markdown text={m.content} /></div>
                  ) : (
                    <div className="chat-bubble-text">{m.content}</div>
                  )}
                  {m.role === 'user' && m.attachments && m.attachments.length > 0 ? (
                    <details className="chat-steps" open={m.attachments.length === 1}>
                      <summary>
                        📎 {m.attachments.length} attachment{m.attachments.length === 1 ? '' : 's'}:{' '}
                        {m.attachments.map((a) => a.name).join(', ')}
                      </summary>
                      {m.attachments.map((a, ai) => (
                        <div key={ai} className="chat-attach-content">
                          <div className="admin-hint">{a.name} — {a.content.length.toLocaleString()} chars</div>
                          <pre>{a.content}</pre>
                        </div>
                      ))}
                    </details>
                  ) : null}
                  {m.role === 'assistant' && m.diff ? (
                    <details className="chat-steps" open>
                      <summary>Changes: {m.diff.summary}</summary>
                      {/* P2 — the snapshotted git diff is SELECTABLE: per-file
                          accept/reject + "Commit accepted" (the engine commits
                          only the accepted subset). */}
                      <DiffCard diff={m.diff} selectable onCommitAccepted={commitAcceptedDiff} />
                    </details>
                  ) : null}
                  {m.role === 'assistant' && m.artifacts && (m.artifacts.diffs.length > 0 || m.artifacts.results.length > 0 || m.artifacts.deploys.length > 0) ? (
                    // P2 — the artifact stack is a keyboard-navigable list:
                    // ↑/↓ moves between cards, Home/End jumps to the ends.
                    <ArtifactNav>
                      {m.artifacts.diffs.map((d, di) => (
                        <div key={`diff-${di}`} data-artifact-card tabIndex={0} role="group" aria-label={`Diff: ${d.summary}`} className="chat-artifact-item">
                          {/* P2 — extracted TEXT diffs are selectable only with
                              an attached project: the diff plausibly refers to
                              that working tree. Without one, the diff is prose
                              with no known repo — read-only + a hint, so a
                              stray ```diff block can never trigger a commit. */}
                          {attachedProject ? (
                            <DiffCard diff={d} selectable onCommitAccepted={commitAcceptedDiff} />
                          ) : (
                            <DiffCard diff={d} lockedHint="Attach a project to review and commit these changes." />
                          )}
                        </div>
                      ))}
                      {m.artifacts.results.map((r, ri) => (
                        <div key={`result-${ri}`} data-artifact-card tabIndex={0} role="group" aria-label={`Result: ${r.title}`} className="chat-artifact-item">
                          <ResultCard result={r} />
                        </div>
                      ))}
                      {m.artifacts.deploys.map((d, di) => (
                        <div key={`deploy-${di}`} data-artifact-card tabIndex={0} role="group" aria-label={`Deployment: ${d.url}`} className="chat-artifact-item">
                          <DeployCard deploy={d} />
                        </div>
                      ))}
                    </ArtifactNav>
                  ) : null}
                  {m.role === 'assistant' && m.task ? (
                    <TaskRunCard task={m.task} onCancel={m.task.status === 'running' ? () => void cancelTaskRun(m.task!.id) : undefined} />
                  ) : null}
                  {m.role === 'assistant' && m.draft ? (
                    <details className="chat-steps" open>
                      <summary>Skill draft: {m.draft.name}</summary>
                      <SkillDraftCard draft={m.draft} onAccept={acceptDraft} onReject={rejectDraft} onEdit={editDraft} />
                    </details>
                  ) : null}
                  {m.role === 'assistant' && m.plan ? (
                    <details className="chat-steps" open>
                      <summary>Plan: {m.plan.goal}</summary>
                      <PlanCard plan={m.plan} />
                    </details>
                  ) : null}
                  {m.role === 'assistant' && m.tools && m.tools.length > 0 ? (
                    <details className="chat-steps" open>
                      <summary>
                        {m.tools.length} tool call{m.tools.length === 1 ? '' : 's'}
                      </summary>
                      <ToolCards tools={m.tools} />
                    </details>
                  ) : null}
                  {m.role === 'assistant' && m.steps && m.steps.length > 0 ? (
                    <details className="chat-steps">
                      <summary>{m.steps.length} step{m.steps.length === 1 ? '' : 's'}</summary>
                      <div className="chat-step-line">
                        {m.steps.map((l, j) => <div key={j}>{l.trim()}</div>)}
                      </div>
                    </details>
                  ) : null}
                </div>
              ))
            )}
            {busy ? (
              <div className="chat-bubble chat-assistant">
                <div className="chat-bubble-role">🤖 Agent</div>
                {livePlan ? <PlanCard plan={livePlan} /> : null}
                {liveDiff ? <DiffCard diff={liveDiff} /> : null}
                {liveDraft ? <SkillDraftCard draft={liveDraft} onAccept={acceptDraft} onReject={rejectDraft} onEdit={editDraft} /> : null}
                {secretRequests.map((sr) => (
                  <SecretRequestCard key={sr.skillName} request={sr} onSave={saveSecrets} />
                ))}
                {executionResults.map((er, idx) => (
                  <ExecutionResultCard key={`${er.skillName}-${idx}`} result={er} />
                ))}
                <ToolCards tools={liveTools} live />
                {streamingText ? (
                  <div className="chat-bubble-text chat-streaming">
                    <Markdown text={streamingText} />
                  </div>
                ) : null}
                <div className="chat-working">
                  {liveSteps.length > 0 ? (
                    <span className="chat-working-lines">
                      {liveSteps.map((l, i) => <div key={i} className="chat-step-line">{l.trim()}</div>)}
                    </span>
                  ) : (
                    <>💭 thinking… <span className="chat-dots" /></>
                  )}
                </div>
              </div>
            ) : null}
          </div>

          {error ? <div className="admin-row-msg admin-row-msg-err">{error}</div> : null}

          {retryAsk && !busy ? (
            <div className="chat-retry-row">
              <button className="admin-refresh-btn" type="button" onClick={() => void send(retryAsk)}>
                ↻ Retry
              </button>
              <span className="admin-hint">Re-send the last message — the turn failed.</span>
            </div>
          ) : null}

          {pendingResolve && !busy ? (
            <div className="chat-resolve-card">
              {pendingResolve.top?.ambiguous && pendingResolve.top.options?.length ? (
                <>
                  <div className="chat-resolve-head">
                    <strong>🤔 Which do you mean?</strong> — "{pendingResolve.ask}" maps to more than one action.
                  </div>
                  <div className="chat-resolve-options">
                    {pendingResolve.top.options.map((o) => (
                      <button key={o.command} className="chat-chip" type="button" onClick={() => void send(o.command)}>
                        {o.summary} — <code>{o.command}</code>
                      </button>
                    ))}
                  </div>
                  <div className="chat-resolve-foot">
                    <button className="admin-mini-btn" type="button" onClick={() => { setPendingResolve(null); }}>✕ Not that — ask the agent</button>
                  </div>
                </>
              ) : (
                <>
                  <div className="chat-resolve-head">
                    <strong>⚡ Run this command?</strong> — "{pendingResolve.ask}"
                  </div>
                  <div className="chat-resolve-cmd"><code>{pendingResolve.top?.command}</code></div>
                  {pendingResolve.top?.confirmation ? (
                    <div className="admin-hint">⚠ This changes running services/state.</div>
                  ) : null}
                  <div className="chat-resolve-foot">
                    <button className="admin-refresh-btn" type="button" onClick={() => void runResolvedCommand(pendingResolve.ask)}>
                      ▶ Run
                    </button>
                    <button className="admin-mini-btn" type="button" onClick={() => declineResolvedCommand(pendingResolve.ask)}>
                      ✕ No — ask the agent
                    </button>
                  </div>
                </>
              )}
            </div>
          ) : null}

          {pendingQuestion ? (
            <div className="chat-resolve-card chat-question-card">
              <div className="chat-resolve-head">
                <strong>🤔 {pendingQuestion.question}</strong>
              </div>
              <div className="chat-resolve-options">
                {pendingQuestion.choices.map((c, i) => (
                  <button
                    key={`${c.label}-${i}`}
                    type="button"
                    className={`chat-chip${questionSel.has(i) ? ' chat-chip-selected' : ''}`}
                    onClick={() => toggleQuestionChoice(i)}
                  >
                    {c.label}
                    {c.description ? <span className="admin-hint"> — {c.description}</span> : null}
                  </button>
                ))}
              </div>
              <div className="chat-resolve-foot">
                <button className="admin-refresh-btn" type="button" onClick={submitQuestion}>
                  {pendingQuestion.multiSelect ? 'Submit' : 'Choose'}
                </button>
                <button className="admin-mini-btn" type="button" onClick={skipQuestion}>
                  Skip — best judgment
                </button>
              </div>
            </div>
          ) : null}

          {latestFollowups.length > 0 && !busy ? (
            <div className="chat-followups">
              <span className="admin-hint">Next steps:</span>
              {latestFollowups.map((f, i) => (
                <button key={i} className="chat-chip" type="button" onClick={() => void send(f.prompt)}>
                  {f.label || f.prompt}
                </button>
              ))}
            </div>
          ) : null}

          <form
            className={`chat-composer${dragOver ? ' chat-composer-drag' : ''}`}
            onSubmit={(e) => { e.preventDefault(); void send(input); }}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              const files = Array.from(e.dataTransfer?.files ?? []);
              for (const f of files.slice(0, 10)) void pickFile(f);
            }}
          >
            {pasteOffer ? (
              <div className="chat-paste-offer">
                <span className="admin-hint">
                  📄 You pasted {pasteOffer.text.length.toLocaleString()} characters. Attach it as a file instead?
                </span>
                <button type="button" className="chat-chip" onClick={acceptPasteOffer}>Attach as text</button>
                <button type="button" className="chat-mini-action" onClick={() => { setPasteOffer(null); pastePosRef.current = null; }}>Keep inline</button>
              </div>
            ) : null}
            {attachments.length > 0 ? (
              <div className="chat-attach-row">
                {attachments.map((a, i) => (
                  <span key={`${a.name}-${i}`} className="chat-attach-chip" title={`${a.name} (${a.content.length.toLocaleString()} chars)`}>
                    📎 {a.name}
                    <span className="admin-hint"> {a.content.length.toLocaleString()}c</span>
                    <button type="button" className="chat-mini-action" onClick={() => removeAttachment(i)}>✕</button>
                  </span>
                ))}
              </div>
            ) : null}
            <div className="chat-input-row">
              <input
                ref={fileInputRef}
                type="file"
                style={{ display: 'none' }}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void pickFile(f);
                  e.target.value = '';
                }}
              />
              <button
                type="button"
                className="chat-attach-btn"
                title="Attach a file (up to 300 KB, text only)"
                disabled={busy || attachments.length >= 10}
                onClick={() => fileInputRef.current?.click()}
              >
                📎
              </button>
              <textarea
                className="chat-input-box"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onPaste={handlePaste}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    void send(input);
                  } else if (e.key === 'ArrowUp' && input === '' && lastSentRef.current) {
                    // ↑ on an empty box recalls the last sent message (Phase 6).
                    e.preventDefault();
                    setInput(lastSentRef.current);
                  }
                }}
                placeholder="Message the agent… (Enter to send · Shift+Enter for a new line · ↑ recalls last · 📎 attach a file or paste a large document)"
                disabled={busy}
                maxLength={8000}
                rows={1}
                autoFocus
              />
              {busy ? (
                <button className="admin-mini-btn chat-cancel-btn" type="button" onClick={cancelTurn}>
                  ⏹ Cancel
                </button>
              ) : null}
              <button className="admin-refresh-btn" type="submit" disabled={busy || (!input.trim() && attachments.length === 0)}>
                {busy ? '⏳ Working…' : '➤ Send'}
              </button>
            </div>
          </form>
          <p className="admin-hint">
            Each message runs the full agent loop in the dashboard process (same engine as{' '}
            <code>buff chat "&lt;prompt&gt;"</code>) — the provider API keys must be configured in the dashboard
            process. Clarifications (<code>ask_user</code>) appear as a question card here — choose an answer or
            skip (best judgment).
          </p>
          </div>
          </div>
        </>
      )}
    </div>
  );
}
