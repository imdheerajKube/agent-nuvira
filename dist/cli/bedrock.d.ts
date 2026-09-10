/**
 * Bedrock command — Dedicated AWS Bedrock onboarding and management.
 *
 * Usage:
 *   nuvira bedrock setup    — Interactive wizard to configure Bedrock credentials + region + model access
 *   nuvira bedrock status   — Show current Bedrock configuration and connectivity
 *   nuvira bedrock test     — Probe models and test inference
 *
 * Bedrock is different from other providers because it requires:
 *   1. AWS credentials (Bearer token or IAM access key + secret key)
 *   2. A specific AWS region (models vary by region)
 *   3. Model access to be explicitly requested/approved in the AWS Console
 *
 * This command guides the user through all three steps.
 */
import { Command } from 'commander';
import { BaseCommand } from './commands.js';
export declare class BedrockCommand extends BaseCommand {
    create(): Command;
    private createSetupCommand;
    private runSetup;
    private createStatusCommand;
    private showStatus;
    private createTestCommand;
    private testBedrock;
}
//# sourceMappingURL=bedrock.d.ts.map