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
 *   (the model sees every request and calls the matching
 *   tool; rules are only hints + the no-model fallback, never a bypass).
 * - The first-class experience tools (Session 7c): `ask_user` (
 *   `clarify_tool.py` parity — in-loop clarification, ≤4 choices +
 *   multi_select), `suggest_followups` (
 *   parity — end-of-response follow-up recommendations), and
 *   `verify_requirement` (the C2 requirementState check as a reusable tool).
 *
 * One
 * schema (zod), two transports (native tool_calls when the provider supports
 * it, JSON fallback otherwise — C3 acceptance b). The JSON Schema handed to
 * native tool-calling providers is DERIVED from the zod schema via
 * `z.toJSONSchema` — never hand-kept.
 */

import { join } from 'path';
import { envBuff } from '../config/paths';
import { z, toJSONSchema, type ZodType } from 'zod';
import { ACTION_BY_INTENT } from '../nlu/actions.js';
import { detectPermissionSeeking, IRREVERSIBLE_ACTION_RE } from '../learning/autonomy-policy.js';

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
 * returned string is fed back to the model as the tool result (
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
   * Whether a SUCCESSFUL call to this tool ends the agent step: the tool's
   * result is then delivered as the step's answer instead of asking the model
   * for one more step (see the endsAgentStep exit in tool-loop.ts).
   *
   * This is set on the DISPENSER tools whose call runs an entire task on its
   * own — `build`/`resume`/`repair`/`document`/`website`/`analyze`/`test`/
   * `publish` — because their result text already IS the deliverable. Every
   * ordinary tool (a read, an edit, a search) and every CONTROL tool
   * (`ask_user` — its result is the user's answer, which the model must act
   * on; `suggest_followups` — it closes the turn through its own followups
   * path) is `false`.
   *
   * NOTE: this docstring previously stated the OPPOSITE (`true` = continue),
   * which contradicted every registration — and nothing read the field, so the
   * declared semantics did nothing at all.
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
  /**
   * G13 — does the CURRENT request authorize file writes?
   *
   * Set once per turn by the tool loop from the last user message (see
   * `requestAuthorizesWrites` in learning/autonomy-policy.ts). The
   * confirm-before-write gate and `ask_user` read it to tell "the user already
   * ordered this" apart from "this would be a surprise", so an unattended run
   * does not stop to ask permission for the work it was asked to do.
   *
   * `undefined` (no loop, direct tool invocation, a test) keeps the original
   * confirm-or-refuse behaviour exactly.
   */
  writesAuthorized?: import('../learning/autonomy-policy.js').WriteAuthorization;
  /**
   * The raw last user message the verdict above was derived from.
   *
   * The verdict answers "did the request ask for FILES" — but each gate needs
   * the evidence ITS OWN question requires, and that evidence lives in the
   * request text: whether the request names the file being edited
   * (`edit_file`), asks for a commit (`git commit`), or resolves to the exact
   * CLI command being run (`run_cli`). Handing the gates the text lets each one
   * measure for itself instead of guessing from a boolean that was computed for
   * a different question.
   *
   * `undefined` (no loop, a direct tool call, a test) means every gate keeps
   * its original confirm-or-refuse behaviour exactly.
   */
  authorizationRequest?: string;
  /** Emit an event on the observability bus (for pipeline runs). */
  emit?: (event: string, data: unknown, source?: string) => void;
  /** LLM call fn for C2 verify (resolved provider already chosen). */
  callLLM?: import('../agents/agent.js').LLMCallFn;
  /**
   * I3 — artifact sink: tools hand deliverables here.
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
    /**
     * Send to an EXPLICIT resolved channel ref. Preferred over `send` for
     * delivery because a failure is ledgered for retry and — with a verified
     * adapter (WhatsApp) — the real reason is available via `lastSendError`.
     */
    sendToRef?(ref: { platform: string; channelId: string }, text: string, target?: string): Promise<boolean>;
    /** Why the most recent send to this target failed (undefined = none/ok). */
    lastSendError?(ref: { platform: string; channelId: string }): string | undefined;
    sendMedia?(target: string, media: { type: 'image' | 'video' | 'audio' | 'document'; data: Uint8Array; caption?: string; filename?: string }): Promise<boolean>;
    /** The originating channel (platform + channelId) for this gateway-triggered turn. */
    origin?: { platform: string; channelId: string };
    /** Auto-deliver a media payload to the originating channel. Tools that produce
     *  artifacts (generate_image, speak, etc.) call this to send results back
     *  without needing to know the target. Returns true on success. */
    autoDeliverMedia?(media: { type: 'image' | 'video' | 'audio' | 'document'; data: Uint8Array; caption?: string; filename?: string }): Promise<boolean>;
    directory: { resolve(target: string): { platform: string; channelId: string } | null };
  };
  /**
   * P0.7 — the session's plan store (plan_todo). The dashboard console
   * injects a PER-SESSION store so plans never leak across conversations;
   * chat.ts falls back to one per ChatCommand instance. Absent (bare test
   * contexts) → plan_todo uses the shared module store (best-effort, never
   * throws).
   */
  planStore?: import('./plan-store.js').PlanStoreLike;
  /**
   * Tiered tool exposure (AGENTIC_CAPABILITY_ASSESSMENT Addendum v3/v4):
   * when the loop runs in 'tiered' mode, tools outside the CORE set are
   * hidden from the model's schema until loaded. A `tool_search` load action
   * writes the loaded toolset names here; the tool loop reads this AFTER
   * each tool execution and unions the loaded toolsets' tool schemas into
   * the live set before the next model step. Optional — absent contexts
   * (tests, non-tiered callers) simply never extend the schema set.
   */
  loadedExtraTools?: Set<string>;
}

/** A clarify-style choice. */
export interface AskUserChoice {
  label: string;
  description?: string;
}

/** The ask_user result — a question + ≤4 choices + multi_select. */
export interface AskUserAnswer {
  /** The chosen label(s) — a single label for single-select, an array for multi. */
  answer: string | string[];
  /** The 0-based index (or indices) of the chosen choice(s). */
  index: number | number[];
  /** Free text when the user typed a custom answer. */
  custom?: string;
}

/**
 * A follow-up recommendation. Defined in the dependency-free leaf module
 * (`followup-utils.ts`) and re-exported here so the many existing importers of
 * `FollowupSuggestion` from the registry keep working unchanged.
 */
import type { FollowupSuggestion } from './followup-utils.js';
export type { FollowupSuggestion } from './followup-utils.js';

/** Sink collecting `suggest_followups` calls during a loop. */
export interface FollowupSink {
  push(followup: FollowupSuggestion): void;
}

// ─── Tool definitions ───────────────────────────────────────────────────────

// ─── Shared auto-delivery helper ─────────────────────────────────────────
// Tools that produce artifact files (generate_image, speak, video_generate)
// use this to automatically send the result back to the originating channel
// when running in a gateway context (WhatsApp/Telegram/etc.).

