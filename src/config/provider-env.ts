/**
 * Provider-credential env vars — the single source of truth.
 *
 * Why this is its own leaf module: the same set answers three different
 * questions in three different layers, and before this module each layer had
 * its own (or no) copy:
 *
 *   1. `skills/skill-executor.ts` — may this var pass through into a skill
 *      sandbox? (A skill must never receive the agent's own provider keys.)
 *   2. `skills/secret-capture.ts` / the dashboard skill-secret endpoint — may
 *      this var be stored as a SKILL secret? (No: it is a *provider* secret,
 *      configured through provider setup, and storing it here would imply a
 *      skill can use it when it deliberately cannot.)
 *   3. The dashboard's env-var editor — is this row a blocked provider
 *      credential the user should not be able to edit here?
 *
 * With the list duplicated, the editor could show a 🔒 "blocked" badge while
 * the write endpoint happily accepted the same key — a cosmetic invariant with
 * no enforcement behind it. One definition, imported everywhere, keeps the
 * badge and the enforcement honest.
 *
 * The set is intentionally explicit rather than pattern-matched
 * (`/^[A-Z_]*API_KEY$/` would wrongly block a skill's own custom key, e.g.
 * `MY_SERVICE_API_KEY`).
 */

/** Provider env vars that must NEVER be handed to a skill execution. */
export const PROVIDER_ENV_BLOCKLIST: ReadonlySet<string> = new Set([
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_TOKEN',
  'OPENAI_API_KEY',
  'OPENAI_TOKEN',
  'GROQ_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'MISTRAL_API_KEY',
  'COHERE_API_KEY',
  'TOGETHER_API_KEY',
  'DEEPINFRA_API_KEY',
  'FIREWORKS_API_KEY',
  'OPENROUTER_API_KEY',
  'AZURE_OPENAI_API_KEY',
  'BEDROCK_ACCESS_KEY',
  'BEDROCK_SECRET_KEY',
  'NUVIRA_API_KEY', // Don't pass the agent's own key
  // Modality + web-research providers (image-generation and search BYOK).
  // These are agent-level provider credentials now, not a skill's own key, so
  // they must never be handed to (or stored by) a skill sandbox either.
  'STABILITY_API_KEY',
  'BRAVE_SEARCH_API_KEY',
  'BRAVE_API_KEY',
  'SERPER_API_KEY',
  'TAVILY_API_KEY',
  'GOOGLE_CSE_API_KEY',
  // Other agent-consumed services (video / speech / page-reading) — same rule:
  // these are the agent's credentials, never a skill's, so a skill sandbox must
  // not receive them either.
  'FAL_KEY',
  'ELEVENLABS_API_KEY',
  'JINA_API_KEY',
  'NEUTTS_API_KEY',
]);

/**
 * Is this env var a provider credential (i.e. blocked from skills and from the
 * skill-secret editor)?
 */
export function isProviderEnvBlocked(varName: string): boolean {
  return PROVIDER_ENV_BLOCKLIST.has(varName);
}

/**
 * Shapes that are credential-looking even when they are not one of OUR
 * providers — a user's own `STRIPE_SECRET_KEY`, `AWS_SECRET_ACCESS_KEY`, an
 * SMTP password, a tenant token.
 *
 * Why this exists: `executeSkill` hands the sandbox every `process.env` entry
 * that is not in `PROVIDER_ENV_BLOCKLIST`. That set only knows *our* provider
 * keys, so a messaging-platform password or a cloud credential sitting in the
 * environment of the nuvira process was passed to any skill with a shell. The
 * explicit-names list cannot cover vars we have never heard of; a shape rule
 * can.
 *
 * Deliberately NOT an allowlist: `PATH`, `HOME`, `LANG`, `NODE_ENV` and every
 * other benign var must keep flowing, or every non-trivial skill breaks. This
 * only removes things that look like secrets, and it is applied to the
 * AUTOMATIC `process.env` passthrough ONLY — a value the caller passed
 * explicitly (a skill's own declared `required_environment_variables`) is
 * always allowed, so a skill can still receive its own declared key.
 */
const SENSITIVE_ENV_PATTERNS: readonly RegExp[] = [
  /_(API_?KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIALS?)$/i,
  /^(API_?KEY|SECRET|TOKEN|PASSWORD|CREDENTIALS?)$/i,
  /^(AWS|AZURE|GCP|GOOGLE|DIGITALOCEAN|CLOUDFLARE|STRIPE|TWILIO|SENDGRID|SLACK|DISCORD|TELEGRAM)_/i,
  /(_|^)(ACCESS_?KEY|PRIVATE_?KEY|SESSION_?KEY|SIGNING_?KEY|AUTH_?TOKEN)$/i,
];

/**
 * Does this env var look like a credential that must not be handed to a skill
 * automatically? Provider keys (the explicit list) always answer true.
 */
export function isSensitiveEnvVar(varName: string): boolean {
  if (isProviderEnvBlocked(varName)) return true;
  return SENSITIVE_ENV_PATTERNS.some((re) => re.test(varName));
}
