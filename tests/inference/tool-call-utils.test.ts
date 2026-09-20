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
  toUserFacingGenerationError,
  isToolCallingUnsupported,
  stripToolCallArtifacts,
  GENERATION_FAILURE_MESSAGE,
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

/**
 * The second confusion family — the model reads the suggest_followups
 * INSTRUCTION as the user's request and answers by OFFERING to suggest things.
 * Every string below is verbatim from the user's live WhatsApp inbox ledger
 * (~/.nuvira/gateway/inbox.json) or the dashboard reply they reported; all of
 * them were previously delivered to the sender, and the first was also CACHED
 * as a successful answer (so every retry inside the hour replayed it).
 *
 * They cannot be caught by the literal tool name: the model PARAPHRASES it.
 */
describe('looksLikeConfusedScaffoldingReply — contract-as-request deflections', () => {
  const liveDeflections = [
    'Sure, I can help you with suggestions and followups. Please provide me with more details so I can assist you better.',
    "Sure, I can help you with suggesting followups. Please provide some details or a specific query you'd like me to suggest.",
    "I'm ready to help! Could you please provide more details about the tasks or actions you'd like to perform or discuss?",
    'Sure, I can help you with your suggestions. What do you need help with?',
    "Sure! Please provide the details for the action you want me to suggest, and I'll assist you with the suggestions.",
  ];

  it.each(liveDeflections)('flags the live deflection: %s', (reply) => {
    expect(looksLikeConfusedScaffoldingReply(reply)).toBe(true);
  });

  it('still never flags real answers that merely mention suggestions/follow-ups', () => {
    // A genuine answer that happens to use the vocabulary, but is not an
    // offer-to-help + please-provide frame.
    expect(
      looksLikeConfusedScaffoldingReply(
        'Division with a remainder: 20101 ÷ 2 = 10050 remainder 1. Follow-ups: more practice sums.',
      ),
    ).toBe(false);
    expect(looksLikeConfusedScaffoldingReply('Follow-ups: 1. More examples 2. Harder sums')).toBe(false);
    expect(
      looksLikeConfusedScaffoldingReply('I suggest starting with counters, then move to long division.'),
    ).toBe(false);
    // A long real deliverable that happens to contain the vocabulary.
    const long = `${'Teach it with counters and place value. '.repeat(20)}I suggest practice next.`;
    expect(looksLikeConfusedScaffoldingReply(long)).toBe(false);
  });

  it('stays silent on an empty string and whitespace', () => {
    expect(looksLikeConfusedScaffoldingReply('')).toBe(false);
    expect(looksLikeConfusedScaffoldingReply('  \n ')).toBe(false);
  });
});

describe('isToolCallingUnsupported', () => {
  it('flags the live Groq 400 verbatim', () => {
    const err = new Error(
      'Tool-calling API error (400): {"error":{"message":"`tool calling` is not supported with this model","type":"invalid_request_error","param":"tool calling"}}',
    );
    expect(isToolCallingUnsupported(err)).toBe(true);
  });

  it('flags the other phrasing shapes providers use', () => {
    expect(isToolCallingUnsupported(new Error('tools are not supported for this model'))).toBe(true);
    expect(isToolCallingUnsupported(new Error('tool calling is not supported'))).toBe(true);
    expect(isToolCallingUnsupported(new Error('function calling is unsupported'))).toBe(true);
    expect(isToolCallingUnsupported(new Error('this model does not support tool calling'))).toBe(true);
    expect(isToolCallingUnsupported(new Error('tools are not enabled for this request'))).toBe(true);
  });

  it('does NOT flag transient failures (they must fail over, not change transport)', () => {
    expect(isToolCallingUnsupported(new Error('429 rate limit exceeded'))).toBe(false);
    expect(isToolCallingUnsupported(new Error('fetch failed: ECONNREFUSED'))).toBe(false);
    expect(isToolCallingUnsupported(new Error('401 Unauthorized'))).toBe(false);
    expect(isToolCallingUnsupported(new Error('the tool result was too large'))).toBe(false);
    expect(isToolCallingUnsupported(undefined)).toBe(false);
    expect(isToolCallingUnsupported('plain string')).toBe(false);
  });

  it('does NOT flag a malformed tool call — the model supports tools, the CALL was bad', () => {
    // `tool_use_failed` means the model CAN call tools but emitted bad syntax.
    // Salvage (S3) recovers the content; otherwise the turn must FAIL OVER, not
    // silently continue over another transport (pinned by the chat S3 test).
    const body =
      'Tool-calling API error (400): {"error":{"code":"tool_use_failed","failed_generation":"I will implement the login form. <function=build [{\\"goal\\": \\"login\\"}]</function>"}}';
    expect(isToolCallingUnsupported(new Error(body))).toBe(false);
  });
});

