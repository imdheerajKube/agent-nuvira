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
  looksLikeReasoningLeakReply,
  stripLeadingReasoningTrace,
  detectAnswerQualityFailure,
  answerQualityError,
  stripReasoningLeak,
  ANSWER_QUALITY_FAILURE_LINE,
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

  /**
   * The THIRD artifact shape — the model wrote the tool's ARGUMENTS under a
   * bold caption instead of making a call. Captured verbatim from
   * `nuvira execute` (B3pipeline.log): the execute CLI printed this whole block
   * to the user while the gateway's own two-regex strip missed it (no `"tool"`
   * key), which is exactly the surface-parity gap this closes.
   */
  const CAPTIONED_PAYLOAD =
    'Would you like to dive deeper into any of these phases, or need help choosing a stack?  \n' +
    '\n' +
    '**suggest_followups**  \n' +
    '```json\n' +
    '{\n' +
    '  "followups": [\n' +
    '    { "label": "Choose Stack", "prompt": "Compare Electron vs Qt." },\n' +
    '    { "label": "Backlog", "prompt": "Create a feature backlog." }\n' +
    '  ]\n' +
    '}\n' +
    '```\n';

  it('removes a captioned fenced ARGUMENTS payload (the live execute leak)', () => {
    expect(stripToolCallArtifacts(CAPTIONED_PAYLOAD)).toBe(
      'Would you like to dive deeper into any of these phases, or need help choosing a stack?',
    );
  });

  /**
   * The FOURTH shape, captured live from `nuvira execute` on 2026-09-21: the
   * model caption a BARE JSON ARRAY (not an object) with the tool name.
   */
  it('removes a captioned BARE ARRAY payload and the separator before the caption', () => {
    const arr =
      'Plan complete.\n\n---\n\n**suggest_followups**  \n' +
      '[\n' +
      '  { "prompt": "What features should the calculator include?" },\n' +
      '  { "prompt": "Which unit categories do you want in the converter?" }\n' +
      ']\n';
    expect(stripToolCallArtifacts(arr)).toBe('Plan complete.');
  });

  it('leaves a legitimate trailing JSON array alone (no followups shape)', () => {
    const data = 'Here are the primes:\n[2, 3, 5, 7]';
    expect(stripToolCallArtifacts(data)).toBe(data);
  });

  it('removes an uncaptioned fenced arguments payload and a bare trailing one', () => {
    expect(stripToolCallArtifacts('Answer.\n\n```json\n{"followups":[{"prompt":"Next?"}]}\n```')).toBe('Answer.');
    expect(stripToolCallArtifacts('Answer.\n{"followups":[{"prompt":"Next?"}]}')).toBe('Answer.');
    expect(stripToolCallArtifacts('Answer.\n\n**suggest_followups**\n{"followups":["Next?"]}')).toBe('Answer.');
  });

  it('keeps a real earlier code block and only drops the trailing payload', () => {
    const mixed =
      'See:\n\n```js\nconst a = 1;\n```\n\n**suggest_followups**\n```json\n{"followups":[{"prompt":"N"}]}\n```';
    expect(stripToolCallArtifacts(mixed)).toBe('See:\n\n```js\nconst a = 1;\n```');
  });

  it('NEVER touches a user-requested block that merely contains a followups field', () => {
    // Structural, not word-matching: the body parses to a JSON SCHEMA, not to
    // the followups contract, so it survives intact.
    const schema =
      'Here is the schema:\n\n```json\n{"type":"object","properties":{"followups":{"type":"array"}}}\n```';
    expect(stripToolCallArtifacts(schema)).toBe(schema);
    // …and prose that merely names the tool is untouched.
    const prose = 'You can end the turn with suggest_followups when it fits.';
    expect(stripToolCallArtifacts(prose)).toBe(prose);
    // An UNCAPTIONED object of plain STRINGS stays ambiguous — it is also a
    // perfectly ordinary config a user could have asked for, so it survives.
    // (The tool's own `{prompt}` objects need no caption.)
    const ambiguous = 'Config:\n{"followups":["Do you like it?"]}';
    expect(stripToolCallArtifacts(ambiguous)).toBe(ambiguous);
  });
});

