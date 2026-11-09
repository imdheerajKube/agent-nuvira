/**
 * The guidance lane — the second, always-available input channel while a run is
 * active.
 *
 * The main composer is intentionally locked during a turn: the original task is
 * stable. This panel is a separate lane that submits to a durable inbox, shows
 * what the change was understood as, and lets the user approve or reject material
 * changes. It renders nothing when the deployment flag is off.
 *
 * Accessibility: every outcome is announced through an aria-live region, status
 * is always glyph + word (never colour alone), and the approval buttons are
 * ordinary keyboard-focusable buttons.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import {
  steeringBacklog,
  steeringClose,
  steeringDecide,
  steeringDiscuss,
  steeringGet,
  steeringGuide,
  steeringInterpret,
} from '../api';
import type { SteeringBacklogItem, SteeringChangeRecord, SteeringProjection } from '../types';

interface SteeringPanelProps {
  sessionId: string;
  busy: boolean;
  /**
   * Hand a backlog item's prompt to a fresh chat. The page owns "new chat"
   * (session id, persisted id, cleared transcript), so the panel only states the
   * intent and the page decides how to realise it.
   */
  onStartTask?: (prompt: string) => void;
}

function statusChip(status: string): string {
  switch (status) {
    case 'received':
      return '⏳ received';
    case 'triaging':
      return '🔎 assessing';
    case 'triaged':
      return '📋 assessed';
    case 'needs_approval':
      return '🛑 needs approval';
    case 'accepted':
    case 'scheduled':
      return '🕓 queued for next safe point';
    case 'applied':
      return '✅ applied';
    case 'deferred':
      return '⏸ deferred';
    case 'answer_only':
      return '💬 answered';
    case 'backlog':
      return '🗂 backlog';
    case 'rejected':
      return '⛔ rejected';
    case 'stale':
      return '⚠️ stale — plan moved first';
    case 'failed':
      return '⚠️ failed to apply';
    case 'withdrawn':
      return '↩️ withdrawn';
    default:
      return status;
  }
}

const ESCALATION_TEXT: Record<string, string> = {
  high_impact: 'high impact — it can change material work',
  conflict: 'conflicts with an existing requirement',
  supersedes_approved_requirement: 'supersedes an approved requirement',
  irreversible: 'not automatically reversible',
  removes_completed_work: 'touches work that is already complete',
  steward_requested: 'the assessor flagged it as material',
  policy_override_attempt: 'attempts to change the safety policy',
};

function escalationTexts(codes: string[] | undefined): string[] {
  return (codes ?? []).map((code) => ESCALATION_TEXT[code] ?? code.replace(/_/g, ' '));
}