/** Detect media type from file extension. */
function mediaTypeFromExt(ext: string): 'image' | 'video' | 'audio' | 'document' {
  const e = ext.toLowerCase().replace('.', '');
  if (['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(e)) return 'image';
  if (['mp4', 'mov', 'mkv', 'webm'].includes(e)) return 'video';
  if (['mp3', 'm4a', 'ogg', 'wav'].includes(e)) return 'audio';
  return 'document';
}

/**
 * Try to auto-deliver a local file to the originating gateway channel.
 * Returns a result string to append to the tool's response.
 * Best-effort: never throws, never blocks the tool on failure.
 */
async function tryAutoDeliver(
  filePath: string,
  caption: string | undefined,
  ctx: ToolContext,
  label: string,
): Promise<string> {
  if (!ctx.gateway?.autoDeliverMedia) return '';
  const { readFileSync: fsReadFileSync } = await import('fs');
  const { extname } = await import('path');
  try {
    const data = fsReadFileSync(filePath) as unknown as Uint8Array;
    if (data.length === 0) return '';
    const ext = extname(filePath);
    const type = mediaTypeFromExt(ext);
    const delivered = await ctx.gateway.autoDeliverMedia({
      type,
      data,
      caption,
      filename: filePath.split('/').pop() ?? filePath,
    });
    if (delivered) return ` — ${label} auto-delivered to the originating channel.`;
    return ` — ${label} could not be auto-delivered (the platform may not support media). Use gateway_send with image_path to send manually.`;
  } catch {
    return '';
  }
}

// Pipeline tools reuse the C3 action descriptors' zod schemas — the exact
// same schemas `resolveDispatch()` hands the orchestrator, never re-declared.

const buildArgs: ZodType = ACTION_BY_INTENT.create.inputSchema;
const resumeArgs: ZodType = ACTION_BY_INTENT.continue.inputSchema;
const repairArgs: ZodType = ACTION_BY_INTENT.fix.inputSchema;

/** Clarify contract: question + ≤4 choices + multi_select. */
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
    .describe('2–4 answer choices the user can pick from'),
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

/** E3g — gateway message delivery: target + text + optional media (model-decides vocabulary). */
export const gatewaySendSchema = z.object({
  target: z
    .string()
    .min(1)
    .describe('Channel target — a registered alias (e.g. "ops") or platform:channelId (e.g. "whatsapp:Alex", "whatsapp:+15551234567", "telegram:123456", "slack:C0123", "email:team@example.com"). WhatsApp accepts a contact NAME from the paired account\'s address book (e.g. "Alex").'),
  text: z.string().min(1).describe('The message text to send to the channel/contact'),
  image_path: z
    .string()
    .optional()
    .describe('Absolute path to an image file (png/jpg/jpeg/gif/webp) to send as a media message. When set alongside text, the image is sent with the text as a caption. Supported on WhatsApp, Telegram, and Discord.'),
  caption: z
    .string()
    .optional()
    .describe('Optional caption for the media file (only used when image_path is set). If omitted and text is also set, the text is used as the caption.'),
});

/** run_cli — plain-English → CLI execution via the command manifest. */
export const runCliSchema = z.object({
  ask: z
    .string()
    .min(1)
    .describe('The plain-English request, e.g. "stop the dashboard", "add Rahul to whatsapp", "run the eval suite", "send a message to ops". The tool resolves it against the command manifest and executes the matching nuvira command.'),
  confirm: z
    .boolean()
    .optional()
    .default(false)
    .describe('Set true ONLY after the user explicitly confirmed a destructive/system-level command you initiated. When the user’s own request resolves to the exact command (they asked to stop the dashboard), that IS the confirmation — the tool applies it. Irreversible intents (history.clear, memory.prune, stats.cost.clear, publish) always need it.'),
});

/** P3b — gated git args: structured status/log/diff/commit. */
export const gitToolSchema = z.object({
  action: z.enum(['status', 'log', 'diff', 'commit']).describe('What to do — status/log are read-only; diff returns a structured diff (rendered as a card); commit is GATED unless the user’s own request asked for the commit.'),
  message: z.string().optional().describe('Commit message (action=commit, required)'),
  files: z.array(z.string()).optional().describe('Files to stage+commit — the ACCEPTED subset after the user reviewed the diff card (absent = all changes)'),
  confirm: z.boolean().default(false).describe('Commit gate — required only when the MODEL initiated the commit. When the user’s own request asks for a commit ("commit these changes"), that request IS the approval: call it with confirm:false and it applies.'),
  limit: z.number().int().min(1).max(100).optional().describe('Log limit (action=log, default 20)'),
});

/** P3a — clone_repo args: a git URL to assess (depth-1 shallow only). */
export const cloneRepoSchema = z.object({
  url: z.string().min(1).describe('Git repository URL — http(s)://, git@host:path, or git:// only. Cloned depth-1 (shallow) into an ephemeral cache; the turn then operates on the clone.'),
  ref: z.string().optional().describe('Optional branch/tag/commit to check out (default: the remote default branch)'),
});

/** P0.8 — skill tool args: load a reusable capability pack by name (+ params). */
export const skillToolSchema = z.object({
  skill: z.string().optional().describe('Skill name or id to load, e.g. "website-deploy" or "code-assessment". Omit to list every available skill.'),
  params: z.record(z.string(), z.string()).optional().describe('Optional --param=value overrides resolved into {{param}} placeholders in the skill steps'),
  bundle: z.string().optional().describe('P6b — bundle slug to load, e.g. "backend-dev" loads EVERY member skill\'s methodology in one result (cross-skill composition). Use "list" to enumerate available bundles.'),
  manage: z
    .object({
      action: z.enum(['create', 'patch', 'write_file', 'delete']).describe('create = write a DRAFT (preview card gate); patch = apply an old→new text replacement to a draft/skill; write_file = add a reference file to a draft; delete = remove a draft.'),
      name: z.string().describe('Skill/draft name (^[a-z0-9-]+$ — the id it loads by).'),
      markdown: z.string().optional().describe('Full SKILL.md (frontmatter + body) for action=create.'),
      oldText: z.string().optional().describe('Exact text to replace (action=patch).'),
      newText: z.string().optional().describe('Replacement text (action=patch).'),
      file: z.string().optional().describe('Reference file path relative to the draft dir (action=write_file).'),
      content: z.string().optional().describe('Reference file content (action=write_file).'),
    })
    .optional()
    .describe('P6a — /learn-style authoring: manage a skill DRAFT (the preview card is the accept/edit/reject gate).'),
});

/** P0.7 — plan_todo args: declare ordered steps, then update their status. */
export const planTodoSchema = z.object({
  action: z.enum(['create', 'update']).describe('create = declare/replace the plan steps; update = mark one step\'s status'),
  goal: z.string().optional().describe('The plan goal (required for action=create)'),
  steps: z
    .array(
      z.object({
        id: z.string().describe('Short stable step id, e.g. "step-1" or "reproduce"'),
        description: z.string().describe('What this step accomplishes, e.g. "Reproduce the failure with a minimal test"'),
      }),
    )
    .optional()
    .describe('Ordered steps (required for action=create)'),
  id: z.string().optional().describe('The step id to update (required for action=update)'),
  status: z.enum(['pending', 'running', 'done', 'blocked']).optional().describe('New status for the step (required for action=update)'),
});

/** H2 — delegate tool args: a focused subtask for a specialized sub-agent. */
const delegateSchema = z.object({
  agent_type: z.string().describe('The specialized sub-agent to run (e.g. context-gatherer, reviewer, security, tester)'),
  prompt: z.string().describe('The focused subtask for the sub-agent'),
  files: z.array(z.string()).optional().describe('Optional file paths the sub-agent should read as context'),
});

/** I1 — web_search tool args: free-tier web search. */
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
  path: z.string().optional().describe('Path to a single file to read, relative to the workspace root (e.g. "src/server.ts"). Absolute paths outside the workspace and ".." traversal are denied. Prefer `paths` to read several files in one call.'),
  paths: z
    .array(
      z.union([
        z.string(),
        z.object({
          path: z.string(),
          offset: z.number().int().min(1).optional(),
          limit: z.number().int().min(1).max(2000).optional(),
        }),
      ]),
    )
    .optional()
    .describe('Several files to read in ONE call — each entry a path or { path, offset, limit }. Reads share a bounded character budget; each file gets its own line count and a continuation offset when truncated, and one bad path never discards the rest. Prefer this over many read_file calls.'),
  offset: z.number().int().min(1).default(1).describe('First line number to read (single-file form; 1-based). Continue a truncated read by passing the next line.'),
  limit: z.number().int().min(1).max(2000).default(2000).describe('Max lines to read (single-file form; default 2000).'),
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

/** P0.3 — edit_file tool args: surgical exact-text replacement (confirmed). */
const editFileSchema = z.object({
  path: z.string().describe('Path to the file to edit, relative to the workspace root (e.g. "src/server.ts"). Absolute paths outside the workspace and ".." traversal are denied.'),
  old_string: z.string().optional().describe('Exact text to find (single-pair form) — literal match including whitespace. Refused when it occurs multiple times unless allow_multiple is set. Prefer `replacements` for several edits to the same file.'),
  new_string: z.string().optional().describe('Replacement text for the single-pair form (empty string deletes the matched text).'),
  allow_multiple: z.boolean().default(false).describe('Replace ALL occurrences of old_string (single-pair form; default false — an ambiguous match is refused).'),
  replacements: z
    .array(
      z.object({
        old_string: z.string().min(1),
        new_string: z.string(),
        allow_multiple: z.boolean().optional().default(false),
      }),
    )
    .optional()
    .describe('Several replacements to this ONE file in a single call, applied in order. TRANSACTIONAL: if any replacement fails to match, NOTHING is written — so a refactor can never half-apply. Use one call instead of many edits.'),
  dry_run: z.boolean().default(false).describe('Validate and preview the change (returns the unified diff) without writing anything. Needs no confirmation.'),
  confirm: z.boolean().default(false).describe('Set true ONLY after the user explicitly confirmed an edit you initiated. A surgical edit (small relative to the file) to a file the request asked for is applied directly, as is an edit to a file the request names. Refused without it when the edit would rewrite most of the file — a re-run cannot recover that, so it is the user’s call.'),
});

/** P0.3 — write_file tool args: create/overwrite a file (confirmed). */
const writeFileSchema = z.object({
  path: z.string().describe('Path to write, relative to the workspace root (parent directories are created as needed). Overwrites existing content.'),
  content: z.string().describe('The FULL new file content (replaces any existing content).'),
  confirm: z.boolean().default(false).describe('Set true ONLY after the user explicitly confirmed this write via ask_user. CREATING a new file the request asked for needs no confirmation — it is applied directly. Refused without it only when it would REPLACE content that already exists.'),
});

/** P0.4 — run_terminal tool args: verify commands + gated shell execution. */
const runTerminalSchema = z.object({
  command: z.string().min(1).describe('The shell command to run in the workspace — e.g. "npx vitest run tests/foo.test.ts", "npx tsc --noEmit", "npm run build", "git diff --stat". Read-only verify commands run directly. Recoverable workspace commands (dependency installs, mkdir/touch/cp/mv, git add, npm init) also run directly when the request authorized the work; every other state-changing command needs confirm:true after the user approves via ask_user. Destructive/system commands are denied outright.'),
  confirm: z.boolean().default(false).describe('Set true ONLY after the user explicitly confirmed a command you initiated. Required for state-changing commands outside the recoverable workspace set (network fetches, arbitrary code, global installs, anything that leaves the machine).'),
  timeout_ms: z.number().int().min(1000).max(300000).optional().describe('Timeout in ms (default 120000).'),
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
    // min 1, NO hard max — the model aims for ~3, but a
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

/** All registered tools, sorted by name (stable `nuvira tools list` output). */
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
 * The tool contract embedded in the chat system prompt
 * (verified against `agents/base-chat.ts`): the model ends its response by
 * calling suggest_followups with exactly 3 followups, and clarifies ambiguous
 * requests via ask_user instead of guessing.
 */
export const TOOL_CONTRACT = `You have tools available. Call them when appropriate.

- If a request is ambiguous or incomplete, call \`ask_user\` with a question and 2–4 choices — never guess, never ask in plain text.
- If a request needs code written, debugged, or prior work resumed, call \`build\`, \`repair\`, or \`resume\` with the goal.
- If a request needs documentation, a website, analysis of a project, or running tests, call \`document\`, \`website\`, \`analyze\`, or \`test\` with the goal.
- If a request asks to publish a release (npm/GitHub), call \`publish\`. It leaves this machine and is irreversible — confirm the bump type and target with the user via \`ask_user\` first unless they already specified them.
- If a request's completeness is uncertain, call \`verify_requirement\` first.
- If a request asks to deliver a message or result to a DIFFERENT contact/channel than the one you are currently chatting on (WhatsApp, Telegram, Slack, email, …), call \`gateway_send\` with the target (e.g. \`whatsapp:Alex\`) and the text. Do NOT call gateway_send to reply to the CURRENT conversation — your text response is automatically delivered back. If the target contact is not configured, tell the user what to set up.
- If a request asks to manage the system/agent itself in plain English — start/stop the dashboard or gateway, check status, add/remove a verified sender, configure a platform (telegram/whatsapp), run evals, show stats — call \`run_cli\` with the plain-English ask. It resolves the exact \`nuvira\` command and runs it. If the user's own request already resolves to that command ("stop the dashboard"), it just runs — do not ask for permission to do what was just asked. If it reports AMBIGUOUS, call \`ask_user\` with the two choices; if the intent is one YOU chose rather than the user (or is irreversible: history.clear, memory.prune, stats.cost.clear, publish), call \`ask_user\` first and retry with confirm:true.
- If a subtask can be delegated to a specialized sub-agent (gather context, review, security scan, run tests), call \`delegate\` with the agent type, a focused prompt, and optional file paths.
- To find code matching a pattern (context gathering, locating definitions/usages), call \`code_search\` with the pattern and optional globs.
- To READ the project: call \`read_file\` to open a file (with line numbers), \`list_dir\` to see a directory's contents, or \`glob\` to find files by pattern. Always prefer reading the actual file over assuming its contents — a large file reports a line range, continue with offset/limit.
- To CHANGE code (after reading it): call \`edit_file\` for a surgical exact-text replacement, or \`write_file\` to create/replace a file. CREATING a file the request asked for is applied directly — no confirmation needed, so just call it. An \`edit_file\` that is surgical (small relative to the file) also applies directly, as does one on a file the request names — the verify loop must not need a human between iterations. A whole-file write over existing content, or an edit that rewrites most of a file, refuses without confirm — call \`ask_user\` with a one-line summary, then retry with confirm:true.
- NEVER ask for permission to do work the user already asked for — not via \`ask_user\` and never in plain text. Decide it yourself, state the decision in your answer, and continue. Reserve \`ask_user\` for a decision that is genuinely the user's: it cannot proceed without an answer, it is high-impact AND irreversible, and there is no sensible default (overwriting existing work, deleting data, spending money, publishing).
- To VERIFY code by actual invocation: call \`run_terminal\` with the real command (\`npx vitest run tests/x.test.ts\`, \`npx tsc --noEmit\`, \`npm run build\`, \`git diff\`). Read-only verify commands run directly, and so do recoverable workspace commands (\`npm/pnpm/yarn/bun install\`, \`pip install\`, \`mkdir\`, \`touch\`, \`cp\`, \`mv\`, \`git add\`, \`npm init\`) when the request authorized the work — the build you were asked for is your job to set up. Everything else state-changing (network fetches, arbitrary code, global installs, anything leaving the machine) needs confirm:true after the user approves via ask_user. Never guess that a test passes — run it and read the output. Use run_cli (not run_terminal) for buff/agent-nuvira control commands, and the \`git\` tool (not run_terminal) to commit.
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
// The model-decides vocabulary: the MODEL sees every
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
  // NOT a dispenser: the tool result is the user's ANSWER, which the model
  // must act on in the next step (ending the step here would throw the answer
  // away). See the endsAgentStep contract in this file.
  endsAgentStep: false,
  run: async (args, ctx) => {
    const { question, choices, multi_select } = askUserSchema.parse(args);
    // ── G13: do not round-trip a permission question the ask already answered ─
    // Over a chat surface (WhatsApp/Telegram) an ask_user call is a MESSAGE to
    // the user, so a reflexive "Do you want me to create the full project
    // structure?" costs a full turn and delivers nothing. When the request
    // already authorized the work (and the question is not about something
    // irreversible), the autonomy policy settles it here instead: the model is
    // told to proceed with its own default and to state the decision.
    //
    // Narrow on purpose — both conditions must hold, and any question naming an
    // irreversible action (overwrite, delete, publish, deploy, send, pay…) is
    // passed straight through, because that decision IS the user's.
    if (
      ctx.writesAuthorized?.authorized === true &&
      detectPermissionSeeking(question) &&
      !IRREVERSIBLE_ACTION_RE.test(question)
    ) {
      const recommended = choices[0]?.label ?? '';
      ctx.emit?.('autonomy:consult-suppressed', {
        question,
        authorization: ctx.writesAuthorized.reason,
      }, 'tool-loop');
      return (
        'Not shown to the user: their request already authorized this work, and this is a ' +
        'permission question about doing it. Decide it yourself and continue.\n' +
        (recommended ? `Recommended default: "${recommended}".\n` : '') +
        'Carry the work out now and state the decision in your answer so the user can redirect. ' +
        'Only if the choice is genuinely theirs — it cannot proceed without an answer, is ' +
        'high-impact and irreversible, and has no sensible default — re-call ask_user naming ' +
        'that specific irreversible choice (e.g. whether to overwrite an existing file).'
      );
    }
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
// Code search is exposed to the agent for context gathering.
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
  description: 'Read files with line numbers. Pass `path` for one file (offset/limit for large files) OR `paths` to read several in one call — batching is one step instead of many. Each file gets its own line count and a continuation offset when truncated. Use to open the actual contents of files code_search or glob located — never guess what a file contains.',
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

registerTool({
  name: 'edit_file',
  description: 'Surgical exact-text edit to a file (find old_string, replace with new_string — like str_replace). Make ONE call for ALL edits to a file via `replacements[]` (they apply atomically — all-or-nothing, never a partial edit). Optionally `dry_run` to preview a unified diff without writing. State-changing: confirm with the user via ask_user first, then retry with confirm:true. Use after read_file so the match is exact.',
  category: 'workflow',
  inputSchema: editFileSchema,
  endsAgentStep: false,
  run: (args, ctx) => import('./coding-tools.js').then((m) => m.runEditFile(args as import('./coding-tools.js').EditFileArgs, ctx)),
});

registerTool({
  name: 'write_file',
  description: 'Create a new file or overwrite one with full content (parent directories are created). State-changing: confirm with the user via ask_user first, then retry with confirm:true.',
  category: 'workflow',
  inputSchema: writeFileSchema,
  endsAgentStep: false,
  run: (args, ctx) => import('./coding-tools.js').then((m) => m.runWriteFile(args as import('./coding-tools.js').WriteFileArgs, ctx)),
});

registerTool({
  name: 'run_terminal',
  description: 'Run a shell command in the workspace and see its REAL output — typecheck, a single test file, a build, git diff/status. Use to verify code by actual invocation: run, read the failure, edit, re-run. Verify-class commands (tests/typecheck/build/git-readonly) run directly; state-changing commands need confirm:true after the user approves via ask_user. Destructive/system commands (sudo, git push, rm -rf at dangerous targets, ...) are denied outright.',
  category: 'workflow',
  inputSchema: runTerminalSchema,
  endsAgentStep: false,
  run: (args, ctx) => import('./run-terminal.js').then((m) => m.runTerminalTool(args as import('./run-terminal.js').RunTerminalArgs, ctx)),
});

// ─── P0.7 plan/todo tool (creating AND tracking plans) ─────────────────────
// The model declares ordered steps and updates their status as it works
// (pending → running → done/blocked). State lives in the session's PlanStore
// (survives the turn — a later turn can say "step 3 is done"). Each mutation
// emits `plan:changed` on the context bus with a structured snapshot so the
// dashboard chat renders a live checklist that updates IN PLACE (P0.6 step
// cards show tool calls; this shows the plan itself).

registerTool({
  name: 'plan_todo',
  description: 'Declare and track a multi-step plan: create ordered steps with descriptions, then mark each as running/done/blocked as you work through them. Use for any job with 2+ steps — the checklist persists across the whole conversation, so a later turn can reference "step N is done". Call create once at the start, then update per step as each completes.',
  category: 'workflow',
  inputSchema: planTodoSchema,
  endsAgentStep: false,
  run: async (args, ctx) => {
    const { action, goal, steps, id, status } = planTodoSchema.parse(args);
    const { defaultPlanStore } = await import('./plan-store.js');
    const store: import('./plan-store.js').PlanStoreLike = ctx.planStore ?? defaultPlanStore();
    if (action === 'create') {
      if (!goal || !steps || steps.length === 0) {
        return 'Error: plan_todo create needs goal + steps (id + description each).';
      }
      store.create(goal, steps);
    } else if (id && status) {
      store.update(id, status);
    } else {
      return 'Error: plan_todo update needs id + status (pending|running|done|blocked).';
    }
    // Structured snapshot for the GUI checklist card (best-effort — a missing
    // emit must never break the tool).
    if (store.toGUI) {
      const snapshot = store.toGUI();
      if (snapshot) {
        ctx.emit?.('plan:changed', snapshot);
      }
    }
    return store.toText ? store.toText() : `Plan updated (${action}).`;
  },
});

// ─── I1 web-research tools (web_search / read_page) ─────────────────────────
// The research-tool pattern
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
    const searxngUrl = envBuff('SEARXNG_URL');
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
  description: 'Generate an image from a text prompt (Pollinations.ai free endpoint, or a local Stable Diffusion/ComfyUI via BUFF_IMAGE_API_URL). The image is saved to the sandbox images/ dir and the path is returned. When running in a gateway context (WhatsApp/Telegram/etc.), the image is automatically sent back to the originating channel.',
  category: 'workflow',
  inputSchema: imageGenSchema,
  endsAgentStep: false,
  run: async (args, ctx) => {
    const parsed = imageGenSchema.parse(args);
    const { generateImage, isImageGenAvailable } = await import('./modality/image-gen.js');
    if (!isImageGenAvailable()) return 'generate_image: unavailable (no image backend configured).';
    const result = await generateImage(parsed.prompt, {
      width: parsed.width,
      height: parsed.height,
      apiUrl: envBuff('IMAGE_API_URL'),
    });
    if (!result.ok) return `generate_image: failed — ${result.error}`;
    const file = result.file!;
    const delivered = await tryAutoDeliver(file, parsed.prompt, ctx, 'image');
    return `generate_image: saved to ${file}${delivered}`;
  },
});

registerTool({
  name: 'speak',
  description: 'Synthesize speech for text to an audio file (edge-tts or Piper, both free and local). Requires edge-tts or piper on PATH. Returns the audio file path. When running in a gateway context, the audio is automatically sent back to the originating channel.',
  category: 'workflow',
  inputSchema: speakSchema,
  endsAgentStep: false,
  run: async (args, ctx) => {
    const parsed = speakSchema.parse(args);
    const { speak } = await import('./modality/voice.js');
    const result = await speak(parsed.text, { voice: parsed.voice });
    if (!result.ok) return `speak: failed — ${result.error}`;
    const file = result.file!;
    const delivered = await tryAutoDeliver(file, parsed.text, ctx, 'audio');
    return `speak: saved to ${file}${delivered}`;
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
  description: 'Send a message (text or image) to a DIFFERENT channel or contact through the gateway (WhatsApp by contact name or number, Telegram, Slack, Discord, email, or any registered alias). Do NOT use this tool to reply to the CURRENT conversation — your text response is automatically sent back to the originating channel. Only call this when the user asks you to deliver a result to SOMEONE ELSE — e.g. "send the poem to Alex on whatsapp" (while you are chatting with Divya). For images, set image_path to the file path (e.g. from generate_image output) — the image is sent with text as caption. AUTHORIZATION: on a gateway turn the sender must hold outbound send authority for that platform (dashboard → Agent Hub → Permissions → Send authority); the result string tells you plainly when a send was refused and why — report that to the user honestly and NEVER claim a message was delivered unless this tool returned its \'✅ sent\' result.',
  category: 'workflow',
  inputSchema: gatewaySendSchema,
  endsAgentStep: false,
  run: (args, ctx) => import('./gateway-send.js').then((m) => m.runGatewaySendTool(args, ctx)),
});

registerTool({
  name: 'run_cli',
  description: 'Resolve a plain-English request into the exact nuvira CLI command and execute it (start/stop the dashboard or gateway, check status, add a verified sender or send-by-name contact, configure a platform like telegram/whatsapp, run evals, show stats, manage memory/cache, etc.). Use when the user describes a system/tooling task in plain English instead of typing the command — e.g. "stop the dashboard", "add Rahul to whatsapp", "enable telegram support", "run the eval suite". Ambiguous asks and destructive actions are gated: the tool returns what to confirm, then call ask_user and retry with confirm:true when the user agreed.',
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

// ─── P0.8 skill tool (load reusable capability packs in chat) ──────────────
// The chat agent can finally SAY "load the code-assessment skill" — the skill
// store existed but was unreachable from the chat loop (round-3 finding).
// Backed by `src/tools/skill-tool.ts`: resolves from BOTH the compiled
// SkillStore (nuvira skill list) and the hub catalog (nuvira skills install →
// SKILL.md), returns the methodology (steps + parameters, placeholders
// resolved), marks used, refuses disabled skills, lists on unknown.

registerTool({
  name: 'skill',
  description: 'Load a reusable capability pack (skill) into the conversation — its methodology (ordered steps + parameters) comes back to guide the work. Use when a task matches a known skill: code assessment, technical roadmap, plan creation, test strategy, website deployment, etc. Omit the name to list every available skill.',
  category: 'experience',
  inputSchema: skillToolSchema,
  endsAgentStep: false,
  run: (args, ctx) => import('./skill-tool.js').then((m) => m.runSkillTool(args as import('./skill-tool.js').SkillToolArgs, ctx)),
});

// ─── P3a clone_repo tool (assess other people's projects) ──────────────────
// Copilot parity: "cloned the repo in a temp dir and did analysis". The agent
// can now clone any git repo (depth-1, shallow) into an ephemeral hashed
// cache and scope the WHOLE coding-tool family to it via ctx.cwd — the
// user's own workspace is never touched. Deny-first URL validation + argv
// exec (no shell) make injection structurally impossible.

registerTool({
  name: 'clone_repo',
  description: 'Clone a git repository (depth-1 shallow) into an ephemeral cache and scope the conversation to it — read_file / list_dir / glob / code_search / run_terminal then operate on the CLONE, so you can assess another project without touching the user\'s workspace. Use when the ask is about a repo that is not the attached project.',
  category: 'workflow',
  inputSchema: cloneRepoSchema,
  endsAgentStep: false,
  run: (args, ctx) => import('./clone-repo.js').then((m) => m.runCloneRepo(args as import('./clone-repo.js').CloneRepoArgs, ctx)),
});

// ─── P3b gated git tool (diff/commit with accept-reject) ───────────────────
// The agent can commit IN CONVERSATION, visibly: `git diff` emits a
// structured event the dashboard renders as a 🔧 diff card (per-file +/−
// sections); `git commit` is GATED (confirm:true after ask_user) and stages
// only the ACCEPTED files subset. push/reset --hard/clean are structurally
// unexpressible (the action enum) AND deny-guarded — parity with run_terminal.

registerTool({
  name: 'git',
  description: 'Structured git operations: status/log (read-only), diff (unified output + a diff card in the GUI), and commit (GATED — confirm:true only after the user approved via ask_user; optional files = the accepted subset to stage+commit). Use for the whole commit flow: diff → ask_user (accept/reject files) → commit with confirm:true.',
  category: 'workflow',
  inputSchema: gitToolSchema,
  endsAgentStep: false,
  run: (args, ctx) => import('./git-tool.js').then((m) => m.runGitTool(args as import('./git-tool.js').GitToolArgs, ctx)),
});

// ─── H2 delegation tool (sub-agent registry) ────────────────────────────────
// The model can
// spawn a specialized sub-agent with an isolated context. The tool reuses the
// SAME ModuleRegistry the orchestrator uses — the registry is the only place
// agents are declared (H2 acceptance: `nuvira tools list` shows delegation tools).

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
    // NOTE: this is a PARSER — it validates and returns every followup the
    // model emitted (the schema deliberately has no hard max). Hygiene/capping
    // belongs to the render/collect points (normalizeFollowups), so callers
    // that want the top N keep the whole list to choose from.
    const parsed2 = suggestFollowupsSchema.safeParse({ followups });
    return parsed2.success ? parsed2.data.followups : [];
  } catch {
    return [];
  }
}

// ─── Followup hygiene + continuation ────────────────────────────────────────
// The implementation lives in the dependency-FREE leaf module
// `followup-utils.ts` and is re-exported here for the surfaces that already
// import the registry. It is deliberately NOT implemented inline: the gateway
// and dashboard must be able to normalise a followup (and recognise a clicked
// one) WITHOUT pulling the whole 110-tool registry into their import graph —
// doing so measurably slowed those hot paths.
export {
  MAX_FOLLOWUPS,
  MAX_FOLLOWUP_PROMPT_CHARS,
  MAX_FOLLOWUP_LABEL_CHARS,
  normalizeFollowups,
  FOLLOWUP_CONTINUATION_MARKER,
  buildFollowupContinuationPrompt,
  isFollowupContinuation,
  isSuggestedFollowup,
} from './followup-utils.js';

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

// ─── NEW TOOLS: MCP, Browser, Schema, Binary, Working Diff ─────────────────

// MCP OAuth tool
registerTool({
  name: 'mcp_oauth',
  description: 'MCP OAuth2 authentication: authorize MCP servers via auth code, client credentials, or PKCE flows.',
  category: 'workflow',
  inputSchema: z.object({
    action: z.enum(['authorize', 'refresh', 'revoke', 'status', 'callback']).describe('OAuth action'),
    serverId: z.string().optional().describe('MCP server ID'),
    code: z.string().optional().describe('Authorization code'),
    state: z.string().optional().describe('OAuth state'),
  }),
  endsAgentStep: false,
  run: (args) => import('../mcp/mcp-oauth.js').then((m) => {
    const { action, serverId, code, state } = args as any;
    const mgr = m.getMCPOAuthManager();
    switch (action) {
      case 'status': return JSON.stringify({ servers: Array.from((mgr as any).states?.keys() || []) });
      case 'authorize': return serverId ? mgr.startAuthorizationCodeFlow(serverId, { authorizationUrl: '', tokenEndpoint: '' } as any).then((r: any) => JSON.stringify(r)) : 'serverId required';
      case 'callback': return code && state ? mgr.exchangeCode(serverId || 'default', code, state).then((r: any) => JSON.stringify(r)) : 'code, state, and serverId required';
      case 'refresh': return serverId ? mgr.refreshToken(serverId).then((r: any) => JSON.stringify(r)) : 'serverId required';
      case 'revoke': return serverId ? (mgr.clearTokens(serverId), 'Cleared') : 'serverId required';
      default: return 'Unknown action';
    }
  }),
});

// MCP Schema Cache tool
registerTool({
  name: 'mcp_schema_cache',
  description: 'MCP schema cache: cache tool schemas for faster discovery, invalidate cache.',
  category: 'workflow',
  inputSchema: z.object({
    action: z.enum(['get', 'invalidate', 'stats']).describe('Cache action'),
    serverId: z.string().optional().describe('MCP server ID'),
    configHash: z.string().optional().describe('Config hash'),
  }),
  endsAgentStep: false,
  run: (args) => import('../mcp/mcp-schema-cache.js').then((m) => {
    const { action, serverId, configHash } = args as any;
    const cache = m.getMCPSchemaCache();
    switch (action) {
      case 'get': return serverId && configHash ? JSON.stringify(cache.get(serverId, configHash)) : 'serverId and configHash required';
      case 'invalidate': return serverId ? (cache.invalidate(serverId), 'Invalidated') : 'serverId required';
      case 'stats': return JSON.stringify(cache.getStats());
      default: return 'Unknown action';
    }
  }),
});

// MCP Watchdog tool
registerTool({
  name: 'mcp_watchdog',
  description: 'MCP stdio watchdog: monitor MCP server process health, auto-restart crashed servers.',
  category: 'workflow',
  inputSchema: z.object({
    action: z.enum(['status', 'health']).describe('Watchdog action'),
    serverId: z.string().optional().describe('MCP server ID'),
  }),
  endsAgentStep: false,
  run: (args) => import('../mcp/mcp-watchdog.js').then((m) => {
    const { action } = args as any;
    const watchdog = m.getMCPWatchdog();
    switch (action) {
      case 'status': return JSON.stringify(watchdog.getHealth());
      case 'health': return JSON.stringify(watchdog.getHealth());
      default: return 'Unknown action';
    }
  }),
});

// Browser Supervisor tool
registerTool({
  name: 'browser_supervisor',
  description: 'Browser CDP supervisor: monitor health, detect dialogs, track frames.',
  category: 'workflow',
  inputSchema: z.object({
    action: z.enum(['status', 'health', 'destroy']).describe('Supervisor action'),
    taskId: z.string().optional().describe('Task ID'),
    cdpUrl: z.string().optional().describe('CDP WebSocket URL'),
  }),
  endsAgentStep: false,
  run: (args) => import('./browser-supervisor.js').then((m) => {
    const { action, taskId, cdpUrl } = args as any;
    switch (action) {
      case 'status': return taskId ? JSON.stringify(m.getSupervisor(taskId, '').getSnapshot()) : 'taskId required';
      case 'health': return JSON.stringify(m.getActiveSupervisors().map((s: any) => s.getSnapshot()));
      case 'destroy': return taskId ? (m.removeSupervisor(taskId), 'Destroyed') : 'taskId required';
      default: return 'Unknown action';
    }
  }),
});

// Browser Dialog tool
registerTool({
  name: 'browser_dialog',
  description: 'Handle native browser dialogs: accept, dismiss, or enter values.',
  category: 'workflow',
  inputSchema: z.object({
    action: z.enum(['accept', 'dismiss', 'status', 'accept-all', 'dismiss-all']).describe('Dialog action'),
    taskId: z.string().optional().describe('Task ID'),
    index: z.number().optional().describe('Dialog index'),
    value: z.string().optional().describe('Value for prompts'),
  }),
  endsAgentStep: false,
  run: (args) => import('./browser-dialog.js').then((m) => {
    const { action, taskId, index, value } = args as any;
    const mgr = m.getBrowserDialogManager();
    if (!taskId) return 'taskId required';
    switch (action) {
      case 'accept': return mgr.respond(taskId, index || 0, 'accept', value).then((r: any) => JSON.stringify(r));
      case 'dismiss': return mgr.respond(taskId, index || 0, 'dismiss').then((r: any) => JSON.stringify(r));
      case 'status': return JSON.stringify(mgr.getStatus(taskId));
      case 'accept-all': return mgr.acceptAll(taskId).then((r: any) => JSON.stringify(r));
      case 'dismiss-all': return mgr.dismissAll(taskId).then((r: any) => JSON.stringify(r));
      default: return 'Unknown action';
    }
  }),
});

// Camofox tool
registerTool({
  name: 'camofox',
  description: 'Camofox anti-detection browser: open pages, screenshots, interact via a11y refs.',
  category: 'workflow',
  inputSchema: z.object({
    action: z.enum(['open', 'snapshot', 'click', 'type', 'screenshot', 'navigate', 'close']).describe('Camofox action'),
    url: z.string().optional().describe('URL'),
    ref: z.string().optional().describe('Element ref'),
    text: z.string().optional().describe('Text to type'),
  }),
  endsAgentStep: false,
  run: (args) => import('./browser-camofox.js').then((m) => {
    const { action, url, ref, text } = args as any;
    const client = m.getCamofoxClient();
    switch (action) {
      case 'open': return url ? client.openPage(url).then((r: any) => JSON.stringify(r)) : 'url required';
      case 'snapshot': return client.snapshot().then((r: any) => r.text);
      case 'click': return ref ? client.click(ref).then(() => 'Clicked') : 'ref required';
      case 'type': return ref && text ? client.type(ref, text).then(() => 'Typed') : 'ref and text required';
      case 'screenshot': return client.screenshot().then((r: any) => r.data.slice(0, 100) + '...');
      case 'navigate': return url ? client.navigate(url).then(() => 'Navigated') : 'url required';
      case 'close': return client.closePage().then(() => 'Closed');
      default: return 'Unknown action';
    }
  }),
});

// Docker tool
registerTool({
  name: 'docker',
  description: 'Docker management: containers, images, compose, volumes, networks.',
  category: 'workflow',
  inputSchema: z.object({
    action: z.enum(['list-containers', 'start', 'stop', 'exec', 'logs', 'images', 'compose-up', 'compose-down']).describe('Docker action'),
    name: z.string().optional().describe('Container name'),
    command: z.string().optional().describe('Command for exec'),
    composePath: z.string().optional().describe('Compose file path'),
    lines: z.number().optional().describe('Log lines'),
  }),
  endsAgentStep: false,
  run: (args) => import('./docker-tool.js').then((m) => {
    const { action, name, command, composePath, lines } = args as any;
    const docker = m.getDockerTool();
    switch (action) {
      case 'list-containers': return docker.listContainers().then((r: any) => JSON.stringify(r));
      case 'start': return name ? docker.startContainer(name).then(() => 'Started') : 'name required';
      case 'stop': return name ? docker.stopContainer(name).then(() => 'Stopped') : 'name required';
      case 'exec': return name && command ? docker.exec(name, command).then((r: any) => JSON.stringify(r)) : 'name and command required';
      case 'logs': return name ? docker.logs(name).then((r: any) => JSON.stringify(r)) : 'name required';
      case 'images': return docker.listImages().then((r: any) => JSON.stringify(r));
      case 'compose-up': return composePath ? docker.composeUp(composePath).then((r: any) => JSON.stringify(r)) : 'composePath required';
      case 'compose-down': return composePath ? docker.composeDown(composePath).then(() => 'Stopped') : 'composePath required';
      default: return 'Unknown action';
    }
  }),
});

// Session management tool
registerTool({
  name: 'session',
  description: 'Session search and thread context management.',
  category: 'workflow',
  inputSchema: z.object({
    action: z.enum(['create-session', 'search', 'create-thread']).describe('Session action'),
    query: z.string().optional().describe('Search query'),
    sessionId: z.string().optional().describe('Session ID'),
  }),
  endsAgentStep: false,
  run: (args) => import('./session-tools.js').then((m) => {
    const { action, query } = args as any;
    switch (action) {
      case 'create-session': return JSON.stringify(m.getSessionStore().create(query || 'New session'));
      case 'search': return JSON.stringify(m.getSessionStore().search(query || ''));
      case 'create-thread': return JSON.stringify(m.getThreadContextManager().create(query || 'New thread'));
      default: return 'Action not implemented';
    }
  }),
});

// Schema sanitizer tool
registerTool({
  name: 'sanitize',
  description: 'Sanitize content to prevent XSS, SQL injection, path traversal.',
  category: 'workflow',
  inputSchema: z.object({
    action: z.enum(['sanitize', 'validate']).describe('Action'),
    content: z.string().describe('Content'),
    schema: z.record(z.string(), z.string()).optional().describe('Validation schema'),
  }),
  endsAgentStep: false,
  run: (args) => import('./schema-binary-tools.js').then((m) => {
    const { action, content, schema } = args as any;
    const sanitizer = new m.SchemaSanitizer();
    if (action === 'sanitize') return JSON.stringify(sanitizer.sanitize(content));
    if (action === 'validate' && schema) return JSON.stringify(sanitizer.validate(JSON.parse(content), schema));
    return 'Invalid action';
  }),
});

// Binary extensions tool
registerTool({
  name: 'binary_extensions',
  description: 'Detect binary file extensions, check MIME types.',
  category: 'workflow',
  inputSchema: z.object({
    action: z.enum(['is-binary', 'mime']).describe('Extension action'),
    extension: z.string().optional().describe('File extension'),
  }),
  endsAgentStep: false,
  run: (args) => import('./schema-binary-tools.js').then((m) => {
    const { action, extension } = args as any;
    switch (action) {
      case 'is-binary': return extension ? JSON.stringify({ isBinary: (m.SchemaSanitizer as any).isBinary(extension) }) : 'extension required';
      case 'mime': return extension ? (m.SchemaSanitizer as any).getMimeType(extension) : 'extension required';
      default: return 'Unknown action';
    }
  }),
});

// Working diff tool
registerTool({
  name: 'working_diff',
  description: 'Track working diffs: record changes, list unapplied diffs, mark as applied.',
  category: 'workflow',
  inputSchema: z.object({
    action: z.enum(['record', 'unapplied', 'file-diffs', 'mark-applied']).describe('Diff action'),
    filePath: z.string().optional().describe('File path'),
    diff: z.string().optional().describe('Diff content'),
    diffId: z.string().optional().describe('Diff ID'),
  }),
  endsAgentStep: false,
  run: (args) => import('./project-tools.js').then((m) => {
    const { action, filePath, diff, diffId } = args as any;
    const tracker = m.getWorkingDiffTracker();
    switch (action) {
      case 'record': return filePath && diff ? JSON.stringify(tracker.record(filePath, diff)) : 'filePath and diff required';
      case 'unapplied': return JSON.stringify(tracker.getUnappliedDiffs());
      case 'file-diffs': return filePath ? JSON.stringify(tracker.getFileDiffs(filePath)) : 'filePath required';
      case 'mark-applied': return diffId ? (tracker.markApplied(diffId) ? 'Marked' : 'Not found') : 'diffId required';
      default: return 'Unknown action';
    }
  }),
});

// Kanban tool
registerTool({
  name: 'kanban',
  description: 'Kanban board: create boards, manage cards, track priorities.',
  category: 'workflow',
  inputSchema: z.object({
    action: z.enum(['create-board', 'add-card', 'move-card', 'list-cards', 'stats']).describe('Action'),
    board: z.string().optional().describe('Board name'),
    card: z.string().optional().describe('Card title'),
    column: z.string().optional().describe('Column name'),
    priority: z.enum(['low', 'medium', 'high', 'critical']).optional().describe('Priority'),
  }),
  endsAgentStep: false,
  run: (args) => import('./kanban-tools.js').then((m) => {
    const { action, board, card, column, priority } = args as any;
    const mgr = m.getKanbanManager();
    switch (action) {
      case 'create-board': return board ? JSON.stringify(mgr.createBoard(board)) : 'board required';
      case 'add-card': return board && card ? JSON.stringify(mgr.addCard(board, 'Todo', card, { priority })) : 'board and card required';
      case 'move-card': return board && card && column ? JSON.stringify(mgr.moveCard(board, card, column)) : 'board, card, column required';
      case 'list-cards': return board ? JSON.stringify(mgr.getBoard(board)?.columns) : 'board required';
      case 'stats': return board ? JSON.stringify(mgr.getStats(board)) : 'board required';
      default: return 'Unknown action';
    }
  }),
});

// Cronjob tool
registerTool({
  name: 'cronjob',
  description: 'Cronjob management: create, list, enable, pause, delete jobs.',
  category: 'workflow',
  inputSchema: z.object({
    action: z.enum(['create', 'list', 'enable', 'pause', 'delete', 'run-now', 'stats']).describe('Action'),
    name: z.string().optional().describe('Job name'),
    schedule: z.string().optional().describe('Cron expression'),
    command: z.string().optional().describe('Command'),
    jobId: z.string().optional().describe('Job ID'),
  }),
  endsAgentStep: false,
  run: (args) => import('./cronjob-tools.js').then((m) => {
    const { action, name, schedule, command, jobId } = args as any;
    const mgr = m.getCronJobManager();
    switch (action) {
      case 'create': return name && schedule && command ? JSON.stringify(mgr.create(name, schedule, command)) : 'name, schedule, command required';
      case 'list': return JSON.stringify(mgr.getAllJobs());
      case 'enable': return jobId ? (mgr.enableJob(jobId) ? 'Enabled' : 'Not found') : 'jobId required';
      case 'pause': return jobId ? (mgr.pauseJob(jobId) ? 'Paused' : 'Not found') : 'jobId required';
      case 'delete': return jobId ? (mgr.deleteJob(jobId) ? 'Deleted' : 'Not found') : 'jobId required';
      case 'run-now': return jobId ? mgr.runJob(jobId).then((r: any) => JSON.stringify(r)) : 'jobId required';
      case 'stats': return JSON.stringify(mgr.getStats());
      default: return 'Unknown action';
    }
  }),
});

// Todo tool
registerTool({
  name: 'todo',
  description: 'Simple todo list: add, complete, list tasks.',
  category: 'workflow',
  inputSchema: z.object({
    action: z.enum(['add', 'complete', 'list']).describe('Action'),
    task: z.string().optional().describe('Task description'),
    id: z.string().optional().describe('Task ID'),
  }),
  endsAgentStep: false,
  run: (args) => import('./todo-tool.js').then((m) => {
    const { action, task, id } = args as any;
    const mgr = m.getTodoStore();
    switch (action) {
      case 'add': return task ? JSON.stringify(mgr.add(task)) : 'task required';
      case 'complete': return id ? JSON.stringify(mgr.update(id, { status: 'completed' })) : 'id required';
      case 'list': return JSON.stringify(mgr.getAll());
      default: return 'Unknown action';
    }
  }),
});

// Approval tool
registerTool({
  name: 'approval',
  description: 'Request approval before dangerous operations.',
  category: 'workflow',
  inputSchema: z.object({
    action: z.enum(['request', 'decide', 'get-pending']).describe('Action'),
    requestId: z.string().optional().describe('Request ID'),
    description: z.string().optional().describe('Description'),
    approved: z.boolean().optional().describe('Approved'),
  }),
  endsAgentStep: false,
  run: (args) => import('./approval-tools.js').then((m) => {
    const { action, requestId, description, approved } = args as any;
    switch (action) {
      case 'request': return JSON.stringify(m.getApprovalManager().request({ description: description || 'Unknown', targets: [], requester: 'agent' }));
      case 'decide': return requestId ? (m.getApprovalManager().decide(requestId, approved ?? false) ? 'Decided' : 'Not found') : 'Request ID required';
      case 'get-pending': return JSON.stringify(m.getApprovalManager().getPending());
      default: return 'Unknown action';
    }
  }),
});

// Env probe tool
registerTool({
  name: 'env_probe',
  description: 'Probe environment variables and credential files.',
  category: 'workflow',
  inputSchema: z.object({
    action: z.enum(['probe', 'probe-pattern', 'check-file']).describe('Action'),
    name: z.string().describe('Env var name or file path'),
  }),
  endsAgentStep: false,
  run: (args) => import('./credential-env-tools.js').then((m) => {
    const { action, name } = args as any;
    switch (action) {
      case 'probe': return JSON.stringify(m.getEnvProbe().probe(name));
      case 'probe-pattern': return JSON.stringify(m.getEnvProbe().probePattern(name));
      case 'check-file': return JSON.stringify(m.getCredentialFileManager().checkFile(name));
      default: return 'Unknown action';
    }
  }),
});

// Blueprint tool
registerTool({
  name: 'blueprint',
  description: 'Project blueprints: create project templates with file structure.',
  category: 'workflow',
  inputSchema: z.object({
    action: z.enum(['create', 'list']).describe('Action'),
    name: z.string().optional().describe('Blueprint name'),
    template: z.string().optional().describe('Template type'),
  }),
  endsAgentStep: false,
  run: (args) => import('./project-tools.js').then((m) => {
    const { action, name, template } = args as any;
    const mgr = m.getBlueprintManager();
    switch (action) {
      case 'create': return name && template ? JSON.stringify(mgr.create({ name, description: template, category: 'user', files: [], variables: [] })) : 'name and template required';
      case 'list': return JSON.stringify(mgr.getAll());
      default: return 'Unknown action';
    }
  }),
});

// File ops tool
registerTool({
  name: 'file_ops',
  description: 'Advanced file operations: state tracking, safe writes, extraction, preview.',
  category: 'workflow',
  inputSchema: z.object({
    action: z.enum(['state', 'extract', 'preview', 'safe-write']).describe('Action'),
    path: z.string().describe('File path'),
    content: z.string().optional().describe('Content'),
  }),
  endsAgentStep: false,
  run: (args) => import('./file-operations.js').then((m) => {
    const { action, path, content } = args as any;
    switch (action) {
      case 'state': return JSON.stringify(m.getFileStateManager().getStates().get(path));
      case 'extract': return m.getContentExtractor().extract(path).then((r: any) => JSON.stringify(r));
      case 'preview': return m.getFilePreviewer().preview(path).then((r: any) => JSON.stringify(r));
      case 'safe-write': return content ? m.getSafeFileOps().safeWrite(path, content).then(() => 'Written') : 'content required';
      default: return 'Unknown action';
    }
  }),
});

// Debug tool
registerTool({
  name: 'debug',
  description: 'Debug helpers: analyze errors, capture hook output.',
  category: 'workflow',
  inputSchema: z.object({
    action: z.enum(['analyze', 'hint', 'capture', 'history']).describe('Action'),
    error: z.string().optional().describe('Error message'),
    hookName: z.string().optional().describe('Hook name'),
    output: z.string().optional().describe('Output'),
    exitCode: z.number().optional().describe('Exit code'),
    durationMs: z.number().optional().describe('Duration'),
  }),
  endsAgentStep: false,
  run: (args) => import('./debug-helpers.js').then((m) => {
    const { action, error, hookName, output, exitCode, durationMs } = args as any;
    switch (action) {
      case 'analyze': return error ? JSON.stringify(m.getErrorAnalyzer().analyze(error)) : 'error required';
      case 'hint': return error ? (m.getTerminalHints().getHint(error)?.suggestion || 'No hints') : 'error required';
      case 'capture': return hookName && output ? JSON.stringify(m.getHookOutputHandler().capture(hookName, output, exitCode || 0, durationMs || 0)) : 'hookName and output required';
      case 'history': return hookName ? JSON.stringify(m.getHookOutputHandler().getOutputsForHook(hookName)) : 'hookName required';
      default: return 'Unknown action';
    }
  }),
});

// Delegate system tool
registerTool({
  name: 'delegate_system',
  description: 'Full delegation: spawn subagents, batch execute.',
  category: 'workflow',
  inputSchema: z.object({
    action: z.enum(['delegate', 'batch', 'status', 'cancel']).describe('Action'),
    goal: z.string().optional().describe('Task goal'),
    id: z.string().optional().describe('Task ID'),
    goals: z.array(z.string()).optional().describe('Batch goals'),
  }),
  endsAgentStep: false,
  run: (args) => import('./delegation-system.js').then((m) => {
    const { action, goal, id, goals } = args as any;
    const mgr = m.getDelegationManager();
    switch (action) {
      case 'delegate': return goal ? mgr.delegate(goal).then((r: any) => JSON.stringify(r)) : 'goal required';
      case 'batch': return goals ? mgr.delegateBatch(goals).then((r: any) => JSON.stringify(r)) : 'goals required';
      case 'status': return id ? JSON.stringify(mgr.getTask(id)) : 'id required';
      case 'cancel': return id ? (mgr.cancel(id) ? 'Cancelled' : 'Not found') : 'id required';
      default: return 'Unknown action';
    }
  }),
});

// Subagent tool
registerTool({
  name: 'subagent',
  description: 'Spawn real subagents that make their own LLM calls and use tools.',
  category: 'workflow',
  inputSchema: z.object({
    action: z.enum(['spawn', 'status', 'wait', 'kill', 'log']).describe('Action'),
    goal: z.string().optional().describe('Task goal'),
    id: z.string().optional().describe('Subagent ID'),
    timeout: z.number().optional().describe('Timeout'),
  }),
  endsAgentStep: false,
  run: (args) => import('./subagent-spawner.js').then((m) => {
    const { action, goal, id, timeout } = args as any;
    const mgr = m.getSubagentManager();
    switch (action) {
      case 'spawn': return goal ? mgr.spawn({ goal }).then((s: any) => JSON.stringify(s)) : 'goal required';
      case 'status': return id ? JSON.stringify(mgr.getState(id)) : 'id required';
      case 'wait': return id ? mgr.waitForCompletion(id, timeout || 300_000).then((r: any) => JSON.stringify(r)) : 'id required';
      case 'kill': return id ? (mgr.kill(id) ? 'Killed' : 'Not found') : 'id required';
      case 'log': return id ? mgr.getLog(id).join('\n') : 'id required';
      default: return 'Unknown action';
    }
  }),
});

// Managed gateway tool
registerTool({
  name: 'managed_gateway',
  description: 'Managed tool gateway: call vendor APIs through proxy.',
  category: 'workflow',
  inputSchema: z.object({
    action: z.enum(['call', 'stats', 'list']).describe('Action'),
    gateway: z.string().optional().describe('Gateway name'),
    tool: z.string().optional().describe('Tool to call'),
    payload: z.record(z.string(), z.unknown()).optional().describe('Payload'),
  }),
  endsAgentStep: false,
  run: (args) => import('./managed-gateway.js').then((m) => {
    const { action, gateway, tool, payload } = args as any;
    switch (action) {
      case 'call': return gateway && tool ? m.getGateway(gateway)?.call(tool, payload || {}).then((r: any) => JSON.stringify(r)) || 'Gateway not found' : 'gateway and tool required';
      case 'stats': return gateway ? JSON.stringify(m.getGateway(gateway)?.getStats()) : JSON.stringify(m.listGateways().map((g: any) => g.getStats()));
      case 'list': return JSON.stringify(m.listGateways().map((g: any) => ({ name: g['config'].name, endpoint: g['config'].endpoint })));
      default: return 'Unknown action';
    }
  }),
});

// Messaging tool
registerTool({
  name: 'messaging',
  description: 'Send messages to Discord, Slack, Telegram, Feishu.',
  category: 'workflow',
  inputSchema: z.object({
    action: z.enum(['send', 'react']).describe('Action'),
    service: z.enum(['discord', 'slack', 'telegram', 'feishu']).describe('Service'),
    channel: z.string().optional().describe('Channel'),
    message: z.string().optional().describe('Message'),
    emoji: z.string().optional().describe('Emoji'),
  }),
  endsAgentStep: false,
  run: (args) => import('./messaging-tools.js').then((m) => {
    const { action, service, channel, message, emoji } = args as any;
    const mgr = m.getMessagingManager();
    switch (action) {
      case 'send': return channel && message ? mgr.sendMessage({ platform: service, channelId: channel } as any, { content: message } as any).then((r: any) => JSON.stringify(r)) : 'channel and message required';
      case 'react': return channel && emoji ? mgr.reactToMessage(service, channel, 'latest', emoji).then(() => 'Reacted') : 'channel and emoji required';
      default: return 'Unknown action';
    }
  }),
});

// Vision tool — comprehensive image analysis, OCR, UI element detection
registerTool({
  name: 'vision',
  description: 'Vision tools: analyze images, extract text via OCR, detect UI elements, compare screenshots. Use when the user provides an image or asks about visual content.',
  category: 'workflow',
  inputSchema: z.object({
    action: z.enum(['analyze', 'ocr', 'detect-elements', 'compare', 'find-element', 'extract-text']).describe('Vision action'),
    imagePath: z.string().describe('Path to image file'),
    prompt: z.string().optional().describe('Specific analysis prompt'),
    imagePath2: z.string().optional().describe('Second image for comparison'),
    searchText: z.string().optional().describe('Text to search for in UI elements'),
  }),
  endsAgentStep: false,
  run: (args) => import('./vision-tools.js').then((m) => {
    const { action, imagePath, prompt, imagePath2, searchText } = args as any;
    const analyzer = m.getVisionAnalyzer();
    switch (action) {
      case 'analyze': return analyzer.analyze(imagePath).then((r: any) => JSON.stringify(r));
      case 'ocr': return analyzer.ocr(imagePath).then((r: any) => JSON.stringify(r));
      case 'detect-elements': return analyzer.detectUIElements(imagePath).then((r: any) => JSON.stringify(r));
      case 'compare': return imagePath2 ? analyzer.compare(imagePath, imagePath2).then((r: any) => JSON.stringify(r)) : 'imagePath2 required for comparison';
      case 'find-element': return searchText ? analyzer.findElementByText(imagePath, searchText).then((r: any) => JSON.stringify(r)) : 'searchText required';
      case 'extract-text': return analyzer.extractText(imagePath).then((r: any) => JSON.stringify({ text: r }));
      default: return 'Unknown action';
    }
  }),
});

// ─── Batch 1: Critical Infrastructure ─────────────────────────────────────

// Interrupt tool
registerTool({
  name: 'interrupt',
  description: 'Global interrupt: stop all running operations or interrupt a specific task.',
  category: 'workflow',
  inputSchema: z.object({
    action: z.enum(['global', 'task', 'check', 'clear']).describe('Action'),
    taskId: z.string().optional().describe('Task ID for task interrupt'),
    reason: z.string().optional().describe('Interrupt reason'),
  }),
  endsAgentStep: false,
  run: (args) => import('./interrupt-tool.js').then((m) => {
    const { action, taskId, reason } = args as any;
    const mgr = m.getInterruptManager();
    switch (action) {
      case 'global': return JSON.stringify(mgr.interruptGlobal(reason || 'User requested', 'tool'));
      case 'task': return taskId ? JSON.stringify(mgr.interruptTask(taskId, reason || 'User requested', 'tool')) : 'taskId required';
      case 'check': return JSON.stringify({ interrupted: mgr.isInterrupted(taskId) });
      case 'clear': return taskId ? (mgr.clearTaskInterrupt(taskId), 'Cleared') : (mgr.clearGlobal(), 'Global cleared');
      default: return 'Unknown action';
    }
  }),
});

// Daemon pool tool
registerTool({
  name: 'daemon_pool',
  description: 'Background daemon process management: register, start, stop, monitor health.',
  category: 'workflow',
  inputSchema: z.object({
    action: z.enum(['register', 'start', 'stop', 'list', 'stats']).describe('Action'),
    id: z.string().optional().describe('Daemon ID'),
    name: z.string().optional().describe('Daemon name'),
    command: z.string().optional().describe('Command to run'),
  }),
  endsAgentStep: false,
  run: (args) => import('./daemon-pool.js').then((m) => {
    const { action, id, name, command } = args as any;
    const pool = m.getDaemonPool();
    switch (action) {
      case 'register': return name && command ? JSON.stringify(pool.register({ name, command })) : 'name and command required';
      case 'start': return id ? JSON.stringify(pool.start(id)) : 'id required';
      case 'stop': return id ? (pool.stop(id) ? 'Stopped' : 'Not found') : 'id required';
      case 'list': return JSON.stringify(pool.list());
      case 'stats': return JSON.stringify({ total: pool.list().length, running: pool.list().filter((d: any) => d.status === 'running').length });
      default: return 'Unknown action';
    }
  }),
});

// Process registry tool
registerTool({
  name: 'process_registry',
  description: 'Track all running processes with metadata and cleanup.',
  category: 'workflow',
  inputSchema: z.object({
    action: z.enum(['register', 'list', 'stats', 'kill', 'cleanup']).describe('Action'),
    id: z.string().optional().describe('Process ID'),
    pid: z.number().optional().describe('OS PID'),
    command: z.string().optional().describe('Command name'),
  }),
  endsAgentStep: false,
  run: (args) => import('./process-registry.js').then((m) => {
    const { action, id, pid, command } = args as any;
    const reg = m.getProcessRegistry();
    switch (action) {
      case 'register': return pid && command ? JSON.stringify(reg.register(pid, command)) : 'pid and command required';
      case 'list': return JSON.stringify(reg.list());
      case 'stats': return JSON.stringify(reg.getStats());
      case 'kill': return id ? (reg.kill(id) ? 'Killed' : 'Not found') : 'id required';
      case 'cleanup': return JSON.stringify({ cleaned: reg.cleanup() });
      default: return 'Unknown action';
    }
  }),
});

// Code execution tool
registerTool({
  name: 'code_execution',
  description: 'Execute code in sandboxed environment with timeout and resource limits.',
  category: 'workflow',
  inputSchema: z.object({
    language: z.enum(['javascript', 'typescript', 'python', 'bash', 'powershell']).describe('Language'),
    code: z.string().describe('Code to execute'),
    timeoutMs: z.number().optional().describe('Timeout in ms'),
  }),
  endsAgentStep: false,
  run: (args) => import('./code-execution.js').then((m) => {
    const { language, code, timeoutMs } = args as any;
    return m.getCodeExecutor().execute({ language, code, timeoutMs }).then((r: any) => JSON.stringify(r));
  }),
});

// Checkpoint manager tool
registerTool({
  name: 'checkpoint',
  description: 'Save and restore execution state for rollback.',
  category: 'workflow',
  inputSchema: z.object({
    action: z.enum(['create', 'restore', 'list', 'delete', 'diff']).describe('Action'),
    id: z.string().optional().describe('Checkpoint ID'),
    name: z.string().optional().describe('Checkpoint name'),
    state: z.record(z.string(), z.unknown()).optional().describe('State to save'),
    id2: z.string().optional().describe('Second checkpoint for diff'),
  }),
  endsAgentStep: false,
  run: (args) => import('./checkpoint-manager.js').then((m) => {
    const { action, id, name, state, id2 } = args as any;
    const mgr = m.getCheckpointManager();
    switch (action) {
      case 'create': return name && state ? JSON.stringify(mgr.create(name, state)) : 'name and state required';
      case 'restore': return id ? JSON.stringify(mgr.restore(id)) : 'id required';
      case 'list': return JSON.stringify(mgr.list());
      case 'delete': return id ? (mgr.delete(id) ? 'Deleted' : 'Not found') : 'id required';
      case 'diff': return id && id2 ? JSON.stringify(mgr.diff(id, id2)) : 'id and id2 required';
      default: return 'Unknown action';
    }
  }),
});

// ─── Batch 2: Security Deep ───────────────────────────────────────────────

// AST audit tool
registerTool({
  name: 'ast_audit',
  description: 'AST-based code audit: detect eval(), hardcoded secrets, SQL injection patterns.',
  category: 'workflow',
  inputSchema: z.object({
    filePath: z.string().describe('File to audit'),
  }),
  endsAgentStep: false,
  run: (args) => import('./security-deep.js').then((m) => {
    const { filePath } = args as any;
    return JSON.stringify(m.getASTAuditor().audit(filePath));
  }),
});

// Threat patterns tool
registerTool({
  name: 'threat_patterns',
  description: 'Detect threat patterns: shell execution, external HTTP, obfuscation.',
  category: 'workflow',
  inputSchema: z.object({
    filePath: z.string().describe('File to scan'),
  }),
  endsAgentStep: false,
  run: (args) => import('./security-deep.js').then((m) => {
    const { filePath } = args as any;
    return JSON.stringify(m.getThreatDetector().detect(filePath));
  }),
});

// URL safety tool
registerTool({
  name: 'url_safety',
  description: 'Check URL safety: suspicious TLDs, patterns, length.',
  category: 'workflow',
  inputSchema: z.object({
    url: z.string().describe('URL to check'),
  }),
  endsAgentStep: false,
  run: (args) => import('./security-deep.js').then((m) => {
    const { url } = args as any;
    return JSON.stringify(m.getURLSafetyChecker().check(url));
  }),
});

// Path security tool
registerTool({
  name: 'path_security',
  description: 'Check path security: traversal, null bytes, directory escape.',
  category: 'workflow',
  inputSchema: z.object({
    path: z.string().describe('Path to check'),
    allowedDir: z.string().optional().describe('Allowed directory'),
  }),
  endsAgentStep: false,
  run: (args) => import('./security-deep.js').then((m) => {
    const { path, allowedDir } = args as any;
    return JSON.stringify(m.getPathSecurityChecker().checkPath(path, allowedDir));
  }),
});

// Security score tool
registerTool({
  name: 'security_score',
  description: 'Calculate security score for a file: code injection, secrets, threats.',
  category: 'workflow',
  inputSchema: z.object({
    filePath: z.string().describe('File to score'),
  }),
  endsAgentStep: false,
  run: (args) => import('./security-deep.js').then((m) => {
    const { filePath } = args as any;
    return JSON.stringify(m.getSecurityScorer().score(filePath));
  }),
});

// ─── Batch 5: Infrastructure ──────────────────────────────────────────────

// Tool search tool — the tiered-exposure discovery surface. Two actions:
// - search (default): fuzzy-find tools by query (the pre-existing behavior).
// - load: LOAD a whole toolset's tools into the CURRENT turn's model schema
//   (tiered exposure — assessment Addendum v3/v4). Writes the toolset's tool
//   names into ctx.loadedExtraTools; the tool loop unions them into the live
//   schema set before the next model step. Domain tools (media, browser,
//   channels, docker, …) stay out of every turn's schema until this runs —
//   ~85% of per-turn schema tokens saved, zero capability lost.
registerTool({
  name: 'tool_search',
  description:
    'Discover and load tools. Actions: "search" fuzzy-finds tools by query; ' +
    '"load" activates a whole toolset (media, browser, channels, docker, ' +
    'productivity, publish, core-pipeline, …) for THIS turn — call it before ' +
    'using any tool outside the always-available core set. "load" returns ' +
    'the toolset\'s tool names, which become callable immediately.',
  category: 'workflow',
  inputSchema: z.object({
    action: z.enum(['search', 'load']).optional().describe('Defaults to "search".'),
    query: z.string().optional().describe('Search query (action=search)'),
    limit: z.number().optional().describe('Max results (action=search)'),
    toolset: z.string().optional().describe('Toolset name to load (action=load) — e.g. "media", "browser", "channels"'),
  }),
  endsAgentStep: false,
  run: async (args, ctx) => {
    const { action = 'search', query, limit, toolset } = args as {
      action?: 'search' | 'load'; query?: string; limit?: number; toolset?: string;
    };

    // ── load: activate a toolset for this turn (tiered exposure) ──
    if (action === 'load') {
      if (!toolset) {
        // No toolset named — return the CATALOG so the model can pick one.
        // All enabled toolsets are listed; loading one whose tools are
        // already core-exposed is a harmless idempotent union.
        const { getToolsetStatus } = await import('./toolsets.js');
        const status = getToolsetStatus(ctx?.configManager as any)
          .filter((s) => s.enabled)
          .map((s) => ({ name: s.name, label: s.label, tools: s.tools }));
        return JSON.stringify({
          loaded: false,
          message: 'No toolset named. Loadable toolsets (call again with action:"load", toolset:<name>):',
          toolsets: status,
        });
      }
      const { TOOLSETS, isToolEnabled } = await import('./toolsets.js');
      const def = TOOLSETS.find((t) => t.name === toolset);
      if (!def) {
        const names = TOOLSETS.map((t) => t.name).join(', ');
        return `Error: unknown toolset "${toolset}". Available: ${names}.`;
      }
      // A user-disabled toolset must not resurrect through the load path —
      // the I1 enablement gate stays the single source of truth.
      if (!isToolEnabled(def.tools[0], ctx?.configManager as any)) {
        return `Error: toolset "${toolset}" is disabled by configuration — enable it with \`nuvira tools toolsets\` first.`;
      }
      const already = ctx?.loadedExtraTools instanceof Set ? ctx.loadedExtraTools : undefined;
      if (already) {
        for (const name of def.tools) already.add(name);
      }
      return JSON.stringify({
        loaded: true,
        toolset: def.name,
        label: def.label,
        tools: def.tools,
        note: already
          ? 'Tools are now callable this turn.'
          : 'Toolset recorded, but this context has no live schema loader (loop not in tiered mode) — tools remain governed by the standard enablement gate.',
      });
    }

    // ── search: the pre-existing fuzzy find (unchanged behavior) ──
    const m = await import('./infra-tools.js');
    const engine = m.getToolSearchEngine();
    // Index from registry
    const { listTools } = await import('./registry.js');
    engine.index(listTools().map((t: any) => ({ name: t.name, description: t.description })));
    return JSON.stringify(engine.search(query || '', limit || 10));
  },
});