/**
 * The model's own reasoning delivered as the answer.
 *
 * Every string below is a VERBATIM opening from the live inbox ledger
 * (~/.nuvira/gateway/inbox.json). These reached a real WhatsApp sender. They
 * slipped past `stripGatewayReasoning` because that stripper is FORMAT-driven
 * — it removes `<think>` blocks and lines carrying a known planning label after
 * a `*`/`1.` marker — and these traces are flat prose with neither.
 */
describe('looksLikeReasoningLeakReply', () => {
  const REAL_LEAKS: Array<[string, string]> = [
    [
      'the "Hi" trace (recites the system prompt back as a checklist)',
      'The user said "Hi" via WhatsApp.\nAccording to the instructions:\n- Deliver answer DIRECTLY.\n- No preamble.\n- No meta-commentary.\n- End with `suggest_followups`.\n\nSince it\'s a simple "Hi", I should respond with a friendly greeting.',
    ],
    [
      'the travel trace (narration prefixed onto a real answer)',
      'The user is asking for travel advice for a trip in December 2026 from Delhi, India.\nOptions: Vietnam or Philippines.\nInterests: Indian food, casinos, and beaches.\nDuration: 7-10 days.\n\nI need to compare Vietnam and the Philippines based on these specific interests.',
    ],
    [
      'the second travel trace',
      'The user is planning a trip in December 2026 from Delhi, India.\nOptions: Vietnam or Philippines.\nInterests: Indian food, Casinos, Beaches.\nDuration: 7-10 days.\n\n**Vietnam Analysis:**',
    ],
  ];

  it.each(REAL_LEAKS)('catches %s', (_name, leak) => {
    expect(looksLikeReasoningLeakReply(leak)).toBe(true);
  });

  it('catches the recite-the-prompt checklist even when it appears alone', () => {
    expect(looksLikeReasoningLeakReply('- No preamble.\n- No meta-commentary.')).toBe(true);
    expect(looksLikeReasoningLeakReply('- End with suggest_followups')).toBe(true);
  });

  it('catches first-person deliberation openers', () => {
    expect(looksLikeReasoningLeakReply('Let me think about how to answer this.')).toBe(true);
    expect(looksLikeReasoningLeakReply('Wait, the prompt says it should be a haiku.')).toBe(true);
    expect(looksLikeReasoningLeakReply('My plan:\n1. Greet the user')).toBe(true);
  });

  it('does NOT flag a real answer — a wrong verdict would burn a good reply', () => {
    const GOOD = [
      'Namaste! How can I help you today?',
      'For casinos AND beaches together, the Philippines wins. Boracay and Palawan are world-class.',
      'Here is the fix:\n\n```ts\nif (!ready) return;\n```',
      // The repo's own domain: `user` is a table. Keying off the bare token
      // "The user" would reject ordinary prose about a schema.
      'The user table now has an index — your request is implemented.',
      'The user can log in with Google now.',
      // A quoted opening is excluded by the start anchor.
      '"The user said X" is a common test fixture — I replaced it with a generator.',
      // Mid-text uses are untouched: the anchor is the FIRST line.
      'Your request has been implemented. The user table now has an index.',
      'I need to know which city you are in before I can answer. Which one is it?',
      'The parser handles nested calls. Actually, it handles them recursively.',
      '1. Install the CLI\n2. Run nuvira gateway start',
    ];
    for (const good of GOOD) {
      expect(looksLikeReasoningLeakReply(good), `wrongly flagged: ${good.slice(0, 50)}`).toBe(false);
    }
  });

  it('is empty-safe', () => {
    expect(looksLikeReasoningLeakReply('')).toBe(false);
    expect(looksLikeReasoningLeakReply('   \n  ')).toBe(false);
  });
});

