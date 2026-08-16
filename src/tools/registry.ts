/**
 * H1 — Tool registry (`src/tools/registry.ts`).
 *
 * ONE declarative source of truth for every tool the agent can invoke:
 * - The C3 pipeline action descriptors (build/resume/repair) — the same
 *   vocabulary `resolveDispatch()` derives, so "a tool registered once works
 *   everywhere with zero per-command re-implementation" (H1 acceptance,
 *   STANDING RULE).
 * - The E3c model-decides task tools (publish/document/website/analyze/test) —
 *   the vocabulary that lets the MODEL decide what a request needs, exactly
 *   like Freebuff/Hermes (the model sees every request and calls the matching
 *   tool; rules are only hints + the no-model fallback, never a bypass).
 * - The first-class experience tools (Session 7c): `ask_user` (Hermes
 *   `clarify_tool.py` parity — in-loop clarification, ≤4 choices +
 *   multi_select), `suggest_followups` (Freebuff `agents/base-chat.ts`
 *   parity — end-of-response follow-up recommendations), and
 *   `verify_requirement` (the C2 requirementState check as a reusable tool).
 *
 * Mirrors Hermes `tools/registry.py` + Freebuff `tool-executor.ts`: one
 * schema (zod), two transports (native tool_calls when the provider supports
 * it, JSON fallback otherwise — C3 acceptance b). The JSON Schema handed to
 * native tool-calling providers is DERIVED from the zod schema via
 * `z.toJSONSchema` — never hand-kept.
 */

import { z, toJSONSchema, type ZodType } from 'zod';
import { ACTION_BY_INTENT } from '../nlu/actions.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export type ToolCategory = 'pipeline' | 'experience' | 'workflow';

/** The JSON-schema form handed to native tool-calling providers. */
export interface ToolJsonSchema {
  name: string;
  description: string;
  /** OpenAPI-style JSON schema derived from the zod inputSchema. */
  parameters: Record<string, unknown>;
}

/**
 * A declarative tool. `run` executes with validated args + context; the
 * returned string is fed back to the model as the tool result (Freebuff
 * tool-executor shape).
 */
export interface Tool {
  /** Tool name — the vocabulary shared with native tool-calling providers. */
  name: string;
  /** Human description (the tool schema description field). */
  description: string;
  category: ToolCategory;
  /** zod input schema — the same schema handed to tool-calling providers. */
  inputSchema: ZodType;
  /**
   * Whether executing this tool should continue the loop after it returns.
   * `false` (e.g. suggest_followups) lets the model end the turn right after
   * (Freebuff `endsAgentStep` semantics).
   */
  endsAgentStep: boolean;
  /** What runs. Returns the tool-result text fed back to the model. */
  run: (args: unknown, ctx: ToolContext) => Promise<string>;
}

/** Context handed to every tool run. */
export interface ToolContext {
  /** ConfigManager — pipeline tools resolve providers/workspace through it. */
  configManager: any;
  /** Working directory (defaults to process.cwd()). */
  cwd?: string;
  /** Live pipeline board (for pipeline tool runs inside the chat loop). */
  board?: any;
  /** Sink for `suggest_followups` results. */
  followups?: FollowupSink;
  /**
   * Injectable ask_user renderer (tests stub it; default renders inquirer).
   * Returns the user's answer(s).
   */
  askUser?: (question: string, choices: AskUserChoice[], multiSelect: boolean) => Promise<AskUserAnswer>;
  /** Emit an event on the observability bus (for pipeline runs). */
  emit?: (event: string, data: unknown, source?: string) => void;
  /** LLM call fn for C2 verify (resolved provider already chosen). */
  callLLM?: import('../agents/agent.js').LLMCallFn;
  /**
   * I3 — artifact sink: tools hand deliverables here (Hermes run.py parity).
   * The tool loop parses `{artifact, result}` payloads, pushes the artifact
   * to this sink, and feeds only `result` back to the model.
   */
  artifacts?: import('./artifact-types.js').ArtifactSink;
  /**
   * Live gateway for `gateway_send`. When present (a gateway-triggered chat
   * answer), delivery reuses the ALREADY-CONNECTED adapters — no second
   * WhatsApp/Telegram connection is opened (a fresh registry would hang on
   * WhatsApp's single-session handshake). Absent (CLI chat/execute) → the
   * tool builds its own registry as before.
   */
  gateway?: {
    send(target: string, text: string): Promise<boolean>;
    directory: { resolve(target: string): { platform: string; channelId: string } | null };
  };
}

/** A Hermes-clarify-style choice. */
export interface AskUserChoice {
  label: string;
  description?: string;
}

