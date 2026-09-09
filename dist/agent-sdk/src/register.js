/**
 * @agent-nuvira/sdk/register — Register a custom agent with the orchestrator.
 *
 * Modifies `src/agents/orchestrator.ts` to:
 * 1. Add an import statement for the custom agent class
 * 2. Add a `case` to the `createAgent()` switch statement
 * 3. Add an icon to the `AGENT_ICONS` map
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
// ─── Registration Logic ─────────────────────────────────────────────────────
/**
 * Register a custom agent with the orchestrator.
 *
 * Reads the orchestrator source file, adds the import and switch case,
 * and writes the file back.
 */
export function registerAgent(options) {
    const { orchestratorPath: inputPath, sourceModule, className, agentType, icon = DEFAULT_ICON, name = className } = options;
    const orchestratorPath = inputPath || resolve(process.cwd(), 'src/agents/orchestrator.ts');
    if (!existsSync(orchestratorPath)) {
        return { success: false, message: `Orchestrator file not found at: ${orchestratorPath}`, modifiedFiles: [], agentType };
    }
    const originalContent = readFileSync(orchestratorPath, 'utf-8');
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
        }
        else {
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
        }
        else {
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
    const changes = [];
    if (!originalContent.includes(importStatement))
        changes.push('import');
    if (!originalContent.includes(caseBlock))
        changes.push('switch case');
    if (!originalContent.includes(iconLine))
        changes.push('icon');
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
export function unregisterAgent(options) {
    const { orchestratorPath: inputPath, agentType, className } = options;
    const orchestratorPath = inputPath || resolve(process.cwd(), 'src/agents/orchestrator.ts');
    if (!existsSync(orchestratorPath)) {
        return { success: false, message: `Orchestrator file not found at: ${orchestratorPath}`, modifiedFiles: [], agentType };
    }
    const originalContent = readFileSync(orchestratorPath, 'utf-8');
    if (!originalContent.includes(`case '${agentType}':`)) {
        return { success: true, message: `Agent '${agentType}' is not registered. No changes needed.`, modifiedFiles: [], agentType };
    }
    let newContent = originalContent;
    let changesMade = false;
    // ── Remove the switch case block ──────────────────────────────────
    // Matches the exact pattern added by registerAgent()
    const caseRegex = new RegExp(`    case '${escapeRegex(agentType)}':\\n      return new \\w+\\(\\);\\n\\n    `, 'g');
    const afterCase = newContent.replace(caseRegex, '');
    if (afterCase !== newContent) {
        newContent = afterCase;
        changesMade = true;
    }
    else {
        // Fallback: try without trailing indent (for last case in switch)
        const fallbackRegex = new RegExp(`    case '${escapeRegex(agentType)}':\\n      return new \\w+\\(\\);\\n`, 'g');
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
        const importRegex = new RegExp(`^import \\{ ${escapeRegex(className)} \\} from '[^']+';\n`, 'gm');
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
    if (importRemoved)
        removed.push('import');
    return {
        success: true,
        message: `Unregistered agent '${agentType}' from the orchestrator. Removed: ${removed.join(', ')}.`,
        modifiedFiles: [orchestratorPath],
        agentType,
    };
}
// ─── Helpers ────────────────────────────────────────────────────────────────
/** Escape special regex characters in a string */
function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
//# sourceMappingURL=register.js.map