describe('stripLeadingReasoningTrace', () => {
  it('recovers the deliverable that sat behind a trace (the travel case)', () => {
    // Two of the three real leaks were thinking PREFIXED onto a real answer, so
    // discarding the whole reply would throw away content the sender wanted.
    const reply = [
      'The user is asking for travel advice for a trip in December 2026 from Delhi, India.',
      'Options: Vietnam or Philippines.',
      'Duration: 7-10 days.',
      '',
      'I need to compare Vietnam and the Philippines based on these interests.',
      '',
      // The real ledger shape (asterisk, spaces, asterisk) — the deliverable
      // half of the leak opens on Markdown structure, which the tail gate needs.
      '*   *Beaches:* Vietnam has great beaches in Da Nang, Nha Trang and Phu Quoc.',
    ].join('\n');
    const salvaged = stripLeadingReasoningTrace(reply);
    expect(salvaged).toContain('great beaches in Da Nang');
    expect(salvaged).not.toContain('The user is asking');
    expect(salvaged).not.toContain('I need to compare');
    expect(looksLikeReasoningLeakReply(salvaged)).toBe(false);
  });

  it('refuses a remainder that is still thinking rather than delivering it', () => {
    // The walk cannot know every trace shape, so it may stop one line too late.
    // A non-structural remainder must be refused (→ suppress), never shipped.
    const reply = [
      'The user said "Hi" via WhatsApp.',
      '',
      'Let\'s try to be helpful. If the user is checking whether I work, I should reply.',
    ].join('\n');
    expect(stripLeadingReasoningTrace(reply)).toBe('');
  });

  it('keeps real content in the tail even when a LATER line reads like trace', () => {
    // Live: the salvaged answer's own conclusion was "If the user wants a mix of
    // …" — a whole-tail check would have rejected the content it exists to save.
    const reply = [
      'The user is planning a trip in December 2026.',
      '',
      '**Vietnam Analysis:**',
      '- **Beaches:** Excellent beaches in Da Nang and Phu Quoc.',
      '',
      'If the user wants high-end casinos and world-class beaches, the Philippines wins.',
    ].join('\n');
    const salvaged = stripLeadingReasoningTrace(reply);
    expect(salvaged).toContain('**Vietnam Analysis:**');
    expect(salvaged).toContain('If the user wants high-end casinos');
    expect(salvaged).not.toContain('The user is planning');
  });

  it('empties a reply that was trace and nothing else (the "Hi" case)', () => {
    // Nothing to salvage — the caller must suppress rather than deliver it.
    const trace =
      'The user said "Hi" via WhatsApp.\nAccording to the instructions:\n- Deliver answer DIRECTLY.\n\nSince it\'s a simple "Hi", I should respond with a friendly greeting.';
    expect(stripLeadingReasoningTrace(trace)).toBe('');
  });

  it('does not mutate a reply the detector does not flag', () => {
    const good = 'Namaste! How can I help you today?';
    expect(stripLeadingReasoningTrace(good)).toBe(good);
    const schema = 'The user table now has an index — your request is implemented.';
    expect(stripLeadingReasoningTrace(schema)).toBe(schema);
  });

  it('leaves an answer that merely opens with a quoted trace alone', () => {
    const q = '"The user said X" is a common test fixture — I replaced it with a generator.';
    expect(stripLeadingReasoningTrace(q)).toBe(q);
  });
});

/**
 * The SHARED answer-quality contract — one detector and one error shape, so the
 * chat loop and the loop engine (`nuvira execute` / every pipeline run) cannot
 * disagree about what counts as an answer. The loop engine had no check at all
 * until this existed, and a quality failure never throws on its own, so the
 * failover walk accepted it and the turn was reported as a success.
 */
