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

import { useCallback, useEffect, useState } from 'react';

import {
  steeringBacklog,
  steeringDecide,
  steeringDiscuss,
  steeringGet,
  steeringGuide,
  steeringInterpret,
} from '../api';
import type { SteeringChangeRecord, SteeringProjection } from '../types';

interface SteeringPanelProps {
  sessionId: string;
  busy: boolean;
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
  busy,
}: {
  change: SteeringChangeRecord;
  onDecision: (changeId: string, action: 'approve' | 'reject' | 'defer' | 'withdraw') => void;
  onInterpret: (changeId: string, choice: 'guidance' | 'new_task' | 'question') => void;
  onCapture: (changeId: string) => void;
  busy: boolean;
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
      {change.decision?.reason ? <div className="steering-reason">{change.decision.reason}</div> : null}
      {diff ? <div className="admin-hint">{diff}</div> : null}
      {change.failure ? <div className="steering-error">{change.failure}</div> : null}
      {change.decision?.action === 'confirm_interpretation' ? (
        <div className="steering-actions">
          <span className="admin-hint">How should I treat this?</span>
          <button type="button" className="admin-refresh-btn" disabled={busy} onClick={() => onInterpret(change.id, 'guidance')}>
            Current task
          </button>
          <button type="button" className="admin-refresh-btn" disabled={busy} onClick={() => onInterpret(change.id, 'new_task')}>
            New task
          </button>
          <button type="button" className="admin-refresh-btn" disabled={busy} onClick={() => onInterpret(change.id, 'question')}>
            Just a question
          </button>
        </div>
      ) : null}
      {change.status === 'needs_approval' ? (
        <div className="steering-actions">
          <button type="button" className="admin-refresh-btn" disabled={busy} onClick={() => onDecision(change.id, 'approve')}>
            Approve
          </button>
          <button type="button" className="admin-refresh-btn" disabled={busy} onClick={() => onDecision(change.id, 'reject')}>
            Reject
          </button>
          <button type="button" className="admin-refresh-btn" disabled={busy} onClick={() => onDecision(change.id, 'defer')}>
            Defer
          </button>
          <button type="button" className="admin-refresh-btn" disabled={busy} onClick={() => onDecision(change.id, 'withdraw')}>
            Withdraw
          </button>
        </div>
      ) : change.status === 'received' || change.status === 'triaged' || change.status === 'deferred' ? (
        <div className="steering-actions">
          <button type="button" className="admin-refresh-btn" disabled={busy} onClick={() => onDecision(change.id, 'withdraw')}>
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

export default function SteeringPanel({ sessionId, busy }: SteeringPanelProps) {
  const [view, setView] = useState<SteeringProjection | null>(null);
  const [text, setText] = useState('');
  const [discuss, setDiscuss] = useState('');
  const [answer, setAnswer] = useState('');
  const [receipt, setReceipt] = useState('');
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const [copied, setCopied] = useState('');

  const refresh = useCallback(async () => {
    const result = await steeringGet(sessionId);
    if (result.ok) setView(result.projection ?? null);
  }, [sessionId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => void refresh(), 2500);
    return () => clearInterval(timer);
  }, [busy, refresh]);

  const send = async (intentHint: 'guidance' | 'question' | 'new_task') => {
    const value = text.trim();
    if (!value || sending) return;
    setSending(true);
    setError('');
    const result = await steeringGuide({ runId: sessionId, text: value, intentHint });
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
        const answered = await steeringDiscuss({ runId: sessionId, question: value });
        if (answered.ok) setAnswer(answered.answer ?? '');
      }
    }
    setSending(false);
  };

  const interpret = async (
    changeId: string,
    choice: 'guidance' | 'new_task' | 'question',
  ) => {
    setError('');
    const result = await steeringInterpret({ runId: sessionId, changeId, choice });
    if (!result.ok) {
      setError(result.error ?? `Could not interpret ${changeId}.`);
      return;
    }
    setReceipt(
      `🧭 ${changeId} — ${choice === 'new_task' ? 'treated as a separate task; it will be backlogged' : choice === 'question' ? 'treated as a question' : 'treated as a change to the current task'}.`,
    );
    if (result.projection) setView(result.projection);
    if (choice === 'question' && result.change) {
      const answered = await steeringDiscuss({ runId: sessionId, question: result.change.rawText });
      if (answered.ok) setAnswer(answered.answer ?? '');
    }
  };

  const decide = async (changeId: string, action: 'approve' | 'reject' | 'defer' | 'withdraw') => {
    setError('');
    const result = await steeringDecide({ runId: sessionId, changeId, action });
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
    const result = await steeringDiscuss({ runId: sessionId, question });
    if (!result.ok) {
      setAnswer('');
      setError(result.error ?? 'Could not answer that question.');
    } else {
      setAnswer(result.answer ?? '');
    }
  };

  const capture = async (changeId: string) => {
    setError('');
    const result = await steeringBacklog({ runId: sessionId, action: 'capture', changeId });
    if (!result.ok) {
      setError(result.error ?? `Could not add ${changeId} to the backlog.`);
      return;
    }
    setReceipt(`🗂 ${changeId} captured in the backlog; it is not part of this run.`);
    void refresh();
  };

  const createTask = async (backlogId: string) => {
    const result = await steeringBacklog({ runId: sessionId, backlogId, action: 'create-task' });
    if (!result.ok) {
      setError(result.error ?? 'Could not prepare the task.');
      return;
    }
    setReceipt(`🗂 Task prepared: ${result.command ?? result.prompt ?? ''}`);
    try {
      await navigator.clipboard?.writeText(result.command ?? result.prompt ?? '');
      setCopied(backlogId);
    } catch {
      setCopied('');
    }
    void refresh();
  };

  if (!view) return null;
  if (!view.enabled) return null;

  const counts = view.counts;
  const open = view.changes.filter(
    (change) => change.status !== 'applied' && change.status !== 'rejected' && change.status !== 'withdrawn',
  );
  const recentApplied = view.changes.filter((change) => change.status === 'applied').slice(-4).reverse();
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
      </div>
      <div className="steering-counts admin-hint">
        {counts.open} open · {counts.applied} applied · {counts.needsApproval} awaiting approval ·{' '}
        {counts.deferred} deferred · {counts.stale} stale · {counts.backlog} backlogged ·{' '}
        {counts.rejected} rejected
      </div>
      <div className="steering-counts admin-hint">
        triage p95 {view.metrics.p95TriageLatencyMs}ms · apply avg {view.metrics.avgTimeToApplyMs}ms ·{' '}
        {Math.round(view.metrics.staleRate * 100)}% stale ·{' '}
        {view.metrics.highImpactFalseAccepts} high-impact false accepts ·{' '}
        {view.metrics.lowConfidenceCount} low-confidence assessments
      </div>

      <div className="steering-compose">
        <textarea
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
        </div>
        <div className="admin-hint">
          Guidance is assessed, then applied at the next safe point. New tasks go to the backlog, never this run.
        </div>
      </div>

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
              busy={busy}
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
                busy={busy}
              />
            ))}
          </ul>
        </details>
      ) : null}

      <div className="steering-discuss">
        <label className="admin-hint" htmlFor={`steering-discuss-${sessionId}`}>
          Discuss (read-only — never changes the plan)
        </label>
        <div className="steering-actions">
          <input
            id={`steering-discuss-${sessionId}`}
            className="steering-input"
            value={discuss}
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
            <div className="steering-actions">
              <button
                type="button"
                className="chat-chip"
                onClick={() => {
                  setText(discuss);
                  setDiscuss('');
                }}
              >
                Promote to guidance
              </button>
            </div>
          </div>
        ) : null}
      </div>

      {view.backlog.length > 0 ? (
        <div className="steering-backlog">
          <span className="admin-hint">Backlog (separate tasks — never absorbed into this run)</span>
          <ul className="steering-list">
            {view.backlog.slice(-8).map((item) => (
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
                    disabled={item.status !== 'open'}
                    onClick={() => void createTask(item.id)}
                  >
                    Create task
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
