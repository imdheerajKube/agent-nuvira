/**
 * WhatsAppPanel — P2 in-page WhatsApp bridge pairing (GUI parity with
 * `buff whatsapp pair`).
 *
 * Lives in the Agent Hub → Channels tab. Shows the bridge pairing state,
 * starts a pairing session (QR mode or phone-number code mode), streams the
 * live QR into an <img> (the QR auto-refreshes as WhatsApp rotates it), shows
 * the 8-char code for phone mode, cancels, and un-pairs. Everything rides the
 * real BaileysBridge in the dashboard process via /api/whatsapp — the same
 * engine the CLI's `buff whatsapp pair` uses, so a QR scanned here is the
 * same session the gateway uses.
 *
 * Pair/cancel/unpair are write actions → gated behind the admin session +
 * routing.operate (admin or operator), like the other Channels-tab actions.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { dashboardAPI } from '../api';
import type { WhatsAppPairStatus } from '../types';
import { maskSenderId } from '../mask';

const STATE_LABEL: Record<WhatsAppPairStatus['state'], string> = {
  idle: 'Not paired',
  pairing: '⏳ Pairing…',
  paired: '✅ Paired',
  failed: '❌ Pairing failed',
  cancelled: '⏹ Cancelled',
  error: '💥 Pairing error',
};

interface Props {
  /** Logged in (admin session). */
  authed: boolean;
  /** routing.operate — admin or operator may pair/cancel/unpair. */
  canWrite: boolean;
  /** Called when a write returns 401 (session expired). */
  sessionExpired: () => void;
  /** Reveal full sender ids instead of masked ones (Agent Hub privacy toggle). */
  reveal?: boolean;
}

