/**
 * Provider resolution SERVICE.
 *
 * This module exists to be imported INWARD: it resolves a CLI `--provider`
 * value (built-in id, catalog id, plugin id, or the `auto` directive) to a
 * concrete `InferenceProvider`. It must never import a command module — the
 * dispatcher that wires commands lives in `./cli-program.ts`, and the two used
 * to share one file, which put 28 modules into a single static import cycle
 * (every command imported this file for `resolveProvider`, while this file
 * imported every command for `createCLI`).
 *
 * Layering rule: `cli-program.ts` and `index.ts` may depend on this file; this
 * file depends only on config / inference / learning / plugins.
 *
 * Verified with `node scripts/check-import-cycles.mjs`.
 */
import { ConfigManager } from '../config/manager.js';
import { InferenceProvider } from '../inference/interface.js';
/**
 * Resolve the inference provider from CLI options.
 *
 * Supports both built-in providers (local, nim, gemini, openrouter, groq)
 * and auto-discovered plugin providers from ~/.nuvira/plugins/.
 *
 * For plugin providers, the type string returned is the plugin's provider type.
 */
export declare function resolveProvider(configManager: ConfigManager, providerOption?: string): {
    type: string;
    provider: InferenceProvider;
};
//# sourceMappingURL=router.d.ts.map