// Budget config tool
registerTool({
  name: 'budget_config',
  description: 'Budget management: check limits, record usage, reset daily.',
  category: 'workflow',
  inputSchema: z.object({
    action: z.enum(['check', 'record', 'reset', 'status']).describe('Action'),
    tokens: z.number().optional().describe('Tokens to record'),
    cost: z.number().optional().describe('Cost to record'),
  }),
  endsAgentStep: false,
  run: (args) => import('./infra-tools.js').then((m) => {
    const { action, tokens, cost } = args as any;
    const mgr = m.getBudgetManager();
    switch (action) {
      case 'check': return JSON.stringify(mgr.canSpend(tokens || 0, cost || 0));
      case 'record': return tokens ? (mgr.record(tokens, cost || 0), 'Recorded') : 'tokens required';
      case 'reset': return (mgr.resetDaily(), 'Reset');
      case 'status': return JSON.stringify(mgr.getConfig());
      default: return 'Unknown action';
    }
  }),
});

// Fuzzy match tool
registerTool({
  name: 'fuzzy_match',
  description: 'Fuzzy string matching with Levenshtein distance.',
  category: 'workflow',
  inputSchema: z.object({
    query: z.string().describe('Query string'),
    items: z.array(z.string()).describe('Items to match against'),
    limit: z.number().optional().describe('Max results'),
  }),
  endsAgentStep: false,
  run: (args) => import('./infra-tools.js').then((m) => {
    const { query, items, limit } = args as any;
    const matcher = m.getFuzzyMatcher();
    const results = matcher.match(query, items, (i: string) => i, limit || 5);
    return JSON.stringify(results);
  }),
});

