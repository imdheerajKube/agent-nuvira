/**
 * @agent-nuvira/sdk/register — Register a custom agent with the orchestrator.
 *
 * WHICH FILE THIS EDITS depends on the checkout it runs in, and it has to: the
 * harness replaced its hardcoded `createAgent()` switch with a
 * `ModuleRegistry` (see `src/agents/module-registry.ts`), so a registration tool
 * that only knew about the switch would edit a block that no longer exists and
 * report success while the agent stayed unrunnable.
 *
 * 1. **ModuleRegistry layout** (current): adds an import plus a
 *    `registry.registerOrOverride(...)` call to
 *    `src/agents/module-registry.ts`, inside `createWithBuiltins()`.
 * 2. **Legacy switch layout**: adds the import, a `case` in `createAgent()` and
 *    an `AGENT_ICONS` entry in `src/agents/orchestrator.ts`.
 *
 * Both are SOURCE-CHECKOUT edits. With the CLI installed from npm there is no
 * such file, and the call says so rather than pretending; distribute a
 * prebuilt plugin file into `~/.nuvira/agents/` instead (`nuvira plugins list`).
 *
 * ## Usage
 *
 * ```ts
 * import { registerAgent } from '@agent-nuvira/sdk/register';
 *
 * const changes = registerAgent({
 *   sourceModule: './agents/my-agent.js',
 *   className: 'MyAgent',
 *   agentType: 'my-agent',
 * });
 * ```
 *
 * @module @agent-nuvira/sdk/register
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

// ─── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_ICON = '🧩';

// ─── Public Types ───────────────────────────────────────────────────────────

/** Options for registering a custom agent */
export interface RegisterOptions {
  /** Absolute or relative path to the orchestrator source file (default: auto-detected) */
  orchestratorPath?: string;
  /**
   * The import module path for the agent class, relative to the directory the
   * registration is written into (`src/agents/`). Example: './agents/my-agent.js'
   */
  sourceModule: string;
  /** The exported class name to import. Example: 'MyAgent' */
  className: string;
  /** The agent type string used in task plans and the registry call. Example: 'my-agent' */
  agentType: string;
  /** Optional emoji icon for the agent (default: 🧩) */
  icon?: string;
  /** Optional human-readable name (defaults to className) */
  name?: string;
  /** Optional description shown in the plan/UI (defaults to a generic line). */
  description?: string;
}

/** Result of a register/unregister operation */
export interface RegisterResult {
  /** Whether the operation succeeded */
  success: boolean;
  /** Human-readable message describing what happened */
  message: string;
  /** Files that were modified */
  modifiedFiles: string[];
  /** The agent type that was operated on */
  agentType: string;
}

// ─── Registration Logic ─────────────────────────────────────────────────────

/**
 * Register a custom agent with the orchestrator.
 *
 * Reads the orchestrator source file, adds the import and switch case,
 * and writes the file back.
 */