function proofTime(iso?: string): string {
  if (!iso) return '';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

function ids(values: string[], max = 4): string {
  const shown = values.slice(0, max).join(', ');
  return values.length > max ? `${shown} +${values.length - max} more` : shown;
}

function diffLine(change: SteeringChangeRecord): string | null {
  const diff = change.planDiff;
  if (!diff) return null;
  const parts: string[] = [];
  if (diff.added.length) parts.push(`added: ${ids(diff.added)}`);
  if (diff.updated.length) parts.push(`changed: ${ids(diff.updated)}`);
  if (diff.removed.length) parts.push(`removed: ${ids(diff.removed)}`);
  if (diff.cancelled.length) parts.push(`cancelled (future only): ${ids(diff.cancelled)}`);
  if (diff.constraintsAdded.length) parts.push(`constraints: ${ids(diff.constraintsAdded, 2)}`);
  return parts.length ? `plan v${change.planVersion ?? '?'} · ${parts.join(' · ')}` : null;
}

function ChangeRow({
  change,
  onDecision,
  onInterpret,
  onCapture,
}: {
  change: SteeringChangeRecord;
  onDecision: (changeId: string, action: 'approve' | 'reject' | 'defer' | 'withdraw') => void;
  onInterpret: (changeId: string, choice: 'guidance' | 'new_task' | 'question') => void;
  onCapture: (changeId: string) => void;
}) {
  const assessment = change.assessment;
  const diff = diffLine(change);
  return (
    <li className="steering-row">
      <div className="steering-row-head">
        <span className="steering-id">{change.id}</span>
        <span className={`steering-chip steering-chip-${change.status}`}>{statusChip(change.status)}</span>
      </div>
      <div className="steering-text">{change.rawText}</div>
      {assessment ? (
        <>
          <div className="admin-hint">
            {assessment.relation.replace(/_/g, ' ')} · {assessment.kind.replace(/_/g, ' ')} ·{' '}
            {assessment.impact} impact · {Math.round(assessment.confidence * 100)}% confidence
            {assessment.affectedStepIds.length > 0
              ? ` · affects ${assessment.affectedStepIds.join(', ')}`
              : ''}
          </div>
          {assessment.rationale ? (
            <div className="admin-hint">Assessment: {assessment.rationale}</div>
          ) : null}
          {assessment.conflictsWith.length > 0 || assessment.supersedes.length > 0 ? (
            <div className="admin-hint">
              {assessment.conflictsWith.length > 0
                ? `Conflicts with: ${ids(assessment.conflictsWith)}`
                : ''}
              {assessment.conflictsWith.length > 0 && assessment.supersedes.length > 0 ? ' · ' : ''}
              {assessment.supersedes.length > 0
                ? `Supersedes: ${ids(assessment.supersedes)}`
                : ''}
            </div>
          ) : null}
        </>
      ) : null}
      {change.decision?.reason &&
      change.decision.reason.trim() !== change.assessment?.rationale?.trim() ? (
        <div className="steering-reason">{change.decision.reason}</div>
      ) : null}
      {change.decision?.escalations?.length ? (
        <div className="steering-escalation">
          Why this needs you: {escalationTexts(change.decision.escalations).join(' · ')}
        </div>
      ) : null}
      {change.decision?.approvalEffect ? (
        <div className="admin-hint">{change.decision.approvalEffect}</div>
      ) : null}
      {diff ? <div className="admin-hint">{diff}</div> : null}
      {change.status === 'applied' || change.directive ? (
        <details className="steering-proof">
          <summary className="admin-hint">
            Proof — what the executor received · received {proofTime(change.submittedAt)}
            {typeof change.triageLatencyMs === 'number'
              ? ` · triaged in ${change.triageLatencyMs} ms`
              : ''}
            {change.appliedAt ? ` · applied ${proofTime(change.appliedAt)}` : ''}
          </summary>
          {change.decision ? (
            <div className="admin-hint">
              Decision: {change.decision.action} — {change.decision.reason}
            </div>
          ) : null}
          <pre className="steering-proof-text">
            {change.directive ??
              'No directive was issued: this change did not produce a plan version.'}
          </pre>
        </details>
      ) : null}
      {change.failure ? <div className="steering-error">{change.failure}</div> : null}
      {change.decision?.action === 'confirm_interpretation' ? (
        <div className="steering-actions">
          <span className="admin-hint">How should I treat this?</span>
          {/* Deliberately NOT disabled while the turn is busy: a decision is a
              durable record that the run applies at its next safe point, not an
              action on the live turn. Freezing it made the user wait for the
              very run they were trying to steer (measured 2026-11-09). */}
          <button type="button" className="admin-refresh-btn" onClick={() => onInterpret(change.id, 'guidance')}>
            Current task
          </button>
          <button type="button" className="admin-refresh-btn" onClick={() => onInterpret(change.id, 'new_task')}>
            New task
          </button>
          <button type="button" className="admin-refresh-btn" onClick={() => onInterpret(change.id, 'question')}>
            Just a question
          </button>
        </div>
      ) : null}
      {change.status === 'needs_approval' ? (
        <div className="steering-actions">
          <button type="button" className="admin-refresh-btn" onClick={() => onDecision(change.id, 'approve')}>
            Approve
          </button>
          <button type="button" className="admin-refresh-btn" onClick={() => onDecision(change.id, 'reject')}>
            Reject
          </button>
          <button type="button" className="admin-refresh-btn" onClick={() => onDecision(change.id, 'defer')}>
            Defer
          </button>
          <button type="button" className="admin-refresh-btn" onClick={() => onDecision(change.id, 'withdraw')}>
            Withdraw
          </button>
        </div>
      ) : change.status === 'received' || change.status === 'triaged' || change.status === 'deferred' ? (
        <div className="steering-actions">
          <button type="button" className="admin-refresh-btn" onClick={() => onDecision(change.id, 'withdraw')}>
            Withdraw
          </button>
        </div>
      ) : null}
      {change.status === 'rejected' || change.status === 'stale' || change.status === 'failed' ? (
        <div className="steering-actions">
          <button type="button" className="admin-refresh-btn" onClick={() => onCapture(change.id)}>
            Send to backlog
          </button>
        </div>
      ) : null}
    </li>
  );
}

export default function SteeringPanel({ sessionId, busy, onStartTask }: SteeringPanelProps) {
  const [view, setView] = useState<SteeringProjection | null>(null);
  const [runs, setRuns] = useState<
    Array<{ runId: string; status: string; goal: string; stale?: boolean }>
  >([]);
  const [activeRunId, setActiveRunId] = useState(sessionId);
  const [text, setText] = useState('');
  const [discuss, setDiscuss] = useState('');
  const [answer, setAnswer] = useState('');
  const [answerSource, setAnswerSource] = useState<'model' | 'deterministic' | ''>('');
  const [receipt, setReceipt] = useState('');
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const guidanceRef = useRef<HTMLTextAreaElement>(null);
  const [copied, setCopied] = useState('');
  const [backlogBusy, setBacklogBusy] = useState('');

  // P2.2 cross-surface continuity: the same durable run is readable from the
  // dashboard, the CLI and any gateway sender. The picker lists every run this
  // store knows, so a change submitted from `nuvira steer` is visible (and
  // decidable) here without switching processes.
  useEffect(() => {
    setActiveRunId(sessionId);
  }, [sessionId]);

  const refresh = useCallback(async () => {
    const [result, all] = await Promise.all([steeringGet(activeRunId), steeringGet()]);
    if (result.ok) setView(result.projection ?? null);
    if (all.ok) setRuns(all.runs ?? []);
  }, [activeRunId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => void refresh(), 2500);
    return () => clearInterval(timer);
  }, [busy, refresh]);

  /**
   * First-class pause/stop. These are ordinary control guidance: the prefilter
   * recognises them deterministically, the scheduler records them, and the safe
   * point reports the control BEFORE any plan write. No raw text reaches the
   * executor and no model is required.
   */
  const control = async (action: 'pause' | 'stop') => {
    if (sending) return;
    setSending(true);
    setError('');
    const result = await steeringGuide({ runId: activeRunId, text: action });
    setSending(false);
    if (!result.ok) {
      setError(result.error ?? `Could not ${action} the run.`);
      return;
    }
    setReceipt(
      action === 'stop'
        ? '⏹ Stop requested — the run ends at the next safe point; its plan and queue are preserved.'
        : '⏸ Pause requested — the run holds at the next safe point and stays resumable.',
    );
    if (result.projection) setView(result.projection);
  };

  const send = async (intentHint: 'guidance' | 'question' | 'new_task') => {
    const value = text.trim();
    if (!value || sending) return;
    setSending(true);
    setError('');
    const result = await steeringGuide({ runId: activeRunId, text: value, intentHint });
    if (!result.ok) {
      setError(result.error ?? 'Could not submit guidance.');
    } else {
      setReceipt(
        `📨 Received ${result.change?.id ?? ''}. ${
          result.deduped ? 'This duplicates an item already in the queue.' : 'Assessing relevance and impact…'
        }`,
      );
      setText('');
      if (result.projection) setView(result.projection);
      // A question is answer-only. The durable record is the audit trail; the
      // readable answer comes from the read-only discuss path, which has no
      // authority to change the plan.
      if (intentHint === 'question') {
        const answered = await steeringDiscuss({ runId: activeRunId, question: value });
        if (answered.ok) {
          setAnswer(answered.answer ?? '');
          setAnswerSource(answered.source ?? '');
        }
      }
    }
    setSending(false);
  };

  const interpret = async (
    changeId: string,
    choice: 'guidance' | 'new_task' | 'question',
  ) => {
    setError('');
    const result = await steeringInterpret({ runId: activeRunId, changeId, choice });
    if (!result.ok) {
      setError(result.error ?? `Could not interpret ${changeId}.`);
      return;
    }
    setReceipt(
      `🧭 ${changeId} — ${choice === 'new_task' ? 'treated as a separate task; it will be backlogged' : choice === 'question' ? 'treated as a question' : 'treated as a change to the current task'}.`,
    );
    if (result.projection) setView(result.projection);
    if (choice === 'question' && result.change) {
      const answered = await steeringDiscuss({ runId: activeRunId, question: result.change.rawText });
      if (answered.ok) {
        setAnswer(answered.answer ?? '');
        setAnswerSource(answered.source ?? '');
      }
    }
  };

  const decide = async (changeId: string, action: 'approve' | 'reject' | 'defer' | 'withdraw') => {
    setError('');
    const result = await steeringDecide({ runId: activeRunId, changeId, action });
    if (!result.ok) setError(result.error ?? `Could not ${action} ${changeId}.`);
    else {
      setReceipt(
        `✅ ${changeId} — ${
          action === 'approve'
            ? 'approved; it will apply at the next safe point'
            : action === 'reject'
              ? 'rejected; the run is unchanged'
              : action === 'withdraw'
                ? 'withdrawn'
                : 'deferred; it stays visible'
        }.`,
      );
      if (result.projection) setView(result.projection);
      else void refresh();
    }
  };

  const ask = async () => {
    const question = discuss.trim();
    if (!question) return;
    setError('');
    setAnswer('…');
    setAnswerSource('');
    const result = await steeringDiscuss({ runId: activeRunId, question });
    if (!result.ok) {
      setAnswer('');
      setError(result.error ?? 'Could not answer that question.');
    } else {
      setAnswer(result.answer ?? '');
      setAnswerSource(result.source ?? '');
    }
  };

  /**
   * Move the read-only answer's question into the guidance field.
   *
   * The button used to set a textarea that was not rendered while this chat's
   * turn was busy, so it looked like it did nothing. The field is now always
   * available during a live run; this moves the text there, focuses it, and
   * says plainly that it has not been sent yet.
   */
  const promote = () => {
    const value = discuss.trim();
    if (!value) return;
    setText(value);
    setDiscuss('');
    setAnswer('');
    setAnswerSource('');
    setReceipt(
      '🧭 Moved the question into the guidance field — edit it into an instruction, then press Send guidance.',
    );
    requestAnimationFrame(() => guidanceRef.current?.focus());
  };

  const capture = async (changeId: string) => {
    setError('');
    const result = await steeringBacklog({ runId: activeRunId, action: 'capture', changeId });
    if (!result.ok) {
      setError(result.error ?? `Could not add ${changeId} to the backlog.`);
      return;
    }
    setReceipt(`🗂 ${changeId} captured in the backlog; it is not part of this run.`);
    void refresh();
  };

  const createTask = async (item: SteeringBacklogItem) => {
    setBacklogBusy(item.id);
    setError('');
    const result = await steeringBacklog({ runId: activeRunId, backlogId: item.id, action: 'create-task' });
    setBacklogBusy('');
    if (!result.ok) {
      setError(result.error ?? 'Could not prepare the task.');
      return;
    }
    setReceipt(
      item.status === 'scheduled'
        ? '🗂 Command copied again — this task is still waiting for you to start it.'
        : '🗂 Task prepared and its command copied. Start it in a new chat when ready.',
    );
    if (result.projection) setView(result.projection);
    try {
      await navigator.clipboard?.writeText(result.command ?? result.prompt ?? '');
      setCopied(item.id);
    } catch {
      setCopied('');
    }
    void refresh();
  };

  /**
   * "Start as new task": mark the item scheduled (the same durable handoff as
   * Create task), then hand its prompt to a fresh chat. The prompt is the
   * server's canonical one, so the new chat says exactly what the backlog holds.
   */
  const startTask = async (item: SteeringBacklogItem) => {
    setBacklogBusy(item.id);
    setError('');
    const result = await steeringBacklog({ runId: activeRunId, backlogId: item.id, action: 'create-task' });
    setBacklogBusy('');
    if (!result.ok) {
      setError(result.error ?? 'Could not prepare the task.');
      return;
    }
    if (result.projection) setView(result.projection);
    setReceipt('🧭 Starting a new chat with this task…');
    onStartTask?.(
      result.prompt ?? [item.title, item.description].filter(Boolean).join('\n\n'),
    );
  };

  const dismissTask = async (item: SteeringBacklogItem) => {
    setBacklogBusy(item.id);
    setError('');
    const result = await steeringBacklog({ runId: activeRunId, backlogId: item.id, action: 'dismiss' });
    setBacklogBusy('');
    if (!result.ok) {
      setError(result.error ?? `Could not dismiss ${item.id}.`);
      return;
    }
    setReceipt(`🗂 ${item.id} dismissed — it stays in the run journal.`);
    if (result.projection) setView(result.projection);
    else void refresh();
  };

  // P3.1: closing is only offered for a stale run; the server refuses a live
  // lease, so this button cannot terminate a run that is still working.
  const closeRun = async () => {
    setError('');
    const result = await steeringClose(activeRunId);
    if (!result.ok) {
      setError(result.error ?? 'Could not close the run.');
      return;
    }
    setReceipt('⏹ Closed the stale run. Its plan and guidance queue are preserved for inspection.');
    if (result.projection) setView(result.projection);
    void refresh();
  };

  if (!view) return null;
  if (!view.enabled) return null;
  // A fresh chat has no run of its own, even when the durable store still lists
  // older runs. Rendering this panel then put a dead guidance composer above the
  // normal task box, and its Pause/Stop buttons targeted a run id that did not
  // exist yet.
  if (!view.run) return null;

  // The chat composer is the guidance input while THIS run is live. Keeping a
  // second guidance box here made the dashboard show three text fields at once
  // (panel guidance, read-only discuss, main composer) for one task.
  const currentRunBusy = busy && activeRunId === sessionId;
  const runActive = view.run.status === 'running' || view.run.status === 'paused';

  const counts = view.counts;
  const open = view.changes.filter(
    (change) => change.status !== 'applied' && change.status !== 'rejected' && change.status !== 'withdrawn',
  );
  const recentApplied = view.changes.filter((change) => change.status === 'applied').slice(-4).reverse();
  const visibleBacklog = view.backlog.filter((item) => item.status !== 'dismissed');
  const plan = view.plan;
  const done = plan?.steps.filter((step) => step.status === 'done').length ?? 0;

  return (
    <section className="steering-panel" aria-label="Mid-run guidance">
      <div className="steering-head">
        <strong>Guidance</strong>
        <span className="admin-hint">
          main task locked · {view.run?.status ?? 'no run'} · plan v{plan?.version ?? 0} · {done}/
          {plan?.steps.length ?? 0} steps done
        </span>
        {runs.length > 1 ? (
          <select
            className="steering-run-picker"
            aria-label="Steering run"
            value={activeRunId}
            onChange={(event) => setActiveRunId(event.target.value)}
          >
            {runs.map((run) => (
              <option key={run.runId} value={run.runId}>
                {run.runId.slice(0, 14)} · {run.status}
                {run.stale ? ' · stale' : ''}
              </option>
            ))}
          </select>
        ) : null}
      </div>
      {view.run?.stale ? (
        <div className="steering-stale" role="alert">
          ⚠ This run looks stale — its lease expired, so nothing is applying guidance.
          {view.run.staleSince ? ` Since ${proofTime(view.run.staleSince)}.` : ''} Closing keeps the
          plan and queue for inspection.
          <button type="button" className="admin-refresh-btn" onClick={() => void closeRun()}>
            Close stale run
          </button>
        </div>
      ) : null}
      <div className="steering-counts admin-hint">
        {counts.open} open · {counts.applied} applied · {counts.needsApproval} awaiting approval ·{' '}
        {counts.deferred} deferred · {counts.stale} stale · {counts.backlog} backlogged ·{' '}
        {counts.rejected} rejected
      </div>
      <div className="steering-counts admin-hint">
        {view.metrics.guidanceReceived} received · triage avg {view.metrics.avgTriageLatencyMs}ms / p95{' '}
        {view.metrics.p95TriageLatencyMs}ms · apply avg {view.metrics.avgTimeToApplyMs}ms ·{' '}
        {Math.round(view.metrics.staleRate * 100)}% stale ·{' '}
        {view.metrics.abandonedApprovals} expired approval(s) · approval avg{' '}
        {view.metrics.avgApprovalLatencyMs}ms · {view.metrics.needsApproval} awaiting approval ·{' '}
        {view.metrics.highImpactFalseAccepts} high-impact false accepts ·{' '}
        {view.metrics.lowConfidenceCount} low-confidence assessments
      </div>

      {!runActive ? (
        <div className="steering-compose-hint admin-hint">
          This run is {view.run.status}; guidance is closed. Start a new turn to steer it.
        </div>
      ) : (
        <div className="steering-compose">
          <textarea
            ref={guidanceRef}
            className="steering-input"
            value={text}
            maxLength={8000}
            rows={2}
            placeholder="Guide the run: add a requirement, correct an assumption, say what not to touch…"
            onChange={(event) => setText(event.target.value)}
            aria-label="Guidance text"
          />
          <div className="steering-actions">
            <button type="button" className="admin-refresh-btn" disabled={sending || !text.trim()} onClick={() => void send('guidance')}>
              Send guidance
            </button>
            <button type="button" className="admin-refresh-btn" disabled={sending || !text.trim()} onClick={() => void send('question')}>
              Ask a question
            </button>
            <button type="button" className="admin-refresh-btn" disabled={sending || !text.trim()} onClick={() => void send('new_task')}>
              New task
            </button>
            <button type="button" className="admin-refresh-btn" disabled={sending} onClick={() => void control('pause')}>
              ⏸ Pause run
            </button>
            <button type="button" className="admin-refresh-btn" disabled={sending} onClick={() => void control('stop')}>
              ⏹ Stop run
            </button>
          </div>
          <div className="admin-hint">
            {currentRunBusy
              ? 'The chat composer below also adds to this run. These buttons work while it is busy.'
              : 'Guidance is assessed, then applied at the next safe point. New tasks go to the backlog, never this run.'}
          </div>
        </div>
      )}

      <div className="steering-live" aria-live="polite" role="status">
        {receipt}
        {error ? <span className="steering-error"> {error}</span> : null}
      </div>

      {open.length > 0 ? (
        <ul className="steering-list">
          {open.slice(-12).map((change) => (
            <ChangeRow
              key={change.id}
              change={change}
              onDecision={(id, action) => void decide(id, action)}
              onInterpret={(id, choice) => void interpret(id, choice)}
              onCapture={(id) => void capture(id)}
            />
          ))}
        </ul>
      ) : (
        <div className="admin-hint">No open guidance.</div>
      )}

      {recentApplied.length > 0 ? (
        <details className="steering-applied">
          <summary className="admin-hint">Applied changes ({counts.applied})</summary>
          <ul className="steering-list">
            {recentApplied.map((change) => (
              <ChangeRow
                key={change.id}
                change={change}
                onDecision={() => undefined}
                onInterpret={() => undefined}
                onCapture={() => undefined}
              />
            ))}
          </ul>
        </details>
      ) : null}

      <details className="steering-discuss">
        <summary className="admin-hint">Ask about this run (read-only — never changes the plan)</summary>
        <div className="steering-discuss-body">
          <div className="steering-actions">
            <input
              id={`steering-discuss-${sessionId}`}
              className="steering-input"
              value={discuss}
              aria-label="Read-only question about this run"
              placeholder="e.g. what is left, and why is step 4 blocked?"
              onChange={(event) => setDiscuss(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  void ask();
                }
              }}
            />
            <button type="button" className="admin-refresh-btn" disabled={!discuss.trim()} onClick={() => void ask()}>
              Ask
            </button>
          </div>
          {answer ? (
            <div className="steering-answer">
              {answer}
              {answerSource === 'deterministic' ? (
                <div className="admin-hint">
                  Answered from the run record — the model was unavailable for this question.
                </div>
              ) : null}
              <div className="steering-actions">
                <button
                  type="button"
                  className="chat-chip"
                  disabled={!discuss.trim()}
                  onClick={promote}
                >
                  Promote to guidance
                </button>
              </div>
            </div>
          ) : null}
        </div>
      </details>

      {visibleBacklog.length > 0 ? (
        <div className="steering-backlog">
          <span className="admin-hint">Backlog (separate tasks — never absorbed into this run)</span>
          <ul className="steering-list">
            {visibleBacklog.slice(-8).map((item) => (
              <li key={item.id} className="steering-row">
                <div className="steering-row-head">
                  <span className="steering-id">{item.id}</span>
                  <span className="steering-chip">🗂 {item.status}</span>
                </div>
                <div className="steering-text">{item.title}</div>
                <div className="admin-hint">{item.reason}</div>
                <div className="steering-actions">
                  <button
                    type="button"
                    className="admin-refresh-btn"
                    disabled={backlogBusy === item.id}
                    onClick={() => void createTask(item)}
                  >
                    {item.status === 'scheduled' ? 'Copy task again' : 'Create task'}
                  </button>
                  {onStartTask ? (
                    <button
                      type="button"
                      className="admin-refresh-btn"
                      disabled={backlogBusy === item.id}
                      onClick={() => void startTask(item)}
                    >
                      Start as new task
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="admin-refresh-btn"
                    disabled={backlogBusy === item.id}
                    onClick={() => void dismissTask(item)}
                  >
                    Dismiss
                  </button>
                  {copied === item.id ? <span className="admin-hint">command copied</span> : null}
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
