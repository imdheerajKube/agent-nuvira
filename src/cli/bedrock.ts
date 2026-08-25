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
import inquirer from 'inquirer';
import { BaseCommand, getCliName } from './commands.js';
import { logger } from '../utils/logger.js';

/** Well-known Bedrock regions where models are widely available. */
const BEDROCK_REGIONS = [
  { value: 'us-east-1', name: 'us-east-1 (N. Virginia) — most models available' },
  { value: 'us-west-2', name: 'us-west-2 (Oregon) — most models available' },
  { value: 'eu-west-1', name: 'eu-west-1 (Ireland) — good EU coverage' },
  { value: 'ap-southeast-1', name: 'ap-southeast-1 (Singapore) — Asia-Pacific' },
  { value: 'ap-northeast-1', name: 'ap-northeast-1 (Tokyo) — Japan/Asia' },
];

/** Well-known Bedrock model IDs grouped by provider. */
const MODEL_FAMILIES = [
  {
    name: 'Anthropic Claude',
    checked: true,
    models: [
      'anthropic.claude-haiku-4-5-20251001-v1:0',
      'anthropic.claude-sonnet-4-6',
      'anthropic.claude-fable-5',
      'anthropic.claude-opus-4-6-v1',
    ],
  },
  {
    name: 'Meta Llama',
    checked: true,
    models: [
      'meta.llama3-1-8b-instruct-v1:0',
      'meta.llama3-3-70b-instruct-v1:0',
      'meta.llama4-scout-17b-instruct-v1:0',
      'meta.llama4-maverick-17b-instruct-v1:0',
    ],
  },
  {
    name: 'Mistral AI',
    checked: false,
    models: [
      'mistral.mistral-large-3-675b-instruct',
      'mistral.devstral-2-123b',
      'mistral.ministral-3-14b-instruct',
    ],
  },
  {
    name: 'DeepSeek',
    checked: false,
    models: ['deepseek.v3.2', 'deepseek.r1-v1:0'],
  },
  {
    name: 'Amazon Nova',
    checked: false,
    models: ['amazon.nova-pro-v1:0', 'amazon.nova-lite-v1:0'],
  },
  {
    name: 'OpenAI on Bedrock',
    checked: false,
    models: ['openai.gpt-5.6-terra', 'openai.gpt-oss-120b-1:0'],
  },
  {
    name: 'Qwen',
    checked: false,
    models: ['qwen.qwen3-coder-next', 'qwen.qwen3-32b-v1:0'],
  },
  {
    name: 'Google Gemma',
    checked: false,
    models: ['google.gemma-3-12b-it'],
  },
  {
    name: 'xAI',
    checked: false,
    models: ['xai.grok-4.6'],
  },
];

export class BedrockCommand extends BaseCommand {
  create(): Command {
    const command = new Command('bedrock')
      .description('AWS Bedrock setup and management (dedicated onboarding for Bedrock)')
      .addCommand(this.createSetupCommand())
      .addCommand(this.createStatusCommand())
      .addCommand(this.createTestCommand());

    return command;
  }

  // ── nuvira bedrock setup ────────────────────────────────────────────────────
  private createSetupCommand(): Command {
    return new Command('setup')
      .description('Interactive wizard to configure AWS Bedrock (credentials, region, model access)')
      .action(async () => {
        await this.runSetup();
      });
  }

