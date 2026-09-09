import { Agent } from './agent';
import * as fs from 'fs';
import * as path from 'path';
/**
 * NVDAAddonAgent — An agent that creates an NVDA addon plugin.
 *
 * This agent takes the user's goal and working directory as input, and produces
 * an NVDA addon plugin as output.
 */
export class NVDAAddonAgent extends Agent {
    name = 'NVDA Addon';
    description = 'Creates an NVDA addon plugin';
    async execute(context, callLLM) {
        const goal = context.goal;
        const workingDirectory = context.workingDirectory;
        // Create the NVDA addon plugin
        const pluginContent = await createNVDAAddonPlugin(goal, workingDirectory, callLLM);
        // Add the plugin to the context
        context.artifacts.push({
            path: 'nvda-addon.py',
            content: pluginContent,
            description: 'NVDA addon plugin',
        });
        // Count the number of files in the identified NVDA addon plugin
        const pluginDirectory = path.join(workingDirectory, 'nvda-addon');
        let fileCount = 0;
        if (fs.existsSync(pluginDirectory)) {
            const files = await fs.promises.readdir(pluginDirectory);
            fileCount = files.length;
        }
        return {
            success: true,
            summary: `NVDA addon plugin created successfully with ${fileCount} files`,
            details: `The plugin has been added to the context and contains ${fileCount} files`,
        };
    }
}
/**
 * Creates an NVDA addon plugin based on the user's goal and working directory.
 *
 * @param goal The user's goal
 * @param workingDirectory The working directory
 * @param callLLM The LLM call function
 * @returns The NVDA addon plugin content
 */
async function createNVDAAddonPlugin(goal, workingDirectory, callLLM) {
    // Use the LLM to generate the plugin content
    const prompt = `Create an NVDA addon plugin for ${goal} in ${workingDirectory}`;
    const response = await callLLM(prompt);
    return response;
}
//# sourceMappingURL=nvda-addon.js.map