export function registerAgent(options: RegisterOptions): RegisterResult {
  const {
    orchestratorPath: inputPath,
    sourceModule,
    className,
    agentType,
    icon = DEFAULT_ICON,
    name = className,
    description = `Custom agent '${name}'`,
  } = options;
  const orchestratorPath = inputPath || resolve(process.cwd(), 'src/agents/orchestrator.ts');

  if (!existsSync(orchestratorPath)) {
    return { success: false, message: `Orchestrator file not found at: ${orchestratorPath}`, modifiedFiles: [], agentType };
  }

  const originalContent = readFileSync(orchestratorPath, 'utf-8');

  // ── 0. Which layout is this? ────────────────────────────────────────
  // The registry layout is detected by the file it edits, not by a version
  // string: a checkout that has `module-registry.ts` with a `createWithBuiltins`
  // body is the current one, and the switch is legacy.
  if (!hasLegacySwitch(originalContent)) {
    const registryPath = resolve(orchestratorPath, '..', 'module-registry.ts');
    if (existsSync(registryPath)) {
      return registerInModuleRegistry({ registryPath, sourceModule, className, agentType, icon, name, description });
    }
    return {
      success: false,
      message:
        `Neither a createAgent() switch in ${orchestratorPath} nor a module-registry.ts beside it — ` +
        `this checkout has no place to register '${agentType}'. Distribute a prebuilt plugin file to ` +
        `~/.nuvira/agents/ instead (see \`nuvira plugins list\`).`,
      modifiedFiles: [],
      agentType,
    };
  }

  // ── 1. Check if already registered ──────────────────────────────────
  if (originalContent.includes(`case '${agentType}':`)) {
    return { success: true, message: `Agent '${agentType}' is already registered. No changes made.`, modifiedFiles: [], agentType };
  }

  // ── 2. Add import statement ─────────────────────────────────────────
  const importStatement = `import { ${className} } from '${sourceModule}';`;
  let newContent = originalContent;

  if (!originalContent.includes(importStatement)) {
    const importLines = newContent.match(/^import .+;$/gm);
    if (importLines && importLines.length > 0) {
      const lastImport = importLines[importLines.length - 1];
      const insertPos = newContent.lastIndexOf(lastImport) + lastImport.length;
      newContent = newContent.slice(0, insertPos) + '\n' + importStatement + newContent.slice(insertPos);
    } else {
      return { success: false, message: 'Could not find import section in orchestrator file.', modifiedFiles: [], agentType };
    }
  }

  // ── 3. Add case to createAgent switch ───────────────────────────────
  const caseBlock = `    case '${agentType}':\n      return new ${className}();`;
  if (!newContent.includes(caseBlock)) {
    const defaultPattern = 'default:\n      return null;';
    const defaultIndex = newContent.lastIndexOf(defaultPattern);
    if (defaultIndex >= 0) {
      newContent = newContent.slice(0, defaultIndex) + caseBlock + '\n\n    ' + newContent.slice(defaultIndex);
    } else {
      return { success: false, message: 'Could not find default case in createAgent switch.', modifiedFiles: [], agentType };
    }
  }

  // ── 4. Add icon to AGENT_ICONS map ─────────────────────────────────
  const iconLine = `  '${agentType}': '${icon}',`;
  if (!newContent.includes(iconLine)) {
    const iconsEndMarker = '};\n\nfunction createAgent';
    const iconsEndIndex = newContent.lastIndexOf(iconsEndMarker);
    if (iconsEndIndex >= 0) {
      newContent = newContent.slice(0, iconsEndIndex) + iconLine + '\n' + newContent.slice(iconsEndIndex);
    }
  }

  // ── 5. Write changes ────────────────────────────────────────────────
  if (newContent === originalContent) {
    return { success: true, message: `No changes needed for agent '${agentType}'. Already fully registered.`, modifiedFiles: [], agentType };
  }

  writeFileSync(orchestratorPath, newContent, 'utf-8');

  const changes: string[] = [];
  if (!originalContent.includes(importStatement)) changes.push('import');
  if (!originalContent.includes(caseBlock)) changes.push('switch case');
  if (!originalContent.includes(iconLine)) changes.push('icon');

  return {
    success: true,
    message: `Registered agent '${agentType}' (${name}) with the orchestrator. Added: ${changes.join(', ') || 'nothing new'}.`,
    modifiedFiles: [orchestratorPath],
    agentType,
  };
}

// ─── Unregistration Logic ───────────────────────────────────────────────────

/**
 * Unregister a custom agent from the orchestrator.
 *
 * Removes the switch case and icon entry. If `className` is provided,
 * also removes the matching import statement using an exact pattern
 * (`import { className } from '...';`) to avoid accidentally removing
 * built-in imports.
 */