  private async runSetup(): Promise<void> {
    logger.highlight('\n🟠 AWS Bedrock Setup Wizard\n');
    logger.info('Bedrock requires 3 things that other providers don\'t:\n');
    console.log('  1. AWS credentials (API key or IAM access key + secret key)');
    console.log('  2. A region where Bedrock is available (models vary by region)');
    console.log('  3. Model access approved in the AWS Console\n');

    // ── Step 1: Credentials ───────────────────────────────────────────
    logger.highlight('Step 1: AWS Credentials\n');
    const currentKey = process.env.AWS_BEARER_TOKEN || '';
    console.log(`  Current API key: ${currentKey ? `${currentKey.slice(0, 8)}…${currentKey.slice(-4)}` : '(not set)'}\n`);

    const { authMethod } = await inquirer.prompt([{
      type: 'list',
      name: 'authMethod',
      message: 'How do you want to authenticate with Bedrock?',
      choices: [
        { value: 'bearer', name: 'Bedrock API key (Bearer token) — simplest, from Bedrock → Settings → API keys' },
        { value: 'iam', name: 'IAM credentials (AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY) — full AWS SDK auth' },
        { value: 'skip', name: 'Skip — I\'ll configure credentials later' },
      ],
    }]);

    const envUpdates: Record<string, string> = {};

    if (authMethod === 'bearer') {
      console.log('');
      console.log('  To get a Bedrock API key:');
      console.log('  1. Open https://console.aws.amazon.com/bedrock/');
      console.log('  2. Go to Settings → API keys');
      console.log('  3. Create a new key\n');

      const { apiKey } = await inquirer.prompt([{
        type: 'password',
        name: 'apiKey',
        message: 'Paste your Bedrock API key:',
        mask: '•',
        validate: (input: string) => {
          if (!input) return 'API key is required';
          if (input.length < 10) return 'API key seems too short — check your key';
          return true;
        },
      }]);
      envUpdates.AWS_BEARER_TOKEN = apiKey;

    } else if (authMethod === 'iam') {
      console.log('');
      console.log('  IAM credentials are typically set via:');
      console.log('  export AWS_ACCESS_KEY_ID=AKIA...');
      console.log('  export AWS_SECRET_ACCESS_KEY=...');
      console.log('  export AWS_SESSION_TOKEN=... (if using temporary credentials)\n');

      const { accessKey, secretKey, sessionToken } = await inquirer.prompt([
        {
          type: 'input',
          name: 'accessKey',
          message: 'AWS_ACCESS_KEY_ID:',
          validate: (input: string) => input.startsWith('AKIA') ? true : 'Access key should start with AKIA',
        },
        {
          type: 'password',
          name: 'secretKey',
          message: 'AWS_SECRET_ACCESS_KEY:',
          mask: '•',
          validate: (input: string) => input.length >= 20 ? true : 'Secret key seems too short',
        },
        {
          type: 'input',
          name: 'sessionToken',
          message: 'AWS_SESSION_TOKEN (optional, press Enter to skip):',
          default: '',
        },
      ]);
      envUpdates.AWS_ACCESS_KEY_ID = accessKey;
      envUpdates.AWS_SECRET_ACCESS_KEY = secretKey;
      if (sessionToken) {
        envUpdates.AWS_SESSION_TOKEN = sessionToken;
      }
    }

    // ── Step 2: Region ────────────────────────────────────────────────
    logger.highlight('\nStep 2: AWS Region\n');
    console.log('  Models vary by region. us-east-1 and us-west-2 have the most models.\n');
    console.log('  ⚠️  Do NOT use eu-north-1 unless models are explicitly enabled there.\n');

    const currentRegion = process.env.BEDROCK_REGION || 'us-east-1';
    const { region } = await inquirer.prompt([{
      type: 'list',
      name: 'region',
      message: 'Which AWS region do you want to use?',
      choices: BEDROCK_REGIONS,
      default: BEDROCK_REGIONS.find(r => r.value === currentRegion)?.value || 'us-east-1',
    }]);
    envUpdates.BEDROCK_REGION = region;

    // ── Step 3: Model Access ──────────────────────────────────────────
    logger.highlight('\nStep 3: Model Access\n');
    console.log('  Bedrock requires you to request access for each model family.\n');
    console.log(`  → Open https://console.aws.amazon.com/bedrock/home?region=${region}#/modelaccess`);
    console.log('  → Click "Manage model access"');
    console.log('  → Select the model families you want below\n');

    const { selectedFamilies } = await inquirer.prompt([{
      type: 'checkbox',
      name: 'selectedFamilies',
      message: 'Which model families do you want to enable? (select all that apply)',
      choices: MODEL_FAMILIES.map(f => ({
        value: f.name,
        name: `${f.name} — ${f.models.length} model(s)${f.checked ? ' (recommended)' : ''}`,
        checked: f.checked,
      })),
    }]);

    if (selectedFamilies.length > 0) {
      console.log('\n  Models to request access for:');
      for (const family of MODEL_FAMILIES.filter(f => selectedFamilies.includes(f.name))) {
        for (const model of family.models) {
          console.log(`    • ${model}`);
        }
      }
    }

    console.log(`\n  After submitting in the console, approval is usually instant for Anthropic and Meta models.`);

    // ── Step 4: Save ──────────────────────────────────────────────────
    logger.highlight('\nStep 4: Save Configuration\n');

    const { confirm } = await inquirer.prompt([{
      type: 'confirm',
      name: 'confirm',
      message: 'Save this configuration to ~/.nuvira/.env?',
      default: true,
    }]);

    if (confirm) {
      const { writeEnvFile, applyEnvToProcess } = await import('../gateway/platform-config.js');
      const { wrote } = writeEnvFile(envUpdates);
      applyEnvToProcess(envUpdates);
      console.log(`\n  ✅ Saved ${wrote.length} env var(s) to ~/.nuvira/.env:`);
      for (const key of wrote) {
        const val = envUpdates[key];
        const display = key.includes('SECRET') || key.includes('KEY') || key.includes('TOKEN')
          ? `${val.slice(0, 8)}…${val.slice(-4)}`
          : val;
        console.log(`     ${key}=${display}`);
      }

      // ── Step 5: Verify connectivity ──────────────────────────────
      logger.highlight('\nStep 5: Verify Connectivity\n');
      await this.testBedrock(region);
    } else {
      console.log('\n  Configuration not saved. You can set env vars manually:');
      for (const [key, value] of Object.entries(envUpdates)) {
        console.log(`    export ${key}=${value}`);
      }
    }

    // ── Summary ───────────────────────────────────────────────────────
    logger.highlight('\n📋 Next Steps\n');
    console.log('  1. If you haven\'t already, request model access in the AWS Console:');
    console.log(`     https://console.aws.amazon.com/bedrock/home?region=${region}#/modelaccess`);
    console.log('  2. Run `${getCliName()} bedrock status` to check connectivity');
    console.log('  3. Run `${getCliName()} bedrock test` to probe and test models');
    console.log('  4. Bedrock models will now appear in the dashboard Models panel\n');
  }

