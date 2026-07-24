import { Agent, AgentContext, AgentResult } from './agent';
import { LLMCallFn } from './agent';
/**
 * NVDAAddonAgent — An agent that creates an NVDA addon plugin.
 *
 * This agent takes the user's goal and working directory as input, and produces
 * an NVDA addon plugin as output.
 */
export declare class NVDAAddonAgent extends Agent {
    readonly name = "NVDA Addon";
    readonly description = "Creates an NVDA addon plugin";
    execute(context: AgentContext, callLLM: LLMCallFn): Promise<AgentResult>;
}
//# sourceMappingURL=nvda-addon.d.ts.map