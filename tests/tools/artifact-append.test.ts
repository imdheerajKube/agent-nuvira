/**
 * I3 — Artifact-append tests.
 *
 * Covers: payload extraction (valid / prose-wrapped / invalid shapes), the
 * auto-append hook (sink receives the artifact, only `result` reaches the
 * model), preview reading, and the tool-loop integration.
 */

import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  extractToolArtifact,
  appendToolArtifact,
  readArtifactPreview,
  recordArtifact,
} from '../../src/tools/artifact-append.js';
import type { ArtifactSink } from '../../src/tools/artifact-types.js';
import { runToolLoop, type ToolLoopDeps, type StepResponse } from '../../src/tools/tool-loop.js';

/**
 * recordArtifact — the DIRECT sink path.
 *
 * The `{artifact, result}` payload swaps a tool's whole result for JSON. Tools
 * that return prose the model must read verbatim (`write_file: created 'x'`,
 * `generate_image: saved to …`) cannot do that, so they hand over the
 * deliverable themselves. These tests pin the contract that made that safe: the
 * bookkeeping fields are filled, a missing sink is a no-op, and a failing sink
 * can never break the tool that produced the artifact.
 */
describe('recordArtifact — direct sink', () => {
  it('fills id / source / createdAt and forwards the producer\'s fields', () => {
    const pushed: Array<{ kind: string; id: string; source: string; createdAt: number; title: string }> = [];
    recordArtifact({ push: (a) => pushed.push(a as never) }, {
      kind: 'file',
      title: 'src/app.ts',
      path: '/repo/src/app.ts',
      sizeBytes: 42,
    });

    expect(pushed).toHaveLength(1);
    expect(pushed[0].kind).toBe('file');
    expect(pushed[0].title).toBe('src/app.ts');
    expect(pushed[0].id).toBeTruthy();
    expect(pushed[0].source).toBe('tool');
    expect(pushed[0].createdAt).toBeGreaterThan(0);
  });

  it('is a no-op with no sink (the CLI, a bare tool run)', () => {
    expect(() => recordArtifact(undefined, { kind: 'file', title: 'x', path: '/x' })).not.toThrow();
  });

  it('never breaks the producer when the sink throws', () => {
    const sink = {
      push: () => {
        throw new Error('disk full');
      },
    };
    expect(() => recordArtifact(sink, { kind: 'file', title: 'x', path: '/x' })).not.toThrow();
  });

  it('honours an explicit id / source when the producer supplies one', () => {
    const pushed: Array<{ id: string; source: string }> = [];
    recordArtifact({ push: (a) => pushed.push(a as never) }, {
      kind: 'media',
      title: 'logo',
      path: '/tmp/logo.png',
      id: 'fixed-id',
      source: 'agent',
    });
    expect(pushed[0].id).toBe('fixed-id');
    expect(pushed[0].source).toBe('agent');
  });
});

describe('extractToolArtifact — payload parsing', () => {
  it('parses a clean {artifact, result} payload and normalizes it', () => {
    const out = extractToolArtifact(
      '{"artifact": {"kind": "file", "title": "deploy report", "path": "/tmp/report.md", "mime": "text/markdown"}, "result": "Report written to /tmp/report.md"}',
    );
    expect(out).not.toBeNull();
    expect(out!.artifact.kind).toBe('file');
    expect(out!.artifact.title).toBe('deploy report');
    expect(out!.artifact.path).toBe('/tmp/report.md');
    expect(out!.artifact.mime).toBe('text/markdown');
    expect(out!.artifact.id).toBeTruthy();
    expect(out!.artifact.createdAt).toBeGreaterThan(0);
    expect(out!.artifact.source).toBe('tool'); // default
    expect(out!.result).toBe('Report written to /tmp/report.md');
  });

  it('tolerates prose before/after the payload (wrapped result)', () => {
    const out = extractToolArtifact(
      'Here you go:\n{"artifact": {"kind": "data", "title": "schema", "path": "/tmp/schema.json"}, "result": "ok"}\n— enjoy',
    );
    expect(out?.artifact.kind).toBe('data');
    expect(out?.result).toBe('ok');
  });

  it('scans past brace-containing prose to find the real payload', () => {
    const out = extractToolArtifact(
      'Use {placeholder} syntax like {this}. Payload: {"artifact": {"kind": "file", "title": "t", "path": "/tmp/t"}, "result": "found"}',
    );
    expect(out?.artifact.kind).toBe('file');
    expect(out?.result).toBe('found');
  });

  it('stringifies an object result instead of mangling it', () => {
    const out = extractToolArtifact(
      '{"artifact": {"kind": "data", "title": "d", "path": "/tmp/d"}, "result": {"n": 1}}',
    );
    expect(out?.result).toBe('{"n":1}');
  });

  it('returns null for non-payload tool output', () => {
    expect(extractToolArtifact('plain text result')).toBeNull();
    expect(extractToolArtifact('')).toBeNull();
    expect(extractToolArtifact('{"artifact": 42}')).toBeNull();
    expect(extractToolArtifact('{"artifact": {"kind": "file", "title": "x", "path": "/x"}, "result": "r"} {"junk')).not.toBeNull();
  });

  it('rejects invalid shapes (missing result / bad kind / missing path)', () => {
    expect(extractToolArtifact('{"artifact": {"kind": "file", "title": "x", "path": "/x"}}')).toBeNull();
    expect(extractToolArtifact('{"artifact": {"kind": "nope", "title": "x", "path": "/x"}, "result": "r"}')).toBeNull();
    expect(extractToolArtifact('{"artifact": {"kind": "file", "title": "x"}, "result": "r"}')).toBeNull();
  });

  it('preserves explicit id/source/createdAt when the tool provides them', () => {
    const out = extractToolArtifact(
      '{"artifact": {"id": "a-1", "kind": "doc", "title": "api", "path": "/tmp/api.md", "source": "agent", "createdAt": 1234}, "result": "r"}',
    );
    expect(out?.artifact.id).toBe('a-1');
    expect(out?.artifact.source).toBe('agent');
    expect(out?.artifact.createdAt).toBe(1234);
  });
});

