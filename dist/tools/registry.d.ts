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
import { z, type ZodType } from 'zod';
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
     * Whether executing this tool should continue the loop after it returns.
     * `false` (e.g. suggest_followups) lets the model end the turn right after
     * (endsAgentStep semantics).
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
        sendMedia?(target: string, media: {
            type: 'image' | 'video' | 'audio' | 'document';
            data: Uint8Array;
            caption?: string;
            filename?: string;
        }): Promise<boolean>;
        /** The originating channel (platform + channelId) for this gateway-triggered turn. */
        origin?: {
            platform: string;
            channelId: string;
        };
        /** Auto-deliver a media payload to the originating channel. Tools that produce
         *  artifacts (generate_image, speak, etc.) call this to send results back
         *  without needing to know the target. Returns true on success. */
        autoDeliverMedia?(media: {
            type: 'image' | 'video' | 'audio' | 'document';
            data: Uint8Array;
            caption?: string;
            filename?: string;
        }): Promise<boolean>;
        directory: {
            resolve(target: string): {
                platform: string;
                channelId: string;
            } | null;
        };
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
/** A follow-up recommendation. */
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
/** E3c — publish tool args: bump type + safety flags (irreversible action). */
export declare const publishToolSchema: z.ZodObject<{
    goal: z.ZodOptional<z.ZodString>;
    bump: z.ZodDefault<z.ZodEnum<{
        patch: "patch";
        minor: "minor";
        major: "major";
    }>>;
    dry_run: z.ZodDefault<z.ZodBoolean>;
    skip_tests: z.ZodDefault<z.ZodBoolean>;
}, z.core.$strip>;
/** E3g — gateway message delivery: target + text + optional media (model-decides vocabulary). */
export declare const gatewaySendSchema: z.ZodObject<{
    target: z.ZodString;
    text: z.ZodString;
    image_path: z.ZodOptional<z.ZodString>;
    caption: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
/** run_cli — plain-English → CLI execution via the command manifest. */
export declare const runCliSchema: z.ZodObject<{
    ask: z.ZodString;
    confirm: z.ZodDefault<z.ZodOptional<z.ZodBoolean>>;
}, z.core.$strip>;
/** P3b — gated git args: structured status/log/diff/commit. */
export declare const gitToolSchema: z.ZodObject<{
    action: z.ZodEnum<{
        status: "status";
        log: "log";
        commit: "commit";
        diff: "diff";
    }>;
    message: z.ZodOptional<z.ZodString>;
    files: z.ZodOptional<z.ZodArray<z.ZodString>>;
    confirm: z.ZodDefault<z.ZodBoolean>;
    limit: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>;
/** P3a — clone_repo args: a git URL to assess (depth-1 shallow only). */
export declare const cloneRepoSchema: z.ZodObject<{
    url: z.ZodString;
    ref: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
/** P0.8 — skill tool args: load a reusable capability pack by name (+ params). */
export declare const skillToolSchema: z.ZodObject<{
    skill: z.ZodOptional<z.ZodString>;
    params: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
    bundle: z.ZodOptional<z.ZodString>;
    manage: z.ZodOptional<z.ZodObject<{
        action: z.ZodEnum<{
            delete: "delete";
            create: "create";
            write_file: "write_file";
            patch: "patch";
        }>;
        name: z.ZodString;
        markdown: z.ZodOptional<z.ZodString>;
        oldText: z.ZodOptional<z.ZodString>;
        newText: z.ZodOptional<z.ZodString>;
        file: z.ZodOptional<z.ZodString>;
        content: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
}, z.core.$strip>;
/** P0.7 — plan_todo args: declare ordered steps, then update their status. */
export declare const planTodoSchema: z.ZodObject<{
    action: z.ZodEnum<{
        create: "create";
        update: "update";
    }>;
    goal: z.ZodOptional<z.ZodString>;
    steps: z.ZodOptional<z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        description: z.ZodString;
    }, z.core.$strip>>>;
    id: z.ZodOptional<z.ZodString>;
    status: z.ZodOptional<z.ZodEnum<{
        done: "done";
        pending: "pending";
        running: "running";
        blocked: "blocked";
    }>>;
}, z.core.$strip>;
/**
 * The shared suggest_followups output schema (exported for cross-command
 * parity — execute/plan post-run followups validate against the SAME schema
 * the chat loop's tool uses, so one contract is enforced everywhere).
 */
export declare const suggestFollowupsSchema: z.ZodObject<{
    followups: z.ZodArray<z.ZodObject<{
        prompt: z.ZodString;
        label: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
}, z.core.$strip>;
/**
 * Register a tool. The registry is a Map, so re-registering the same name
 * replaces the definition (idempotent — safe on hot module reloads).
 */
export declare function registerTool(tool: Tool): void;
/** Look up a tool by name. */
export declare function getTool(name: string): Tool | undefined;
/** All registered tools, sorted by name (stable `nuvira tools list` output). */
export declare function listTools(): Tool[];
/**
 * The JSON-schema form of every tool — handed to native tool-calling
 * providers (OpenAI `tools: [{type:'function',function:{...}}]`). Derived
 * from the zod schemas, never hand-kept.
 */
export declare function toolJsonSchemas(toolNames?: string[]): ToolJsonSchema[];
/**
 * The tool contract embedded in the chat system prompt
 * (verified against `agents/base-chat.ts`): the model ends its response by
 * calling suggest_followups with exactly 3 followups, and clarifies ambiguous
 * requests via ask_user instead of guessing.
 */
export declare const TOOL_CONTRACT = "You have tools available. Call them when appropriate.\n\n- If a request is ambiguous or incomplete, call `ask_user` with a question and 2\u20134 choices \u2014 never guess, never ask in plain text.\n- If a request needs code written, debugged, or prior work resumed, call `build`, `repair`, or `resume` with the goal.\n- If a request needs documentation, a website, analysis of a project, or running tests, call `document`, `website`, `analyze`, or `test` with the goal.\n- If a request asks to publish a release (npm/GitHub), call `publish`. It is irreversible \u2014 confirm the bump type and target with the user via `ask_user` first unless they already specified them.\n- If a request's completeness is uncertain, call `verify_requirement` first.\n- If a request asks to deliver a message or result to a DIFFERENT contact/channel than the one you are currently chatting on (WhatsApp, Telegram, Slack, email, \u2026), call `gateway_send` with the target (e.g. `whatsapp:Alex`) and the text. Do NOT call gateway_send to reply to the CURRENT conversation \u2014 your text response is automatically delivered back. If the target contact is not configured, tell the user what to set up.\n- If a request asks to manage the system/agent itself in plain English \u2014 start/stop the dashboard or gateway, check status, add/remove a verified sender, configure a platform (telegram/whatsapp), run evals, show stats \u2014 call `run_cli` with the plain-English ask. It resolves the exact `buff` command and runs it. If the tool reports AMBIGUOUS or asks for confirmation, call `ask_user` first, then retry run_cli with the user's answer.\n- If a subtask can be delegated to a specialized sub-agent (gather context, review, security scan, run tests), call `delegate` with the agent type, a focused prompt, and optional file paths.\n- To find code matching a pattern (context gathering, locating definitions/usages), call `code_search` with the pattern and optional globs.\n- To READ the project: call `read_file` to open a file (with line numbers), `list_dir` to see a directory's contents, or `glob` to find files by pattern. Always prefer reading the actual file over assuming its contents \u2014 a large file reports a line range, continue with offset/limit.\n- To CHANGE code (after reading it): call `edit_file` for a surgical exact-text replacement, or `write_file` to create/replace a file. Both are state-changing and refuse without confirm \u2014 call `ask_user` to confirm the change with a one-line summary, then retry with confirm:true.\n- To VERIFY code by actual invocation: call `run_terminal` with the real command (`npx vitest run tests/x.test.ts`, `npx tsc --noEmit`, `npm run build`, `git diff`). Read-only verify commands run directly; state-changing ones need confirm:true after the user approves via ask_user. Never guess that a test passes \u2014 run it and read the output. Use run_cli (not run_terminal) for buff/agent-nuvira control commands.\n- END EVERY RESPONSE by calling `suggest_followups` with exactly 3 followups the user is likely to want next \u2014 natural next questions, deeper dives, or related directions that build on what you just said; specific to this conversation, not generic.\n- If you have nothing to add, answer directly and still end with suggest_followups.\n- ORDERING (non-negotiable): deliver the user's answer FIRST, then suggest_followups. The followup call must come only AFTER the complete answer is written \u2014 never before it, never instead of it. A bare lead-in (\"Sure, I can help!\") is NOT an answer; write the full answer in the same step as the followup call.";
/** The JSON-fallback tool contract — for providers WITHOUT native tool-calling. */
export declare const TOOL_CONTRACT_JSON = "You have tools available. Call them when appropriate.\n\n- If a request is ambiguous or incomplete, call `ask_user` with a question and 2\u20134 choices \u2014 never guess, never ask in plain text.\n- If a request needs code written, debugged, or prior work resumed, call `build`, `repair`, or `resume` with the goal.\n- If a request needs documentation, a website, analysis of a project, or running tests, call `document`, `website`, `analyze`, or `test` with the goal.\n- If a request asks to publish a release (npm/GitHub), call `publish`. It is irreversible \u2014 confirm the bump type and target with the user via `ask_user` first unless they already specified them.\n- If a request's completeness is uncertain, call `verify_requirement` first.\n- If a request asks to deliver a message or result to a DIFFERENT contact/channel than the one you are currently chatting on (WhatsApp, Telegram, Slack, email, \u2026), call `gateway_send` with the target (e.g. `whatsapp:Alex`) and the text. Do NOT call gateway_send to reply to the CURRENT conversation \u2014 your text response is automatically delivered back. If the target contact is not configured, tell the user what to set up.\n- If a request asks to manage the system/agent itself in plain English \u2014 start/stop the dashboard or gateway, check status, add/remove a verified sender, configure a platform (telegram/whatsapp), run evals, show stats \u2014 call `run_cli` with the plain-English ask. It resolves the exact `buff` command and runs it. If the tool reports AMBIGUOUS or asks for confirmation, call `ask_user` first, then retry run_cli with the user's answer.\n- If a subtask can be delegated to a specialized sub-agent (gather context, review, security scan, run tests), call `delegate` with the agent type, a focused prompt, and optional file paths.\n- To find code matching a pattern (context gathering, locating definitions/usages), call `code_search` with the pattern and optional globs.\n- To READ the project: call `read_file` to open a file (with line numbers), `list_dir` to see a directory's contents, or `glob` to find files by pattern. Always prefer reading the actual file over assuming its contents \u2014 a large file reports a line range, continue with offset/limit.\n- To CHANGE code (after reading it): call `edit_file` for a surgical exact-text replacement, or `write_file` to create/replace a file. Both are state-changing and refuse without confirm \u2014 call `ask_user` to confirm the change with a one-line summary, then retry with confirm:true.\n- To VERIFY code by actual invocation: call `run_terminal` with the real command (`npx vitest run tests/x.test.ts`, `npx tsc --noEmit`, `npm run build`, `git diff`). Read-only verify commands run directly; state-changing ones need confirm:true after the user approves via ask_user. Never guess that a test passes \u2014 run it and read the output. Use run_cli (not run_terminal) for buff/agent-nuvira control commands.\n- END EVERY RESPONSE by calling `suggest_followups` with exactly 3 followups the user is likely to want next \u2014 natural next questions, deeper dives, or related directions that build on what you just said; specific to this conversation, not generic.\n- If you have nothing to add, answer directly and still end with suggest_followups.\n- ORDERING (non-negotiable): deliver the user's answer FIRST, then suggest_followups. The followup call must come only AFTER the complete answer is written \u2014 never before it, never instead of it. A bare lead-in (\"Sure, I can help!\") is NOT an answer; write the full answer in the same step as the followup call.\n\nTOOL CALL FORMAT (JSON fallback transport):\nWhen calling a tool, emit its JSON AFTER your response text, in this exact shape:\n{\"tool\":\"<name>\",\"arguments\":{...}}\nOne tool call per block. The final block may be a suggest_followups call.";
/**
 * Parse + validate a model's followups output against the shared
 * suggest_followups schema. Accepts both the tool shape `[{prompt,label?}]`
 * and the legacy execute.ts shape `[{label,description,goal}]` (mapped to
 * prompt/label) so every surface speaks one vocabulary. Returns [] when
 * unparseable or schema-invalid (callers fall back to rule-based suggestions).
 */
export declare function toFollowupSuggestions(raw: string): FollowupSuggestion[];
//# sourceMappingURL=registry.d.ts.map