/** The ask_user result — mirrors Hermes clarify_tool's answer contract. */
export interface AskUserAnswer {
  /** The chosen label(s) — a single label for single-select, an array for multi. */
  answer: string | string[];
  /** The 0-based index (or indices) of the chosen choice(s). */
  index: number | number[];
  /** Free text when the user typed a custom answer. */
  custom?: string;
}

/** A Freebuff-style follow-up recommendation. */
export interface FollowupSuggestion {
  /** The full prompt sent as the next user message when clicked. */
  prompt: string;
  /** Optional short display label (defaults to the prompt). */
  label?: string;
}

/** Sink collecting `suggest_followups` calls during a loop. */
export interface FollowupSink {
  push(followup: FollowupSuggestion): void;
}

// ─── Tool definitions ───────────────────────────────────────────────────────

// Pipeline tools reuse the C3 action descriptors' zod schemas — the exact
// same schemas `resolveDispatch()` hands the orchestrator, never re-declared.

const buildArgs: ZodType = ACTION_BY_INTENT.create.inputSchema;
const resumeArgs: ZodType = ACTION_BY_INTENT.continue.inputSchema;
const repairArgs: ZodType = ACTION_BY_INTENT.fix.inputSchema;

/** Hermes clarify_tool.py parity: question + ≤4 choices + multi_select. */
const askUserSchema = z.object({
  question: z.string().describe('The clarifying question to ask the user'),
  choices: z
    .array(
      z.object({
        label: z.string().describe('Short choice label'),
        description: z.string().optional().describe('Optional one-line detail shown on focus'),
      }),
    )
    .min(2)
    .max(4)
    .describe('2–4 answer choices (Hermes clarify contract)'),
  multi_select: z.boolean().default(false).describe('Allow multiple selections (checkbox)'),
});

/** E3c — publish tool args: bump type + safety flags (irreversible action). */
export const publishToolSchema = z.object({
  goal: z.string().optional().describe('Optional release goal (e.g. "Release v1.2.0")'),
  bump: z.enum(['patch', 'minor', 'major']).default('patch').describe('Version bump type'),
  dry_run: z.boolean().default(false).describe('Preview the publish phases without publishing anything'),
  skip_tests: z.boolean().default(false).describe('Skip the test-verification phase'),
});

/** E3c — the task tools all carry a goal (model-decides vocabulary). */
const taskGoalArgs = z.object({ goal: z.string().describe('The task goal passed to the agent pipeline') });

/** E3g — gateway message delivery: target + text (model-decides vocabulary). */
export const gatewaySendSchema = z.object({
  target: z
    .string()
    .min(1)
    .describe('Channel target — a registered alias (e.g. "ops") or platform:channelId (e.g. "whatsapp:Alex", "whatsapp:+15551234567", "telegram:123456", "slack:C0123", "email:team@example.com"). WhatsApp accepts a contact NAME from the paired account\'s address book (e.g. "Alex").'),
  text: z.string().min(1).describe('The message text to send to the channel/contact'),
});

/** run_cli — plain-English → CLI execution via the command manifest. */
export const runCliSchema = z.object({
  ask: z
    .string()
    .min(1)
    .describe('The plain-English request, e.g. "stop the dashboard", "add Rahul to whatsapp", "run the eval suite", "send a message to ops". The tool resolves it against the command manifest and executes the matching buff command.'),
  confirm: z
    .boolean()
    .optional()
    .default(false)
    .describe('Set true ONLY after the user explicitly confirmed a destructive/system-level command (stop/shutdown/publish/clear/disallow). The tool refuses without it.'),
});

/** H2 — delegate tool args: a focused subtask for a specialized sub-agent. */
const delegateSchema = z.object({
  agent_type: z.string().describe('The specialized sub-agent to run (e.g. context-gatherer, reviewer, security, tester)'),
  prompt: z.string().describe('The focused subtask for the sub-agent'),
  files: z.array(z.string()).optional().describe('Optional file paths the sub-agent should read as context'),
});

/** I1 — web_search tool args: free-tier web search (Freebuff researcher-web parity). */
const webSearchSchema = z.object({
  query: z.string().min(1).describe('The search query (plain words work best)'),
  max_results: z.number().int().min(1).max(20).default(5).describe('Max results to return (default 5)'),
});

/** I1 — read_page tool args: fetch a URL and return its readable text. */
const readPageSchema = z.object({
  url: z.string().url().describe('The URL to read (http/https)'),
  max_chars: z.number().int().min(1000).max(50000).default(20000).describe('Max characters of extracted text (default 20000)'),
});