describe('answer quality — the shared detector and error contract', () => {
  const REASONING = [
    'The user wants a project plan for a "multiple screen calculator".',
    '',
    'I should use the `plan_todo` tool to create a structured plan.',
  ].join('\n');
  const CONFUSION =
    "I'm sorry, but the provided example call to suggest_followups is incomplete. Could you please provide more context?";

  it('classifies each family', () => {
    expect(detectAnswerQualityFailure(REASONING)).toEqual({ kind: 'reasoning' });
    expect(detectAnswerQualityFailure(CONFUSION)).toEqual({ kind: 'confusion' });
    expect(detectAnswerQualityFailure('Here is the plan:\n1. Core engine')).toBeNull();
    expect(detectAnswerQualityFailure('')).toBeNull();
  });

  it('builds a throwable that drives failover and carries the raw reply', () => {
    const err = answerQualityError(REASONING, { kind: 'reasoning' }) as Error & {
      confusedReply?: string;
      qualityKind?: string;
    };
    expect(err.message).toMatch(/its own reasoning instead of the task/);
    expect(err.confusedReply).toBe(REASONING);
    expect(err.qualityKind).toBe('reasoning');
    // The loop engine branches on qualityKind to avoid parking a healthy
    // provider for a prompt it answered in the wrong voice.
    const confusion = answerQualityError(CONFUSION, { kind: 'confusion' }) as Error & {
      qualityKind?: string;
    };
    expect(confusion.message).toMatch(/tool-contract confusion/);
    expect(confusion.qualityKind).toBe('confusion');
  });

  it('has a two-tier signal set: acting steps are judged on high-precision signs only', () => {
    // A tool-carrying step may narrate its action; the final answer may not.
    const deliberation = 'Let me think about the cleanest approach.';
    expect(detectAnswerQualityFailure(deliberation)).toEqual({ kind: 'reasoning' });
    expect(detectAnswerQualityFailure(deliberation, undefined, { highPrecisionOnly: true })).toBeNull();

    // Narrating the CONVERSATION (or reciting the prompt) is high-precision:
    // it is flagged even on a step that carries tool calls — this is the live
    // `nuvira execute` leak, which arrived WITH `plan_todo` and
    // `suggest_followups` calls in the same step.
    const narration = 'The user wants a project plan for a multiple screen calculator.';
    expect(detectAnswerQualityFailure(narration, undefined, { highPrecisionOnly: true })).toEqual({
      kind: 'reasoning',
    });
  });

  it('reports the honest cause instead of "the model was unavailable"', () => {
    const line = toUserFacingGenerationError(answerQualityError(REASONING, { kind: 'reasoning' }));
    expect(line).not.toBe(GENERATION_FAILURE_MESSAGE);
    expect(line).toMatch(/working notes/i);
    expect(line).toMatch(/switch models/);
  });
});

describe('stripReasoningLeak — the render-site sanitizer', () => {
  it('passes a real answer through untouched', () => {
    const good = 'Namaste! How can I help you today?';
    expect(stripReasoningLeak(good)).toBe(good);
  });

  it('recovers the deliverable behind a trace', () => {
    const reply = [
      'The user is asking for a calculator plan.',
      '',
      '**Calculator plan**',
      '1. Core engine — expression parser + conversion tables.',
    ].join('\n');
    const salvaged = stripReasoningLeak(reply);
    expect(salvaged).toContain('**Calculator plan**');
    expect(salvaged).not.toContain('The user is asking');
  });

  it('returns EMPTY (never a fragment) when the trace was the whole reply', () => {
    expect(stripReasoningLeak(REASONING_REPLY_ONLY)).toBe('');
    // The caller substitutes this line, so the user is never shown nothing.
    expect(ANSWER_QUALITY_FAILURE_LINE).toMatch(/working notes/);
  });
});

/** Verbatim from a live `nuvira execute` run — the model's thinking, as shipped. */
const REASONING_REPLY_ONLY = [
  'The user wants a project plan for a "multiple screen calculator and unit converter" with a GUI and cross-platform support.',
  '',
  'I should use the `plan_todo` tool to create a structured plan.',
].join('\n');
