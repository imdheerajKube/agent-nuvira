/**
 * Tests for the three complex examples.
 *
 * They are written to show the parts worth copying: a typed mock context, the
 * canned/sequential/failing LLM helpers, the result assertions, and — for the
 * parts that are pure logic — direct unit tests with no mock at all.
 *
 * Run from the repo root: `npm run examples:verify`.
 */

import { describe, it, expect } from 'vitest';
import {
  createMockContext,
  createMockLLM,
  createSequentialMockLLM,
  createFailingMockLLM,
  runAgentTest,
  assertAgentSuccess,
  assertAgentFailure,
  addArtifact,
  addFileChange,
} from '@agent-nuvira/sdk/testing';

import {
  apiContractDifferDescriptor,
  diffContracts,
  extractJsonArray,
  MigrationGuardAgent,
  ApiContractDifferAgent,
  parseRationale,
  releaseNotesPlugin,
} from '../src/index.js';

// ─── A migration fixture with one destructive and one review-worthy statement ──

const MIGRATION = [
  'ALTER TABLE users ADD COLUMN nickname text;',
  'DROP TABLE legacy_sessions;',
  'TRUNCATE audit_log;',
].join('\n');

describe('MigrationGuardAgent', () => {
  const agent = new MigrationGuardAgent();

  it('classifies in code, then asks the model only about the risky statements', async () => {
    const context = createMockContext({
      goal: 'Add a nickname column and clean up old tables',
      artifacts: [{ path: 'migrations/0007_cleanup.sql', content: MIGRATION, description: 'migration' }],
    });
    const callLLM = createMockLLM(
      'migrations/0007_cleanup.sql: DROP TABLE — every session row is gone permanently\n' +
        'migrations/0007_cleanup.sql: TRUNCATE — the audit log cannot be recovered',
    );

    const result = await runAgentTest(agent, context, callLLM);

    assertAgentSuccess(result);
    expect(result.summary).toContain('2 destructive statement(s)');
    // Only the two risky statements were sent — the ADD COLUMN was not.
    expect(callLLM.prompts).toHaveLength(1);
    expect(callLLM.prompts[0].prompt).not.toContain('ADD COLUMN nickname');
    expect(callLLM.prompts[0].prompt).toContain('DROP TABLE');
  });

  it('writes to the whole context bus: metadata, a message to the writer, and a proposed file', async () => {
    const context = createMockContext({
      goal: 'Clean up',
      artifacts: [{ path: 'migrations/0007_cleanup.sql', content: MIGRATION, description: 'migration' }],
    });

    const result = await runAgentTest(agent, context, createMockLLM('migrations/0007_cleanup.sql: DROP TABLE — gone'));

    assertAgentSuccess(result);
    expect(context.metadata.migrationDestructiveCount).toBe(2);
    expect((context.metadata.migrationFindings as unknown[]).length).toBe(2);
    expect(context.conversations).toHaveLength(1);
    expect(context.conversations[0].to).toBe('writer');
    expect(context.conversations[0].content).toContain('Do not apply 2 destructive statement(s)');
    // Proposed, not written: a custom agent has no filesystem access.
    expect(context.fileChanges).toHaveLength(1);
    expect(context.fileChanges[0].path).toBe('docs/migration-review.md');
    expect(context.fileChanges[0].status).toBe('created');
  });

  it('reports a clean migration as success with no model call', async () => {
    const context = createMockContext({
      goal: 'Add an index',
      artifacts: [
        { path: 'migrations/0008_index.sql', content: 'CREATE INDEX idx_users_email ON users(email);', description: 'migration' },
      ],
    });
    const callLLM = createMockLLM('never used');

    const result = await runAgentTest(agent, context, callLLM);

    assertAgentSuccess(result);
    expect(result.summary).toContain('No destructive statements');
    expect(callLLM.prompts).toHaveLength(0);
    expect(context.fileChanges).toHaveLength(0);
  });

  it('refuses to run when no artifact looks like a migration', async () => {
    const context = createMockContext({
      goal: 'Check something',
      artifacts: [{ path: 'src/app.ts', content: 'export const x = 1;', description: 'source' }],
    });

    const result = await runAgentTest(agent, context, createMockLLM('x'));

    assertAgentFailure(result, 'look like SQL migrations');
  });

  it('obeys onRateLimit instead of retrying blindly', async () => {
    const context = createMockContext({
      goal: 'Clean up',
      artifacts: [{ path: 'migrations/0007_cleanup.sql', content: MIGRATION, description: 'migration' }],
      onRateLimit: true, // the helper installs a callback that answers { action: 'retry' }
    });
    let attempts = 0;
    const flaky = async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('429 Too Many Requests');
      return 'migrations/0007_cleanup.sql: DROP TABLE — gone';
    };

    const result = await runAgentTest(agent, context, flaky);

    assertAgentSuccess(result);
    expect(attempts).toBe(2); // asked, was told to retry, retried exactly once
  });

  it('reports a rate limit it could not resolve as a failure, not a success', async () => {
    const context = createMockContext({
      goal: 'Clean up',
      artifacts: [{ path: 'migrations/0007_cleanup.sql', content: MIGRATION, description: 'migration' }],
    });

    const result = await runAgentTest(agent, context, createFailingMockLLM(new Error('429 Too Many Requests')));

    assertAgentFailure(result, '429');
    expect(result.summary).toContain('could not reach a model');
  });

  it('parses the rationale lines models actually produce', () => {
    const parsed = parseRationale(
      [
        '0007.sql: DROP TABLE — every row is gone',
        '- 0007.sql | TRUNCATE | the log is unrecoverable',
        'noise that should be ignored',
      ].join('\n'),
    );
    expect(parsed.get('0007.sql|DROP TABLE')).toBe('every row is gone');
    expect(parsed.get('0007.sql|TRUNCATE')).toBe('the log is unrecoverable');
    expect(parsed.size).toBe(2);
  });
});

