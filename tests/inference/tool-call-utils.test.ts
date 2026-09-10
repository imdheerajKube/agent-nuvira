/**
 * Shared tool-call helpers (S2/S3) — unit tests for the module every
 * tool-calling surface uses. These are the CHAT-INDEPENDENT guarantees: a fix
 * here propagates to chat, the dashboard console, and any future loop.
 */

import { describe, it, expect } from 'vitest';
import {
  salvageFailedGeneration,
  compactToolSchemas,
  buildJsonFallbackPrompt,
  looksLikeConfusedScaffoldingReply,
} from '../../src/inference/tool-call-utils.js';
import type { ToolJsonSchema } from '../../src/tools/registry.js';

/** The wire error Groq-style APIs produce when the CALL is rejected. */
function toolCall400(failedGeneration: string): Error {
  const escaped = failedGeneration
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n');
  return new Error(
    `Tool-calling API error (400): {"error":{"message":"Failed to call a function.","type":"invalid_request_error","code":"tool_use_failed","failed_generation":"${escaped}"}}`,
  );
}

const essay = 'The elephant is a very big animal.\nIt has a long trunk.';
const followupTag =
  '<function=suggest_followups [{"prompt": "What do elephants eat?", "label": "Elephant Diet"}, {"prompt": "Why are elephants important?"}]</function>';

describe('salvageFailedGeneration', () => {
  it('recovers the answer + followups from a Groq-style 400 (space-form tag)', () => {
    const salvaged = salvageFailedGeneration(toolCall400(`${essay}\n\n${followupTag}`));
    expect(salvaged).not.toBeNull();
    expect(salvaged!.content).toBe(essay);
    expect(salvaged!.content).not.toContain('<function');
    expect(salvaged!.followups).toEqual([
      { prompt: 'What do elephants eat?', label: 'Elephant Diet' },
      { prompt: 'Why are elephants important?' },
    ]);
  });

  it('recovers content from the Claude angle-form tag <function=name>args</function>', () => {
    const raw = `${essay}\n\n<function=suggest_followups>[{"prompt":"P"}]</function>`;
    const salvaged = salvageFailedGeneration(toolCall400(raw));
    expect(salvaged?.content).toBe(essay);
    expect(salvaged?.followups).toEqual([{ prompt: 'P' }]);
  });

  it('returns null when the intended call is a REAL tool (build must not be "answered" with prose)', () => {
    const raw = 'I will implement the login form. <function=build [{"goal":"login"}]</function>';
    expect(salvageFailedGeneration(toolCall400(raw))).toBeNull();
  });

  it('returns null for non-400 errors / missing failed_generation', () => {
    expect(salvageFailedGeneration(new Error('429: rate limit'))).toBeNull();
    expect(salvageFailedGeneration(new Error('Tool-calling API error (400): {}'))).toBeNull();
    expect(salvageFailedGeneration('not an error')).toBeNull();
  });

  it('returns null when failed_generation is empty', () => {
    expect(salvageFailedGeneration(toolCall400('   '))).toBeNull();
  });
});

describe('compactToolSchemas', () => {
  const schemas: ToolJsonSchema[] = [
    {
      name: 'suggest_followups',
      description: 'x',
      parameters: {
        type: 'object',
        properties: {
          followups: { type: 'array', items: { type: 'object' } },
        },
        required: ['followups'],
      },
    },
    {
      name: 'verify_requirement',
      description: 'x',
      parameters: { type: 'object', properties: { request: { type: 'string' } }, required: ['request'] },
    },
  ];

  it('renders one compact line per tool with required flags', () => {
    const text = compactToolSchemas(schemas);
    expect(text).toContain('suggest_followups: { followups: []<object> (required) }');
    expect(text).toContain('verify_requirement: { request: string (required) }');
  });

  it('handles empty / schema-less tools', () => {
    expect(compactToolSchemas([])).toBe('');
    expect(compactToolSchemas([{ name: 'noargs', description: 'x', parameters: {} }])).toContain(
      'noargs: { no args }',
    );
  });
});

describe('buildJsonFallbackPrompt', () => {
  it('flattens the thread and appends the schema-shape section', () => {
    const messages = [
      { role: 'system' as const, content: 'sys' },
      { role: 'user' as const, content: 'write an essay' },
      { role: 'assistant' as const, content: 'ok', toolCalls: [] },
      { role: 'tool' as const, toolCallId: 't1', content: 'result' },
    ];
    const prompt = buildJsonFallbackPrompt(messages, [
      { name: 'suggest_followups', description: '', parameters: { type: 'object', properties: {}, required: [] } },
    ]);
    expect(prompt).toContain('[System]\nsys');
    expect(prompt).toContain('[User]\nwrite an essay');
    expect(prompt).toContain('[Tool result]\nresult');
    expect(prompt).toContain('TOOL ARGUMENT SHAPES (use these exact keys):');
    expect(prompt).toContain('Example suggest_followups call:');
  });

  it('omits the schema section when no tools are exposed', () => {
    const prompt = buildJsonFallbackPrompt([{ role: 'user' as const, content: 'hi' }], []);
    expect(prompt).not.toContain('TOOL ARGUMENT SHAPES');
    expect(prompt).toBe('[User]\nhi');
  });
});

describe('looksLikeConfusedScaffoldingReply', () => {
  it('flags the live WhatsApp incident reply (contract meta-talk with an apologetic tone)', () => {
    const confused = "I'm sorry, but the provided example call to suggest_followups is incomplete and not fully defined. Could you please provide more context or a specific action you'd like me to suggest?";
    expect(looksLikeConfusedScaffoldingReply(confused)).toBe(true);
  });

  it('flags contract meta-talk even without naming a tool (tool/call/schema nouns + confusion tone)', () => {
    expect(looksLikeConfusedScaffoldingReply('I am not sure what to do with the provided tool arguments — please provide more context.')).toBe(true);
    expect(looksLikeConfusedScaffoldingReply("I can't fulfill this request — the given schema is invalid.")).toBe(true);
  });

  it('never flags a legitimate short answer that merely mentions a tool', () => {
    expect(looksLikeConfusedScaffoldingReply('Sure — I can call suggest_followups once the song is written.')).toBe(false);
    expect(looksLikeConfusedScaffoldingReply('Sorry for the delay — here is your song about Kashvi.')).toBe(false);
  });

  it('never flags real deliverables (long answers stay untouched)', () => {
    const song = Array.from({ length: 12 }, (_, i) => `Line ${i + 1} of the song for my dear daughter.`).join('\n');
    expect(looksLikeConfusedScaffoldingReply(song)).toBe(false);
  });

  it('never flags empty content', () => {
    expect(looksLikeConfusedScaffoldingReply('')).toBe(false);
    expect(looksLikeConfusedScaffoldingReply('   ')).toBe(false);
  });

  it('honors a custom tool list (execute loops)', () => {
    expect(looksLikeConfusedScaffoldingReply("I'm sorry, but the provided example call to execute is incomplete.", ['execute'])).toBe(true);
  });

  it('flags the dictionary-of-tasks pattern (Groq/unknown model receiving tool schemas as input)', () => {
    const confused = "I'm sorry, but the provided information seems to be a dictionary of tasks, actions, and their parameters rather than a structured API response. I can't directly interpret or provide a structured response about the tasks you're asking about.";
    expect(looksLikeConfusedScaffoldingReply(confused)).toBe(true);
  });

  it('flags provided information + directly interpret pattern', () => {
    const confused = "Sorry, but the given information doesn't look like a valid request. I cannot directly interpret this format.";
    expect(looksLikeConfusedScaffoldingReply(confused)).toBe(true);
  });
});
