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
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { dashboardAPI } from '../api';

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
  // Plain-English → CLI short-circuit: a confident command match shows a
  // confirm card instead of burning a model turn; ambiguous asks show choices.
  const [pendingResolve, setPendingResolve] = useState<PendingResolve | null>(null);
  // Mirrors liveSteps/liveTools for the async send callback (state would be
  // stale in the closure when the POST resolves) — the final message snapshots
  // every step.
  const liveStepsRef = useRef<string[]>([]);
  const liveToolsRef = useRef<ToolStep[]>([]);
  const sessionIdRef = useRef<string>(newSessionId());
  const subRef = useRef<(() => void) | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
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

  const canChat = auth?.authenticated === true && (auth.role === 'admin' || auth.role === 'operator');

  const send = useCallback(
    async (text: string) => {
      const clean = text.trim();
      if (!clean || busy) return;
      setError('');
      setMeta(null);
      setLiveSteps([]);
      liveStepsRef.current = [];
      setLiveTools([]);
      liveToolsRef.current = [];
      setMessages((m) => [...m, { role: 'user', content: clean }]);
      setInput('');
      setBusy(true);

      // Pre-resolve the ask against the command manifest. A confident match
      // short-circuits to a confirm card (deterministic commands like "stop
      // the dashboard" shouldn't need a model turn); ambiguous asks show
      // their options as choices; everything else falls through to the agent.
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

      const sessionId = sessionIdRef.current;
      // Subscribe to LIVE progress BEFORE the turn starts so no step is missed
      // (EventSource auto-reconnects; the final answer arrives via the POST).
      subRef.current?.();
      subRef.current = dashboardAPI.subscribeChat(sessionId, {
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
      });
      const r = await dashboardAPI.chatSend(sessionId, clean);
      subRef.current?.();
      subRef.current = null;
      if (r.ok) {
        setMeta(r.generationFailed ? null : `${r.provider ?? 'provider'}${r.model ? ` / ${r.model}` : ' (auto-routed)'}`);
        setMessages((m) => [
          ...m,
          {
            role: 'assistant',
            content: r.content || '(the agent produced no text — try rephrasing)',
            error: r.generationFailed,
            followups: r.followups,
            steps: liveStepsRef.current,
            tools: liveToolsRef.current,
          },
        ]);
      } else {
        if (r.unauthorized) {
          setAuth((a) => (a ? { ...a, authenticated: false } : a));
          setError('Session expired — log in again to chat.');
        } else {
          setError(r.error || 'The agent could not answer — check that a provider API key is set for the dashboard process.');
        }
        // Drop the optimistic user bubble so the thread reflects the server state.
        setMessages((m) => m.slice(0, -1));
      }
      setBusy(false);
    },
    [busy],
  );

  /** Run the resolved CLI command directly (the user confirmed the card). */
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
    const runLabel = `▶ Ran: \`${top.command}\``;
    // Poll until the task settles (short commands finish fast).
    let result = '';
    for (let i = 0; i < 60; i += 1) {
      const t = await dashboardAPI.getTask(id);
      if (!t?.task) break;
      if (t.task.status !== 'running') {
        const logs = (t.task.logs ?? []).map((l: { text: string }) => l.text).join('\n');
        result = `${runLabel}\n\`\`\`\n${logs.trim().slice(0, 3000) || '(no output)'}\n\`\`\`\n_exit ${t.task.exitCode ?? '?'}_`;
        break;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    setMessages((m) => [...m, { role: 'assistant', content: result || `${runLabel} (still running — see the Command Console)` }]);
    setBusy(false);
  }, []);

  /** User declined the command card — ask the agent normally instead. */
  const declineResolvedCommand = useCallback((ask: string) => {
    setPendingResolve(null);
    void send(ask);
  }, [send]);

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
    subRef.current?.();
    subRef.current = null;
    await dashboardAPI.chatReset(sessionIdRef.current).catch(() => {});
    sessionIdRef.current = newSessionId();
    setMessages([]);
    setLiveSteps([]);
    liveStepsRef.current = [];
    setLiveTools([]);
    liveToolsRef.current = [];
    setError('');
    setMeta(null);
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
          <div className="chat-thread" ref={listRef} role="log" aria-live="polite">
            {messages.length === 0 ? (
              <div className="empty-state">
                Say anything — the agent decides what to do (answer, fix code, plan, run the pipeline). Try “what's the state of this project?” or “fix the failing test”.
              </div>
            ) : (
              messages.map((m, i) => (
                <div key={i} className={`chat-bubble chat-${m.role}${m.error ? ' chat-error' : ''}`}>
                  <div className="chat-bubble-role">{m.role === 'user' ? 'You' : '🤖 Agent'}</div>
                  <div className="chat-bubble-text">{m.content}</div>
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
                <ToolCards tools={liveTools} live />
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

          <form className="chat-input-row" onSubmit={(e) => { e.preventDefault(); void send(input); }}>
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Message the agent… (Enter to send)"
              disabled={busy}
              maxLength={8000}
              autoFocus
            />
            <button className="admin-refresh-btn" type="submit" disabled={busy || !input.trim()}>
              {busy ? '⏳ Working…' : '➤ Send'}
            </button>
          </form>
          <p className="admin-hint">
            Each message runs the full agent loop in the dashboard process (same engine as{' '}
            <code>buff chat "&lt;prompt&gt;"</code>) — the provider API keys must be configured in the dashboard
            process. Clarifications (<code>ask_user</code>) appear as a question card here — choose an answer or
            skip (best judgment).
          </p>
        </>
      )}
    </div>
  );
}
