/**
 * release-notes-plugin — the OTHER way to ship an agent: a plugin FILE.
 *
 * WHY THIS SHAPE EXISTS. The two examples beside this one are classes you wire
 * into a source checkout (`nuvira sdk register`) or import into your own program.
 * But most people run the CLI from npm, where there is no `src/` to edit — and a
 * plugin file is the answer: drop one compiled `.js` into
 * `~/.nuvira/agents/` and the harness discovers it, registers it under each
 * `metadata.agentTypes` entry, and a plan step whose `agentType` matches will run
 * it. No fork, no rebuild, no registry edit.
 *
 * The plugin contract is deliberately smaller than the `Agent` class:
 *
 *   - `metadata` is data (name, version, description, author, agentTypes);
 *   - `execute(context, callLLM)` is the whole behaviour;
 *   - `validate` / `cleanup` are OPTIONAL — the harness calls them only if you
 *     provide them (the plugin is adapted to the agent base class for you).
 *
 * HOW TO SHIP IT:
 *   1. `npm run build` (this file compiles to `dist/release-notes-plugin.js`);
 *   2. `cp dist/release-notes-plugin.js ~/.nuvira/agents/`;
 *   3. `nuvira plugins list` — the file should appear as a discovered agent
 *      plugin, under every agent type it declares;
 *   4. a plan step with `agentType: 'release-notes'` now resolves to it.
 *
 * The type below mirrors what the loader requires. The same interface is
 * exported by the main package as `AgentPlugin` (from `agent-nuvira`), which is
 * what you want if you import it rather than re-declaring it.
 */

import type { AgentContext, AgentResult, FileChange, LLMCallFn } from '@agent-nuvira/sdk';

/** The subset of the harness `AgentPlugin` contract this file implements. */
export interface PluginMetadata {
  name: string;
  version: string;
  description: string;
  author?: string;
  /** Every agent type a plan step may use to reach this plugin. */
  agentTypes: string[];
}

export interface AgentPluginShape {
  metadata: PluginMetadata;
  execute(context: AgentContext, callLLM: LLMCallFn): Promise<AgentResult>;
  /** Optional — the harness calls it before `execute` and treats a string as a refusal. */
  validate?(context: AgentContext): true | string;
}

/** Groups the proposed changes so the model gets a compact, ordered summary. */
function summarizeChanges(context: AgentContext): { created: string[]; modified: string[]; deleted: string[] } {
  const pick = (status: FileChange['status']) =>
    context.fileChanges.filter((c) => c.status === status).map((c) => c.path);
  return { created: pick('created'), modified: pick('modified'), deleted: pick('deleted') };
}

export const plugin: AgentPluginShape = {
  metadata: {
    name: 'ReleaseNotes',
    version: '1.0.0',
    description: 'Turns the turn\'s file changes into a user-facing release-notes section',
    author: 'example',
    // Two agent types, so either name in a plan reaches this plugin — useful when
    // a planner phrases the step differently.
    agentTypes: ['release-notes', 'changelog-writer'],
  },

  validate(context: AgentContext): true | string {
    // A precondition is what stops a step from being "successful" while doing
    // nothing: with no changes there is nothing to write notes about.
    if (context.fileChanges.length === 0) {
      return 'ReleaseNotes needs at least one proposed file change to summarize.';
    }
    return true;
  },

  async execute(context: AgentContext, callLLM: LLMCallFn): Promise<AgentResult> {
    const { created, modified, deleted } = summarizeChanges(context);

    const prompt = [
      'You write release notes for users, not for developers.',
      'Rules:',
      '- Markdown bullets grouped under "Added", "Changed", "Removed".',
      '- One line per change, describing the OUTCOME, never the file path alone.',
      '- Omit a group entirely when it is empty.',
      '',
      `Goal of this turn: ${context.goal}`,
      '',
      `Added (${created.length}): ${created.join(', ') || 'none'}`,
      `Changed (${modified.length}): ${modified.join(', ') || 'none'}`,
      `Removed (${deleted.length}): ${deleted.join(', ') || 'none'}`,
    ].join('\n');

    const raw = await callLLM(prompt, { temperature: 0.4, maxTokens: 600 });
    const notes = (raw ?? '').trim();
    if (!notes) {
      return { success: false, summary: 'The model returned empty release notes' };
    }

    // Proposed, never written here: the harness applies file changes.
    context.fileChanges.push({
      path: 'RELEASE_NOTES_SECTION.md',
      newContent: notes,
      status: 'created',
    });
    // Tell the next agent in the plan that this is done, and where it is.
    context.conversations.push({
      from: 'ReleaseNotes',
      to: 'writer',
      content: `Release notes drafted at RELEASE_NOTES_SECTION.md (${created.length} added, ${modified.length} changed).`,
      timestamp: Date.now(),
    });

    const total = created.length + modified.length + deleted.length;
    return {
      success: true,
      summary: `Drafted release notes for ${total} change(s)`,
      details: notes,
    };
  },
};

export default plugin;
