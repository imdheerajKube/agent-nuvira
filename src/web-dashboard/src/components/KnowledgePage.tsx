/**
 * Knowledge — tag-scoped retrieval over the operator's own documents.
 *
 * The feature exists end to end (learning/knowledge-base.ts + the `knowledge`
 * tool + `nuvira knowledge`), but the dashboard had no way to see or drive it.
 * This page is that surface: it lists every tag with its documents and chunk
 * counts, ingests files/folders under a tag, and runs a query so the retrieved
 * passages (with their source files) are visible rather than taken on faith.
 *
 * Write capability mirrors the server's rule (`routing.operate` → admin or
 * operator): a viewer sees the tags that exist but no ingest/forget control.
 */

import { useCallback, useEffect, useState } from 'react';
import { basename } from '../path-utils';
import { dashboardAPI } from '../api';
import type { KnowledgeHit, KnowledgeTag } from '../api';
import { useAuthVersion } from '../useAuthVersion';
import PageHeader from './PageHeader';

interface AuthState {
  configured: boolean;
  authenticated: boolean;
  role: string | null;
}

export default function KnowledgePage() {
  const [auth, setAuth] = useState<AuthState>({ configured: false, authenticated: false, role: null });
  const authVersion = useAuthVersion();
  const [tags, setTags] = useState<KnowledgeTag[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [ingestTag, setIngestTag] = useState('');
  const [ingestPaths, setIngestPaths] = useState('');
  const [ingesting, setIngesting] = useState(false);

  const [queryTag, setQueryTag] = useState('');
  const [question, setQuestion] = useState('');
  const [hits, setHits] = useState<KnowledgeHit[] | null>(null);
  const [querying, setQuerying] = useState(false);

  const canWrite = auth.authenticated && (auth.role === 'admin' || auth.role === 'operator');

  const refresh = useCallback(async () => {
    const rows = await dashboardAPI.fetchKnowledge();
    setTags(rows);
  }, []);

  useEffect(() => {
    void dashboardAPI.fetchAdminAuthStatus().then((s) => {
      setAuth(
        s
          ? { configured: s.configured, authenticated: s.authenticated, role: s.role ?? null }
          : { configured: false, authenticated: false, role: null },
      );
    });
    void refresh();
  }, [refresh, authVersion]);

  const handleIngest = useCallback(async () => {
    setError(null);
    setNotice(null);
    const paths = ingestPaths
      .split('\n')
      .map((p) => p.trim())
      .filter(Boolean);
    if (!ingestTag.trim() || paths.length === 0) {
      setError('A tag and at least one file or folder path are required.');
      return;
    }
    setIngesting(true);
    try {
      const r = await dashboardAPI.knowledgeIngest(ingestTag, paths);
      if (!r.ok) {
        setError(r.error || 'Ingest failed.');
      } else {
        const skipped = r.skipped?.length
          ? ` Skipped: ${r.skipped.map((s) => `${basename(s.path)} (${s.reason})`).join('; ')}`
          : '';
        setNotice(`Ingested ${r.files ?? 0} document(s) / ${r.chunks ?? 0} chunk(s) under '${r.tag}'.${skipped}`);
        setIngestPaths('');
        await refresh();
      }
    } finally {
      setIngesting(false);
    }
  }, [ingestTag, ingestPaths, refresh]);

  const handleQuery = useCallback(async () => {
    setError(null);
    setHits(null);
    if (!queryTag.trim() || !question.trim()) {
      setError('A tag and a question are required.');
      return;
    }
    setQuerying(true);
    try {
      const r = await dashboardAPI.knowledgeQuery(queryTag, question);
      if (!r.ok) setError(r.error || 'Query failed.');
      else setHits(r.hits ?? []);
    } finally {
      setQuerying(false);
    }
  }, [queryTag, question]);

  const handleForget = useCallback(
    async (tag: string) => {
      setError(null);
      setNotice(null);
      const r = await dashboardAPI.knowledgeForget(tag);
      if (!r.ok) setError(r.error || `Could not remove '${tag}'.`);
      else setNotice(`Removed knowledge tag '${tag}'.`);
      await refresh();
    },
    [refresh],
  );

  return (
    <div>
      <PageHeader
        icon="📚"
        title="Knowledge Base"
        description="Tag your own documents once; answer questions scoped to a tag. The data part comes from your documents, the general part from the model."
      />
      <div className="env-var-header">
        <span className="env-var-title">
          Documents and vectors live in ~/.nuvira/memory — never in a repository or package.
        </span>
        <button className="admin-refresh-btn" type="button" onClick={() => void refresh()}>
          ↻ Refresh
        </button>
      </div>

      {!auth.authenticated ? (
        <div className="admin-hint">
          {auth.configured ? 'Log in to view or manage knowledge tags.' : 'Set up an admin account to manage knowledge tags.'}
        </div>
      ) : null}
      {error ? <div className="admin-error">{error}</div> : null}
      {notice ? <div className="admin-hint">{notice}</div> : null}

      {/* Tags */}
      <h2 className="section-title">Tags</h2>
      {tags && tags.length === 0 ? (
        <div className="admin-hint">No knowledge tags yet. Ingest a document below to create one.</div>
      ) : null}
      {tags && tags.length > 0 ? (
        <div className="admin-table-wrapper">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Tag</th>
                <th>Chunks</th>
                <th>Documents</th>
                {canWrite ? <th /> : null}
              </tr>
            </thead>
            <tbody>
              {tags.map((t) => (
                <tr key={t.tag}>
                  <td>{t.tag}</td>
                  <td>{t.chunkCount}</td>
                  <td>
                    {t.documents.map((d) => (
                      <div key={d.path} title={d.path}>
                        {basename(d.path)} ({d.chunks} chunk{d.chunks === 1 ? '' : 's'})
                      </div>
                    ))}
                  </td>
                  {canWrite ? (
                    <td>
                      <button
                        className="admin-mini-danger"
                        type="button"
                        onClick={() => void handleForget(t.tag)}
                        aria-label={`Remove knowledge tag ${t.tag}`}
                      >
                        Forget
                      </button>
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {/* Ingest */}
      {canWrite ? (
        <>
          <h2 className="section-title">Ingest under a tag</h2>
          <div className="admin-hint">
            One file or folder path per line (PDF, DOCX, XLSX, PPTX, Markdown, CSV, JSON, plain text).
            Tags are normalized: “Dheeraj Health Report” becomes “dheeraj-health-report”.
          </div>
          <div className="admin-gate-form">
            <input
              className="admin-input"
              type="text"
              placeholder="tag (e.g. dheeraj-health-report)"
              value={ingestTag}
              onChange={(e) => setIngestTag(e.target.value)}
              aria-label="Knowledge tag"
            />
            <textarea
              className="admin-input"
              rows={3}
              placeholder="/path/to/labs.pdf&#10;/path/to/notes/"
              value={ingestPaths}
              onChange={(e) => setIngestPaths(e.target.value)}
              aria-label="Paths to ingest"
            />
            <button className="admin-refresh-btn" type="button" onClick={() => void handleIngest()} disabled={ingesting}>
              {ingesting ? 'Ingesting…' : 'Ingest'}
            </button>
          </div>
        </>
      ) : null}

      {/* Query */}
      <h2 className="section-title">Ask a tagged knowledge base</h2>
      <div className="admin-gate-form">
        <input
          className="admin-input"
          type="text"
          placeholder="tag"
          list="knowledge-tags"
          value={queryTag}
          onChange={(e) => setQueryTag(e.target.value)}
          aria-label="Tag to query"
        />
        <datalist id="knowledge-tags">
          {(tags ?? []).map((t) => (
            <option key={t.tag} value={t.tag} />
          ))}
        </datalist>
        <input
          className="admin-input"
          type="text"
          placeholder="what is my LDL and how do I lower it"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          aria-label="Question"
        />
        <button className="admin-refresh-btn" type="button" onClick={() => void handleQuery()} disabled={querying}>
          {querying ? 'Searching…' : 'Query'}
        </button>
      </div>

      {hits && hits.length === 0 ? (
        <div className="admin-hint">No passages matched that tag — check the tag name, or ingest documents first.</div>
      ) : null}
      {hits && hits.length > 0 ? (
        <div>
          {hits.map((h, i) => (
            <div key={`${h.sourcePath}-${h.chunkIndex}-${i}`} className="admin-summary-card">
              <div className="admin-summary-label">
                {basename(h.sourcePath)} · chunk {h.chunkIndex + 1} · sim {h.similarity.toFixed(3)}
              </div>
              <div className="admin-summary-value" style={{ whiteSpace: 'pre-wrap', fontWeight: 400 }}>
                {h.text.slice(0, 600)}
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