// ─── API contract differ ────────────────────────────────────────────────────

describe('ApiContractDifferAgent', () => {
  const agent = new ApiContractDifferAgent();

  const twoSpecs = () => {
    const context = createMockContext({ goal: 'Compare the API contract' });
    addArtifact(context, 'spec/old.yaml', 'GET /v1/issues', 'old API spec');
    addArtifact(context, 'spec/new.yaml', 'GET /v1/issues\nGET /v1/pulls', 'new API spec');
    return context;
  };

  it('uses the model for extraction and code for the diff', async () => {
    const context = twoSpecs();
    const callLLM = createSequentialMockLLM([
      '[{"method":"get","path":"/v1/issues"}]',
      '```json\n[{"method":"GET","path":"/v1/issues"},{"method":"GET","path":"/v1/pulls"},]\n```',
      'Adds a pulls endpoint.',
    ]);

    const result = await runAgentTest(agent, context, callLLM);

    assertAgentSuccess(result);
    expect(result.summary).toBe('1 endpoint(s) added, none removed');
    expect(context.metadata.contractBreaking).toBe(false);
    const diff = context.metadata.contractDiff as { added: Array<{ path: string }> };
    expect(diff.added).toHaveLength(1);
    expect(context.fileChanges[0].path).toBe('CHANGELOG.contract.md');
  });

  it('calls breaking changes what they are', async () => {
    const context = twoSpecs();
    const callLLM = createSequentialMockLLM([
      '[{"method":"GET","path":"/v1/issues"},{"method":"GET","path":"/v1/legacy"}]',
      '[{"method":"GET","path":"/v1/issues"}]',
      'Removes /v1/legacy.',
    ]);

    const result = await runAgentTest(agent, context, callLLM);

    assertAgentSuccess(result);
    expect(result.summary).toContain('BREAKING');
    expect(context.fileChanges[0].newContent).toContain('Breaking API change');
  });

  it('names which side failed to parse instead of returning an empty diff', async () => {
    const context = twoSpecs();
    const callLLM = createSequentialMockLLM(['[{"method":"GET","path":"/v1/issues"}]', 'I could not find any endpoints.']);

    const result = await runAgentTest(agent, context, callLLM);

    assertAgentFailure(result, 'the NEW spec');
  });

  it('keeps the diff when only the phrasing call fails', async () => {
    const context = twoSpecs();
    let call = 0;
    const callLLM = async () => {
      call += 1;
      if (call === 3) throw new Error('provider hiccup');
      return call === 1 ? '[{"method":"GET","path":"/v1/issues"}]' : '[{"method":"GET","path":"/v1/issues"}]';
    };

    const result = await runAgentTest(agent, context, callLLM);

    assertAgentSuccess(result);
    expect(result.details).toContain('summary unavailable: provider hiccup');
  });

  it('refuses to run without two specs', async () => {
    const context = createMockContext({ goal: 'Compare' });
    addArtifact(context, 'spec/old.yaml', 'GET /v1/issues', 'old API spec');

    const result = await runAgentTest(agent, context, createMockLLM('[]'));

    assertAgentFailure(result, 'two non-empty spec artifacts');
  });

  it('parses fenced, prefixed and trailing-comma JSON — and rejects prose', () => {
    expect(extractJsonArray('```json\n[{"method":"GET","path":"/a"}]\n```')).toEqual([{ method: 'GET', path: '/a' }]);
    expect(extractJsonArray('Here you go: [{"method":"post","path":"/b"}] — done')).toEqual([
      { method: 'POST', path: '/b' },
    ]);
    expect(extractJsonArray('[{"method":"GET","path":"/c"},]')).toEqual([{ method: 'GET', path: '/c' }]);
    expect(extractJsonArray('There are no endpoints.')).toBeNull();
    expect(extractJsonArray('[{"path":"/no-method"}]')).toBeNull();
  });

  it('diffs in code, order-independently', () => {
    const before = [
      { method: 'GET', path: '/a' },
      { method: 'POST', path: '/b' },
    ];
    const after = [
      { method: 'POST', path: '/b' },
      { method: 'GET', path: '/c' },
    ];
    const diff = diffContracts(before, after);
    expect(diff.added).toEqual([{ method: 'GET', path: '/c' }]);
    expect(diff.removed).toEqual([{ method: 'GET', path: '/a' }]);
    expect(diff.unchanged).toBe(1);
  });

  it('derives its agent type from the class name', () => {
    expect(apiContractDifferDescriptor.agentType).toBe('api-contract-differ');
  });
});