export function unregisterAgent(options: {
  orchestratorPath?: string;
  agentType: string;
  /** The exact exported class name. When provided, enables safe import removal. */
  className?: string;
}): RegisterResult {
  const { orchestratorPath: inputPath, agentType, className } = options;
  const orchestratorPath = inputPath || resolve(process.cwd(), 'src/agents/orchestrator.ts');

  if (!existsSync(orchestratorPath)) {
    return { success: false, message: `Orchestrator file not found at: ${orchestratorPath}`, modifiedFiles: [], agentType };
  }

  const originalContent = readFileSync(orchestratorPath, 'utf-8');

  // Registry layout: the registration was written into module-registry.ts, so
  // looking for a switch case here would report a registered agent as missing.
  if (!hasLegacySwitch(originalContent)) {
    const registryPath = resolve(orchestratorPath, '..', 'module-registry.ts');
    if (existsSync(registryPath)) {
      const result = unregisterFromModuleRegistry({
        registryPath,
        agentType,
        ...(className ? { className } : {}),
      });
      if (result) return result;
    }
    return { success: true, message: `Agent '${agentType}' is not registered. No changes needed.`, modifiedFiles: [], agentType };
  }

  if (!originalContent.includes(`case '${agentType}':`)) {
    return { success: true, message: `Agent '${agentType}' is not registered. No changes needed.`, modifiedFiles: [], agentType };
  }

  let newContent = originalContent;
  let changesMade = false;

  // ── Remove the switch case block ──────────────────────────────────
  // Matches the exact pattern added by registerAgent()
  const caseRegex = new RegExp(
    `    case '${escapeRegex(agentType)}':\\n      return new \\w+\\(\\);\\n\\n    `,
    'g',
  );
  const afterCase = newContent.replace(caseRegex, '');
  if (afterCase !== newContent) {
    newContent = afterCase;
    changesMade = true;
  } else {
    // Fallback: try without trailing indent (for last case in switch)
    const fallbackRegex = new RegExp(
      `    case '${escapeRegex(agentType)}':\\n      return new \\w+\\(\\);\\n`,
      'g',
    );
    const afterFallback = newContent.replace(fallbackRegex, '');
    if (afterFallback !== newContent) {
      newContent = afterFallback;
      changesMade = true;
    }
  }

  // ── Remove the icon line ──────────────────────────────────────────
  const iconRegex = new RegExp(`  '${escapeRegex(agentType)}': '.[^']*',\\n`, 'g');
  const afterIcon = newContent.replace(iconRegex, '');
  if (afterIcon !== newContent) {
    newContent = afterIcon;
    changesMade = true;
  }

  // ── Remove the import (only with className for safety) ──────────────
  let importRemoved = false;
  if (className) {
    const importRegex = new RegExp(
      `^import \\{ ${escapeRegex(className)} \\} from '[^']+';\n`,
      'gm',
    );
    const afterImport = newContent.replace(importRegex, '');
    // Collapse duplicate blank lines
    const cleaned = afterImport.replace(/\n{3,}/g, '\n\n');
    if (cleaned !== newContent) {
      newContent = cleaned;
      changesMade = true;
      importRemoved = true;
    }
  }

  if (!changesMade) {
    return {
      success: true,
      message: `Could not auto-remove traces of '${agentType}'. Pass --class-name <Name> for import removal. Manual cleanup in src/agents/orchestrator.ts may be needed.`,
      modifiedFiles: [],
      agentType,
    };
  }

  writeFileSync(orchestratorPath, newContent, 'utf-8');

  const removed = ['switch case', 'icon'];
  if (importRemoved) removed.push('import');

  return {
    success: true,
    message: `Unregistered agent '${agentType}' from the orchestrator. Removed: ${removed.join(', ')}.`,
    modifiedFiles: [orchestratorPath],
    agentType,
  };
}

// ─── ModuleRegistry layout (current) ────────────────────────────────────────

/** Does this orchestrator still carry the legacy `createAgent()` switch? */
function hasLegacySwitch(content: string): boolean {
  return content.includes('default:\n      return null;') && content.includes('function createAgent');
}

/** The exact import a registration adds, so unregister can find it again. */
function importLine(className: string, sourceModule: string): string {
  return `import { ${className} } from '${sourceModule}';`;
}

/** The registry call a registration adds, keyed by agentType. */
function registryBlock(agentType: string, className: string, name: string, description: string, icon: string): string {
  return [
    // No backticks in this comment: it is emitted into another source file, and
    // the removal regex matches it literally.
    `    // Added by nuvira sdk register ${className} ${agentType}`,
    `    registry.registerOrOverride('${agentType}', () => new ${className}(), {`,
    `      name: '${name}',`,
    `      description: '${description.replace(/'/g, "\\'")}',`,
    `      icon: '${icon}',`,
    `      isBuiltin: false,`,
    `    });`,
  ].join('\n');
}