// ─── Batch 6: Utility ────────────────────────────────────────────────────

// ANSI strip tool
registerTool({
  name: 'ansi_strip',
  description: 'Strip ANSI escape codes from text.',
  category: 'workflow',
  inputSchema: z.object({
    text: z.string().describe('Text to strip'),
  }),
  endsAgentStep: false,
  run: (args) => import('./utility-tools.js').then((m) => {
    const { text } = args as any;
    return m.getANSIStripper().strip(text);
  }),
});

// OSV check tool
registerTool({
  name: 'osv_check',
  description: 'Check for known vulnerabilities in npm packages via OSV API.',
  category: 'workflow',
  inputSchema: z.object({
    package: z.string().describe('Package name'),
    version: z.string().describe('Package version'),
  }),
  endsAgentStep: false,
  run: (args) => import('./utility-tools.js').then((m) => {
    const { package: pkg, version } = args as any;
    return m.getOSVChecker().check(pkg, version).then((r: any) => JSON.stringify(r));
  }),
});

// Patch parser tool
registerTool({
  name: 'patch_parser',
  description: 'Parse unified diff patches into structured format.',
  category: 'workflow',
  inputSchema: z.object({
    patch: z.string().describe('Patch content'),
  }),
  endsAgentStep: false,
  run: (args) => import('./utility-tools.js').then((m) => {
    const { patch } = args as any;
    return JSON.stringify(m.getPatchParser().parse(patch));
  }),
});