/** I2 — browser tool args: Playwright automation (optional install). */
const browserSchema = z.object({
  action: z.enum(['open', 'click', 'type', 'extract', 'screenshot']).describe('What to do: open a URL, click a selector, type into a field, extract page text, or screenshot'),
  url: z.string().url().optional().describe('URL for action=open'),
  selector: z.string().optional().describe('CSS selector for click/type/extract'),
  text: z.string().optional().describe('Text to type (action=type)'),
  timeout_ms: z.number().int().min(500).max(120000).default(15000).optional().describe('Navigation/timeout in ms'),
});

/** I3 — generate_image tool args: free image generation. */
const imageGenSchema = z.object({
  prompt: z.string().min(1).describe('The image description'),
  width: z.number().int().min(64).max(2048).default(1024).optional().describe('Image width (default 1024)'),
  height: z.number().int().min(64).max(2048).default(1024).optional().describe('Image height (default 1024)'),
});

/** I4 — voice tools: TTS + transcription (optional installs). */
const speakSchema = z.object({
  text: z.string().min(1).describe('The text to speak'),
  voice: z.string().optional().describe('TTS voice (edge-tts voice id, default en-US-AriaNeural)'),
});

const transcribeSchema = z.object({
  audio_path: z.string().describe('Path to the audio file to transcribe (wav/mp3/m4a)'),
  model: z.string().optional().describe('Whisper model (default base)'),
});

/** I5 — vision tool args: describe an image (local llava / free Gemini). */
const describeImageSchema = z.object({
  path: z.string().describe('Path to the image file (png/jpg)'),
  prompt: z.string().optional().describe('Optional custom description prompt'),
});

/** F2 — code_search tool args: ripgrep-fast project search for context gathering. */
const codeSearchSchema = z.object({
  pattern: z.string().describe('The regex or literal pattern to search for'),
  globs: z
    .array(z.string())
    .optional()
    .describe('Optional include/exclude globs, e.g. ["src/**", "!**/*.test.ts"]'),
  max_results: z.number().int().min(1).max(500).default(50).describe('Max matches to return (default 50)'),
  case_sensitive: z.boolean().default(false).describe('Case-sensitive match'),
  whole_word: z.boolean().default(false).describe('Whole-word match only'),
});



/** P0.2 — read_file tool args: open a file with line numbers (deny-first). */
const readFileSchema = z.object({
  path: z.string().describe('Path to the file to read, relative to the workspace root (e.g. "src/server.ts"). Absolute paths outside the workspace and ".." traversal are denied.'),
  offset: z.number().int().min(1).default(1).describe('First line number to read (1-based). Continue a truncated read by passing the next line.'),
  limit: z.number().int().min(1).max(2000).default(2000).describe('Max lines to read (default 2000).'),
});

/** P0.2 — list_dir tool args: list a directory (deny-first). */
const listDirSchema = z.object({
  path: z.string().optional().describe('Directory to list, relative to the workspace root (default "." — the workspace root itself).'),
});

/** P0.2 — glob tool args: find files by pattern (deny-first). */
const globSchema = z.object({
  pattern: z.string().describe('Glob pattern relative to the workspace root, e.g. "src/**\/*.ts", "tests/*.test.ts". Supports ** (any depth), * (within a segment) and ?. Absolute patterns and ".." escapes are denied.'),
  max_results: z.number().int().min(1).max(500).default(200).describe('Max matches to return (default 200).'),
});

/** The C2 requirementState check as a reusable tool. */
const verifyRequirementSchema = z.object({
  request: z.string().describe('The user request whose completeness should be verified'),
});

/**
 * The shared suggest_followups output schema (exported for cross-command
 * parity — execute/plan post-run followups validate against the SAME schema
 * the chat loop's tool uses, so one contract is enforced everywhere).
 */
export const suggestFollowupsSchema = z.object({
  followups: z
    .array(
      z.object({
        prompt: z.string().min(1).describe('The full follow-up prompt the user can click to send'),
        label: z.string().optional().describe('Short display label (defaults to the prompt)'),
      }),
    )
    // Freebuff parity: min 1, NO hard max — the model aims for ~3, but a
    // model emitting 4–5 valid followups must still PARSE (a zod rejection
    // here would feed a tool error back and force a wasteful retry loop, the
    // exact failure class the essay diagnosis fixed). Callers render the
    // top N for display; the loop's last-call-wins dedupes repeats.
    .min(1)
    .describe('Suggested followup prompts the user can click to send (aim for ~3)'),
});

// ─── Registry ───────────────────────────────────────────────────────────────

const registry = new Map<string, Tool>();

