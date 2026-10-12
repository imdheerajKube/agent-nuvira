/**
 * Example agents — the entry point of this example package.
 *
 * Three shapes of custom agent, in the order you should read them:
 *   1. `conventional-commit` — the minimal complete agent (validate → prompt → parse).
 *   2. `api-contract-differ` — where the model goes and where deterministic code must.
 *   3. `migration-guard` — the full context bus plus the rate-limit contract.
 *   4. `release-notes-plugin` — the plugin FILE shape, for CLI installs from npm.
 *
 * Each export has a `agentDescriptor` (or, for the plugin, `metadata`) so it can be
 * registered directly: `nuvira sdk register <Class> <agent-type> <module>`.
 */

export { ConventionalCommitAgent, agentDescriptor, COMMIT_TYPES, CONVENTIONAL_SUBJECT_RE } from './conventional-commit.js';

export {
  ApiContractDifferAgent,
  agentDescriptor as apiContractDifferDescriptor,
  extractJsonArray,
  diffContracts,
  type Endpoint,
  type ContractDiff,
} from './api-contract-differ.js';

export {
  MigrationGuardAgent,
  agentDescriptor as migrationGuardDescriptor,
  parseRationale,
  type MigrationFinding,
} from './migration-guard.js';

export {
  plugin as releaseNotesPlugin,
  type AgentPluginShape,
  type PluginMetadata,
} from './release-notes-plugin.js';