describe('appendToolArtifact — the runtime hook', () => {
  it('pushes the artifact to the sink and returns only the cleaned result', () => {
    const sink: ArtifactSink = { push: vi.fn() };
    const result = appendToolArtifact(
      '{"artifact": {"kind": "log", "title": "build log", "path": "/tmp/build.log"}, "result": "Build succeeded"}',
      sink,
    );
    expect(result).toBe('Build succeeded');
    expect(sink.push).toHaveBeenCalledTimes(1);
    expect((sink.push as any).mock.calls[0][0].kind).toBe('log');
  });

  it('passes non-payload text through untouched (no sink call)', () => {
    const sink: ArtifactSink = { push: vi.fn() };
    expect(appendToolArtifact('normal output', sink)).toBe('normal output');
    expect(sink.push).not.toHaveBeenCalled();
  });
});

describe('readArtifactPreview', () => {
  it('reads the first N chars of a file with an ellipsis when truncated', () => {
    const dir = mkdtempSync(join(tmpdir(), 'buff-preview-'));
    try {
      const file = join(dir, 'preview.txt');
      writeFileSync(file, 'a'.repeat(1000));
      const preview = readArtifactPreview(file, 100);
      expect(preview?.length).toBe(101); // 100 chars + ellipsis
      expect(preview?.endsWith('…')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns undefined for a missing file (best-effort)', () => {
    expect(readArtifactPreview('/nonexistent/file.txt')).toBeUndefined();
  });
});

describe('tool-loop integration', () => {
  it('records the artifact and feeds only the cleaned result back to the model', async () => {
    const sink: ArtifactSink = { push: vi.fn() };
    const callModel = vi.fn();
    let step = 0;
    callModel.mockImplementation(async () => {
      step += 1;
      if (step === 1) {
        return {
          content: '',
          toolCalls: [{ id: 'c1', name: 'code_search', arguments: { pattern: 'foo' } }],
        } satisfies StepResponse;
      }
      return { content: 'Done.', toolCalls: [] } satisfies StepResponse;
    });
    const deps: ToolLoopDeps = {
      callModel,
      executeTool: async () =>
        '{"artifact": {"kind": "data", "title": "matches", "path": "/tmp/matches.json"}, "result": "3 matches"}',
      onEvent: vi.fn(),
    };
    await runToolLoop({
      messages: [{ role: 'user', content: 'search' }],
      context: { configManager: {}, artifacts: sink },
      deps,
    });

    // Artifact recorded…
    expect(sink.push).toHaveBeenCalledTimes(1);
    expect((sink.push as any).mock.calls[0][0].title).toBe('matches');
    // …and the model's step-2 thread saw the CLEAN result, not the payload.
    const threadAtStep2 = callModel.mock.calls[1][0] as Array<{ role: string; content: string }>;
    const toolMsg = [...threadAtStep2].reverse().find((m) => m.role === 'tool');
    expect(toolMsg?.content).toBe('3 matches');
    expect(toolMsg?.content).not.toContain('artifact');
  });
});
