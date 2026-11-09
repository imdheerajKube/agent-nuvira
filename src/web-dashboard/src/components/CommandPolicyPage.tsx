/**
 * Command Policy — the user-owned half of what the agent may RUN.
 *
 * POSITIONING (and why this page is not a bypass): the built-in floor in
 * `src/tools/run-terminal.ts` is not editable here. `rm -rf /`, `sudo`, a fork
 * bomb and history rewrite stay refused unless the user explicitly names that
 * prefix — and even then the result is ONE APPROVAL, never silence. This page
 * only edits the override file (`<config dir>/command-policy.json`), which is
 * the same file `nuvira config policy` writes, through the same validator, so
 * the terminal and the browser cannot disagree.
 *
 * WHY IT EXISTS. The floor was the only way to change what may run: a user who
 * wanted `git push` or `kill -9` had to edit source, and a deny cannot be
 * approved. The CLI added the override; this page is its discoverable half, and
 * it shows the floor per rule so the user can see what an override acts on.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { dashboardAPI } from '../api';
import { useAuthVersion } from '../useAuthVersion';
import type { CommandPolicy, CommandPolicyKind, CommandPolicyView } from '../types';
import PageHeader from './PageHeader';

const KINDS: Array<{
  kind: CommandPolicyKind;
  title: string;
  blurb: string;
  placeholder: string;
}> = [
  {
    kind: 'allow',
    title: 'Allow — run without asking',
    blurb:
      'For an ordinary command this skips the confirmation. On a command the built-in floor denies it still asks ONCE: allow means "I am fine with this", not "this is safe".',
    placeholder: 'npm run build\nnpx cap sync',
  },
  {
    kind: 'approve',
    title: 'Approve — ask once, then run',
    blurb:
      'Relaxes a built-in denial (git push, kill -9) to one human approval. Once approved, the session grant can cover further uses for the rest of the session.',
    placeholder: 'git push\nkill -9',
  },
  {
    kind: 'deny',
    title: 'Deny — never run',
    blurb:
      'Beats every other list and every built-in class. Refused whatever the request says, and a deny cannot be approved.',
    placeholder: 'rm -rf build\ngit clean -fd',
  },
];

/** One prefix per line; blank lines dropped. */
export function policyTextToLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function policyToText(policy: CommandPolicy): Record<CommandPolicyKind, string> {
  return {
    allow: policy.allow.join('\n'),
    approve: policy.approve.join('\n'),
    deny: policy.deny.join('\n'),
  };
}

const EMPTY_TEXT: Record<CommandPolicyKind, string> = { allow: '', approve: '', deny: '' };