  // ── nuvira bedrock status ───────────────────────────────────────────────────
  private createStatusCommand(): Command {
    return new Command('status')
      .description('Show current Bedrock configuration and connectivity status')
      .action(async () => {
        await this.showStatus();
      });
  }

  private async showStatus(): Promise<void> {
    logger.highlight('\n🟠 AWS Bedrock Status\n');

    const region = process.env.BEDROCK_REGION || 'us-east-1';
    const apiKey = process.env.AWS_BEARER_TOKEN;
    const accessKey = process.env.AWS_ACCESS_KEY_ID;

    console.log('  Configuration:');
    console.log(`    Region:        ${region}`);
    console.log(`    Auth method:   ${apiKey ? 'Bearer token (API key)' : accessKey ? 'IAM credentials' : '❌ Not configured'}`);
    console.log(`    API key:       ${apiKey ? `${apiKey.slice(0, 8)}…${apiKey.slice(-4)}` : '(not set)'}`);
    console.log(`    IAM key:       ${accessKey ? `${accessKey.slice(0, 8)}…${accessKey.slice(-4)}` : '(not set)'}`);
    console.log(`    Control plane: https://bedrock.${region}.amazonaws.com`);
    console.log(`    Runtime:       https://bedrock-runtime.${region}.amazonaws.com`);

    if (!apiKey && !accessKey) {
      console.log('\n  ❌ No credentials configured. Run `${getCliName()} bedrock setup` to get started.\n');
      return;
    }

    // Test connectivity
    await this.testBedrock(region);
  }

  // ── nuvira bedrock test ─────────────────────────────────────────────────────
  private createTestCommand(): Command {
    return new Command('test')
      .description('Probe Bedrock models and test inference')
      .option('-r, --region <region>', 'Override the AWS region')
      .action(async (options?: { region?: string }) => {
        const region = options?.region || process.env.BEDROCK_REGION || 'us-east-1';
        await this.testBedrock(region);
      });
  }