// Image source tool
registerTool({
  name: 'image_source',
  description: 'Detect image source: format, size, is screenshot.',
  category: 'workflow',
  inputSchema: z.object({
    path: z.string().describe('Image path'),
  }),
  endsAgentStep: false,
  run: (args) => import('./utility-tools.js').then((m) => {
    const { path } = args as any;
    return JSON.stringify(m.getImageSourceDetector().detect(path));
  }),
});

// ─── Batch 3: Platform Integrations ───────────────────────────────────────

// Discord tool
registerTool({
  name: 'discord',
  description: 'Discord server management: list servers, channels, members, messages, roles. Send messages.',
  category: 'workflow',
  inputSchema: z.object({
    action: z.enum(['list-guilds', 'list-channels', 'list-members', 'fetch-messages', 'send-message', 'list-roles']).describe('Action'),
    guildId: z.string().optional().describe('Guild ID'),
    channelId: z.string().optional().describe('Channel ID'),
    message: z.string().optional().describe('Message content'),
    limit: z.number().optional().describe('Max results'),
  }),
  endsAgentStep: false,
  run: (args) => import('./discord-tool.js').then((m) => {
    const { action, guildId, channelId, message, limit } = args as any;
    const client = m.getDiscordClient();
    switch (action) {
      case 'list-guilds': return client.listGuilds().then((r: any) => JSON.stringify(r));
      case 'list-channels': return guildId ? client.listChannels(guildId).then((r: any) => JSON.stringify(r)) : 'guildId required';
      case 'list-members': return guildId ? client.listMembers(guildId, limit).then((r: any) => JSON.stringify(r)) : 'guildId required';
      case 'fetch-messages': return channelId ? client.fetchMessages(channelId, limit).then((r: any) => JSON.stringify(r)) : 'channelId required';
      case 'send-message': return channelId && message ? client.sendMessage(channelId, message).then((r: any) => JSON.stringify(r)) : 'channelId and message required';
      case 'list-roles': return guildId ? client.listRoles(guildId).then((r: any) => JSON.stringify(r)) : 'guildId required';
      default: return 'Unknown action';
    }
  }),
});