export default function CommandPolicyPage() {
  const authVersion = useAuthVersion();
  const [view, setView] = useState<CommandPolicyView | null>(null);
  const [saved, setSaved] = useState<CommandPolicy>({ allow: [], approve: [], deny: [] });
  const [text, setText] = useState<Record<CommandPolicyKind, string>>(EMPTY_TEXT);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const v = await dashboardAPI.fetchCommandPolicy();
    setView(v);
    if (v.ok && v.policy) {
      setSaved(v.policy);
      setText(policyToText(v.policy));
    } else {
      setError(v.error ?? 'Could not load the command policy.');
      setSaved({ allow: [], approve: [], deny: [] });
      setText(EMPTY_TEXT);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load, authVersion]);

  const draft: CommandPolicy = useMemo(
    () => ({
      allow: policyTextToLines(text.allow),
      approve: policyTextToLines(text.approve),
      deny: policyTextToLines(text.deny),
    }),
    [text],
  );

  const dirty = useMemo(
    () =>
      (['allow', 'approve', 'deny'] as const).some(
        (kind) => draft[kind].join('\n') !== saved[kind].join('\n'),
      ),
    [draft, saved],
  );

  const canSave = view?.ok === true && view.writable === true;

  const save = useCallback(async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    const r = await dashboardAPI.saveCommandPolicy(draft);
    if (!r.ok || !r.policy) {
      setError(r.error ?? 'Could not save the command policy.');
    } else {
      setView((prev) => ({ ...(prev ?? { ok: true }), ...r, ok: true }));
      setSaved(r.policy);
      setText(policyToText(r.policy));
      setNotice(
        'Saved. It applies to the NEXT command — no restart. Built-in floor commands still ask, even in the allow list.',
      );
    }
    setBusy(false);
  }, [draft]);

  return (
    <div className="page">
      <PageHeader
        icon="🛡️"
        title="Command Policy"
        description="What the agent may run on this machine. The built-in floor applies out of the box; the lists below override the built-in class for the command prefixes you name."
        actions={
          <button className="admin-mini-btn" type="button" onClick={() => void load()} disabled={loading || busy}>
            {loading ? 'Reloading…' : 'Reload'}
          </button>
        }
      />

      {error ? (
        <p className="admin-hint" role="alert" style={{ color: 'var(--danger, #b91c1c)' }}>
          {error}
        </p>
      ) : null}
      {notice ? (
        <p className="admin-hint" role="status">
          {notice}
        </p>
      ) : null}

      <section className="panel" style={{ marginBottom: 16 }}>
        <div className="admin-hint" style={{ marginBottom: 8 }}>
          <strong>File:</strong> <code>{view?.file ?? '—'}</code>
          {view?.exists === false ? ' — not created yet, so the built-in defaults are in force.' : null}
        </div>
        <div className="admin-hint" style={{ marginBottom: 8 }}>
          <strong>Precedence:</strong> your <code>deny</code> → a floor command you allowed/approved (one
          approval) → your <code>allow</code> → the built-in class.
        </div>
        <div className="admin-hint">
          {canSave
            ? 'A saved edit is read by the next command. No restart.'
            : 'Read-only: saving requires an admin session (policy.write). Sign in from the Admin page.'}
        </div>
      </section>

      {KINDS.map(({ kind, title, blurb, placeholder }) => (
        <section className="panel" key={kind} style={{ marginBottom: 16 }}>
          <h2 className="section-title" style={{ marginTop: 0 }}>
            {title}
          </h2>
          <p className="admin-hint" style={{ marginTop: 0 }}>
            {blurb}
          </p>
          <label htmlFor={`policy-${kind}`} className="admin-hint" style={{ display: 'block', marginBottom: 4 }}>
            {title} — one command prefix per line
          </label>
          <textarea
            id={`policy-${kind}`}
            rows={4}
            spellCheck={false}
            disabled={!canSave || loading || busy}
            value={text[kind]}
            placeholder={placeholder}
            onChange={(e) => setText((prev) => ({ ...prev, [kind]: e.target.value }))}
            style={{
              width: '100%',
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
              fontSize: 13,
              padding: 8,
              borderRadius: 6,
              border: '1px solid var(--border, #d0d7de)',
              background: 'var(--input-bg, transparent)',
              color: 'inherit',
              resize: 'vertical',
            }}
          />
          <div className="admin-hint" style={{ marginTop: 4 }}>
            {draft[kind].length === 0 ? 'Empty — nothing from this list applies.' : `${draft[kind].length} entr${draft[kind].length === 1 ? 'y' : 'ies'}.`}
          </div>
        </section>
      ))}

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 20 }}>
        <button
          className="admin-refresh-btn"
          type="button"
          onClick={() => void save()}
          disabled={!canSave || !dirty || busy || loading}
        >
          {busy ? 'Saving…' : 'Save policy'}
        </button>
        <button
          className="admin-mini-btn"
          type="button"
          onClick={() => setText(policyToText(saved))}
          disabled={!dirty || busy}
        >
          Discard changes
        </button>
        <span className="admin-hint">
          {dirty ? 'Unsaved changes.' : 'No unsaved changes.'}
        </span>
      </div>

      <section className="panel">
        <h2 className="section-title" style={{ marginTop: 0 }}>
          Built-in floor — what your overrides act on
        </h2>
        <p className="admin-hint" style={{ marginTop: 0 }}>
          These are refused out of the box. Naming one in <code>approve</code> (or <code>allow</code>) turns
          the refusal into ONE approval; it never makes the command run silently.
        </p>
        <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 13 }}>
          <thead>
            <tr>
              <th style={{ textAlign: 'left', padding: '6px 8px', borderBottom: '1px solid var(--border, #d0d7de)' }}>
                Rule
              </th>
              <th style={{ textAlign: 'left', padding: '6px 8px', borderBottom: '1px solid var(--border, #d0d7de)' }}>
                Example it refuses
              </th>
            </tr>
          </thead>
          <tbody>
            {(view?.builtIn ?? []).map((rule, i) => (
              <tr key={`${rule.rule}-${i}`}>
                <td style={{ padding: '6px 8px', borderBottom: '1px solid var(--border, #d0d7de)' }}>{rule.rule}</td>
                <td style={{ padding: '6px 8px', borderBottom: '1px solid var(--border, #d0d7de)' }}>
                  <code>{rule.example}</code>
                </td>
              </tr>
            ))}
            {view && !view.builtIn?.length ? (
              <tr>
                <td colSpan={2} style={{ padding: '6px 8px' }}>
                  The server did not return the floor summary — the lists above still apply.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </section>
    </div>
  );
}
