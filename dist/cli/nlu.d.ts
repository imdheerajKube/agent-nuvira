/**
 * C3 — `nuvira nlu debug "<query>"`.
 *
 * Explainability surface for the NLU layer: shows the deterministic rule path
 * (intent, confidence, mode, action, entities, temporal refs, router
 * task-intent, menu-unreachable gate) and — with `--llm` when the rule path is
 * below the trust threshold — the LLM verify path (mirrors runDeveloperMode's
 * cheap-model resolution so the verify call uses a real, working model).
 */
import { Command } from 'commander';
import { BaseCommand } from './commands.js';
export declare class NluCommand extends BaseCommand {
    create(): Command;
    private execute;
}
//# sourceMappingURL=nlu.d.ts.map