// Home Assistant tool
registerTool({
  name: 'homeassistant',
  description: 'Home Assistant smart home: list entities, get state, call services (turn_on/off, set_temperature).',
  category: 'workflow',
  inputSchema: z.object({
    action: z.enum(['list-entities', 'get-state', 'list-services', 'call-service', 'turn-on', 'turn-off', 'toggle']).describe('Action'),
    entityId: z.string().optional().describe('Entity ID (light.living_room)'),
    domain: z.string().optional().describe('Service domain'),
    service: z.string().optional().describe('Service name'),
    data: z.record(z.string(), z.unknown()).optional().describe('Service data'),
  }),
  endsAgentStep: false,
  run: (args) => import('./homeassistant-tool.js').then((m) => {
    const { action, entityId, domain, service, data } = args as any;
    const client = m.getHomeAssistantClient();
    switch (action) {
      case 'list-entities': return client.listEntities(domain).then((r: any) => JSON.stringify(r));
      case 'get-state': return entityId ? client.getState(entityId).then((r: any) => JSON.stringify(r)) : 'entityId required';
      case 'list-services': return client.listServices().then((r: any) => JSON.stringify(r));
      case 'call-service': return domain && service && entityId ? client.callService(domain, service, entityId, data).then(() => 'Called') : 'domain, service, entityId required';
      case 'turn-on': return entityId ? client.turnOn(entityId, data).then(() => 'Turned on') : 'entityId required';
      case 'turn-off': return entityId ? client.turnOff(entityId).then(() => 'Turned off') : 'entityId required';
      case 'toggle': return entityId ? client.toggle(entityId).then(() => 'Toggled') : 'entityId required';
      default: return 'Unknown action';
    }
  }),
});

// Microsoft Graph tool
registerTool({
  name: 'microsoft_graph',
  description: 'Microsoft Graph API: email, calendar, OneDrive, contacts.',
  category: 'workflow',
  inputSchema: z.object({
    service: z.enum(['email', 'calendar', 'onedrive', 'contacts']).describe('Service'),
    action: z.enum(['list', 'get', 'send', 'create', 'delete', 'search']).describe('Action'),
    id: z.string().optional().describe('Item ID'),
    subject: z.string().optional().describe('Email subject'),
    body: z.string().optional().describe('Email body'),
    to: z.array(z.string()).optional().describe('Recipients'),
    query: z.string().optional().describe('Search query'),
  }),
  endsAgentStep: false,
  run: (args) => import('./microsoft-graph.js').then((m) => {
    const { service, action, id, subject, body, to, query } = args as any;
    const client = m.getMicrosoftGraphClient();
    switch (service) {
      case 'email':
        switch (action) {
          case 'list': return client.listEmails({ filter: query }).then((r: any) => JSON.stringify(r));
          case 'get': return id ? client.getEmail(id).then((r: any) => JSON.stringify(r)) : 'id required';
          case 'send': return to && subject && body ? client.sendEmail({ to, subject, body }).then(() => 'Sent') : 'to, subject, body required';
          case 'delete': return id ? client.deleteEmail(id).then(() => 'Deleted') : 'id required';
          default: return 'Unknown action';
        }
      case 'calendar':
        switch (action) {
          case 'list': return client.listEvents({ filter: query }).then((r: any) => JSON.stringify(r));
          case 'create': return subject ? client.createEvent({ subject, start: new Date().toISOString(), end: new Date(Date.now() + 3600000).toISOString(), body }).then((r: any) => JSON.stringify(r)) : 'subject required';
          case 'delete': return id ? client.deleteEvent(id).then(() => 'Deleted') : 'id required';
          default: return 'Unknown action';
        }
      case 'onedrive':
        switch (action) {
          case 'list': return client.listFiles(query || '/').then((r: any) => JSON.stringify(r));
          case 'get': return id ? client.downloadFile(id).then((r: any) => JSON.stringify({ content: r.slice(0, 1000) })) : 'id required';
          case 'delete': return id ? client.deleteFile(id).then(() => 'Deleted') : 'id required';
          default: return 'Unknown action';
        }
      case 'contacts':
        switch (action) {
          case 'list': return client.listContacts().then((r: any) => JSON.stringify(r));
          default: return 'Unknown action';
        }
      default: return 'Unknown service';
    }
  }),
});

// Feishu document tool
registerTool({
  name: 'feishu_doc',
  description: 'Feishu document management: create, read, update, delete documents.',
  category: 'workflow',
  inputSchema: z.object({
    action: z.enum(['create', 'get', 'content', 'update-title', 'delete']).describe('Action'),
    documentId: z.string().optional().describe('Document ID'),
    title: z.string().optional().describe('Document title'),
  }),
  endsAgentStep: false,
  run: (args) => import('./feishu-tools.js').then((m) => {
    const { action, documentId, title } = args as any;
    const client = m.getFeishuClient();
    switch (action) {
      case 'create': return title ? client.createDocument(title).then((r: any) => JSON.stringify(r)) : 'title required';
      case 'get': return documentId ? client.getDocument(documentId).then((r: any) => JSON.stringify(r)) : 'documentId required';
      case 'content': return documentId ? client.getDocumentContent(documentId).then((r: any) => JSON.stringify({ content: r })) : 'documentId required';
      case 'update-title': return documentId && title ? client.updateDocumentTitle(documentId, title).then(() => 'Updated') : 'documentId and title required';
      case 'delete': return documentId ? client.deleteDocument(documentId).then(() => 'Deleted') : 'documentId required';
      default: return 'Unknown action';
    }
  }),
});

// Feishu drive tool
registerTool({
  name: 'feishu_drive',
  description: 'Feishu drive management: list files, create folders, move, copy, search.',
  category: 'workflow',
  inputSchema: z.object({
    action: z.enum(['list', 'get', 'create-folder', 'delete', 'move', 'copy', 'search']).describe('Action'),
    fileToken: z.string().optional().describe('File token'),
    folderToken: z.string().optional().describe('Folder token'),
    name: z.string().optional().describe('Folder name'),
    query: z.string().optional().describe('Search query'),
  }),
  endsAgentStep: false,
  run: (args) => import('./feishu-tools.js').then((m) => {
    const { action, fileToken, folderToken, name, query } = args as any;
    const client = m.getFeishuClient();
    switch (action) {
      case 'list': return client.listFiles(folderToken).then((r: any) => JSON.stringify(r));
      case 'get': return fileToken ? client.getFileInfo(fileToken).then((r: any) => JSON.stringify(r)) : 'fileToken required';
      case 'create-folder': return name ? client.createFolder(name, folderToken).then((r: any) => JSON.stringify(r)) : 'name required';
      case 'delete': return fileToken ? client.deleteFile(fileToken).then(() => 'Deleted') : 'fileToken required';
      case 'move': return fileToken && folderToken ? client.moveFile(fileToken, folderToken).then(() => 'Moved') : 'fileToken and folderToken required';
      case 'copy': return fileToken && folderToken ? client.copyFile(fileToken, folderToken).then((r: any) => JSON.stringify(r)) : 'fileToken and folderToken required';
      case 'search': return query ? client.searchFiles(query).then((r: any) => JSON.stringify(r)) : 'query required';
      default: return 'Unknown action';
    }
  }),
});

// ─── Batch 4: Media Tools ─────────────────────────────────────────────────

// Video generation tool
registerTool({
  name: 'video_generate',
  description: 'Generate videos from text prompts or images. Supports FAL/BFL providers. When running in a gateway context and a video URL is returned, the video is automatically downloaded and sent back to the originating channel.',
  category: 'workflow',
  inputSchema: z.object({
    action: z.enum(['generate', 'status', 'providers']).describe('Action'),
    prompt: z.string().optional().describe('Text prompt'),
    imageUrl: z.string().optional().describe('Input image URL'),
    duration: z.number().optional().describe('Duration in seconds'),
    aspectRatio: z.string().optional().describe('Aspect ratio (16:9, 9:16, 1:1)'),
    resolution: z.string().optional().describe('Resolution (480p, 720p, 1080p)'),
    jobId: z.string().optional().describe('Job ID for status check'),
  }),
  endsAgentStep: false,
  run: async (args, ctx) => import('./video-generation.js').then(async (m) => {
    const { action, prompt, imageUrl, duration, aspectRatio, resolution, jobId } = args as any;
    const mgr = m.getVideoGenManager();
    switch (action) {
      case 'generate': {
        if (!prompt) return 'prompt required';
        const result = await mgr.generate({ prompt, imageUrl, duration, aspectRatio, resolution });
        const json = JSON.stringify(result);
        // Auto-deliver: download the video from the URL and send to originating channel.
        if (ctx.gateway?.autoDeliverMedia && result.videoUrl) {
          try {
            const { writeFileSync, mkdtempSync, readFileSync: fsReadFileSync } = await import('fs');
            const { join } = await import('path');
            const { tmpdir } = await import('os');
            const tmpDir = mkdtempSync(join(tmpdir(), 'nuvira-video-'));
            const videoPath = join(tmpDir, 'video.mp4');
            const res = await fetch(result.videoUrl);
            if (res.ok) {
              const buf = Buffer.from(await res.arrayBuffer());
              writeFileSync(videoPath, buf);
              const data = fsReadFileSync(videoPath) as unknown as Uint8Array;
              const delivered = await ctx.gateway.autoDeliverMedia({
                type: 'video',
                data,
                caption: prompt,
                filename: 'video.mp4',
              });
              if (delivered) return `${json}\nvideo_generate: video auto-delivered to the originating channel.`;
            }
          } catch { /* best-effort delivery */ }
        }
        return json;
      }
      case 'status': return jobId ? mgr.status(jobId).then((r: any) => JSON.stringify(r)) : 'jobId required';
      case 'providers': return JSON.stringify({ providers: mgr.listProviders() });
      default: return 'Unknown action';
    }
  }),
});

// Voice mode tool
registerTool({
  name: 'voice_mode',
  description: 'Voice interaction: record audio, play audio, convert formats.',
  category: 'workflow',
  inputSchema: z.object({
    action: z.enum(['start-record', 'stop-record', 'play', 'convert', 'status', 'check']).describe('Action'),
    audioPath: z.string().optional().describe('Audio file path'),
    outputPath: z.string().optional().describe('Output file path'),
    duration: z.number().optional().describe('Recording duration'),
  }),
  endsAgentStep: false,
  run: (args) => import('./voice-mode.js').then((m) => {
    const { action, audioPath, outputPath, duration } = args as any;
    const mgr = m.getVoiceManager();
    switch (action) {
      case 'start-record': return mgr.startRecording({ duration }).then((r: any) => JSON.stringify(r));
      case 'stop-record': return mgr.stopRecording().then((r: any) => JSON.stringify(r));
      case 'play': return audioPath ? mgr.play(audioPath).then((r: any) => JSON.stringify({ success: r })) : 'audioPath required';
      case 'convert': return audioPath && outputPath ? mgr.convert(audioPath, outputPath).then((r: any) => JSON.stringify({ success: r })) : 'audioPath and outputPath required';
      case 'status': return JSON.stringify(mgr.getState());
      case 'check': return mgr.isAvailable().then((r: any) => JSON.stringify(r));
      default: return 'Unknown action';
    }
  }),
});

// Wake word tool
registerTool({
  name: 'wake_word',
  description: 'Wake word detection: start/stop listening, configure words, simulate detection.',
  category: 'workflow',
  inputSchema: z.object({
    action: z.enum(['start', 'stop', 'status', 'add-word', 'remove-word', 'simulate']).describe('Action'),
    word: z.string().optional().describe('Wake word'),
    sensitivity: z.number().optional().describe('Sensitivity (0-1)'),
  }),
  endsAgentStep: false,
  run: (args) => import('./wake-word.js').then((m) => {
    const { action, word, sensitivity } = args as any;
    const detector = m.getWakeWordDetector();
    switch (action) {
      case 'start': return detector.start().then((r: any) => JSON.stringify({ started: r }));
      case 'stop': return (detector.stop(), JSON.stringify({ stopped: true }));
      case 'status': return JSON.stringify({ listening: detector.isListening(), words: detector.getWakeWords() });
      case 'add-word': return word ? (detector.addWakeWord(word), JSON.stringify({ added: word })) : 'word required';
      case 'remove-word': return word ? (detector.removeWakeWord(word), JSON.stringify({ removed: word })) : 'word required';
      case 'simulate': return word ? (detector.simulateDetection(word), JSON.stringify({ simulated: word })) : 'word required';
      default: return 'Unknown action';
    }
  }),
});

// NeuTTS synthesis tool
registerTool({
  name: 'neutts_synth',
  description: 'High-quality text-to-speech synthesis via NeuTTS.',
  category: 'workflow',
  inputSchema: z.object({
    action: z.enum(['synthesize', 'voices']).describe('Action'),
    text: z.string().optional().describe('Text to synthesize'),
    voice: z.string().optional().describe('Voice ID'),
    speed: z.number().optional().describe('Speech speed'),
  }),
  endsAgentStep: false,
  run: (args) => import('./neutts-synth.js').then((m) => {
    const { action, text, voice, speed } = args as any;
    const synth = m.getNeuTTSSynthesizer();
    switch (action) {
      case 'synthesize': return text ? synth.synthesize(text, { voice, speed }).then((r: any) => JSON.stringify(r)) : 'text required';
      case 'voices': return synth.listVoices().then((r: any) => JSON.stringify(r));
      default: return 'Unknown action';
    }
  }),
});

// ─── Critical Tools ───────────────────────────────────────────────────────

// Terminal tool — multi-environment execution
registerTool({
  name: 'terminal',
  description: 'Execute commands in local, Docker, Modal, SSH environments with background support.',
  category: 'workflow',
  inputSchema: z.object({
    action: z.enum(['exec', 'kill', 'list', 'status']).describe('Action'),
    command: z.string().optional().describe('Command to execute'),
    env: z.enum(['local', 'docker', 'modal', 'ssh']).optional().describe('Environment'),
    cwd: z.string().optional().describe('Working directory'),
    timeoutMs: z.number().optional().describe('Timeout in ms'),
    taskId: z.string().optional().describe('Task ID for kill/status'),
    dockerImage: z.string().optional().describe('Docker image'),
    sshHost: z.string().optional().describe('SSH host'),
  }),
  endsAgentStep: false,
  run: (args) => import('./terminal-tool.js').then((m) => {
    const { action, command, env, cwd, timeoutMs, taskId, dockerImage, sshHost } = args as any;
    const mgr = m.getTerminalManager();
    switch (action) {
      case 'exec': return command ? mgr.execute(command, { env, cwd, timeoutMs, dockerImage, sshHost }).then((r: any) => JSON.stringify(r)) : 'command required';
      case 'kill': return taskId ? (mgr.kill(taskId) ? 'Killed' : 'Not found') : 'taskId required';
      case 'list': return JSON.stringify(mgr.listTasks());
      case 'status': return taskId ? JSON.stringify(mgr.getTask(taskId)) : 'taskId required';
      default: return 'Unknown action';
    }
  }),
});