/**
 * Register into `createWithBuiltins()` in module-registry.ts.
 *
 * The insertion point is the method's final `return registry;` — the only stable
 * anchor in that file — and `registerOrOverride` (not `register`) is used so a
 * re-registration cannot make boot throw on a duplicate agent type.
 */
function registerInModuleRegistry(args: {
  registryPath: string;
  sourceModule: string;
  className: string;
  agentType: string;
  icon: string;
  name: string;
  description: string;
}): RegisterResult {
  const { registryPath, sourceModule, className, agentType, icon, name, description } = args;
  const originalContent = readFileSync(registryPath, 'utf-8');

  if (originalContent.includes(`registerOrOverride('${agentType}'`)) {
    return {
      success: true,
      message: `Agent '${agentType}' is already registered in module-registry.ts. No changes made.`,
      modifiedFiles: [],
      agentType,
    };
  }

  const returnMarker = '    return registry;';
  const returnIndex = originalContent.lastIndexOf(returnMarker);
  if (returnIndex < 0) {
    return {
      success: false,
      message: `Could not find the \`return registry;\` insertion point in ${registryPath}.`,
      modifiedFiles: [],
      agentType,
    };
  }

  let newContent = originalContent;
  const added: string[] = [];

  const imp = importLine(className, sourceModule);
  if (!newContent.includes(imp)) {
    const importLines = newContent.match(/^import .+;$/gm);
    if (!importLines || importLines.length === 0) {
      return { success: false, message: 'Could not find the import section in module-registry.ts.', modifiedFiles: [], agentType };
    }
    const lastImport = importLines[importLines.length - 1]!;
    const insertPos = newContent.lastIndexOf(lastImport) + lastImport.length;
    newContent = newContent.slice(0, insertPos) + '\n' + imp + newContent.slice(insertPos);
    added.push('import');
  }

  const block = registryBlock(agentType, className, name, description, icon);
  const blockIndex = newContent.lastIndexOf(returnMarker);
  newContent = newContent.slice(0, blockIndex) + block + '\n\n' + newContent.slice(blockIndex);
  added.push('registry call');

  writeFileSync(registryPath, newContent, 'utf-8');
  return {
    success: true,
    message: `Registered agent '${agentType}' (${name}) in module-registry.ts. Added: ${added.join(', ')}.`,
    modifiedFiles: [registryPath],
    agentType,
  };
}

/** Remove a `sdk register` block from module-registry.ts. */
function unregisterFromModuleRegistry(args: {
  registryPath: string;
  agentType: string;
  className?: string;
}): RegisterResult | null {
  const { registryPath, agentType, className } = args;
  const originalContent = readFileSync(registryPath, 'utf-8');
  if (!originalContent.includes(`registerOrOverride('${agentType}'`)) return null;

  // The comment line makes the block unambiguous, so removal cannot take a
  // neighbouring registration with it.
  const blockRegex = new RegExp(
    '    // Added by nuvira sdk register [^\\n]*\\n' +
      "    registry\\.registerOrOverride\\('" +
      escapeRegex(agentType) +
      "'[\\s\\S]*?\\n    \\}\\);\\n\\n?",
    'g',
  );
  let newContent = originalContent.replace(blockRegex, '');
  const removedBlock = newContent !== originalContent;

  let importRemoved = false;
  if (className) {
    const importRegex = new RegExp(`^import \\{ ${escapeRegex(className)} \\} from '[^']+';\\n`, 'gm');
    const afterImport = newContent.replace(importRegex, '').replace(/\n{3,}/g, '\n\n');
    if (afterImport !== newContent) {
      newContent = afterImport;
      importRemoved = true;
    }
  }

  if (!removedBlock && !importRemoved) return null;
  writeFileSync(registryPath, newContent, 'utf-8');

  const removed = [...(removedBlock ? ['registry call'] : []), ...(importRemoved ? ['import'] : [])];
  return {
    success: true,
    message: `Unregistered agent '${agentType}' from module-registry.ts. Removed: ${removed.join(', ')}.`,
    modifiedFiles: [registryPath],
    agentType,
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Escape special regex characters in a string */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