/**
 * Register a tool. The registry is a Map, so re-registering the same name
 * replaces the definition (idempotent — safe on hot module reloads).
 */
export function registerTool(tool: Tool): void {
  registry.set(tool.name, tool);
}

/** Look up a tool by name. */
export function getTool(name: string): Tool | undefined {
  return registry.get(name);
}

/** All registered tools, sorted by name (stable `buff tools list` output). */
export function listTools(): Tool[] {
  return [...registry.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The JSON-schema form of every tool — handed to native tool-calling
 * providers (OpenAI `tools: [{type:'function',function:{...}}]`). Derived
 * from the zod schemas, never hand-kept.
 */
export function toolJsonSchemas(toolNames?: string[]): ToolJsonSchema[] {
  const tools = toolNames ? toolNames.map((n) => registry.get(n)).filter((t): t is Tool => !!t) : listTools();
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: toJSONSchema(t.inputSchema) as Record<string, unknown>,
  }));
}

// ─── The tool contract (system-prompt text) ─────────────────────────────────

/**
 * The Freebuff-parity tool contract embedded in the chat system prompt
 * (verified against `agents/base-chat.ts`): the model ends its response by
 * calling suggest_followups with exactly 3 followups, and clarifies ambiguous
 * requests via ask_user instead of guessing.
 */
export const TOOL_CONTRACT = `You have tools available. Call them when appropriate.

- If a request is ambiguous or incomplete, call \`ask_user\` with a question and 2–4 choices — never guess, never ask in plain text.
- If a request needs code written, debugged, or prior work resumed, call \`build\`, \`repair\`, or \`resume\` with the goal.
- If a request needs documentation, a website, analysis of a project, or running tests, call \`document\`, \`website\`, \`analyze\`, or \`test\` with the goal.
- If a request asks to publish a release (npm/GitHub), call \`publish\`. It is irreversible — confirm the bump type and target with the user via \`ask_user\` first unless they already specified them.
- If a request's completeness is uncertain, call \`verify_requirement\` first.
- If a request asks to deliver a message or result to a contact/channel (WhatsApp, Telegram, Slack, email, …), call \`gateway_send\` with the target (e.g. \`whatsapp:Alex\`) and the text. If the target contact is not configured, tell the user what to set up.
- If a request asks to manage the system/agent itself in plain English — start/stop the dashboard or gateway, check status, add/remove a verified sender, configure a platform (telegram/whatsapp), run evals, show stats — call \`run_cli\` with the plain-English ask. It resolves the exact \`buff\` command and runs it. If the tool reports AMBIGUOUS or asks for confirmation, call \`ask_user\` first, then retry run_cli with the user's answer.
- If a subtask can be delegated to a specialized sub-agent (gather context, review, security scan, run tests), call \`delegate\` with the agent type, a focused prompt, and optional file paths.
- To find code matching a pattern (context gathering, locating definitions/usages), call \`code_search\` with the pattern and optional globs.
- To READ the project: call \`read_file\` to open a file (with line numbers), \`list_dir\` to see a directory's contents, or \`glob\` to find files by pattern. Always prefer reading the actual file over assuming its contents — a large file reports a line range, continue with offset/limit.
- END EVERY RESPONSE by calling \`suggest_followups\` with exactly 3 followups the user is likely to want next — natural next questions, deeper dives, or related directions that build on what you just said; specific to this conversation, not generic.
- If you have nothing to add, answer directly and still end with suggest_followups.
- ORDERING (non-negotiable): deliver the user's answer FIRST, then suggest_followups. The followup call must come only AFTER the complete answer is written — never before it, never instead of it. A bare lead-in ("Sure, I can help!") is NOT an answer; write the full answer in the same step as the followup call.`;

/** The JSON-fallback tool contract — for providers WITHOUT native tool-calling. */
export const TOOL_CONTRACT_JSON = `${TOOL_CONTRACT}

TOOL CALL FORMAT (JSON fallback transport):
When calling a tool, emit its JSON AFTER your response text, in this exact shape:
{"tool":"<name>","arguments":{...}}
One tool call per block. The final block may be a suggest_followups call.`;

// ─── Built-in registration (module load) ────────────────────────────────────

registerTool({
  name: 'build',
  description: ACTION_BY_INTENT.create.description,
  category: 'pipeline',
  inputSchema: buildArgs,
  endsAgentStep: true,
  run: (args, ctx) => runPipelineTool('build', args, ctx),
});

registerTool({
  name: 'resume',
  description: ACTION_BY_INTENT.continue.description,
  category: 'pipeline',
  inputSchema: resumeArgs,
  endsAgentStep: true,
  run: (args, ctx) => runPipelineTool('resume', args, ctx),
});