// Memory tool — persistent curated memory
registerTool({
  name: 'memory',
  description: 'Persistent memory: add/replace/remove entries in MEMORY.md (agent notes) or USER.md (user profile).',
  category: 'workflow',
  inputSchema: z.object({
    action: z.enum(['add', 'replace', 'remove', 'snapshot', 'stats', 'clear']).describe('Action'),
    store: z.enum(['memory', 'user']).describe('Memory store'),
    content: z.string().optional().describe('Content to add/replace'),
    oldSubstring: z.string().optional().describe('Substring to match for replace/remove'),
  }),
  endsAgentStep: false,
  run: (args) => import('./memory-tool.js').then((m) => {
    const { action, store, content, oldSubstring } = args as any;
    const mgr = m.getMemoryManager();
    switch (action) {
      case 'add': return content ? JSON.stringify(mgr.add(store, content)) : 'content required';
      case 'replace': return oldSubstring && content ? JSON.stringify(mgr.replace(store, oldSubstring, content)) : 'oldSubstring and content required';
      case 'remove': return oldSubstring ? JSON.stringify(mgr.remove(store, oldSubstring)) : 'oldSubstring required';
      case 'snapshot': return JSON.stringify({ snapshot: mgr.getSnapshot(store) });
      case 'stats': return JSON.stringify(mgr.getStats(store));
      case 'clear': return (mgr.clear(store), JSON.stringify({ cleared: true }));
      default: return 'Unknown action';
    }
  }),
});

// Send message tool — cross-channel messaging
registerTool({
  name: 'send_message',
  description: 'Send messages to Telegram, Discord, Slack, WhatsApp, Email. Supports media attachments (images, videos, audio, documents) on WhatsApp.',
  category: 'workflow',
  inputSchema: z.object({
    action: z.enum(['send', 'list-targets']).describe('Action'),
    platform: z.enum(['telegram', 'discord', 'slack', 'whatsapp', 'email']).describe('Platform'),
    target: z.string().optional().describe('Target (channel ID, username, email, or WhatsApp contact name/phone number)'),
    text: z.string().optional().describe('Message text'),
    media: z.array(z.string()).optional().describe('File paths for media attachments (WhatsApp: sends first file as image/video/audio/document; type detected from extension)'),
    threadId: z.string().optional().describe('Thread ID'),
  }),
  endsAgentStep: false,
  run: (args) => import('./send-message-tool.js').then((m) => {
    const { action, platform, target, text, media, threadId } = args as any;
    const mgr = m.getSendMessageManager();
    switch (action) {
      case 'send': return target ? mgr.send({ platform, target, text: text || '', media, threadId }).then((r: any) => JSON.stringify(r)) : 'target required';
      case 'list-targets': return mgr.listTargets(platform).then((r: any) => JSON.stringify(r));
      default: return 'Unknown action';
    }
  }),
});

// ─── Skills Ecosystem Tools ───────────────────────────────────────────────

// Skills Hub tool
registerTool({
  name: 'skills_hub',
  description: 'Skill marketplace: install, uninstall, list skills from GitHub, local, or hub sources.',
  category: 'workflow',
  inputSchema: z.object({
    action: z.enum(['install', 'uninstall', 'list-installed', 'list-available', 'info']).describe('Action'),
    source: z.string().optional().describe('Source name (github, local)'),
    skillName: z.string().optional().describe('Skill name'),
    targetDir: z.string().optional().describe('Target directory'),
  }),
  endsAgentStep: false,
  run: (args) => import('./skills-hub.js').then((m) => {
    const { action, source, skillName, targetDir } = args as any;
    const mgr = m.getSkillsHubManager();
    const target = targetDir || join(process.env.HOME || '~', '.nuvira', 'skills');
    switch (action) {
      case 'install': return source && skillName ? mgr.install(source, skillName, target).then((r: any) => JSON.stringify(r)) : 'source and skillName required';
      case 'uninstall': return skillName ? mgr.uninstall(skillName, target).then((r: any) => JSON.stringify({ removed: r })) : 'skillName required';
      case 'list-installed': return mgr.listInstalled(target).then((r: any) => JSON.stringify(r));
      case 'list-available': return mgr.listAvailable().then((r: any) => JSON.stringify(r));
      case 'info': return skillName ? mgr.getInfo(skillName, target).then((r: any) => JSON.stringify(r)) : 'skillName required';
      default: return 'Unknown action';
    }
  }),
});

// Skills Sync tool
registerTool({
  name: 'skills_sync',
  description: 'Sync bundled skills from repo to user directory with manifest tracking.',
  category: 'workflow',
  inputSchema: z.object({
    action: z.enum(['sync', 'status', 'force-sync']).describe('Action'),
    skillName: z.string().optional().describe('Skill name for force-sync'),
    bundledDir: z.string().optional().describe('Bundled skills directory'),
    targetDir: z.string().optional().describe('Target directory'),
  }),
  endsAgentStep: false,
  run: (args) => import('./skills-sync.js').then((m) => {
    const { action, skillName, bundledDir, targetDir } = args as any;
    const mgr = m.getSkillsSyncManager({ bundledDir, targetDir });
    switch (action) {
      case 'sync': return mgr.sync().then((r: any) => JSON.stringify(r));
      case 'status': return JSON.stringify(mgr.getStatus());
      case 'force-sync': return skillName ? mgr.forceSync(skillName).then((r: any) => JSON.stringify({ synced: r })) : 'skillName required';
      default: return 'Unknown action';
    }
  }),
});

// Skills Sync Client tool
registerTool({
  name: 'skills_sync_client',
  description: 'Low-level sync: push/pull skills to remote sync plane.',
  category: 'workflow',
  inputSchema: z.object({
    action: z.enum(['commit', 'push', 'pull', 'status']).describe('Action'),
    skillsDir: z.string().optional().describe('Skills directory'),
    message: z.string().optional().describe('Commit message'),
    remoteUrl: z.string().optional().describe('Remote sync URL'),
  }),
  endsAgentStep: false,
  run: (args) => import('./skills-sync-client.js').then((m) => {
    const { action, skillsDir, message, remoteUrl } = args as any;
    const client = m.getSkillsSyncClient({ remoteUrl });
    const dir = skillsDir || join(process.env.HOME || '~', '.nuvira', 'skills');
    switch (action) {
      case 'commit': return message ? JSON.stringify({ hash: client.commit(dir, message) }) : 'message required';
      case 'push': return client.push().then((r: any) => JSON.stringify(r));
      case 'pull': return client.pull().then((r: any) => JSON.stringify(r));
      case 'status': return JSON.stringify(client.getStatus());
      default: return 'Unknown action';
    }
  }),
});

// Skill Usage tool
registerTool({
  name: 'skill_usage',
  description: 'Track skill usage: record, get stats, most used, recently used.',
  category: 'workflow',
  inputSchema: z.object({
    action: z.enum(['record', 'get', 'most-used', 'recently-used', 'stats']).describe('Action'),
    skillName: z.string().optional().describe('Skill name'),
    context: z.string().optional().describe('Usage context'),
    tokens: z.number().optional().describe('Tokens used'),
  }),
  endsAgentStep: false,
  run: (args) => import('./skill-metadata.js').then((m) => {
    const { action, skillName, context, tokens } = args as any;
    const tracker = m.getSkillUsageTracker();
    switch (action) {
      case 'record': return skillName ? (tracker.record(skillName, context, tokens), JSON.stringify({ recorded: true })) : 'skillName required';
      case 'get': return skillName ? JSON.stringify(tracker.get(skillName)) : 'skillName required';
      case 'most-used': return JSON.stringify(tracker.getMostUsed());
      case 'recently-used': return JSON.stringify(tracker.getRecentlyUsed());
      case 'stats': return JSON.stringify(tracker.getStats());
      default: return 'Unknown action';
    }
  }),
});

// Skill Provenance tool
registerTool({
  name: 'skill_provenance',
  description: 'Track skill provenance: origin, author, version, verification.',
  category: 'workflow',
  inputSchema: z.object({
    action: z.enum(['record', 'get', 'verify', 'list', 'remove']).describe('Action'),
    skillName: z.string().optional().describe('Skill name'),
    source: z.enum(['bundled', 'hub', 'local', 'git']).optional().describe('Source type'),
    sourceUrl: z.string().optional().describe('Source URL'),
    author: z.string().optional().describe('Author'),
    version: z.string().optional().describe('Version'),
  }),
  endsAgentStep: false,
  run: (args) => import('./skill-metadata.js').then((m) => {
    const { action, skillName, source, sourceUrl, author, version } = args as any;
    const mgr = m.getSkillProvenanceManager();
    switch (action) {
      case 'record': return skillName && source ? (mgr.record({ name: skillName, source, sourceUrl, author, version, installedAt: Date.now(), verified: true }), JSON.stringify({ recorded: true })) : 'skillName and source required';
      case 'get': return skillName ? JSON.stringify(mgr.get(skillName)) : 'skillName required';
      case 'verify': return skillName ? JSON.stringify(mgr.verify(skillName, '')) : 'skillName required';
      case 'list': return JSON.stringify(mgr.getAll());
      case 'remove': return skillName ? (mgr.remove(skillName), JSON.stringify({ removed: true })) : 'skillName required';
      default: return 'Unknown action';
    }
  }),
});

// Lazy Deps tool
registerTool({
  name: 'lazy_deps',
  description: 'Lazy dependency loading — only imports heavy modules when invoked, reducing startup time.',
  category: 'workflow',
  inputSchema: z.object({
    action: z.enum(['status', 'preload', 'stats', 'history', 'reset']).describe('Action'),
    modules: z.array(z.string()).optional().describe('Module names to preload'),
  }),
  endsAgentStep: false,
  run: (args) => import('./lazy-deps.js').then((m) => {
    const { action, modules } = args as any;
    const mgr = m.getLazyDepsManager();
    switch (action) {
      case 'status': return JSON.stringify(mgr.getStatus());
      case 'preload': return modules ? mgr.preload(modules).then(() => JSON.stringify({ preloaded: modules })) : 'modules required';
      case 'stats': return JSON.stringify(mgr.getStats());
      case 'history': return JSON.stringify(mgr.getHistory());
      case 'reset': return mgr.reset(), JSON.stringify({ reset: true });
      default: return 'Unknown action';
    }
  }),
});

// Tool Backend Helpers tool
registerTool({
  name: 'tool_backend',
  description: 'Backend selection and load balancing for tool calls — routes to best available backend.',
  category: 'workflow',
  inputSchema: z.object({
    action: z.enum(['select', 'health', 'stats', 'log']).describe('Action'),
    toolName: z.string().optional().describe('Tool name for backend selection'),
    limit: z.number().optional().describe('Limit for log results'),
  }),
  endsAgentStep: false,
  run: (args) => import('./tool-backend-helpers.js').then((m) => {
    const { action, toolName, limit } = args as any;
    const mgr = m.getToolBackendManager();
    switch (action) {
      case 'select': return toolName ? JSON.stringify({ backend: mgr.selectBackend(toolName) }) : 'toolName required';
      case 'health': return mgr.checkHealth().then((r: any) => JSON.stringify(r));
      case 'stats': return JSON.stringify(mgr.getStats());
      case 'log': return JSON.stringify(mgr.getCallLog(limit));
      default: return 'Unknown action';
    }
  }),
});

// Tool Output Limits tool
registerTool({
  name: 'tool_output_limits',
  description: 'Manage output size limits for tool calls — truncate, summarize, or paginate large outputs.',
  category: 'workflow',
  inputSchema: z.object({
    action: z.enum(['truncate', 'config', 'stats']).describe('Action'),
    content: z.string().optional().describe('Content to truncate'),
    toolName: z.string().optional().describe('Tool name for per-tool config'),
    maxChars: z.number().optional().describe('Max characters'),
    maxLines: z.number().optional().describe('Max lines'),
    strategy: z.enum(['tail', 'head', 'middle', 'summarize']).optional().describe('Truncation strategy'),
  }),
  endsAgentStep: false,
  run: (args) => import('./tool-output-limits.js').then((m) => {
    const { action, content, toolName, maxChars, maxLines, strategy } = args as any;
    const mgr = m.getToolOutputLimiter();
    switch (action) {
      case 'truncate': return content ? JSON.stringify(mgr.truncate(content, toolName)) : 'content required';
      case 'config': {
        if (maxChars || maxLines || strategy || toolName) {
          if (toolName) {
            mgr.setToolConfig(toolName, { maxChars, maxLines, truncateStrategy: strategy });
          } else {
            mgr.setGlobalConfig({ maxChars, maxLines, truncateStrategy: strategy });
          }
        }
        return JSON.stringify(mgr.getConfig(toolName));
      }
      case 'stats': return JSON.stringify(mgr.getStats());
      default: return 'Unknown action';
    }
  }),
});

// Tool Result Storage tool
registerTool({
  name: 'tool_result_storage',
  description: 'Persist tool call results across sessions — store, search, and retrieve past results.',
  category: 'workflow',
  inputSchema: z.object({
    action: z.enum(['store', 'get', 'search', 'stats', 'clear']).describe('Action'),
    id: z.string().optional().describe('Result ID for get/delete'),
    tool: z.string().optional().describe('Tool name for search'),
    result: z.string().optional().describe('Result content to store'),
    success: z.boolean().optional().describe('Whether the call succeeded'),
    sessionId: z.string().optional().describe('Session ID'),
    ttl_ms: z.number().optional().describe('Time-to-live in ms'),
    limit: z.number().optional().describe('Search limit'),
  }),
  endsAgentStep: false,
  run: (args) => import('./tool-result-storage.js').then((m) => {
    const { action, id, tool, result, success, sessionId, ttl_ms, limit } = args as any;
    const storage = m.getToolResultStorage();
    switch (action) {
      case 'store': return tool && result ? JSON.stringify({ id: storage.store({ tool, args: {}, result, success: success !== false, session_id: sessionId, ttl_ms }) }) : 'tool and result required';
      case 'get': return id ? JSON.stringify(storage.get(id)) : 'id required';
      case 'search': return tool ? JSON.stringify(storage.searchByTool(tool, limit)) : 'tool required';
      case 'stats': return JSON.stringify(storage.getStats());
      case 'clear': return storage.clearExpired(), JSON.stringify({ cleared: true });
      default: return 'Unknown action';
    }
  }),
});

// MCP Tool — Dynamic MCP server connection and tool invocation
registerTool({
  name: 'mcp_tool',
  description: 'Connect to external MCP servers and invoke their tools — stdio, HTTP, or SSE transport.',
  category: 'workflow',
  inputSchema: z.object({
    action: z.enum(['connect', 'disconnect', 'list-servers', 'list-tools', 'call', 'health']).describe('Action'),
    server: z.string().optional().describe('Server name'),
    tool: z.string().optional().describe('Tool name for call action'),
    args: z.record(z.string(), z.any()).optional().describe('Tool arguments for call action'),
    timeout: z.number().optional().describe('Timeout in ms for tool calls'),
  }),
  endsAgentStep: false,
  run: (args) => import('./mcp-client-tool.js').then((m) => {
    const { action, server, tool, args: toolArgs, timeout } = args as any;
    const mgr = m.getMCPToolManager();
    switch (action) {
      case 'connect': return server ? mgr.connect(server).then((r: any) => JSON.stringify(r)) : 'server required';
      case 'disconnect': return server ? mgr.disconnect(server).then((r: any) => JSON.stringify(r)) : 'server required';
      case 'list-servers': return JSON.stringify(mgr.listServers());
      case 'list-tools': return JSON.stringify(mgr.listTools());
      case 'call': return server && tool ? mgr.callTool(server, tool, toolArgs || {}, timeout).then((r: any) => JSON.stringify(r)) : 'server and tool required';
      case 'health': return mgr.checkHealth().then((r: any) => JSON.stringify(r));
      default: return 'Unknown action';
    }
  }),
});

