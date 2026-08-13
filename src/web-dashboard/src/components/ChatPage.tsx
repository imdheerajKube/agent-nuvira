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
  // Mirrors liveSteps for the async send callback (state would be stale in the
  // closure when the POST resolves) — the final message snapshots every step.
  const liveStepsRef = useRef<string[]>([]);
  const sessionIdRef = useRef<string>(newSessionId());
  const subRef = useRef<(() => void) | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

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
      setMessages((m) => [...m, { role: 'user', content: clean }]);
      setInput('');
      setBusy(true);
      const sessionId = sessionIdRef.current;
      // Subscribe to LIVE progress BEFORE the turn starts so no step is missed
      // (EventSource auto-reconnects; the final answer arrives via the POST).
      subRef.current?.();
      subRef.current = dashboardAPI.subscribeChat(sessionId, {
        onProgress: (line) => {
          liveStepsRef.current = [...liveStepsRef.current, line];
          setLiveSteps(liveStepsRef.current);
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

  const resetConversation = useCallback(async () => {
    subRef.current?.();
    subRef.current = null;
    await dashboardAPI.chatReset(sessionIdRef.current).catch(() => {});
    sessionIdRef.current = newSessionId();
    setMessages([]);
    setLiveSteps([]);
    liveStepsRef.current = [];
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
            process. Clarifications (<code>ask_user</code>) are declined in the GUI, so the agent proceeds on best
            judgment.
          </p>
        </>
      )}
    </div>
  );
}