registerTool({
  name: 'repair',
  description: ACTION_BY_INTENT.fix.description,
  category: 'pipeline',
  inputSchema: repairArgs,
  endsAgentStep: true,
  run: (args, ctx) => runPipelineTool('repair', args, ctx),
});

// ─── E3c model-decides task tools ───────────────────────────────────────────
// The model-decides vocabulary (Freebuff/Hermes parity): the MODEL sees every
// request and picks the matching tool. Rules (C1/C3) are demoted to hints +
// the no-model fallback — they never bypass the loop. These tools wrap the
// same pipeline core + the publish workflow, so any ask auto-runs.

registerTool({
  name: 'document',
  description: 'Write documentation for the project (README, API docs, guides) through the agent pipeline',
  category: 'pipeline',
  inputSchema: taskGoalArgs,
  endsAgentStep: true,
  run: (args, ctx) => runPipelineTool('document', args, ctx),
});

registerTool({
  name: 'website',
  description: 'Create or build a website / web app end-to-end through the agent pipeline',
  category: 'pipeline',
  inputSchema: taskGoalArgs,
  endsAgentStep: true,
  run: (args, ctx) => runPipelineTool('website', args, ctx),
});

registerTool({
  name: 'analyze',
  description: 'Analyze the project (state, architecture, comparison against another project) and produce findings',
  category: 'pipeline',
  inputSchema: taskGoalArgs,
  endsAgentStep: true,
  run: (args, ctx) => runPipelineTool('analyze', args, ctx),
});

registerTool({
  name: 'test',
  description: 'Run the test suite and fix any failing tests through the agent pipeline',
  category: 'pipeline',
  inputSchema: taskGoalArgs,
  endsAgentStep: true,
  run: (args, ctx) => runPipelineTool('test', args, ctx),
});

registerTool({
  name: 'publish',
  description: 'Publish a release to npm/GitHub (version bump, changelog, build, publish). IRREVERSIBLE — confirm bump type and target with ask_user first.',
  category: 'workflow',
  inputSchema: publishToolSchema,
  endsAgentStep: true,
  run: (args, ctx) => runPublishTool(args, ctx),
});

registerTool({
  name: 'ask_user',
  description: 'Ask the user a clarifying question with 2–4 choices (multi-select optional). Use when a request is ambiguous or missing information.',
  category: 'experience',
  inputSchema: askUserSchema,
  endsAgentStep: true,
  run: async (args, ctx) => {
    const { question, choices, multi_select } = askUserSchema.parse(args);
    const render = ctx.askUser || (await import('./ask-user.js')).renderAskUser;
    const answer = await render(question, choices, multi_select);
    const picked = Array.isArray(answer.answer) ? answer.answer.join(', ') : answer.answer;
    return `User answered: ${picked}${answer.custom ? ` (custom: ${answer.custom})` : ''}`;
  },
});

registerTool({
  name: 'suggest_followups',
  description: 'Suggest clickable followup prompts the user can click to send. Use this tool AFTER completing the task — call it last, after your written answer (never before or instead of it). Aim for ~3 suggestions; skip only when there is no sensible next step (e.g. the user said goodbye).',
  category: 'experience',
  inputSchema: suggestFollowupsSchema,
  endsAgentStep: false,
  run: async (args, ctx) => {
    const { followups } = suggestFollowupsSchema.parse(args);
    for (const f of followups) {
      ctx.followups?.push({ prompt: f.prompt, label: f.label });
    }
    return `Recorded ${followups.length} follow-up suggestion(s).`;
  },
});

// ─── F2 code-search tool (ripgrep-fast project search) ─────────────────────
// Freebuff/Hermes both expose code search to the agent for context gathering.
// Backed by `src/utils/code-search.ts` (bundled ripgrep + fs fallback); no
// LLM needed — runs entirely on file system access.