describe('toUserFacingGenerationError', () => {
  const gemini429 =
    'Gemini streaming tool-calling API error (429): {"error":{"code":429,' +
    '"message":"You exceeded your current quota","status":"RESOURCE_EXHAUSTED",' +
    '"details":[{"quotaValue":"16000","retryDelay":"34s"}]}}';

  it('maps a provider quota/429 to a plain sentence with no wire text', () => {
    const msg = toUserFacingGenerationError(new Error(gemini429));
    expect(msg).toMatch(/rate limit|quota/i);
    for (const leak of ['429', 'RESOURCE_EXHAUSTED', 'quotaValue', '{"error"', 'retryDelay', 'Gemini']) {
      expect(msg).not.toContain(leak);
    }
  });

  it('maps model-not-found to actionable guidance (the `default` sentinel 404)', () => {
    const msg = toUserFacingGenerationError(
      new Error(
        'Tool-calling API error (404): {"error":{"message":"The model `default` does not exist or you do not have access to it.","code":"model_not_found"}}',
      ),
    );
    expect(msg).toMatch(/isn't available|not available/i);
    expect(msg).not.toContain('model_not_found');
    expect(msg).not.toContain('does not exist');
  });

  it('maps auth, network, server and timeout errors distinctly', () => {
    expect(toUserFacingGenerationError(new Error('401 Unauthorized: invalid api key'))).toMatch(/API key/);
    expect(toUserFacingGenerationError(new Error('fetch failed: ECONNREFUSED'))).toMatch(/network/i);
    expect(toUserFacingGenerationError(new Error('502 Bad Gateway'))).toMatch(/server error/i);
    expect(toUserFacingGenerationError(new Error('request timed out'))).toMatch(/timed out/i);
  });

  it('names the real failure instead of the canned "language model was unavailable"', () => {
    // Live (2026-09-20): a Groq 400 over the JSON-fallback transport surfaced to
    // the dashboard as "the language model was unavailable" — no model outage at
    // all, just a request that outgrew the model's context window.
    const context = toUserFacingGenerationError(
      new Error(
        'API error (400): {"error":{"message":"Please reduce the length of the messages or completion.","type":"invalid_request_error","param":"messages","code":"context_length_exceeded"}}',
      ),
    );
    expect(context).toMatch(/context window/i);
    expect(context).not.toBe(GENERATION_FAILURE_MESSAGE);

    // Our OWN loop errors: a model that talked about the tool contract, and a
    // provider that resolved with an unusable step payload. Both used to fall
    // through to the canned line, which misdiagnosed a reachable model.
    expect(
      toUserFacingGenerationError(
        new Error('model answered with tool-contract confusion instead of the task (reply: Sure, I can help)'),
      ),
    ).toMatch(/tool instructions/i);
    expect(
      toUserFacingGenerationError(new Error('model returned a malformed step response (no content/toolCalls)')),
    ).toMatch(/incomplete/i);

    // A bare abort carries NO class keyword — Node's DOMException is literally
    // "This operation was aborted", which is how an aborted request used to be
    // reported as an unavailable model.
    expect(toUserFacingGenerationError(new Error('This operation was aborted'))).toMatch(/aborted/i);
  });

  it('still calls a timeout a timeout (a timeout is also an abort)', () => {
    expect(toUserFacingGenerationError(new Error('The operation was aborted due to timeout'))).toMatch(/timed out/i);
  });

  it('falls back to the canonical line for anything unrecognized (and non-Errors)', () => {
    expect(toUserFacingGenerationError(new Error('???'))).toBe(GENERATION_FAILURE_MESSAGE);
    expect(toUserFacingGenerationError(undefined)).toBe(GENERATION_FAILURE_MESSAGE);
    expect(toUserFacingGenerationError('plain string')).toBe(GENERATION_FAILURE_MESSAGE);
  });
});

describe('stripToolCallArtifacts', () => {
  const CALL =
    '{"tool":"suggest_followups","arguments":{"followups":[{"label":"More","prompt":"more please"}]}}';

  it('removes a bare trailing followups call (CLI parity with the dashboard)', () => {
    // Live: `nuvira -t "…"` printed exactly this after the real answer.
    expect(stripToolCallArtifacts(`ok\n\n${CALL}`)).toBe('ok');
  });

  it('removes an empty fenced block left behind when the call body was parsed out', () => {
    expect(stripToolCallArtifacts('The plan is ready.\n\n**Next steps**\n\n```json\n```\n')).toBe(
      'The plan is ready.\n\n**Next steps**',
    );
  });

  it('removes a fenced block whose body is the call, and the tag form', () => {
    expect(stripToolCallArtifacts('Done.\n\n```json\n' + CALL + '\n```')).toBe('Done.');
    expect(
      stripToolCallArtifacts('Done\n<function=suggest_followups [{"prompt":"x"}]</function>'),
    ).toBe('Done');
  });

  it('leaves real content and real code blocks untouched', () => {
    const code = 'Here:\n\n```js\nconst a = 1;\n```';
    expect(stripToolCallArtifacts(code)).toBe(code);
    expect(stripToolCallArtifacts('')).toBe('');
  });
});