export default function WhatsAppPanel({ authed, canWrite, sessionExpired, reveal = false }: Props) {
  const [status, setStatus] = useState<WhatsAppPairStatus | null>(null);
  const [contacts, setContacts] = useState<Record<string, string>>({});
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const subRef = useRef<(() => void) | null>(null);

  const refresh = useCallback(async () => {
    const s = await dashboardAPI.getWhatsAppStatus();
    if (s) {
      setStatus(s.status);
      setContacts(s.contacts ?? {});
    }
  }, []);

  // Fetch once + subscribe to live events (QR data URLs, codes, status) via
  // SSE — the QR refreshes automatically as WhatsApp rotates it.
  useEffect(() => {
    void refresh();
    if (!authed) return;
    // EventSource may be missing (jsdom/SSR-ish environments) — the panel
    // still shows the last-fetched status, it just won't live-update.
    if (typeof EventSource === 'undefined') return;
    const off = dashboardAPI.subscribeWhatsApp({
      onQr: (qr) => setStatus((s) => (s ? { ...s, qr, state: 'pairing' } : s)),
      onCode: (code) => setStatus((s) => (s ? { ...s, pairingCode: code } : s)),
      onStatus: (s) => {
        setStatus(s);
        if (s.state === 'paired' || s.state === 'failed' || s.state === 'error' || s.state === 'cancelled') {
          setBusy(false);
        }
      },
    });
    subRef.current = off;
    return () => {
      off();
      subRef.current = null;
    };
  }, [authed, refresh]);

  const runWrite = async (action: () => Promise<{ ok: boolean; error?: string }>) => {
    setBusy(true);
    setMsg(null);
    const r = await action();
    if (!r.ok && r.error && /Not authenticated|Session expired/i.test(r.error)) {
      sessionExpired();
      setBusy(false);
      return;
    }
    if (r.ok) {
      setMsg({ kind: 'ok', text: 'Done.' });
      await refresh();
    } else {
      setMsg({ kind: 'err', text: r.error || 'Action failed.' });
    }
    setBusy(false);
  };

  const startPair = (withPhone: boolean) => {
    setMsg(null);
    void runWrite(() =>
      dashboardAPI.startWhatsAppPair(withPhone ? phone.trim() : undefined),
    ).then(() => setPhone(''));
  };

  const cancelPair = () => {
    setMsg(null);
    void runWrite(() => dashboardAPI.cancelWhatsAppPair());
  };

  const unpair = () => {
    if (!window.confirm('Remove the paired WhatsApp session from this machine? You will need to scan a QR to pair again.')) return;
    setMsg(null);
    void runWrite(() => dashboardAPI.unpairWhatsApp());
  };

  const state = status?.state ?? 'idle';
  const pairing = state === 'pairing';

  return (
    <div className="wa-panel">
      <div className="wa-panel-head">
        <span className="wa-panel-title">🟢 WhatsApp bridge</span>
        {status ? (
          <span className={`wa-badge ${status.paired ? 'wa-badge-paired' : pairing ? 'wa-badge-pairing' : ''}`}>
            {STATE_LABEL[state]}
          </span>
        ) : (
          <span className="admin-hint">loading…</span>
        )}
      </div>
      <p className="admin-hint">
        The personal Baileys bridge (no Meta Business account) — pair once, and the gateway can send &amp; receive
        WhatsApp. Session: <code>{status?.sessionDir ?? '~/.buff/whatsapp/session'}</code>. Same engine as{' '}
        <code>buff whatsapp pair</code>.
      </p>

      {pairing ? (
        <div className="wa-pairing">
          {status?.qr ? (
            <div className="wa-qr-box">
              <img className="wa-qr-img" src={status.qr} alt="WhatsApp pairing QR code" />
              <p className="admin-hint">
                Open WhatsApp on the phone → <strong>Linked devices → Link a device → scan</strong>. The QR refreshes
                automatically while this window is open.
              </p>
            </div>
          ) : status?.phone ? (
            <div className="wa-code-box">
              <p className="admin-hint">
                On the phone with <strong>{status.phone}</strong>: WhatsApp → Linked devices → Link a device →{' '}
                <strong>“Link with phone number instead”</strong> → enter:
              </p>
              <div className="wa-code">{status.pairingCode ?? '… waiting for code'}</div>
            </div>
          ) : (
            <div className="wa-code-box">
              <p className="admin-hint">Waiting for WhatsApp to hand over a QR… (it usually appears within a few seconds)</p>
            </div>
          )}
          {status?.phone ? null : (
            <div className="admin-hint">
              Tip: on a phone, “Link with phone number instead” needs the number format{' '}
              <code>918844433322</code> (country code included) — enter it below instead of scanning.
            </div>
          )}
          {status?.error ? <div className="admin-row-msg admin-row-msg-err">{status.error}</div> : null}
          {canWrite && authed ? (
            <button className="admin-refresh-btn" type="button" onClick={cancelPair} disabled={busy}>
              {busy ? '⏳…' : '⏹ Cancel pairing'}
            </button>
          ) : null}
        </div>
      ) : (
        <div className="wa-actions">
          {canWrite && authed ? (
            !status?.paired ? (
              <>
                <div className="wa-action-row">
                  <button
                    className="admin-refresh-btn"
                    type="button"
                    onClick={() => startPair(false)}
                    disabled={busy}
                  >
                    {busy ? '⏳…' : '🔳 Pair with a QR'}
                  </button>
                  <span className="admin-hint">Scans from the phone you want to link.</span>
                </div>
                <div className="wa-action-row wa-phone-row">
                  <input
                    type="text"
                    className="wa-phone-input"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    placeholder="or pair with a number — e.g. 918844433322"
                    disabled={busy}
                    maxLength={16}
                  />
                  <button
                    className="admin-refresh-btn"
                    type="button"
                    onClick={() => startPair(true)}
                    disabled={busy || !phone.trim()}
                  >
                    Pair by number
                  </button>
                </div>
              </>
            ) : (
              <div className="wa-action-row">
                <button
                  className="admin-refresh-btn wa-unpair-btn"
                  type="button"
                  onClick={unpair}
                  disabled={busy}
                >
                  {busy ? '⏳…' : '🗑 Unpair (remove session)'}
                </button>
                <span className="admin-hint">Removes creds.json — you will need to scan a QR again.</span>
              </div>
            )
          ) : null}
          {state === 'failed' || state === 'error' || state === 'cancelled' ? (
            <div className="admin-row-msg admin-row-msg-err">
              {status?.error || (state === 'cancelled' ? 'Pairing cancelled.' : 'Pairing failed — try again.')}
            </div>
          ) : null}
          {!authed ? (
            <div className="admin-row-msg">Log in (admin or operator) to pair, cancel, or unpair.</div>
          ) : !canWrite ? (
            <div className="admin-row-msg">Your role can view pairing status but not change it (requires admin or operator).</div>
          ) : null}
          {msg ? <div className={`admin-row-msg${msg.kind === 'ok' ? '' : ' admin-row-msg-err'}`}>{msg.text}</div> : null}
        </div>
      )}

      {/* Send-by-name contacts — the mapping behind `buff whatsapp contact add`.
          These are for SENDING by name only; they do NOT grant inbound access.
          The verified list (Permissions tab / `buff config gateway allow`) is
          what decides who may TRIGGER the agent. */}
      <div className="wa-contacts">
        <div className="wa-contacts-head">
          <span className="wa-panel-title">📇 Send-by-name contacts</span>
          <span className="admin-hint">{Object.keys(contacts).length} mapped</span>
        </div>
        <p className="admin-hint">
          These names are for <strong>sending messages by name</strong> (e.g.{' '}
          <code>buff gateway send whatsapp:Name "…"</code>) — they do{' '}
          <strong>NOT</strong> let these numbers trigger the agent.
        </p>
        <div className="hub-alias-list">
          {Object.keys(contacts).length === 0 ? (
            <span className="admin-hint">(none — add one with <code>buff whatsapp contact add &lt;Name&gt; &lt;number&gt;</code>)</span>
          ) : (
            Object.entries(contacts).map(([name, number]) => (
              <div className="hub-alias-row" key={name}>
                <span className="hub-chip">{name}</span>
                <span className="admin-hint">→ {reveal ? number : maskSenderId(number)}</span>
              </div>
            ))
          )}
        </div>
        <p className="admin-hint" style={{ marginTop: 8 }}>
          To let a number <strong>trigger the agent</strong> (respond to its messages), add it to the{' '}
          <strong>verified list</strong> in the <strong>Permissions tab above</strong>, or run{' '}
          <code>buff config gateway allow whatsapp user &lt;number&gt;</code>.
        </p>
      </div>
    </div>
  );
}