registerTool({
  name: 'code_search',
  description: 'Search the project for a regex/literal pattern (ripgrep-fast), returning matching file:line:column entries. Use for context gathering: finding definitions, usages, and where things live.',
  category: 'workflow',
  inputSchema: codeSearchSchema,
  endsAgentStep: false,
  run: async (args, ctx) => {
    const { pattern, globs, max_results, case_sensitive, whole_word } = codeSearchSchema.parse(args);
    // Deferred import: code-search pulls @vscode/ripgrep; keep registry import-light.
    const { searchCode } = await import('../utils/code-search.js');
    const result = await searchCode(pattern, {
      cwd: ctx.cwd,
      globs,
      maxResults: max_results,
      caseSensitive: case_sensitive,
      wholeWord: whole_word,
    });
    if (result.matches.length === 0) {
      return result.error
        ? `code_search error: ${result.error}`
        : `No matches found for pattern: ${pattern}`;
    }
    const lines = result.matches.map((m) => `${m.file}:${m.line}:${m.column}: ${m.text.trim()}`);
    const truncated = result.truncated ? `\n(truncated — showing first ${lines.length} of more)` : '';
    return `[${result.engine}] ${result.matches.length} match${result.matches.length !== 1 ? 'es' : ''} for /${pattern}/${case_sensitive ? '' : 'i'}${truncated}\n${lines.join('\n')}`;
  },
});

// ─── P0.2 coding perception tools (read_file / list_dir / glob) ───────────
// The interactive file-access layer: the agent can finally OPEN the files
// code_search finds. Deny-first workspace gate (no escapes, no symlink
// outs), size caps + truncation notes so a huge file never floods context.
// Backed by `src/tools/coding-tools.ts` (pure fs — no new dependencies).

registerTool({
  name: 'read_file',
  description: 'Read a file with line numbers (offset/limit for large files). Use to open the actual contents of a file code_search or glob located — never guess what a file contains.',
  category: 'workflow',
  inputSchema: readFileSchema,
  endsAgentStep: false,
  run: (args, ctx) => import('./coding-tools.js').then((m) => m.runReadFile(args as import('./coding-tools.js').ReadFileArgs, ctx)),
});

registerTool({
  name: 'list_dir',
  description: 'List a directory in the workspace (subdirectories first, sorted). Use to explore project structure — what is in this folder, where does this component live.',
  category: 'workflow',
  inputSchema: listDirSchema,
  endsAgentStep: false,
  run: (args, ctx) => import('./coding-tools.js').then((m) => m.runListDir(args as import('./coding-tools.js').ListDirArgs, ctx)),
});

registerTool({
  name: 'glob',
  description: 'Find files by glob pattern relative to the workspace (e.g. "src/**\/*.ts", "tests/*.test.ts"). Use to locate files by shape when code_search content search does not fit.',
  category: 'workflow',
  inputSchema: globSchema,
  endsAgentStep: false,
  run: (args, ctx) => import('./coding-tools.js').then((m) => m.runGlob(args as import('./coding-tools.js').GlobArgs, ctx)),
});

// ─── I1 web-research tools (web_search / read_page) ─────────────────────────
// Freebuff `researcher-web.ts` / `researcher-docs.ts` + Hermes
// `web_search_registry.py` parity: the model can search the web and read a
// page's text to ground its answers (capability gap #3, 🔴 MAJOR). Free
// backends only: DuckDuckGo HTML (no key) / SearXNG (self-host) for search,
// Jina Reader free tier or a plain fetch for page text. Backed by
// `src/tools/web-research.ts` (mocked-fetch tests, no network).