// Computer Use — Desktop automation via cua-driver
registerTool({
  name: 'computer_use',
  description: 'Desktop control via cua-driver — screenshots, mouse, keyboard, scroll without stealing focus.',
  category: 'workflow',
  inputSchema: z.object({
    action: z.enum(['capture', 'click', 'double_click', 'right_click', 'middle_click',
      'drag', 'scroll', 'type', 'key', 'set_value', 'wait',
      'list_apps', 'list_windows', 'focus_app', 'health']).describe('Action'),
    x: z.number().optional().describe('X coordinate for click/drag'),
    y: z.number().optional().describe('Y coordinate for click/drag'),
    element: z.number().optional().describe('Element index for SOM click'),
    text: z.string().optional().describe('Text to type'),
    keys: z.string().optional().describe('Key combination'),
    mode: z.enum(['screenshot', 'som']).optional().describe('Capture mode'),
    app: z.string().optional().describe('App name for focus_app'),
  }),
  endsAgentStep: false,
  run: (args) => import('./computer-use-tool.js').then((m) => {
    const tool = m.getComputerUseTool();
    return tool.execute((args as any).action, args as any).then((r: any) => JSON.stringify(r));
  }),
});

// Async Delegation — Background child agent execution
registerTool({
  name: 'async_delegation',
  description: 'Run child agents in background without blocking parent — parallel task execution.',
  category: 'workflow',
  inputSchema: z.object({
    action: z.enum(['dispatch', 'status', 'list', 'cancel', 'drain', 'stats']).describe('Action'),
    id: z.string().optional().describe('Task ID for status/cancel'),
    goal: z.string().optional().describe('Task goal for dispatch'),
    context: z.string().optional().describe('Task context for dispatch'),
  }),
  endsAgentStep: false,
  run: (args) => import('./async-delegation.js').then((m) => {
    const mgr = m.getAsyncDelegationManager();
    const { action, id, goal, context } = args as any;
    switch (action) {
      case 'dispatch': return goal ? JSON.stringify(mgr.dispatch({ goal, context })) : 'goal required';
      case 'status': return id ? JSON.stringify(mgr.getStatus(id)) : 'id required';
      case 'list': return JSON.stringify(mgr.listTasks());
      case 'cancel': return id ? JSON.stringify({ cancelled: mgr.cancel(id) }) : 'id required';
      case 'drain': return JSON.stringify(mgr.drainCompletionQueue());
      case 'stats': return JSON.stringify(mgr.getStats());
      default: return 'Unknown action';
    }
  }),
});

// Delegation Live Log — Real-time monitoring of delegated tasks
registerTool({
  name: 'delegation_live_log',
  description: 'Live tail-able transcripts for delegated subagents — real-time monitoring.',
  category: 'workflow',
  inputSchema: z.object({
    action: z.enum(['create', 'log', 'update-status', 'prune']).describe('Action'),
    delegationId: z.string().optional().describe('Delegation ID'),
    taskIndex: z.number().optional().describe('Task index'),
    role: z.string().optional().describe('Log entry role'),
    content: z.string().optional().describe('Log entry content'),
    status: z.string().optional().describe('Task status for update'),
  }),
  endsAgentStep: false,
  run: (args) => import('./delegation-live-log.js').then((m) => {
    const mgr = m.getDelegationLiveLogManager();
    const { action, delegationId, taskIndex, role, content, status } = args as any;
    switch (action) {
      case 'create': {
        const tasks = [{ goal: content || 'Background task' }];
        return JSON.stringify(mgr.createTranscripts(tasks, delegationId));
      }
      case 'log': {
        const writer = mgr.getWriter(delegationId, taskIndex || 0);
        if (writer) { writer.event(role || 'system', content || ''); return JSON.stringify({ logged: true }); }
        return JSON.stringify({ error: 'Transcript not found' });
      }
      case 'update-status': {
        mgr.updateStatus(delegationId, [{ taskIndex: taskIndex || 0, status: status || 'completed' }]);
        return JSON.stringify({ updated: true });
      }
      case 'prune': return JSON.stringify({ pruned: mgr.pruneStale() });
      default: return 'Unknown action';
    }
  }),
});

// OpenRouter Client — Multi-LLM routing
registerTool({
  name: 'openrouter_client',
  description: 'Route LLM calls to multiple providers via OpenRouter — cost optimization and fallback.',
  category: 'workflow',
  inputSchema: z.object({
    action: z.enum(['chat', 'models', 'stats']).describe('Action'),
    model: z.string().optional().describe('Model ID'),
    messages: z.array(z.object({ role: z.enum(['system', 'user', 'assistant']), content: z.string() })).optional().describe('Chat messages'),
    maxTokens: z.number().optional().describe('Max tokens'),
    temperature: z.number().optional().describe('Temperature'),
  }),
  endsAgentStep: false,
  run: (args) => import('./openrouter-client.js').then((m) => {
    const client = m.getOpenRouterClient();
    const { action, model, messages, maxTokens, temperature } = args as any;
    switch (action) {
      case 'chat': return messages ? client.chat(messages, { model, maxTokens, temperature }).then((r: any) => JSON.stringify(r)) : 'messages required';
      case 'models': return client.listModels().then((r: any) => JSON.stringify(r));
      case 'stats': return JSON.stringify(client.getStats());
      default: return 'Unknown action';
    }
  }),
});

// TTS Streaming — Provider-agnostic streaming TTS
registerTool({
  name: 'tts_streaming',
  description: 'Convert text to speech using various providers — streaming and batch modes.',
  category: 'workflow',
  inputSchema: z.object({
    action: z.enum(['synthesize', 'stream', 'providers']).describe('Action'),
    text: z.string().optional().describe('Text to synthesize'),
    provider: z.enum(['elevenlabs', 'openai', 'azure', 'google', 'edge-tts']).optional().describe('TTS provider'),
    voice: z.string().optional().describe('Voice ID'),
    speed: z.number().optional().describe('Speed (0.5-2.0)'),
    format: z.enum(['pcm', 'mp3', 'wav']).optional().describe('Audio format'),
  }),
  endsAgentStep: false,
  run: (args) => import('./tts-streaming.js').then((m) => {
    const mgr = m.getTTSStreamingManager();
    const { action, text, provider, voice, speed, format } = args as any;
    switch (action) {
      case 'synthesize': return text ? mgr.synthesize(text, { provider, voice, speed, format }).then((r: any) => JSON.stringify({ success: true, format: r.format, provider: r.provider })) : 'text required';
      case 'stream': return text ? mgr.stream(text, { provider, voice, speed }).then(() => JSON.stringify({ streaming: true })) : 'text required';
      case 'providers': return JSON.stringify({ providers: mgr.listProviders() });
      default: return 'Unknown action';
    }
  }),
});

// TTS Text Normalize — Normalize text for speech synthesis
registerTool({
  name: 'tts_text_normalize',
  description: 'Normalize text for TTS — remove markdown, expand abbreviations, handle code blocks.',
  category: 'workflow',
  inputSchema: z.object({
    text: z.string().describe('Text to normalize'),
    removeMarkdown: z.boolean().optional().describe('Remove markdown formatting'),
    expandAbbreviations: z.boolean().optional().describe('Expand abbreviations'),
    normalizeNumbers: z.boolean().optional().describe('Normalize numbers'),
    removeUrls: z.boolean().optional().describe('Remove URLs'),
  }),
  endsAgentStep: false,
  run: (args) => import('./tts-text-normalize.js').then((m) => {
    const normalizer = m.getTTSTextNormalizer();
    const { text, removeMarkdown, expandAbbreviations, normalizeNumbers, removeUrls } = args as any;
    const result = normalizer.normalize(text, { removeMarkdown, expandAbbreviations, normalizeNumbers, removeUrls });
    return JSON.stringify({ original: text.length, normalized: result.length, text: result });
  }),
});

// Write Approval — Write-approval gate for memory/skill writes
registerTool({
  name: 'write_approval',
  description: 'Approval gate for memory and skill modifications — safety mechanism.',
  category: 'workflow',
  inputSchema: z.object({
    action: z.enum(['request', 'approve', 'deny', 'complete', 'pending', 'audit']).describe('Action'),
    id: z.string().optional().describe('Write ID'),
    writeAction: z.string().optional().describe('Write action type'),
    target: z.string().optional().describe('Write target'),
    reason: z.string().optional().describe('Approval/denial reason'),
  }),
  endsAgentStep: false,
  run: (args) => import('./write-approval.js').then((m) => {
    const mgr = m.getWriteApprovalManager();
    const { action, id, writeAction, target, reason } = args as any;
    switch (action) {
      case 'request': return writeAction && target ? JSON.stringify(mgr.requestApproval({ action: writeAction, target, data: {} })) : 'writeAction and target required';
      case 'approve': return id ? JSON.stringify({ approved: mgr.approve(id, reason) }) : 'id required';
      case 'deny': return id ? JSON.stringify({ denied: mgr.deny(id, reason) }) : 'id required';
      case 'complete': return id ? JSON.stringify({ completed: mgr.complete(id) }) : 'id required';
      case 'pending': return JSON.stringify(mgr.getPending());
      case 'audit': return JSON.stringify(mgr.getAuditLog());
      default: return 'Unknown action';
    }
  }),
});

// Read Extract — Document-to-text extraction
registerTool({
  name: 'read_extract',
  description: 'Extract text from documents — PDF, DOCX, XLSX, PPTX, HTML, CSV, JSON.',
  category: 'workflow',
  inputSchema: z.object({
    filePath: z.string().describe('File path to extract text from'),
  }),
  endsAgentStep: false,
  run: (args) => import('./read-extract.js').then((m) => {
    const mgr = m.getReadExtractManager();
    const { filePath } = args as any;
    return mgr.extract(filePath).then((r: any) => JSON.stringify(r));
  }),
});

// Credential Files — Credential file management
registerTool({
  name: 'credential_files',
  description: 'Manage credential files for remote terminal backends — Docker, SSH, Modal.',
  category: 'workflow',
  inputSchema: z.object({
    action: z.enum(['register', 'get', 'read', 'list', 'remove', 'redact', 'validate']).describe('Action'),
    id: z.string().optional().describe('Credential ID'),
    name: z.string().optional().describe('Credential name'),
    type: z.enum(['ssh-key', 'api-key', 'token', 'certificate', 'env-file', 'generic']).optional().describe('Credential type'),
    credPath: z.string().optional().describe('Credential file path'),
    text: z.string().optional().describe('Text to redact'),
  }),
  endsAgentStep: false,
  run: (args) => import('./credential-files.js').then((m) => {
    const mgr = m.getCredentialFilesManager();
    const { action, id, name, type, credPath, text } = args as any;
    switch (action) {
      case 'register': return name && type && credPath ? JSON.stringify({ id: mgr.register({ name, type, path: credPath }) }) : 'name, type, and credPath required';
      case 'get': return id ? JSON.stringify(mgr.get(id)) : 'id required';
      case 'read': return id ? JSON.stringify({ content: mgr.read(id) }) : 'id required';
      case 'list': return JSON.stringify(mgr.list());
      case 'remove': return id ? JSON.stringify({ removed: mgr.remove(id) }) : 'id required';
      case 'redact': return text ? JSON.stringify({ redacted: mgr.redact(text) }) : 'text required';
      case 'validate': return JSON.stringify(mgr.validate());
      default: return 'Unknown action';
    }
  }),
});

// Memory Tools — Dedicated memory management
registerTool({
  name: 'add_memory',
  description: 'Add a new memory entry (fact, preference, lesson, observation, pattern).',
  category: 'workflow',
  inputSchema: z.object({
    content: z.string().describe('Memory content'),
    type: z.enum(['fact', 'preference', 'lesson', 'observation', 'pattern']).describe('Memory type'),
    tags: z.array(z.string()).optional().describe('Tags for categorization'),
    source: z.string().optional().describe('Source context'),
  }),
  endsAgentStep: false,
  run: (args) => import('./memory-tools.js').then((m) => {
    const store = m.getMemoryStore();
    const { content, type, tags, source } = args as any;
    const entry = store.add({ content, type, tags, source });
    return JSON.stringify({ success: true, id: entry.id, type: entry.type });
  }),
});

registerTool({
  name: 'search_memory',
  description: 'Search memories by content, type, or tags. Searches BOTH memory stores: entries added with add_memory (keyword/tag) and facts learned from earlier sessions (semantic), so a memory recorded by another path is still found.',
  category: 'workflow',
  inputSchema: z.object({
    query: z.string().optional().describe('Search query'),
    type: z.enum(['fact', 'preference', 'lesson', 'observation', 'pattern']).optional().describe('Type filter'),
    tags: z.array(z.string()).optional().describe('Tag filter'),
    limit: z.number().optional().describe('Max results (default: 10)'),
  }),
  endsAgentStep: false,
  run: (args, ctx) => import('./memory-tools.js').then(async (m) => {
    const { query, type, tags, limit } = args as any;
    // Scope the semantic half to this project — the same deriveProjectId() the
    // fact extractor and recall use, so all three agree on the store.
    let projectId: string | undefined;
    try {
      const { deriveProjectId } = await import('../config/workspace.js');
      projectId = deriveProjectId(ctx?.cwd || process.cwd()).id;
    } catch { /* best-effort — memory-store results still return */ }
    const results = await m.searchMemories({ query, type, tags, limit, projectId });
    return JSON.stringify({
      count: results.length,
      results: results.map((r) => ({ id: r.id, content: r.content, type: r.type, score: r.score, source: r.source })),
    });
  }),
});

registerTool({
  name: 'delete_memory',
  description: 'Delete a memory by ID.',
  category: 'workflow',
  inputSchema: z.object({
    id: z.string().describe('Memory ID to delete'),
  }),
  endsAgentStep: false,
  run: (args) => import('./memory-tools.js').then((m) => {
    const store = m.getMemoryStore();
    const { id } = args as any;
    const deleted = store.delete(id);
    return JSON.stringify({ success: deleted, id });
  }),
});

registerTool({
  name: 'replace_memory',
  description: 'Replace an existing memory with updated content.',
  category: 'workflow',
  inputSchema: z.object({
    id: z.string().describe('Memory ID to replace'),
    content: z.string().optional().describe('New content'),
    type: z.enum(['fact', 'preference', 'lesson', 'observation', 'pattern']).optional().describe('New type'),
    tags: z.array(z.string()).optional().describe('New tags'),
  }),
  endsAgentStep: false,
  run: (args) => import('./memory-tools.js').then((m) => {
    const store = m.getMemoryStore();
    const { id, content, type, tags } = args as any;
    const entry = store.update(id, { content, type, tags });
    return entry ? JSON.stringify({ success: true, id: entry.id }) : JSON.stringify({ success: false, error: 'Memory not found' });
  }),
});

registerTool({
  name: 'list_memories',
  description: 'List all memory entries with optional filters.',
  category: 'workflow',
  inputSchema: z.object({
    type: z.enum(['fact', 'preference', 'lesson', 'observation', 'pattern']).optional().describe('Type filter'),
    limit: z.number().optional().describe('Max results'),
  }),
  endsAgentStep: false,
  run: (args) => import('./memory-tools.js').then((m) => {
    const store = m.getMemoryStore();
    const { type, limit } = args as any;
    const entries = store.list({ type, limit });
    return JSON.stringify({ count: entries.length, entries: entries.map(e => ({ id: e.id, content: e.content, type: e.type, tags: e.tags })) });
  }),
});

registerTool({
  name: 'memory_stats',
  description: 'Get memory statistics.',
  category: 'workflow',
  inputSchema: z.object({}),
  endsAgentStep: false,
  run: () => import('./memory-tools.js').then((m) => {
    const store = m.getMemoryStore();
    return JSON.stringify(store.getStats());
  }),
});