// ─── The plugin-FILE shape (what ~/.nuvira/agents/*.js must export) ─────────

describe('release-notes plugin (the default-export shape)', () => {
  /** The loader reads `default.metadata` and registers each `metadata.agentTypes`. */
  function assertLoaderShape(plugin: typeof releaseNotesPlugin): void {
    expect(plugin.metadata).toBeDefined();
    expect(typeof plugin.metadata.name).toBe('string');
    expect(typeof plugin.metadata.version).toBe('string');
    expect(typeof plugin.metadata.description).toBe('string');
    expect(Array.isArray(plugin.metadata.agentTypes)).toBe(true);
    expect(plugin.metadata.agentTypes.length).toBeGreaterThan(0);
    expect(typeof plugin.execute).toBe('function');
  }

  it('has the metadata + execute the plugin loader requires', () => {
    assertLoaderShape(releaseNotesPlugin);
    expect(releaseNotesPlugin.metadata.agentTypes).toEqual(['release-notes', 'changelog-writer']);
  });

  it('refuses with no file changes — a step must not "succeed" doing nothing', () => {
    const context = createMockContext({ goal: 'Ship it' });
    expect(releaseNotesPlugin.validate?.(context)).toContain('at least one proposed file change');
  });

  it('drafts notes, proposes the file, and messages the next agent', async () => {
    const context = createMockContext({ goal: 'Ship the MCP work' });
    addFileChange(context, 'docs/MCP_GUIDE.md', '# guide', undefined, 'created');
    addFileChange(context, 'src/cli/mcp.ts', 'add', 'old', 'modified');

    const callLLM = createMockLLM('- Added a complete MCP configuration guide\n- Changed the MCP CLI');
    const result = await releaseNotesPlugin.execute(context, callLLM);

    expect(result.success).toBe(true);
    expect(result.summary).toContain('2 change(s)');
    expect(context.fileChanges.some((c) => c.path === 'RELEASE_NOTES_SECTION.md')).toBe(true);
    expect(context.conversations[0].from).toBe('ReleaseNotes');
    // The prompt asks for outcomes, and carries the grouped paths.
    expect(callLLM.prompts[0].prompt).toContain('docs/MCP_GUIDE.md');
    expect(callLLM.prompts[0].prompt).toContain('Markdown bullets grouped under');
  });

  it('fails loudly when the model returns nothing', async () => {
    const context = createMockContext({ goal: 'Ship it' });
    addFileChange(context, 'a.ts', 'x', undefined, 'created');

    const result = await releaseNotesPlugin.execute(context, createMockLLM('   '));

    expect(result.success).toBe(false);
    expect(result.summary).toContain('empty release notes');
  });
});