registerTool({
  name: 'web_search',
  description: 'Search the web for a query, returning title/url/snippet hits (DuckDuckGo free tier or a configured SearXNG). Use to ground answers in current information.',
  category: 'workflow',
  inputSchema: webSearchSchema,
  endsAgentStep: false,
  run: async (args) => {
    const { query, max_results } = webSearchSchema.parse(args);
    const { searchWeb } = await import('./web-research.js');
    // Self-hosted SearXNG opt-in via env (free/OSS); unset → DuckDuckGo.
    const searxngUrl = process.env.BUFF_SEARXNG_URL;
    const results = await searchWeb(query, { maxResults: max_results, searxngUrl });
    if (results.length === 0) {
      return `web_search: no results for "${query}" (backend unavailable or network error).`;
    }
    const lines = results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ''}`);
    return `web_search: ${results.length} result${results.length !== 1 ? 's' : ''} for "${query}":\n${lines.join('\n')}`;
  },
});

registerTool({
  name: 'read_page',
  description: 'Fetch a URL and return its readable text (Jina Reader free tier when JINA_API_KEY is set, else a plain fetch). Use to read a full page found by web_search.',
  category: 'workflow',
  inputSchema: readPageSchema,
  endsAgentStep: false,
  run: async (args) => {
    const { url, max_chars } = readPageSchema.parse(args);
    const { readWebPage } = await import('./web-research.js');
    const text = await readWebPage(url, { maxChars: max_chars });
    if (!text) {
      return `read_page: could not read ${url} (network error, blocked, or empty page).`;
    }
    return `read_page: ${url} (${text.length} chars):\n${text}`;
  },
});

// ─── I2–I5 modality packs (browser / image / voice / vision) ────────────────

registerTool({
  name: 'browser',
  description: 'Automate a real browser (open/click/type/extract/screenshot). Requires the optional playwright package (npm i playwright && npx playwright install chromium). Use for tasks that need a live page (login flows, scraping dynamic sites).',
  category: 'workflow',
  inputSchema: browserSchema,
  endsAgentStep: false,
  run: async (args) => {
    const parsed = browserSchema.parse(args);
    const { runBrowserTool } = await import('./modality/browser.js');
    return runBrowserTool(parsed.action, {
      url: parsed.url,
      selector: parsed.selector,
      text: parsed.text,
      timeoutMs: parsed.timeout_ms,
    });
  },
});

registerTool({
  name: 'generate_image',
  description: 'Generate an image from a text prompt (Pollinations.ai free endpoint, or a local Stable Diffusion/ComfyUI via BUFF_IMAGE_API_URL). The image is saved to the sandbox images/ dir and the path is returned.',
  category: 'workflow',
  inputSchema: imageGenSchema,
  endsAgentStep: false,
  run: async (args) => {
    const parsed = imageGenSchema.parse(args);
    const { generateImage, isImageGenAvailable } = await import('./modality/image-gen.js');
    if (!isImageGenAvailable()) return 'generate_image: unavailable (no image backend configured).';
    const result = await generateImage(parsed.prompt, {
      width: parsed.width,
      height: parsed.height,
      apiUrl: process.env.BUFF_IMAGE_API_URL,
    });
    return result.ok
      ? `generate_image: saved to ${result.file}`
      : `generate_image: failed — ${result.error}`;
  },
});

registerTool({
  name: 'speak',
  description: 'Synthesize speech for text to an audio file (edge-tts or Piper, both free and local). Requires edge-tts or piper on PATH. Returns the audio file path.',
  category: 'workflow',
  inputSchema: speakSchema,
  endsAgentStep: false,
  run: async (args) => {
    const parsed = speakSchema.parse(args);
    const { speak } = await import('./modality/voice.js');
    const result = await speak(parsed.text, { voice: parsed.voice });
    return result.ok ? `speak: saved to ${result.file}` : `speak: failed — ${result.error}`;
  },
});

registerTool({
  name: 'transcribe',
  description: 'Transcribe an audio file to text (whisper.cpp or faster-whisper, local and free). Requires whisper on PATH. Returns the transcript.',
  category: 'workflow',
  inputSchema: transcribeSchema,
  endsAgentStep: false,
  run: async (args) => {
    const parsed = transcribeSchema.parse(args);
    const { transcribe } = await import('./modality/voice.js');
    const result = await transcribe(parsed.audio_path, { model: parsed.model });
    return result.ok ? `transcribe: ${result.text}` : `transcribe: failed — ${result.error}`;
  },
});

registerTool({
  name: 'describe_image',
  description: 'Describe an image (local Ollama llava/llama3.2-vision, or free Gemini vision when BUFF_GEMINI_API_KEY is set). Use for screenshots, diagrams, or any image the user references.',
  category: 'workflow',
  inputSchema: describeImageSchema,
  endsAgentStep: false,
  run: async (args) => {
    const parsed = describeImageSchema.parse(args);
    const { describeImage, isVisionAvailable } = await import('./modality/vision.js');
    if (!(await isVisionAvailable())) {
      return 'describe_image: unavailable — start Ollama with a vision model (llava) or set BUFF_GEMINI_API_KEY.';
    }
    const result = await describeImage(parsed.path, parsed.prompt);
    return result.ok ? `describe_image: ${result.description}` : `describe_image: failed — ${result.error}`;
  },
});

registerTool({
  name: 'gateway_send',
  description: 'Send a message to a channel through the gateway (WhatsApp by contact name or number, Telegram, Slack, Discord, email, or any registered alias). Use when the user asks to deliver a result or message to a contact or channel — e.g. "send the poem to Alex on whatsapp".',
  category: 'workflow',
  inputSchema: gatewaySendSchema,
  endsAgentStep: false,
  run: (args, ctx) => import('./gateway-send.js').then((m) => m.runGatewaySendTool(args, ctx)),
});

registerTool({
  name: 'run_cli',
  description: 'Resolve a plain-English request into the exact buff CLI command and execute it (start/stop the dashboard or gateway, check status, add a verified sender or send-by-name contact, configure a platform like telegram/whatsapp, run evals, show stats, manage memory/cache, etc.). Use when the user describes a system/tooling task in plain English instead of typing the command — e.g. "stop the dashboard", "add Rahul to whatsapp", "enable telegram support", "run the eval suite". Ambiguous asks and destructive actions are gated: the tool returns what to confirm, then call ask_user and retry with confirm:true when the user agreed.',
  category: 'workflow',
  inputSchema: runCliSchema,
  endsAgentStep: false,
  run: (args, ctx) => import('./run-cli.js').then((m) => m.runCliTool(args, ctx)),
});

registerTool({
  name: 'verify_requirement',
  description: 'Verify whether a user request is complete enough to act on (requirementState: complete vs needs-clarification), returning the missing information.',
  category: 'experience',
  inputSchema: verifyRequirementSchema,
  endsAgentStep: false,
  run: async (args, ctx) => {
    const { request } = verifyRequirementSchema.parse(args);
    return verifyRequirement(request, ctx);
  },
});

// ─── H2 delegation tool (sub-agent registry) ────────────────────────────────
// Freebuff `spawn_agents` / Hermes `delegate_tool.py` parity: the model can
// spawn a specialized sub-agent with an isolated context. The tool reuses the
// SAME ModuleRegistry the orchestrator uses — the registry is the only place
// agents are declared (H2 acceptance: `buff tools list` shows delegation tools).

registerTool({
  name: 'delegate',
  description: 'Spawn a specialized sub-agent (context-gatherer, reviewer, security, tester, ...) with a fresh isolated context to work on a focused subtask. Returns the sub-agent summary result.',
  category: 'workflow',
  inputSchema: delegateSchema,
  endsAgentStep: false,
  run: async (args, ctx) => {
    const { agent_type, prompt, files } = delegateSchema.parse(args);
    if (!ctx.callLLM) {
      return 'Error: delegate requires a resolved LLM (callLLM is only available inside a model-driven loop).';
    }
    // Deferred import: keeps registry.ts import-light (delegation pulls the
    // module registry + event bus, which the executor/tool-loop already use).
    const { spawnSubagent } = await import('../agents/tools/delegation.js');
    const result = await spawnSubagent(
      { agentType: agent_type, prompt, files },
      {
        callLLM: ctx.callLLM,
        cwd: ctx.cwd,
        emit: ctx.emit,
      },
    );
    if (!result.success) {
      return `Sub-agent ${agent_type} failed: ${result.error || result.summary}`;
    }
    return `Sub-agent ${agent_type} completed (${Math.round(result.durationMs / 1000)}s): ${result.summary}`;
  },
});

// ─── Shared followups parser (cross-command parity) ─────────────────────────

/**
 * Parse + validate a model's followups output against the shared
 * suggest_followups schema. Accepts both the tool shape `[{prompt,label?}]`
 * and the legacy execute.ts shape `[{label,description,goal}]` (mapped to
 * prompt/label) so every surface speaks one vocabulary. Returns [] when
 * unparseable or schema-invalid (callers fall back to rule-based suggestions).
 */
export function toFollowupSuggestions(raw: string): FollowupSuggestion[] {
  try {
    const jsonMatch = raw.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return [];
    const parsed = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(parsed)) return [];
    const followups = parsed.map((s) => {
      if (typeof s === 'object' && s !== null) {
        const obj = s as Record<string, unknown>;
        return {
          prompt: typeof obj.prompt === 'string' ? obj.prompt : (typeof obj.goal === 'string' ? obj.goal : ''),
          label: typeof obj.label === 'string' ? obj.label : undefined,
        };
      }
      return { prompt: '' };
    });
    const parsed2 = suggestFollowupsSchema.safeParse({ followups });
    return parsed2.success ? parsed2.data.followups : [];
  } catch {
    return [];
  }
}

// ─── Tool run implementations (deferred imports to avoid cycles) ────────────

/** Run a C3 pipeline action (build/resume/repair + E3c task tools) — see executor.ts. */
function runPipelineTool(action: string, args: unknown, ctx: ToolContext): Promise<string> {
  // Deferred import: pipeline-tool imports chat-orchestrator pieces; the
  // registry itself must stay import-light (executor/tool-loop are the users).
  return import('./pipeline-tool.js').then((m) => m.runPipelineToolFromRegistry(action, args, ctx));
}

/** E3c — the publish workflow as a tool (non-interactive, creds via env). */
function runPublishTool(args: unknown, ctx: ToolContext): Promise<string> {
  return import('./publish-tool.js').then((m) => m.runPublishTool(args, ctx));
}

/** The C2 requirementState check — see executor.ts. */
function verifyRequirement(request: string, ctx: ToolContext): Promise<string> {
  return import('./verify-requirement.js').then((m) => m.verifyRequirementTool(request, ctx));
}
