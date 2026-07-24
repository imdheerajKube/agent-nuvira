/**
 * Load environment variables from .env files
 * Checks: project .env, home dir .env, and process.env
 *
 * .env file features:
 * - Lines starting with # are comments
 * - Inline comments are supported (KEY=value # comment)
 * - export prefix is stripped (export KEY=value)
 * - Variable expansion: $VAR, ${VAR}, ${VAR:-default}
 *   - References already-parsed vars in the same file first
 *   - Falls back to process.env
 *   - ${VAR:-default} uses 'default' if VAR is not set
 * - Windows CRLF line endings are handled
 * - Quoted values (single and double) are unquoted
 * - Double-quoted values support variable expansion
 * - Single-quoted values are literal (no expansion)
 */
export declare function loadEnv(): Record<string, string | undefined>;
//# sourceMappingURL=env.d.ts.map