  private async testBedrock(region: string): Promise<void> {
    const apiKey = process.env.AWS_BEARER_TOKEN;
    const accessKey = process.env.AWS_ACCESS_KEY_ID;

    if (!apiKey && !accessKey) {
      logger.error('No Bedrock credentials configured. Run `${getCliName()} bedrock setup` first.');
      return;
    }

    const runtimeBase = `https://bedrock-runtime.${region}.amazonaws.com`;
    const controlBase = `https://bedrock.${region}.amazonaws.com`;

    console.log(`  Testing Bedrock in ${region}…\n`);

    // Probe well-known models
    const probeModels = [
      'anthropic.claude-haiku-4-5-20251001-v1:0',
      'anthropic.claude-sonnet-4-6',
      'meta.llama3-1-8b-instruct-v1:0',
      'meta.llama3-3-70b-instruct-v1:0',
      'meta.llama4-scout-17b-instruct-v1:0',
      'deepseek.v3.2',
      'mistral.mistral-large-3-675b-instruct',
      'amazon.nova-pro-v1:0',
      'openai.gpt-5.6-terra',
      'qwen.qwen3-coder-next',
      'xai.grok-4.6',
      'google.gemma-3-12b-it',
    ];

    const authHeader = apiKey ? `Bearer ${apiKey}` : ''; // IAM would need SigV4 here
    const accessible: string[] = [];
    const permissionDenied: string[] = [];

    for (const modelId of probeModels) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);
        const res = await fetch(`${runtimeBase}/openai/v1/chat/completions`, {
          method: 'POST',
          headers: {
            'Authorization': authHeader,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ model: modelId, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 }),
          signal: controller.signal,
        });
        clearTimeout(timeout);

        if (res.ok) {
          console.log(`  ✅ ${modelId}`);
          accessible.push(modelId);
        } else if (res.status === 403) {
          console.log(`  🔒 ${modelId} — access not approved (403)`);
          permissionDenied.push(modelId);
        } else if (res.status === 404) {
          console.log(`  ⚫ ${modelId} — not available in ${region}`);
        } else {
          console.log(`  ❌ ${modelId} — HTTP ${res.status}`);
        }
      } catch {
        console.log(`  ❌ ${modelId} — connection failed`);
      }
    }

    // Summary
    console.log(`\n  Results: ${accessible.length} accessible, ${permissionDenied.length} need approval`);
    console.log(`  Region: ${region}\n`);

    if (accessible.length > 0) {
      // Test inference with first accessible model
      const testModel = accessible[0];
      console.log(`  Testing inference with ${testModel}…`);
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000);
        const res = await fetch(`${runtimeBase}/openai/v1/chat/completions`, {
          method: 'POST',
          headers: {
            'Authorization': authHeader,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: testModel,
            messages: [{ role: 'user', content: 'Say "Bedrock works!" in exactly 3 words.' }],
            max_tokens: 20,
          }),
          signal: controller.signal,
        });
        clearTimeout(timeout);

        if (res.ok) {
          const data = await res.json() as any;
          const response = data?.choices?.[0]?.message?.content || '(empty)';
          console.log(`  ✅ Inference OK: "${response.trim()}"\n`);
        } else {
          console.log(`  ❌ Inference failed: HTTP ${res.status}\n`);
        }
      } catch {
        console.log('  ❌ Inference test failed — connection error\n');
      }
    } else if (permissionDenied.length > 0) {
      console.log('  👉 Request model access in the AWS Console:');
      console.log(`     https://console.aws.amazon.com/bedrock/home?region=${region}#/modelaccess`);
      console.log('     → Click "Manage model access" → Select models → Submit\n');
    } else {
      console.log('  ⚠️  No models accessible. Possible causes:');
      console.log(`     • Region ${region} may not have Bedrock models enabled`);
      console.log('     • API key may be invalid');
      console.log('     • Try: nuvira bedrock setup\n');
    }
  }
}
