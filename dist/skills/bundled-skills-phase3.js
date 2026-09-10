/**
 * Bundled Skills Phase 3 — 55 additional first-party skills.
 *
 * Categories covered (from Hermes gap analysis):
 * - AI/ML: autonomous-agents, mlops, prompt-engineering, rag-pipeline, fine-tuning
 * - Blockchain: solidity, web3-dapp, nft-mint
 * - Communication: discord-bot, slack-integration, teams-webhook
 * - Creative: logo-design, video-edit, podcast-production
 * - Data Science: data-visualization, feature-engineering, time-series
 * - DevOps: infrastructure-as-code, service-mesh, chaos-engineering
 * - Email: transactional-email, newsletter
 * - Finance: payment-gateway, accounting-integration
 * - Health: health-data, fitness-api
 * - MCP: mcp-server, mcp-client, mcp-connector
 * - Migration: data-migration, cloud-migration
 * - Productivity: knowledge-base, decision-framework
 * - Research: osint-investigation, academic-research
 * - Security: penetration-test, compliance-check, secrets-scan
 * - Software Dev: code-review, dependency-audit, monorepo-setup
 * - Web Dev: ssr-setup, pwa-builder, micro-frontend
 * - Windows: powershell-automation, wsl-setup, registry-management, group-policy
 * - Platform: cross-platform-build, electron-app, mobile-bridge
 */
const PHASE3_CREATED_AT = 1_756_000_000_000;
// ─── AI / ML ───────────────────────────────────────────────────────────────
export const BUNDLED_SKILL_ID_AUTONOMOUS_AGENTS = 'skill-autonomous-agents';
export const BUNDLED_SKILL_ID_MLOPS = 'skill-mlops';
export const BUNDLED_SKILL_ID_PROMPT_ENGINEERING = 'skill-prompt-engineering';
export const BUNDLED_SKILL_ID_RAG_PIPELINE = 'skill-rag-pipeline';
export const BUNDLED_SKILL_ID_FINE_TUNING = 'skill-fine-tuning';
export const autonomousAgentsSkill = {
    id: BUNDLED_SKILL_ID_AUTONOMOUS_AGENTS,
    name: 'autonomous-agents',
    description: 'Design, build, and deploy autonomous AI agents with tool use, memory, planning loops, and self-correction. Use when the goal is to create an agent that can reason, act, and iterate without constant human oversight.',
    version: '1.0.0',
    goalPattern: 'autonomous agent AI agent tool use memory planning loop self-correction agent framework',
    steps: [
        {
            agentType: 'context-gatherer',
            description: 'Map the agent requirements: what tools does the agent need? What memory stores (short-term, long-term)? What planning strategy (ReAct, Plan-and-Execute, Tree of Thoughts)? What guardrails (approval gates, budget limits, time limits)? What orchestration (single agent vs multi-agent)?',
            dependsOn: [],
        },
        {
            agentType: 'planner',
            description: 'Design the agent architecture:\n1. Choose the loop pattern: ReAct (reason→act→observe) for simple tasks, Plan-and-Execute for complex multi-step tasks\n2. Define the tool interface: each tool needs a name, description, input schema, and execution function\n3. Design memory: working memory (current context), episodic memory (past interactions), semantic memory (knowledge base)\n4. Define guardrails: max iterations, budget caps, approval for destructive actions, output validation\n5. Plan the observability: trace logging, decision recording, error reporting',
            dependsOn: ['step-0'],
        },
        {
            agentType: 'runner',
            description: 'Implement the agent core:\n1. Agent loop: while not done → observe → think → act → observe result\n2. Tool registry: register tools with schemas, validate inputs, handle errors\n3. Memory manager: store and retrieve context, compress long histories\n4. Planner: decompose goals into steps, re-plan on failure\n5. Guardrails: check before each action, block disallowed operations\n6. Start with a minimal agent (2-3 tools) and expand incrementally',
            dependsOn: ['step-1'],
        },
        {
            agentType: 'reviewer',
            description: 'Verify the agent works end-to-end: run it on 3 progressively complex tasks, verify it reasons correctly, uses tools appropriately, recovers from errors, and respects guardrails. Log the full trace for review.',
            dependsOn: ['step-2'],
        },
    ],
    parameters: [],
    tags: ['ai', 'agents', 'autonomous', 'planning', 'tool-use'],
    sourceTrajectoryIds: ['bundled'],
    qualityScore: 0.85,
    usageCount: 0,
    createdAt: PHASE3_CREATED_AT,
    lastUsedAt: PHASE3_CREATED_AT,
};
export const mlopsSkill = {
    id: BUNDLED_SKILL_ID_MLOPS,
    name: 'mlops',
    description: 'Set up ML operations: model training pipelines, experiment tracking, model registry, deployment, monitoring, and drift detection. Use when the goal is to operationalize ML models for production.',
    version: '1.0.0',
    goalPattern: 'mlops machine learning operations model training deployment experiment tracking registry drift monitoring pipeline',
    steps: [
        {
            agentType: 'context-gatherer',
            description: 'Map the ML landscape: what models are being trained? What framework (PyTorch, TensorFlow, scikit-learn)? What data sources? What compute resources (GPU, TPU, CPU)? What deployment target (API, edge, batch)?',
            dependsOn: [],
        },
        {
            agentType: 'planner',
            description: 'Design the MLOps pipeline:\n1. Experiment tracking: MLflow or Weights & Biases for logging params, metrics, artifacts\n2. Model registry: version models, track lineage, promote to production\n3. Training pipeline: data validation → preprocessing → training → evaluation → registration\n4. Deployment: model serving (TF Serving, TorchServe, Triton) or serverless (Lambda, Cloud Functions)\n5. Monitoring: prediction latency, error rates, data drift, concept drift\n6. CI/CD: automated retraining on schedule or data change',
            dependsOn: ['step-0'],
        },
        {
            agentType: 'runner',
            description: 'Implement the pipeline:\n1. Set up experiment tracking (MLflow server or cloud)\n2. Create training script with metric logging\n3. Build data validation (Great Expectations or custom)\n4. Create model serving endpoint\n5. Add monitoring dashboard\n6. Set up automated retraining trigger',
            dependsOn: ['step-1'],
        },
        {
            agentType: 'reviewer',
            description: 'Verify the pipeline: train a model end-to-end, log to registry, deploy, serve predictions, check monitoring dashboards, trigger retraining. Verify the full loop works.',
            dependsOn: ['step-2'],
        },
    ],
    parameters: [],
    tags: ['ml', 'mlops', 'training', 'deployment', 'monitoring'],
    sourceTrajectoryIds: ['bundled'],
    qualityScore: 0.85,
    usageCount: 0,
    createdAt: PHASE3_CREATED_AT,
    lastUsedAt: PHASE3_CREATED_AT,
};
export const promptEngineeringSkill = {
    id: BUNDLED_SKILL_ID_PROMPT_ENGINEERING,
    name: 'prompt-engineering',
    description: 'Design, test, and optimize prompts for LLMs. Covers chain-of-thought, few-shot, system prompts, prompt chaining, evals, and A/B testing. Use when the goal is to improve LLM output quality or build prompt-driven features.',
    version: '1.0.0',
    goalPattern: 'prompt engineering chain-of-thought few-shot system prompt optimization eval A/B testing LLM prompt design',
    steps: [
        {
            agentType: 'context-gatherer',
            description: 'Understand the task: what LLM is being used? What is the desired output format? What are the failure modes of the current prompt? What constraints exist (latency, cost, token limits)?',
            dependsOn: [],
        },
        {
            agentType: 'planner',
            description: 'Design the prompt strategy:\n1. Choose technique: zero-shot, few-shot, chain-of-thought, ReAct, tree-of-thoughts\n2. Structure: system prompt → context → instructions → examples → output format\n3. Add guardrails: "if not sure, say I don\'t know", format validation, output schemas\n4. Plan evaluation: define metrics (accuracy, relevance, format compliance, hallucination rate)\n5. Plan iteration: A/B test variants, track prompt versions',
            dependsOn: ['step-0'],
        },
        {
            agentType: 'runner',
            description: 'Implement and test:\n1. Write the initial prompt with clear instructions\n2. Add few-shot examples for consistency\n3. Test with 10-20 diverse inputs\n4. Measure output quality against criteria\n5. Iterate: identify failure patterns, adjust prompt, re-test\n6. Version the prompt and log results',
            dependsOn: ['step-1'],
        },
        {
            agentType: 'reviewer',
            description: 'Evaluate the final prompt: run against the full test set, report accuracy/quality metrics, document edge cases, and provide the optimized prompt with version history.',
            dependsOn: ['step-2'],
        },
    ],
    parameters: [],
    tags: ['prompt', 'llm', 'ai', 'optimization', 'evals'],
    sourceTrajectoryIds: ['bundled'],
    qualityScore: 0.85,
    usageCount: 0,
    createdAt: PHASE3_CREATED_AT,
    lastUsedAt: PHASE3_CREATED_AT,
};
export const ragPipelineSkill = {
    id: BUNDLED_SKILL_ID_RAG_PIPELINE,
    name: 'rag-pipeline',
    description: 'Build a Retrieval-Augmented Generation pipeline: document ingestion, chunking, embedding, vector storage, retrieval, and LLM answer generation. Use when the goal is to let an LLM answer questions from a custom knowledge base.',
    version: '1.0.0',
    goalPattern: 'RAG retrieval augmented generation vector embedding knowledge base document ingestion chunking retrieval LLM context',
    steps: [
        {
            agentType: 'context-gatherer',
            description: 'Map the data: what document formats (PDF, Markdown, HTML)? How many documents? What embedding model? What vector store (Pinecone, Weaviate, ChromaDB, pgvector)? What LLM for generation?',
            dependsOn: [],
        },
        {
            agentType: 'planner',
            description: 'Design the RAG pipeline:\n1. Ingestion: parse documents, extract text, handle images/tables\n2. Chunking: choose strategy (fixed-size, semantic, recursive) with overlap\n3. Embedding: select model (OpenAI ada-002, Cohere, sentence-transformers)\n4. Vector store: index embeddings with metadata\n5. Retrieval: semantic search + hybrid (keyword + vector) + re-ranking\n6. Generation: inject retrieved context into LLM prompt, cite sources\n7. Evaluation: measure retrieval precision, answer accuracy, hallucination rate',
            dependsOn: ['step-0'],
        },
        {
            agentType: 'runner',
            description: 'Implement the pipeline:\n1. Build document parser (handle PDF, MD, HTML)\n2. Implement chunking with configurable size/overlap\n3. Generate embeddings and store in vector DB\n4. Implement retrieval with similarity threshold\n5. Build generation prompt with retrieved context\n6. Add source citation and confidence scoring',
            dependsOn: ['step-1'],
        },
        {
            agentType: 'reviewer',
            description: 'Evaluate: test with 20 queries, measure retrieval relevance (precision@5), answer accuracy, hallucination rate. Report results and optimize chunking/retrieval parameters.',
            dependsOn: ['step-2'],
        },
    ],
    parameters: [],
    tags: ['rag', 'vector', 'embedding', 'llm', 'knowledge-base'],
    sourceTrajectoryIds: ['bundled'],
    qualityScore: 0.85,
    usageCount: 0,
    createdAt: PHASE3_CREATED_AT,
    lastUsedAt: PHASE3_CREATED_AT,
};
export const fineTuningSkill = {
    id: BUNDLED_SKILL_ID_FINE_TUNING,
    name: 'fine-tuning',
    description: 'Fine-tune LLMs: data preparation, training config, training loop, evaluation, and deployment. Use when the goal is to customize a base model for a specific task or domain.',
    version: '1.0.0',
    goalPattern: 'fine-tuning fine-tune LLM model training dataset custom model domain adaptation LoRA QLoRA',
    steps: [
        {
            agentType: 'context-gatherer',
            description: 'Map the requirements: what base model? What task (classification, generation, instruction-following)? How much training data? What compute budget? What evaluation metrics?',
            dependsOn: [],
        },
        {
            agentType: 'planner',
            description: 'Design the fine-tuning approach:\n1. Data prep: collect, clean, format (instruction/input/output triples)\n2. Training method: full fine-tune vs LoRA vs QLoRA (based on compute budget)\n3. Hyperparameters: learning rate, batch size, epochs, warmup, weight decay\n4. Evaluation: hold-out set, task-specific metrics, human evaluation\n5. Deployment: merge LoRA weights, export to serving format, deploy',
            dependsOn: ['step-0'],
        },
        {
            agentType: 'runner',
            description: 'Execute the fine-tuning:\n1. Prepare dataset in the required format (JSONL for most frameworks)\n2. Configure training (Hugging Face Trainer, Axolotl, or OpenAI fine-tuning API)\n3. Train with checkpointing and early stopping\n4. Evaluate on held-out set\n5. Export the best model\n6. Deploy and test inference',
            dependsOn: ['step-1'],
        },
        {
            agentType: 'reviewer',
            description: 'Evaluate the fine-tuned model: compare against baseline, measure improvement on target task, check for regressions on general capabilities, report resource usage.',
            dependsOn: ['step-2'],
        },
    ],
    parameters: [],
    tags: ['fine-tuning', 'llm', 'training', 'lora', 'ml'],
    sourceTrajectoryIds: ['bundled'],
    qualityScore: 0.85,
    usageCount: 0,
    createdAt: PHASE3_CREATED_AT,
    lastUsedAt: PHASE3_CREATED_AT,
};
// ─── Blockchain ────────────────────────────────────────────────────────────
export const BUNDLED_SKILL_ID_SOLIDITY = 'skill-solidity';
export const BUNDLED_SKILL_ID_WEB3_DAPP = 'skill-web3-dapp';
export const BUNDLED_SKILL_ID_NFT_MINT = 'skill-nft-mint';
export const soliditySkill = {
    id: BUNDLED_SKILL_ID_SOLIDITY,
    name: 'solidity',
    description: 'Write, test, and deploy Solidity smart contracts. Covers contract design, security patterns, gas optimization, testing with Hardhat/Foundry, and mainnet deployment. Use when building on Ethereum or EVM-compatible chains.',
    version: '1.0.0',
    goalPattern: 'solidity smart contract ethereum EVM hardhat foundry deploy gas optimization security audit blockchain',
    steps: [
        {
            agentType: 'context-gatherer',
            description: 'Map the requirements: what chain (Ethereum, Polygon, Arbitrum)? What does the contract do (token, NFT, DeFi, DAO)? What standard (ERC-20, ERC-721, ERC-1155)? What security requirements?',
            dependsOn: [],
        },
        {
            agentType: 'planner',
            description: 'Design the contract architecture:\n1. Interface design: define public/external functions, events, errors\n2. Storage layout: state variables, mappings, structs (optimize for gas)\n3. Security patterns: checks-effects-interactions, reentrancy guards, access control\n4. Testing strategy: unit tests, fuzz tests, invariant tests\n5. Deployment: testnet first, verify on Etherscan, multi-sig for mainnet',
            dependsOn: ['step-0'],
        },
        {
            agentType: 'runner',
            description: 'Implement the contract:\n1. Write the Solidity contract with NatSpec documentation\n2. Add security checks (OpenZeppelin libraries where possible)\n3. Write comprehensive tests (Hardhat or Foundry)\n4. Run static analysis (Slither, Mythril)\n5. Deploy to testnet and verify\n6. Run integration tests on testnet',
            dependsOn: ['step-1'],
        },
        {
            agentType: 'reviewer',
            description: 'Verify the contract: run all tests, static analysis, gas report, verify on testnet explorer. Document any findings and recommendations.',
            dependsOn: ['step-2'],
        },
    ],
    parameters: [],
    tags: ['solidity', 'blockchain', 'ethereum', 'smart-contract', 'web3'],
    sourceTrajectoryIds: ['bundled'],
    qualityScore: 0.85,
    usageCount: 0,
    createdAt: PHASE3_CREATED_AT,
    lastUsedAt: PHASE3_CREATED_AT,
};
export const web3DappSkill = {
    id: BUNDLED_SKILL_ID_WEB3_DAPP,
    name: 'web3-dapp',
    description: 'Build a Web3 decentralized application: wallet connection, contract interaction, transaction handling, and IPFS integration. Use when the goal is to create a frontend that interacts with blockchain contracts.',
    version: '1.0.0',
    goalPattern: 'web3 dapp decentralized application wallet connection metamask contract interaction IPFS blockchain frontend',
    steps: [
        {
            agentType: 'context-gatherer',
            description: 'Map the stack: what frontend framework (React, Next.js, Vue)? What chain? What wallet (MetaMask, WalletConnect)? What contract ABI? What off-chain storage (IPFS, Arweave)?',
            dependsOn: [],
        },
        {
            agentType: 'planner',
            description: 'Design the DApp architecture:\n1. Wallet connection: RainbowKit or custom connect button\n2. Contract interaction: wagmi hooks or ethers.js read/write calls\n3. Transaction handling: pending state, confirmation, error recovery\n4. IPFS integration: pin files, retrieve content\n5. State management: React Query for on-chain data caching\n6. Error handling: user-friendly messages for common wallet errors',
            dependsOn: ['step-0'],
        },
        {
            agentType: 'runner',
            description: 'Build the DApp:\n1. Set up the project with wagmi + viem (or ethers.js)\n2. Implement wallet connection flow\n3. Add contract read hooks (useContractRead)\n4. Add contract write hooks (useContractWrite) with transaction tracking\n5. Integrate IPFS for file storage\n6. Add error handling and loading states',
            dependsOn: ['step-1'],
        },
        {
            agentType: 'reviewer',
            description: 'Test the DApp: connect wallet, read contract state, execute transactions, verify IPFS upload/download, test error states (wrong chain, rejected transaction).',
            dependsOn: ['step-2'],
        },
    ],
    parameters: [],
    tags: ['web3', 'dapp', 'blockchain', 'wallet', 'ipfs'],
    sourceTrajectoryIds: ['bundled'],
    qualityScore: 0.85,
    usageCount: 0,
    createdAt: PHASE3_CREATED_AT,
    lastUsedAt: PHASE3_CREATED_AT,
};
export const nftMintSkill = {
    id: BUNDLED_SKILL_ID_NFT_MINT,
    name: 'nft-mint',
    description: 'Build an NFT minting platform: smart contract, metadata storage (IPFS), minting frontend, and reveal mechanism. Use when the goal is to create, deploy, and launch an NFT collection.',
    version: '1.0.0',
    goalPattern: 'NFT mint minting platform ERC-721 IPFS metadata collection launch',
    steps: [
        {
            agentType: 'context-gatherer',
            description: 'Map the collection: how many NFTs? What metadata format (standard, generative art)? What chain? What pricing (free mint, fixed price, auction)? What reveal strategy (instant, delayed, staged)?',
            dependsOn: [],
        },
        {
            agentType: 'planner',
            description: 'Design the NFT system:\n1. Contract: ERC-721 with merkle tree allowlist, staged reveal, royalty support\n2. Metadata: JSON schema, IPFS pinning (Pinata/NFT.Storage)\n3. Art: on-chain generative or pre-computed with CID storage\n4. Minting frontend: wallet connect, mint button, transaction tracking\n5. Reveal: delayed reveal with metadata swap mechanism',
            dependsOn: ['step-0'],
        },
        {
            agentType: 'runner',
            description: 'Implement the NFT system:\n1. Write the ERC-721 contract with mint, reveal, and allowlist\n2. Upload metadata to IPFS\n3. Build the minting frontend with wallet integration\n4. Test on testnet (Sepolia)\n5. Deploy to mainnet\n6. Verify and pin metadata',
            dependsOn: ['step-1'],
        },
        {
            agentType: 'reviewer',
            description: 'Verify: test mint flow end-to-end, verify metadata on IPFS, check contract on Etherscan, test reveal mechanism, verify royalties.',
            dependsOn: ['step-2'],
        },
    ],
    parameters: [],
    tags: ['nft', 'erc-721', 'ipfs', 'blockchain', 'minting'],
    sourceTrajectoryIds: ['bundled'],
    qualityScore: 0.85,
    usageCount: 0,
    createdAt: PHASE3_CREATED_AT,
    lastUsedAt: PHASE3_CREATED_AT,
};
// ─── Communication ─────────────────────────────────────────────────────────
export const BUNDLED_SKILL_ID_DISCORD_BOT = 'skill-discord-bot';
export const BUNDLED_SKILL_ID_SLACK_INTEGRATION = 'skill-slack-integration';
export const BUNDLED_SKILL_ID_TEAMS_WEBHOOK = 'skill-teams-webhook';
export const discordBotSkill = {
    id: BUNDLED_SKILL_ID_DISCORD_BOT,
    name: 'discord-bot',
    description: 'Build a Discord bot with slash commands, embeds, buttons, modals, and event handlers. Covers bot setup, permission configuration, deployment, and hosting. Use when the goal is to create a bot for a Discord server.',
    version: '1.0.0',
    goalPattern: 'discord bot slash command embed button modal event handler discord.js',
    steps: [
        {
            agentType: 'context-gatherer',
            description: 'Map the bot: what commands does it need? What events to listen for? What permissions? What hosting (self-hosted, cloud)? What language (discord.js, discord.py)?',
            dependsOn: [],
        },
        {
            agentType: 'planner',
            description: 'Design the bot:\n1. Command registration: slash commands with options and autocomplete\n2. Event handling: message, reaction, member join/leave, voice state\n3. Embeds: rich message formatting with colors, fields, images\n4. Components: buttons, select menus, modals for interactive flows\n5. Permissions: role-based command access, channel restrictions\n6. Error handling: graceful failures, user-facing error messages\n7. Hosting: PM2, Docker, or serverless (AWS Lambda with discord-interactions)',
            dependsOn: ['step-0'],
        },
        {
            agentType: 'runner',
            description: 'Implement the bot:\n1. Set up Discord.js project with TypeScript\n2. Create command handler with auto-registration\n3. Implement event listeners\n4. Build commands with embeds and components\n5. Add permission checks\n6. Deploy and test in a test server',
            dependsOn: ['step-1'],
        },
        {
            agentType: 'reviewer',
            description: 'Test: register commands, test each slash command, verify embeds render correctly, test button interactions, test permission restrictions, verify error handling.',
            dependsOn: ['step-2'],
        },
    ],
    parameters: [],
    tags: ['discord', 'bot', 'slash-commands', 'embeds', 'automation'],
    sourceTrajectoryIds: ['bundled'],
    qualityScore: 0.85,
    usageCount: 0,
    createdAt: PHASE3_CREATED_AT,
    lastUsedAt: PHASE3_CREATED_AT,
};
export const slackIntegrationSkill = {
    id: BUNDLED_SKILL_ID_SLACK_INTEGRATION,
    name: 'slack-integration',
    description: 'Build Slack integrations: bots, app actions, slash commands, modals, and workflow builder steps. Covers Slack Bolt framework, OAuth, and deployment. Use when creating a Slack app or bot.',
    version: '1.0.0',
    goalPattern: 'slack app bot integration slash command modal workflow bolt framework',
    steps: [
        {
            agentType: 'context-gatherer',
            description: 'Map the integration: what triggers (slash command, event, action)? What responses (message, modal, workflow step)? What OAuth scopes needed? What hosting?',
            dependsOn: [],
        },
        {
            agentType: 'planner',
            description: 'Design the Slack app:\n1. App manifest: define commands, events, OAuth scopes\n2. Event handling: message, reaction, app_mention\n3. Interactivity: slash commands, buttons, modals, shortcuts\n4. Workflow steps: custom steps for Workflow Builder\n5. OAuth: install flow, token management\n6. Error handling: graceful degradation, retry logic',
            dependsOn: ['step-0'],
        },
        {
            agentType: 'runner',
            description: 'Implement with Bolt.js:\n1. Set up Bolt project with TypeScript\n2. Define app manifest\n3. Implement command handlers\n4. Add event listeners\n5. Build interactive components\n6. Deploy with Socket Mode or HTTP receiver',
            dependsOn: ['step-1'],
        },
        {
            agentType: 'reviewer',
            description: 'Test: install app in test workspace, test each command, verify events fire, test modal submissions, verify OAuth flow.',
            dependsOn: ['step-2'],
        },
    ],
    parameters: [],
    tags: ['slack', 'integration', 'bolt', 'workspace', 'automation'],
    sourceTrajectoryIds: ['bundled'],
    qualityScore: 0.85,
    usageCount: 0,
    createdAt: PHASE3_CREATED_AT,
    lastUsedAt: PHASE3_CREATED_AT,
};
export const teamsWebhookSkill = {
    id: BUNDLED_SKILL_ID_TEAMS_WEBHOOK,
    name: 'teams-webhook',
    description: 'Build Microsoft Teams integrations: incoming webhooks, outgoing webhooks, bot framework, adaptive cards, and message extensions. Use when connecting a service to Teams.',
    version: '1.0.0',
    goalPattern: 'microsoft teams webhook bot adaptive cards message extensions bot framework integration',
    steps: [
        {
            agentType: 'context-gatherer',
            description: 'Map the integration: incoming or outgoing webhook? Bot Framework adaptive cards? Message extensions? What triggers? What responses?',
            dependsOn: [],
        },
        {
            agentType: 'planner',
            description: 'Design the Teams integration:\n1. Incoming webhook: simple notification posting with adaptive cards\n2. Bot Framework: conversational bot with message handling\n3. Adaptive cards: rich message formatting\n4. Message extensions: search and action commands\n5. Authentication: Azure AD app registration\n6. Deployment: Azure Functions or App Service',
            dependsOn: ['step-0'],
        },
        {
            agentType: 'runner',
            description: 'Implement the integration:\n1. Set up Azure AD app registration\n2. Configure webhook or bot endpoint\n3. Build adaptive card templates\n4. Implement message handling logic\n5. Add authentication and token management\n6. Deploy to Azure',
            dependsOn: ['step-1'],
        },
        {
            agentType: 'reviewer',
            description: 'Test: send test webhook, verify card rendering, test bot conversation, verify message extension, check authentication flow.',
            dependsOn: ['step-2'],
        },
    ],
    parameters: [],
    tags: ['teams', 'microsoft', 'webhook', 'adaptive-cards', 'bot-framework'],
    sourceTrajectoryIds: ['bundled'],
    qualityScore: 0.85,
    usageCount: 0,
    createdAt: PHASE3_CREATED_AT,
    lastUsedAt: PHASE3_CREATED_AT,
};
// ─── Creative ──────────────────────────────────────────────────────────────
export const BUNDLED_SKILL_ID_LOGO_DESIGN = 'skill-logo-design';
export const BUNDLED_SKILL_ID_VIDEO_EDIT = 'skill-video-edit';
export const BUNDLED_SKILL_ID_PODCAST_PRODUCTION = 'skill-podcast-production';
export const logoDesignSkill = {
    id: BUNDLED_SKILL_ID_LOGO_DESIGN,
    name: 'logo-design',
    description: 'Generate logos and brand assets using SVG, canvas, or AI image generation. Covers logo concepts, color palettes, typography, SVG creation, and export formats. Use when the goal is to create a logo or visual brand identity.',
    version: '1.0.0',
    goalPattern: 'logo design brand identity SVG typography color palette visual identity icon',
    steps: [
        {
            agentType: 'context-gatherer',
            description: 'Map the brand: what is the company/product name? What industry? What style (modern, classic, playful, minimal)? What colors? What competitor logos exist? What output format (SVG, PNG, PDF)?',
            dependsOn: [],
        },
        {
            agentType: 'planner',
            description: 'Design the logo approach:\n1. Concept: 3 logo directions (wordmark, lettermark, symbol)\n2. Typography: select fonts (Google Fonts or custom)\n3. Color: primary + accent colors with contrast ratios\n4. Variations: horizontal, stacked, icon-only, dark/light\n5. Export: SVG (scalable), PNG (web), PDF (print)\n6. Brand guide: usage rules, spacing, minimum size',
            dependsOn: ['step-0'],
        },
        {
            agentType: 'runner',
            description: 'Create the logo:\n1. Generate SVG logo with the chosen concept\n2. Create color variations (full color, monochrome, reversed)\n3. Export to required formats\n4. Create a simple brand guide document\n5. Test on different backgrounds and sizes',
            dependsOn: ['step-1'],
        },
        {
            agentType: 'reviewer',
            description: 'Review: check scalability (resize to 16px and 1000px), verify contrast ratios, test on dark/light backgrounds, confirm export quality.',
            dependsOn: ['step-2'],
        },
    ],
    parameters: [],
    tags: ['logo', 'design', 'brand', 'svg', 'visual-identity'],
    sourceTrajectoryIds: ['bundled'],
    qualityScore: 0.85,
    usageCount: 0,
    createdAt: PHASE3_CREATED_AT,
    lastUsedAt: PHASE3_CREATED_AT,
};
export const videoEditSkill = {
    id: BUNDLED_SKILL_ID_VIDEO_EDIT,
    name: 'video-edit',
    description: 'Edit and process videos with FFmpeg: cutting, merging, encoding, format conversion, subtitle overlay, and compression. Use when the goal is to manipulate video files programmatically.',
    version: '1.0.0',
    goalPattern: 'video edit ffmpeg cut merge compress convert subtitle encode transcode format',
    steps: [
        {
            agentType: 'context-gatherer',
            description: 'Map the task: input format(s)? Desired output format? What edits needed (cut, merge, overlay, resize)? Quality requirements? File size constraints?',
            dependsOn: [],
        },
        {
            agentType: 'planner',
            description: 'Plan the FFmpeg commands:\n1. Probing: ffprobe to get codec, resolution, duration info\n2. Cutting: -ss and -t flags for precise cuts\n3. Merging: concat demuxer or filter\n4. Encoding: codec selection (H.264, H.265, VP9, AV1)\n5. Compression: CRF quality, bitrate control, two-pass\n6. Subtitles: SRT/ASS overlay with styling\n7. Thumbnail extraction: single frame at timestamp',
            dependsOn: ['step-0'],
        },
        {
            agentType: 'runner',
            description: 'Execute the video processing:\n1. Probe input file for metadata\n2. Apply edits in sequence\n3. Export to target format\n4. Verify output quality\n5. Check file size meets requirements',
            dependsOn: ['step-1'],
        },
        {
            agentType: 'reviewer',
            description: 'Verify: play output, check quality, verify duration, check file size, confirm all edits applied correctly.',
            dependsOn: ['step-2'],
        },
    ],
    parameters: [],
    tags: ['video', 'ffmpeg', 'editing', 'encoding', 'multimedia'],
    sourceTrajectoryIds: ['bundled'],
    qualityScore: 0.85,
    usageCount: 0,
    createdAt: PHASE3_CREATED_AT,
    lastUsedAt: PHASE3_CREATED_AT,
};
export const podcastProductionSkill = {
    id: BUNDLED_SKILL_ID_PODCAST_PRODUCTION,
    name: 'podcast-production',
    description: 'Produce podcast audio: recording setup, noise reduction, audio normalization, chapter markers, RSS feed generation, and distribution. Use when the goal is to produce and distribute a podcast episode.',
    version: '1.0.0',
    goalPattern: 'podcast audio production recording noise reduction normalization RSS feed distribution chapters',
    steps: [
        {
            agentType: 'context-gatherer',
            description: 'Map the production: how many tracks? What recording quality? What post-processing needed (noise reduction, normalization, compression)? What distribution (RSS, Spotify, Apple)?',
            dependsOn: [],
        },
        {
            agentType: 'planner',
            description: 'Plan the production pipeline:\n1. Audio processing: noise gate, noise reduction (RNNoise), EQ, compression\n2. Loudness normalization: -16 LUFS for podcasts, -1 dBTP true peak\n3. Chapter markers: insert chapter metadata\n4. ID3 tags: title, artist, album art, episode number\n5. RSS feed: iTunes/podcast namespace compliant XML\n6. Distribution: submit to directories (Apple, Spotify, Google)',
            dependsOn: ['step-0'],
        },
        {
            agentType: 'runner',
            description: 'Process the audio:\n1. Apply noise reduction with sox or RNNoise\n2. Normalize loudness to -16 LUFS\n3. Add chapter markers\n4. Embed ID3 metadata and album art\n5. Generate RSS feed XML\n6. Validate feed with podcast validator',
            dependsOn: ['step-1'],
        },
        {
            agentType: 'reviewer',
            description: 'Verify: listen to processed audio, check loudness levels, verify chapter markers, validate RSS feed, test on podcast player.',
            dependsOn: ['step-2'],
        },
    ],
    parameters: [],
    tags: ['podcast', 'audio', 'production', 'rss', 'distribution'],
    sourceTrajectoryIds: ['bundled'],
    qualityScore: 0.85,
    usageCount: 0,
    createdAt: PHASE3_CREATED_AT,
    lastUsedAt: PHASE3_CREATED_AT,
};
// ─── Data Science ──────────────────────────────────────────────────────────
export const BUNDLED_SKILL_ID_DATA_VISUALIZATION = 'skill-data-visualization';
export const BUNDLED_SKILL_ID_FEATURE_ENGINEERING = 'skill-feature-engineering';
export const BUNDLED_SKILL_ID_TIME_SERIES = 'skill-time-series';
export const dataVisualizationSkill = {
    id: BUNDLED_SKILL_ID_DATA_VISUALIZATION,
    name: 'data-visualization',
    description: 'Create data visualizations: charts, dashboards, interactive plots with D3.js, Plotly, Matplotlib, or Chart.js. Covers data transformation, chart selection, accessibility, and export. Use when the goal is to visualize data.',
    version: '1.0.0',
    goalPattern: 'data visualization chart dashboard plot D3 plotly matplotlib chart.js graph infographic',
    steps: [
        {
            agentType: 'context-gatherer',
            description: 'Map the data: what data format (CSV, JSON, database)? What story to tell? What chart type (bar, line, scatter, heatmap, treemap)? What platform (web, print, notebook)? Interactivity needed?',
            dependsOn: [],
        },
        {
            agentType: 'planner',
            description: 'Design the visualization:\n1. Choose chart type based on data and message\n2. Select library (D3 for custom, Plotly for interactive, Chart.js for simple, Matplotlib for notebooks)\n3. Design color scheme (accessible, colorblind-friendly)\n4. Add labels, legends, annotations\n5. Plan interactivity (tooltips, zoom, filter)\n6. Export format (SVG, PNG, HTML)',
            dependsOn: ['step-0'],
        },
        {
            agentType: 'runner',
            description: 'Create the visualization:\n1. Load and transform data\n2. Create the chart with chosen library\n3. Style with colors, fonts, labels\n4. Add interactivity if needed\n5. Export to target format\n6. Test on different screen sizes',
            dependsOn: ['step-1'],
        },
        {
            agentType: 'reviewer',
            description: 'Review: verify data accuracy, check accessibility (alt text, color contrast), test interactivity, confirm export quality.',
            dependsOn: ['step-2'],
        },
    ],
    parameters: [],
    tags: ['visualization', 'charts', 'data', 'd3', 'plotly'],
    sourceTrajectoryIds: ['bundled'],
    qualityScore: 0.85,
    usageCount: 0,
    createdAt: PHASE3_CREATED_AT,
    lastUsedAt: PHASE3_CREATED_AT,
};
export const featureEngineeringSkill = {
    id: BUNDLED_SKILL_ID_FEATURE_ENGINEERING,
    name: 'feature-engineering',
    description: 'Engineer features for ML: encoding, scaling, selection, transformation, and feature stores. Use when preparing data for machine learning models.',
    version: '1.0.0',
    goalPattern: 'feature engineering encoding scaling selection transformation PCA feature store preprocessing',
    steps: [
        {
            agentType: 'context-gatherer',
            description: 'Map the data: what features exist? What types (numeric, categorical, text, date)? What missing values? What distributions? What target variable?',
            dependsOn: [],
        },
        {
            agentType: 'planner',
            description: 'Plan feature engineering:\n1. Numerical: scaling (StandardScaler, MinMaxScaler), log transforms, polynomial features\n2. Categorical: one-hot encoding, target encoding, frequency encoding\n3. Text: TF-IDF, word embeddings, topic features\n4. Date: day of week, month, quarter, is_weekend, time since event\n5. Selection: correlation analysis, mutual information, recursive feature elimination\n6. Pipeline: sklearn Pipeline for reproducible transformations',
            dependsOn: ['step-0'],
        },
        {
            agentType: 'runner',
            description: 'Implement feature engineering:\n1. Analyze feature distributions and missing values\n2. Create numerical transformations\n3. Encode categorical variables\n4. Extract text features\n5. Generate date-based features\n6. Select top features by importance',
            dependsOn: ['step-1'],
        },
        {
            agentType: 'reviewer',
            description: 'Verify: check feature distributions, verify no data leakage, test pipeline end-to-end, measure impact on model performance.',
            dependsOn: ['step-2'],
        },
    ],
    parameters: [],
    tags: ['feature-engineering', 'preprocessing', 'ml', 'data-science'],
    sourceTrajectoryIds: ['bundled'],
    qualityScore: 0.85,
    usageCount: 0,
    createdAt: PHASE3_CREATED_AT,
    lastUsedAt: PHASE3_CREATED_AT,
};
export const timeSeriesSkill = {
    id: BUNDLED_SKILL_ID_TIME_SERIES,
    name: 'time-series',
    description: 'Analyze and forecast time series data: decomposition, stationarity testing, ARIMA, Prophet, and LSTM models. Use when the goal is to understand or predict temporal patterns.',
    version: '1.0.0',
    goalPattern: 'time series forecasting ARIMA prophet LSTM decomposition stationarity trend seasonality prediction',
    steps: [
        {
            agentType: 'context-gatherer',
            description: 'Map the data: time granularity (hourly, daily, weekly)? Historical range? Seasonality patterns? External regressors? Forecast horizon?',
            dependsOn: [],
        },
        {
            agentType: 'planner',
            description: 'Plan the analysis:\n1. Exploration: plot the series, check for trend/seasonality/outliers\n2. Stationarity: ADF test, KPSS test, differencing\n3. Models: ARIMA/SARIMA (statistical), Prophet (robust), LSTM (complex patterns)\n4. Validation: time series split (no random shuffle), MAE/RMSE/MAPE\n5. Deployment: save model, create prediction pipeline',
            dependsOn: ['step-0'],
        },
        {
            agentType: 'runner',
            description: 'Implement the analysis:\n1. Load and visualize the time series\n2. Test for stationarity\n3. Fit ARIMA/Prophet model\n4. Validate with time series cross-validation\n5. Generate forecast with confidence intervals\n6. Save model and prediction function',
            dependsOn: ['step-1'],
        },
        {
            agentType: 'reviewer',
            description: 'Verify: plot forecast vs actual, check residuals (should be white noise), verify confidence intervals, test on hold-out period.',
            dependsOn: ['step-2'],
        },
    ],
    parameters: [],
    tags: ['time-series', 'forecasting', 'arima', 'prophet', 'prediction'],
    sourceTrajectoryIds: ['bundled'],
    qualityScore: 0.85,
    usageCount: 0,
    createdAt: PHASE3_CREATED_AT,
    lastUsedAt: PHASE3_CREATED_AT,
};
// ─── DevOps Advanced ───────────────────────────────────────────────────────
export const BUNDLED_SKILL_ID_INFRA_AS_CODE = 'skill-infra-as-code';
export const BUNDLED_SKILL_ID_SERVICE_MESH = 'skill-service-mesh';
export const BUNDLED_SKILL_ID_CHAOS_ENGINEERING = 'skill-chaos-engineering';
export const infraAsCodeSkill = {
    id: BUNDLED_SKILL_ID_INFRA_AS_CODE,
    name: 'infra-as-code',
    description: 'Define infrastructure with code: Terraform, Pulumi, or CloudFormation. Covers modules, state management, drift detection, and multi-environment setups. Use when the goal is to provision or manage cloud infrastructure.',
    version: '1.0.0',
    goalPattern: 'infrastructure as code terraform pulumi cloudformation modules state drift multi-environment provisioning',
    steps: [
        {
            agentType: 'context-gatherer',
            description: 'Map the infrastructure: what cloud provider? What resources (VPC, ECS, RDS, S3)? How many environments (dev, staging, prod)? What state backend (S3, Terraform Cloud)?',
            dependsOn: [],
        },
        {
            agentType: 'planner',
            description: 'Design the IaC structure:\n1. Module design: reusable modules for VPC, ECS, RDS, etc.\n2. State management: remote state with locking\n3. Variables: input variables, outputs, data sources\n4. Environments: workspace or directory-based separation\n5. CI/CD: plan → apply pipeline with approval gates\n6. Drift detection: scheduled plan checks',
            dependsOn: ['step-0'],
        },
        {
            agentType: 'runner',
            description: 'Implement infrastructure:\n1. Write Terraform/Pulumi modules\n2. Configure state backend\n3. Define variables and outputs\n4. Create environment-specific configs\n5. Run terraform plan/apply\n6. Verify resources in cloud console',
            dependsOn: ['step-1'],
        },
        {
            agentType: 'reviewer',
            description: 'Verify: check terraform state matches reality, run plan with no changes (no drift), verify all outputs, test destroy/recreate cycle.',
            dependsOn: ['step-2'],
        },
    ],
    parameters: [],
    tags: ['terraform', 'pulumi', 'infrastructure', 'cloud', 'devops'],
    sourceTrajectoryIds: ['bundled'],
    qualityScore: 0.85,
    usageCount: 0,
    createdAt: PHASE3_CREATED_AT,
    lastUsedAt: PHASE3_CREATED_AT,
};
export const serviceMeshSkill = {
    id: BUNDLED_SKILL_ID_SERVICE_MESH,
    name: 'service-mesh',
    description: 'Set up a service mesh (Istio, Linkerd, Consul Connect): traffic management, mTLS, observability, and resilience. Use when the goal is to add networking capabilities to a microservices architecture.',
    version: '1.0.0',
    goalPattern: 'service mesh istio linkerd consul mTLS traffic management observability resilience microservices',
    steps: [
        {
            agentType: 'context-gatherer',
            description: 'Map the services: how many services? What Kubernetes version? What mesh (Istio, Linkerd, Consul)? What capabilities needed (mTLS, traffic splitting, circuit breaking)?',
            dependsOn: [],
        },
        {
            agentType: 'planner',
            description: 'Design the mesh configuration:\n1. Installation: control plane + sidecar injection\n2. mTLS: strict mode for service-to-service\n3. Traffic: canary deployments, circuit breaking, retries\n4. Observability: Kiali dashboard, Jaeger tracing, Prometheus metrics\n5. Authorization: service-to-service access policies',
            dependsOn: ['step-0'],
        },
        {
            agentType: 'runner',
            description: 'Deploy the mesh:\n1. Install control plane\n2. Enable sidecar injection for namespaces\n3. Configure mTLS\n4. Set up traffic rules\n5. Deploy observability stack\n6. Test service communication',
            dependsOn: ['step-1'],
        },
        {
            agentType: 'reviewer',
            description: 'Verify: mTLS between services, traffic splitting works, traces appear in Jaeger, metrics in Prometheus, authorization policies enforced.',
            dependsOn: ['step-2'],
        },
    ],
    parameters: [],
    tags: ['service-mesh', 'istio', 'linkerd', 'mtls', 'microservices'],
    sourceTrajectoryIds: ['bundled'],
    qualityScore: 0.85,
    usageCount: 0,
    createdAt: PHASE3_CREATED_AT,
    lastUsedAt: PHASE3_CREATED_AT,
};
export const chaosEngineeringSkill = {
    id: BUNDLED_SKILL_ID_CHAOS_ENGINEERING,
    name: 'chaos-engineering',
    description: 'Practice chaos engineering: inject faults, measure resilience, and improve system reliability. Covers experiment design, fault injection (network, CPU, memory), and blast radius control. Use when testing system resilience.',
    version: '1.0.0',
    goalPattern: 'chaos engineering fault injection resilience testing reliability litmus chaos mesh game day',
    steps: [
        {
            agentType: 'context-gatherer',
            description: 'Map the system: what services to test? What failure modes to explore? What observability exists? What is the blast radius limit?',
            dependsOn: [],
        },
        {
            agentType: 'planner',
            description: 'Design chaos experiments:\n1. Steady state: define normal behavior metrics\n2. Hypothesis: "the system will continue serving requests when X fails"\n3. Fault injection: network latency/loss, pod kills, CPU/memory stress\n4. Blast radius: start small, expand gradually\n5. Rollback: automatic rollback on breach of SLO\n6. Observability: monitor during experiment',
            dependsOn: ['step-0'],
        },
        {
            agentType: 'runner',
            description: 'Run the experiment:\n1. Verify steady state\n2. Inject fault (Litmus, Chaos Mesh, or custom)\n3. Monitor system behavior\n4. Observe if hypothesis holds\n5. Stop experiment\n6. Analyze results',
            dependsOn: ['step-1'],
        },
        {
            agentType: 'reviewer',
            description: 'Review: did the system handle the fault? What degraded? What broke? What improvements are needed? Document findings and action items.',
            dependsOn: ['step-2'],
        },
    ],
    parameters: [],
    tags: ['chaos', 'resilience', 'fault-injection', 'reliability', 'testing'],
    sourceTrajectoryIds: ['bundled'],
    qualityScore: 0.85,
    usageCount: 0,
    createdAt: PHASE3_CREATED_AT,
    lastUsedAt: PHASE3_CREATED_AT,
};
// ─── Email ─────────────────────────────────────────────────────────────────
export const BUNDLED_SKILL_ID_TRANSACTIONAL_EMAIL = 'skill-transactional-email';
export const BUNDLED_SKILL_ID_NEWSLETTER = 'skill-newsletter';
export const transactionalEmailSkill = {
    id: BUNDLED_SKILL_ID_TRANSACTIONAL_EMAIL,
    name: 'transactional-email',
    description: 'Set up transactional email sending: SMTP configuration, email templates, delivery tracking, bounce handling, and provider integration (SendGrid, Postmark, SES). Use when the goal is to send system emails (password resets, notifications, receipts).',
    version: '1.0.0',
    goalPattern: 'transactional email SMTP SendGrid Postmark SES template delivery tracking bounce password reset notification',
    steps: [
        {
            agentType: 'context-gatherer',
            description: 'Map the email needs: what types of emails (welcome, reset, receipt, notification)? What provider? What domain for sending? What templates needed?',
            dependsOn: [],
        },
        {
            agentType: 'planner',
            description: 'Design the email system:\n1. Provider setup: domain verification, SPF/DKIM/DMARC records\n2. SMTP/API integration: SendGrid API, Postmark API, or SES\n3. Templates: HTML + plain text, responsive design, variable interpolation\n4. Delivery: queue-based sending, retry logic, rate limiting\n5. Tracking: delivery, open, click events\n6. Bounce/complaint handling: webhook endpoints, list management',
            dependsOn: ['step-0'],
        },
        {
            agentType: 'runner',
            description: 'Implement email sending:\n1. Set up provider API client\n2. Create email templates\n3. Implement sending function with retry\n4. Add tracking webhooks\n5. Handle bounces and complaints\n6. Test with seed list',
            dependsOn: ['step-1'],
        },
        {
            agentType: 'reviewer',
            description: 'Verify: send test emails, check delivery, verify tracking, test bounce handling, check spam score.',
            dependsOn: ['step-2'],
        },
    ],
    parameters: [],
    tags: ['email', 'transactional', 'smtp', 'sendgrid', 'delivery'],
    sourceTrajectoryIds: ['bundled'],
    qualityScore: 0.85,
    usageCount: 0,
    createdAt: PHASE3_CREATED_AT,
    lastUsedAt: PHASE3_CREATED_AT,
};
export const newsletterSkill = {
    id: BUNDLED_SKILL_ID_NEWSLETTER,
    name: 'newsletter',
    description: 'Build a newsletter system: subscriber management, email composition, scheduling, analytics, and compliance (CAN-SPAM, GDPR). Use when the goal is to create and manage an email newsletter.',
    version: '1.0.0',
    goalPattern: 'newsletter email subscriber management scheduling analytics CAN-SPAM GDPR compose template',
    steps: [
        {
            agentType: 'context-gatherer',
            description: 'Map the newsletter: subscriber list size? Sending frequency? Content type (text, HTML, mixed)? Growth mechanism (signup form)? Compliance requirements?',
            dependsOn: [],
        },
        {
            agentType: 'planner',
            description: 'Design the newsletter system:\n1. Subscriber management: signup, unsubscribe, preferences, list segments\n2. Composition: rich text editor or HTML templates\n3. Scheduling: queue-based sending with time zone support\n4. Analytics: open rates, click rates, unsubscribes\n5. Compliance: CAN-SPAM (unsubscribe link, physical address), GDPR (consent, data export)\n6. Growth: signup forms, referral programs',
            dependsOn: ['step-0'],
        },
        {
            agentType: 'runner',
            description: 'Implement the newsletter:\n1. Build subscriber management (add, remove, segment)\n2. Create email template system\n3. Implement sending queue\n4. Add tracking pixels and click tracking\n5. Build unsubscribe flow\n6. Create signup form',
            dependsOn: ['step-1'],
        },
        {
            agentType: 'reviewer',
            description: 'Verify: subscribe, send test newsletter, check delivery, verify unsubscribe, check analytics, test compliance (CAN-SPAM, GDPR).',
            dependsOn: ['step-2'],
        },
    ],
    parameters: [],
    tags: ['newsletter', 'email', 'marketing', 'subscriber', 'compliance'],
    sourceTrajectoryIds: ['bundled'],
    qualityScore: 0.85,
    usageCount: 0,
    createdAt: PHASE3_CREATED_AT,
    lastUsedAt: PHASE3_CREATED_AT,
};
// ─── Finance ───────────────────────────────────────────────────────────────
export const BUNDLED_SKILL_ID_PAYMENT_GATEWAY = 'skill-payment-gateway';
export const BUNDLED_SKILL_ID_ACCOUNTING_INTEGRATION = 'skill-accounting-integration';
export const paymentGatewaySkill = {
    id: BUNDLED_SKILL_ID_PAYMENT_GATEWAY,
    name: 'payment-gateway',
    description: 'Integrate payment processing: Stripe, PayPal, or Square. Covers checkout flows, subscriptions, refunds, webhooks, and PCI compliance. Use when the goal is to accept payments in an application.',
    version: '1.0.0',
    goalPattern: 'payment gateway stripe paypal square checkout subscription refund webhook PCI compliance',
    steps: [
        {
            agentType: 'context-gatherer',
            description: 'Map the payment flow: one-time or recurring? Currency? Countries supported? What provider (Stripe, PayPal, Square)? What checkout experience (hosted, embedded, custom)?',
            dependsOn: [],
        },
        {
            agentType: 'planner',
            description: 'Design the payment system:\n1. Checkout: Stripe Checkout, Payment Intents, or Elements\n2. Subscriptions: pricing plans, trial periods, metered billing\n3. Webhooks: handle payment events (succeeded, failed, refunded)\n4. Refunds: full and partial refund handling\n5. PCI: use Stripe Elements (no card data touches your server)\n6. Testing: test mode with Stripe test cards',
            dependsOn: ['step-0'],
        },
        {
            agentType: 'runner',
            description: 'Implement payment processing:\n1. Set up Stripe/PayPal SDK\n2. Create checkout session\n3. Handle success/cancel redirects\n4. Implement webhook handler\n5. Add subscription management\n6. Test with test cards',
            dependsOn: ['step-1'],
        },
        {
            agentType: 'reviewer',
            description: 'Verify: test checkout flow, verify webhook events, test refund, check subscription lifecycle, verify in provider dashboard.',
            dependsOn: ['step-2'],
        },
    ],
    parameters: [],
    tags: ['payment', 'stripe', 'checkout', 'subscription', 'billing'],
    sourceTrajectoryIds: ['bundled'],
    qualityScore: 0.85,
    usageCount: 0,
    createdAt: PHASE3_CREATED_AT,
    lastUsedAt: PHASE3_CREATED_AT,
};
export const accountingIntegrationSkill = {
    id: BUNDLED_SKILL_ID_ACCOUNTING_INTEGRATION,
    name: 'accounting-integration',
    description: 'Integrate accounting software: QuickBooks, Xero, or FreshBooks API integration for invoices, expenses, and financial reporting. Use when the goal is to sync financial data with an accounting system.',
    version: '1.0.0',
    goalPattern: 'accounting quickbooks xero freshbooks invoice expense financial reporting integration API',
    steps: [
        {
            agentType: 'context-gatherer',
            description: 'Map the integration: what accounting platform? What data to sync (invoices, expenses, customers, products)? Sync direction (bidirectional, push, pull)? Frequency?',
            dependsOn: [],
        },
        {
            agentType: 'planner',
            description: 'Design the integration:\n1. Auth: OAuth2 flow for API access\n2. Data mapping: your models → accounting platform models\n3. Sync: create/update invoices, expenses, contacts\n4. Webhooks: receive updates from accounting platform\n5. Error handling: retry, conflict resolution\n6. Reporting: pull financial data for dashboards',
            dependsOn: ['step-0'],
        },
        {
            agentType: 'runner',
            description: 'Implement the integration:\n1. Set up OAuth2 authentication\n2. Create API client for the accounting platform\n3. Implement data sync functions\n4. Add webhook handlers\n5. Build conflict resolution logic\n6. Test with sandbox account',
            dependsOn: ['step-1'],
        },
        {
            agentType: 'reviewer',
            description: 'Verify: create invoice via API, verify it appears in accounting platform, test expense sync, verify financial reports pull correctly.',
            dependsOn: ['step-2'],
        },
    ],
    parameters: [],
    tags: ['accounting', 'quickbooks', 'xero', 'finance', 'integration'],
    sourceTrajectoryIds: ['bundled'],
    qualityScore: 0.85,
    usageCount: 0,
    createdAt: PHASE3_CREATED_AT,
    lastUsedAt: PHASE3_CREATED_AT,
};
// ─── Health ────────────────────────────────────────────────────────────────
export const BUNDLED_SKILL_ID_HEALTH_DATA = 'skill-health-data';
export const BUNDLED_SKILL_ID_FITNESS_API = 'skill-fitness-api';
export const healthDataSkill = {
    id: BUNDLED_SKILL_ID_HEALTH_DATA,
    name: 'health-data',
    description: 'Integrate health data APIs: Apple HealthKit, Google Fit, or Fitbit for reading and writing health metrics. Covers authorization, data types, and privacy compliance. Use when building health or wellness applications.',
    version: '1.0.0',
    goalPattern: 'health data healthkit google fit fitbit wellness metrics privacy HIPAA integration',
    steps: [
        {
            agentType: 'context-gatherer',
            description: 'Map the health data: what platform (iOS, Android, web)? What metrics (steps, heart rate, sleep, weight)? What provider (HealthKit, Google Fit, Fitbit)? Privacy requirements (HIPAA)?',
            dependsOn: [],
        },
        {
            agentType: 'planner',
            description: 'Design the health integration:\n1. Authorization: OAuth scopes for health data\n2. Data types: map app data types to platform types\n3. Reading: fetch historical and real-time data\n4. Writing: save workout data, custom health metrics\n5. Privacy: data encryption, user consent, data deletion\n6. Sync: background sync, conflict resolution',
            dependsOn: ['step-0'],
        },
        {
            agentType: 'runner',
            description: 'Implement the integration:\n1. Set up API credentials\n2. Implement authorization flow\n3. Create data reading functions\n4. Add data writing functions\n5. Handle data normalization\n6. Test with sample data',
            dependsOn: ['step-1'],
        },
        {
            agentType: 'reviewer',
            description: 'Verify: authorize access, read health data, write test data, verify sync, check privacy controls.',
            dependsOn: ['step-2'],
        },
    ],
    parameters: [],
    tags: ['health', 'fitness', 'healthkit', 'privacy', 'integration'],
    sourceTrajectoryIds: ['bundled'],
    qualityScore: 0.85,
    usageCount: 0,
    createdAt: PHASE3_CREATED_AT,
    lastUsedAt: PHASE3_CREATED_AT,
};
export const fitnessApiSkill = {
    id: BUNDLED_SKILL_ID_FITNESS_API,
    name: 'fitness-api',
    description: 'Build a fitness API: workout tracking, exercise database, nutrition logging, and progress analytics. Use when creating a fitness or wellness application backend.',
    version: '1.0.0',
    goalPattern: 'fitness API workout tracking exercise database nutrition logging progress analytics',
    steps: [
        {
            agentType: 'context-gatherer',
            description: 'Map the API: what endpoints needed (workouts, exercises, meals, progress)? What database? What authentication? What analytics (charts, trends, goals)?',
            dependsOn: [],
        },
        {
            agentType: 'planner',
            description: 'Design the fitness API:\n1. Data model: exercises, workouts, meals, goals, progress\n2. Endpoints: CRUD for all entities, analytics queries\n3. Exercise database: pre-loaded exercises with muscle groups, equipment\n4. Nutrition: food database, calorie/macro tracking\n5. Progress: body measurements, workout PRs, trends\n6. Auth: JWT with refresh tokens',
            dependsOn: ['step-0'],
        },
        {
            agentType: 'runner',
            description: 'Implement the API:\n1. Design database schema\n2. Create API endpoints with validation\n3. Build exercise database\n4. Implement nutrition tracking\n5. Add analytics queries\n6. Seed with sample data',
            dependsOn: ['step-1'],
        },
        {
            agentType: 'reviewer',
            description: 'Verify: CRUD operations, exercise search, nutrition logging, progress analytics, authentication flow.',
            dependsOn: ['step-2'],
        },
    ],
    parameters: [],
    tags: ['fitness', 'api', 'workout', 'nutrition', 'health'],
    sourceTrajectoryIds: ['bundled'],
    qualityScore: 0.85,
    usageCount: 0,
    createdAt: PHASE3_CREATED_AT,
    lastUsedAt: PHASE3_CREATED_AT,
};
// ─── MCP ───────────────────────────────────────────────────────────────────
export const BUNDLED_SKILL_ID_MCP_SERVER = 'skill-mcp-server';
export const BUNDLED_SKILL_ID_MCP_CLIENT = 'skill-mcp-client';
export const BUNDLED_SKILL_ID_MCP_CONNECTOR = 'skill-mcp-connector';
export const mcpServerSkill = {
    id: BUNDLED_SKILL_ID_MCP_SERVER,
    name: 'mcp-server',
    description: 'Build a Model Context Protocol (MCP) server: expose tools, resources, and prompts to AI agents via the MCP standard. Covers stdio and HTTP transports, tool definitions, resource URIs, and OAuth. Use when making your service available to AI agents.',
    version: '1.0.0',
    goalPattern: 'MCP model context protocol server tools resources prompts stdio HTTP transport',
    steps: [
        {
            agentType: 'context-gatherer',
            description: 'Map the server: what tools to expose? What resources (files, database, API)? What prompts? What transport (stdio for local, HTTP for remote)? Authentication needed?',
            dependsOn: [],
        },
        {
            agentType: 'planner',
            description: 'Design the MCP server:\n1. Tools: define function schemas (name, description, input parameters)\n2. Resources: expose data via resource URIs (file://, db://, api://)\n3. Prompts: define reusable prompt templates\n4. Transport: stdio (child process) or HTTP (SSE/streamable HTTP)\n5. Authentication: API key or OAuth for remote servers\n6. Error handling: structured error responses',
            dependsOn: ['step-0'],
        },
        {
            agentType: 'runner',
            description: 'Implement the MCP server:\n1. Set up MCP SDK (TypeScript or Python)\n2. Define tool handlers with input validation\n3. Create resource providers\n4. Add prompt templates\n5. Configure transport\n6. Test with MCP inspector',
            dependsOn: ['step-1'],
        },
        {
            agentType: 'reviewer',
            description: 'Verify: connect with MCP client, list tools, call tools, list resources, read resources, test error handling.',
            dependsOn: ['step-2'],
        },
    ],
    parameters: [],
    tags: ['mcp', 'model-context-protocol', 'server', 'ai-agents', 'tools'],
    sourceTrajectoryIds: ['bundled'],
    qualityScore: 0.85,
    usageCount: 0,
    createdAt: PHASE3_CREATED_AT,
    lastUsedAt: PHASE3_CREATED_AT,
};
export const mcpClientSkill = {
    id: BUNDLED_SKILL_ID_MCP_CLIENT,
    name: 'mcp-client',
    description: 'Build an MCP client: connect to MCP servers, discover tools/resources, and execute operations. Covers server management, tool calling, and resource reading. Use when your agent needs to consume MCP servers.',
    version: '1.0.0',
    goalPattern: 'MCP client connect server discover tools resources execute operations agent integration',
    steps: [
        {
            agentType: 'context-gatherer',
            description: 'Map the client needs: what servers to connect to? What transport (stdio, HTTP)? What tools to use? What resources to read? Error handling requirements?',
            dependsOn: [],
        },
        {
            agentType: 'planner',
            description: 'Design the MCP client:\n1. Server management: connect, disconnect, reconnect\n2. Tool discovery: list available tools with schemas\n3. Tool calling: invoke tools with arguments, handle results\n4. Resource reading: list and read resources\n5. Error handling: timeouts, connection failures, tool errors\n6. Caching: cache tool schemas, resource contents',
            dependsOn: ['step-0'],
        },
        {
            agentType: 'runner',
            description: 'Implement the MCP client:\n1. Set up MCP SDK client\n2. Implement server connection management\n3. Add tool discovery and calling\n4. Implement resource reading\n5. Add error handling and retries\n6. Test with sample servers',
            dependsOn: ['step-1'],
        },
        {
            agentType: 'reviewer',
            description: 'Verify: connect to test server, discover tools, call tools with various inputs, read resources, test error scenarios.',
            dependsOn: ['step-2'],
        },
    ],
    parameters: [],
    tags: ['mcp', 'client', 'agent', 'integration', 'tools'],
    sourceTrajectoryIds: ['bundled'],
    qualityScore: 0.85,
    usageCount: 0,
    createdAt: PHASE3_CREATED_AT,
    lastUsedAt: PHASE3_CREATED_AT,
};
export const mcpConnectorSkill = {
    id: BUNDLED_SKILL_ID_MCP_CONNECTOR,
    name: 'mcp-connector',
    description: 'Bridge APIs to MCP: wrap existing REST/GraphQL APIs as MCP servers with auto-generated tool schemas. Use when you need to expose an existing API to AI agents without rewriting it.',
    version: '1.0.0',
    goalPattern: 'MCP connector bridge REST API GraphQL auto-generate tools schema wrapper',
    steps: [
        {
            agentType: 'context-gatherer',
            description: 'Map the API: what endpoints? What authentication? What request/response formats? What rate limits?',
            dependsOn: [],
        },
        {
            agentType: 'planner',
            description: 'Design the connector:\n1. Schema generation: parse OpenAPI/GraphQL schema → MCP tool definitions\n2. Tool mapping: API endpoint → MCP tool with matching input/output\n3. Authentication: proxy API keys or OAuth tokens\n4. Error mapping: API errors → MCP error responses\n5. Rate limiting: respect API limits\n6. Caching: cache tool schemas, optionally cache responses',
            dependsOn: ['step-0'],
        },
        {
            agentType: 'runner',
            description: 'Implement the connector:\n1. Parse API schema (OpenAPI or GraphQL)\n2. Generate MCP tool definitions\n3. Create tool handlers that call the API\n4. Add authentication proxy\n5. Map error responses\n6. Test end-to-end',
            dependsOn: ['step-1'],
        },
        {
            agentType: 'reviewer',
            description: 'Verify: generate tools from schema, call each tool, verify API responses, test error handling, check auth flow.',
            dependsOn: ['step-2'],
        },
    ],
    parameters: [],
    tags: ['mcp', 'connector', 'api', 'bridge', 'auto-generate'],
    sourceTrajectoryIds: ['bundled'],
    qualityScore: 0.85,
    usageCount: 0,
    createdAt: PHASE3_CREATED_AT,
    lastUsedAt: PHASE3_CREATED_AT,
};
// ─── Migration ─────────────────────────────────────────────────────────────
export const BUNDLED_SKILL_ID_DATA_MIGRATION = 'skill-data-migration';
export const BUNDLED_SKILL_ID_CLOUD_MIGRATION = 'skill-cloud-migration';
export const dataMigrationSkill = {
    id: BUNDLED_SKILL_ID_DATA_MIGRATION,
    name: 'data-migration',
    description: 'Plan and execute data migrations: schema mapping, ETL pipelines, validation, rollback strategies, and zero-downtime migrations. Use when moving data between systems or databases.',
    version: '1.0.0',
    goalPattern: 'data migration ETL schema mapping validation rollback zero-downtime database migration',
    steps: [
        {
            agentType: 'context-gatherer',
            description: 'Map the migration: source and target systems? Data volume? Schema differences? Downtime tolerance? Rollback requirements?',
            dependsOn: [],
        },
        {
            agentType: 'planner',
            description: 'Design the migration:\n1. Schema mapping: source → target field mapping, type conversions\n2. ETL: extract, transform, load pipeline design\n3. Validation: row counts, checksums, business rules\n4. Rollback: backup strategy, reverse migration plan\n5. Zero-downtime: dual-write, CDC, or scheduled cutover\n6. Monitoring: progress tracking, error alerts',
            dependsOn: ['step-0'],
        },
        {
            agentType: 'runner',
            description: 'Execute the migration:\n1. Create backup of source data\n2. Run ETL pipeline on sample data, validate\n3. Run full migration with progress tracking\n4. Validate target data\n5. Switch traffic to new system\n6. Monitor and keep rollback ready',
            dependsOn: ['step-1'],
        },
        {
            agentType: 'reviewer',
            description: 'Verify: row count match, checksum validation, business rule validation, performance benchmarks, rollback tested.',
            dependsOn: ['step-2'],
        },
    ],
    parameters: [],
    tags: ['migration', 'etl', 'database', 'data', 'rollback'],
    sourceTrajectoryIds: ['bundled'],
    qualityScore: 0.85,
    usageCount: 0,
    createdAt: PHASE3_CREATED_AT,
    lastUsedAt: PHASE3_CREATED_AT,
};
export const cloudMigrationSkill = {
    id: BUNDLED_SKILL_ID_CLOUD_MIGRATION,
    name: 'cloud-migration',
    description: 'Migrate applications to the cloud: assessment, planning, containerization, deployment, and optimization. Covers AWS, GCP, and Azure migration paths. Use when moving on-premise applications to cloud infrastructure.',
    version: '1.0.0',
    goalPattern: 'cloud migration AWS GCP Azure containerization assessment planning deployment optimization lift-and-shift',
    steps: [
        {
            agentType: 'context-gatherer',
            description: 'Map the application: what runtime? What dependencies? What data stores? What networking? Target cloud provider?',
            dependsOn: [],
        },
        {
            agentType: 'planner',
            description: 'Design the migration:\n1. Assessment: inventory workloads, dependencies, costs\n2. Strategy: lift-and-shift vs re-platform vs refactor\n3. Containerization: Dockerize the application\n4. Infrastructure: provision cloud resources (VPC, compute, storage)\n5. Data migration: database, files, configuration\n6. Cutover: DNS switch, traffic migration, monitoring',
            dependsOn: ['step-0'],
        },
        {
            agentType: 'runner',
            description: 'Execute migration:\n1. Containerize the application\n2. Push images to cloud registry\n3. Provision infrastructure (IaC)\n4. Deploy application\n5. Migrate data\n6. Switch traffic and monitor',
            dependsOn: ['step-1'],
        },
        {
            agentType: 'reviewer',
            description: 'Verify: application running on cloud, data migrated, performance comparable, costs within budget, rollback plan tested.',
            dependsOn: ['step-2'],
        },
    ],
    parameters: [],
    tags: ['cloud', 'migration', 'aws', 'gcp', 'azure', 'containerization'],
    sourceTrajectoryIds: ['bundled'],
    qualityScore: 0.85,
    usageCount: 0,
    createdAt: PHASE3_CREATED_AT,
    lastUsedAt: PHASE3_CREATED_AT,
};
// ─── Productivity ──────────────────────────────────────────────────────────
export const BUNDLED_SKILL_ID_KNOWLEDGE_BASE = 'skill-knowledge-base';
export const BUNDLED_SKILL_ID_DECISION_FRAMEWORK = 'skill-decision-framework';
export const knowledgeBaseSkill = {
    id: BUNDLED_SKILL_ID_KNOWLEDGE_BASE,
    name: 'knowledge-base',
    description: 'Build a knowledge base system: document ingestion, search, versioning, and collaborative editing. Use when the goal is to create a searchable knowledge repository for a team or product.',
    version: '1.0.0',
    goalPattern: 'knowledge base wiki documentation search versioning collaborative editing docs',
    steps: [
        {
            agentType: 'context-gatherer',
            description: 'Map the knowledge base: what content types (markdown, HTML, PDF)? What search requirements? Version control needed? Access control?',
            dependsOn: [],
        },
        {
            agentType: 'planner',
            description: 'Design the knowledge base:\n1. Storage: markdown files in git or database-backed\n2. Search: full-text search (Meilisearch, Typesense, Algolia)\n3. Versioning: git-based or database revisions\n4. Editing: WYSIWYG or markdown editor\n5. Navigation: categories, tags, related articles\n6. Access control: public, team-only, role-based',
            dependsOn: ['step-0'],
        },
        {
            agentType: 'runner',
            description: 'Build the knowledge base:\n1. Create content storage layer\n2. Implement search indexing\n3. Build the editor interface\n4. Add navigation and categorization\n5. Implement access control\n6. Seed with initial content',
            dependsOn: ['step-1'],
        },
        {
            agentType: 'reviewer',
            description: 'Verify: create/edit articles, search functionality, version history, access control, navigation works.',
            dependsOn: ['step-2'],
        },
    ],
    parameters: [],
    tags: ['knowledge-base', 'wiki', 'documentation', 'search', 'content'],
    sourceTrajectoryIds: ['bundled'],
    qualityScore: 0.85,
    usageCount: 0,
    createdAt: PHASE3_CREATED_AT,
    lastUsedAt: PHASE3_CREATED_AT,
};
export const decisionFrameworkSkill = {
    id: BUNDLED_SKILL_ID_DECISION_FRAMEWORK,
    name: 'decision-framework',
    description: 'Apply structured decision-making frameworks: RICE scoring, weighted matrix, decision trees, and ADR (Architecture Decision Records). Use when the goal is to make a systematic, well-documented technical or product decision.',
    version: '1.0.0',
    goalPattern: 'decision framework RICE weighted matrix decision tree ADR architecture decision record evaluation trade-off',
    steps: [
        {
            agentType: 'context-gatherer',
            description: 'Map the decision: what is being decided? What are the options? What criteria matter? Who are the stakeholders? What constraints exist?',
            dependsOn: [],
        },
        {
            agentType: 'planner',
            description: 'Choose and apply the framework:\n1. RICE: Reach × Impact × Confidence / Effort for prioritization\n2. Weighted matrix: criteria × weights × scores for complex decisions\n3. Decision tree: branching logic for conditional decisions\n4. ADR: document the decision context, options, rationale, and consequences\n5. Pros/cons: structured comparison for simpler decisions\n6. Six Thinking Hats: explore from multiple perspectives',
            dependsOn: ['step-0'],
        },
        {
            agentType: 'runner',
            description: 'Execute the framework:\n1. Define options clearly\n2. Score each option against criteria\n3. Calculate weighted scores or RICE scores\n4. Document the analysis\n5. Make the recommendation\n6. Write the ADR if it\'s an architecture decision',
            dependsOn: ['step-1'],
        },
        {
            agentType: 'reviewer',
            description: 'Review the decision: verify scoring is objective, check for bias, validate the recommendation against constraints, document in ADR format.',
            dependsOn: ['step-2'],
        },
    ],
    parameters: [],
    tags: ['decision', 'framework', 'adr', 'prioritization', 'analysis'],
    sourceTrajectoryIds: ['bundled'],
    qualityScore: 0.85,
    usageCount: 0,
    createdAt: PHASE3_CREATED_AT,
    lastUsedAt: PHASE3_CREATED_AT,
};
// ─── Research ──────────────────────────────────────────────────────────────
export const BUNDLED_SKILL_ID_OSINT_INVESTIGATION = 'skill-osint-investigation';
export const BUNDLED_SKILL_ID_ACADEMIC_RESEARCH = 'skill-academic-research';
export const osintInvestigationSkill = {
    id: BUNDLED_SKILL_ID_OSINT_INVESTIGATION,
    name: 'osint-investigation',
    description: 'Conduct open-source intelligence (OSINT) investigations: reconnaissance, data collection, analysis, and reporting. Covers OSINT tools, techniques, and ethical guidelines. Use when gathering intelligence from public sources.',
    version: '1.0.0',
    goalPattern: 'OSINT open source intelligence investigation reconnaissance data collection analysis public sources',
    steps: [
        {
            agentType: 'context-gatherer',
            description: 'Map the investigation: target (person, company, domain, IP)? What OSINT categories (domain, IP, email, social media, public records)? Ethical/legal constraints?',
            dependsOn: [],
        },
        {
            agentType: 'planner',
            description: 'Plan the investigation:\n1. Reconnaissance: domain WHOIS, DNS records, subdomains\n2. IP intelligence: geolocation, ASN, reverse DNS\n3. Email: breach databases, social media profiles\n4. Social media: profile analysis, connections, activity\n5. Public records: company filings, certificates\n6. Documentation: evidence collection, chain of custody',
            dependsOn: ['step-0'],
        },
        {
            agentType: 'runner',
            description: 'Conduct the investigation:\n1. Run WHOIS and DNS queries\n2. Check IP reputation and geolocation\n3. Search for email/domain breaches\n4. Analyze social media presence\n5. Check public records\n6. Document all findings with sources',
            dependsOn: ['step-1'],
        },
        {
            agentType: 'reviewer',
            description: 'Review findings: verify sources, cross-reference data, assess reliability, check legal compliance, produce final report.',
            dependsOn: ['step-2'],
        },
    ],
    parameters: [],
    tags: ['osint', 'intelligence', 'reconnaissance', 'security', 'investigation'],
    sourceTrajectoryIds: ['bundled'],
    qualityScore: 0.85,
    usageCount: 0,
    createdAt: PHASE3_CREATED_AT,
    lastUsedAt: PHASE3_CREATED_AT,
};
export const academicResearchSkill = {
    id: BUNDLED_SKILL_ID_ACADEMIC_RESEARCH,
    name: 'academic-research',
    description: 'Conduct academic literature research: paper discovery, citation analysis, systematic reviews, and research summaries. Use when the goal is to review academic literature on a topic.',
    version: '1.0.0',
    goalPattern: 'academic research literature review paper citation systematic review arxiv pubmed scholar',
    steps: [
        {
            agentType: 'context-gatherer',
            description: 'Map the research topic: what field? What search terms? What databases (arXiv, PubMed, Google Scholar)? What time range? What inclusion criteria?',
            dependsOn: [],
        },
        {
            agentType: 'planner',
            description: 'Plan the literature review:\n1. Search strategy: keywords, boolean operators, databases\n2. Screening: title/abstract → full text selection\n3. Data extraction: methods, findings, quality assessment\n4. Synthesis: thematic analysis, meta-analysis if quantitative\n5. Citation analysis: key papers, influential authors\n6. Reporting: structured summary with gaps identified',
            dependsOn: ['step-0'],
        },
        {
            agentType: 'runner',
            description: 'Execute the review:\n1. Search databases with query strategy\n2. Screen results (title/abstract)\n3. Full-text review of selected papers\n4. Extract key findings\n5. Synthesize across papers\n6. Identify research gaps',
            dependsOn: ['step-1'],
        },
        {
            agentType: 'reviewer',
            description: 'Review: verify search completeness, check extraction accuracy, validate synthesis, ensure citations are correct.',
            dependsOn: ['step-2'],
        },
    ],
    parameters: [],
    tags: ['academic', 'research', 'literature', 'citation', 'review'],
    sourceTrajectoryIds: ['bundled'],
    qualityScore: 0.85,
    usageCount: 0,
    createdAt: PHASE3_CREATED_AT,
    lastUsedAt: PHASE3_CREATED_AT,
};
// ─── Security Advanced ─────────────────────────────────────────────────────
export const BUNDLED_SKILL_ID_PENETRATION_TEST = 'skill-penetration-test';
export const BUNDLED_SKILL_ID_COMPLIANCE_CHECK = 'skill-compliance-check';
export const BUNDLED_SKILL_ID_SECRETS_SCAN = 'skill-secrets-scan';
export const penetrationTestSkill = {
    id: BUNDLED_SKILL_ID_PENETRATION_TEST,
    name: 'penetration-test',
    description: 'Conduct penetration testing: reconnaissance, vulnerability scanning, exploitation, and reporting. Covers OWASP testing guide, common attack vectors, and responsible disclosure. Use when testing application security.',
    version: '1.0.0',
    goalPattern: 'penetration testing pen test vulnerability exploitation OWASP attack vector security testing',
    steps: [
        {
            agentType: 'context-gatherer',
            description: 'Map the target: what application type (web, API, mobile)? What scope (full, limited)? Authorization obtained? Testing environment vs production?',
            dependsOn: [],
        },
        {
            agentType: 'planner',
            description: 'Plan the pentest:\n1. Reconnaissance: technology fingerprinting, directory enumeration\n2. Vulnerability scanning: automated + manual testing\n3. Exploitation: attempt to exploit found vulnerabilities\n4. Post-exploitation: assess impact, data access\n5. Reporting: findings with severity, evidence, remediation\n6. Responsible disclosure: timeline for fix verification',
            dependsOn: ['step-0'],
        },
        {
            agentType: 'runner',
            description: 'Execute the pentest:\n1. Run reconnaissance (nmap, whatweb, dirb)\n2. Scan for vulnerabilities (nuclei, nikto)\n3. Manual testing of high-risk areas\n4. Attempt exploitation\n5. Document all findings\n6. Clean up any test artifacts',
            dependsOn: ['step-1'],
        },
        {
            agentType: 'reviewer',
            description: 'Review: verify findings are valid, check severity ratings, ensure remediation steps are clear, confirm no production data was accessed.',
            dependsOn: ['step-2'],
        },
    ],
    parameters: [],
    tags: ['pentest', 'security', 'vulnerability', 'owasp', 'testing'],
    sourceTrajectoryIds: ['bundled'],
    qualityScore: 0.85,
    usageCount: 0,
    createdAt: PHASE3_CREATED_AT,
    lastUsedAt: PHASE3_CREATED_AT,
};
export const complianceCheckSkill = {
    id: BUNDLED_SKILL_ID_COMPLIANCE_CHECK,
    name: 'compliance-check',
    description: 'Check regulatory compliance: GDPR, HIPAA, SOC2, PCI-DSS. Covers requirements mapping, gap analysis, control implementation, and audit preparation. Use when ensuring an application meets compliance standards.',
    version: '1.0.0',
    goalPattern: 'compliance GDPR HIPAA SOC2 PCI-DSS audit requirements gap analysis controls regulatory',
    steps: [
        {
            agentType: 'context-gatherer',
            description: 'Map the compliance landscape: what regulations apply (GDPR, HIPAA, SOC2, PCI-DSS)? What data is processed? What controls exist? What gaps are known?',
            dependsOn: [],
        },
        {
            agentType: 'planner',
            description: 'Plan the compliance check:\n1. Requirements mapping: regulation → specific requirements → current controls\n2. Gap analysis: what requirements are not met\n3. Control implementation: technical and organizational measures\n4. Documentation: policies, procedures, evidence\n5. Audit preparation: evidence collection, walkthrough readiness\n6. Continuous monitoring: ongoing compliance checks',
            dependsOn: ['step-0'],
        },
        {
            agentType: 'runner',
            description: 'Execute the check:\n1. Map requirements to current implementation\n2. Identify gaps\n3. Implement missing controls\n4. Create documentation\n5. Collect evidence\n6. Prepare audit materials',
            dependsOn: ['step-1'],
        },
        {
            agentType: 'reviewer',
            description: 'Review: verify all requirements addressed, evidence is sufficient, controls are effective, documentation is complete.',
            dependsOn: ['step-2'],
        },
    ],
    parameters: [],
    tags: ['compliance', 'gdpr', 'hipaa', 'soc2', 'audit'],
    sourceTrajectoryIds: ['bundled'],
    qualityScore: 0.85,
    usageCount: 0,
    createdAt: PHASE3_CREATED_AT,
    lastUsedAt: PHASE3_CREATED_AT,
};
export const secretsScanSkill = {
    id: BUNDLED_SKILL_ID_SECRETS_SCAN,
    name: 'secrets-scan',
    description: 'Scan codebases for leaked secrets: API keys, passwords, tokens, certificates. Covers detection patterns, false positive handling, and remediation. Use when auditing for credential exposure.',
    version: '1.0.0',
    goalPattern: 'secrets scan API key password token credential leak detection remediation gitleaks trufflehog',
    steps: [
        {
            agentType: 'context-gatherer',
            description: 'Map the scan scope: what repositories? What file types to scan? What secret patterns to detect? What history depth?',
            dependsOn: [],
        },
        {
            agentType: 'planner',
            description: 'Plan the secrets scan:\n1. Tools: gitleaks, trufflehog, or custom regex patterns\n2. Patterns: AWS keys, GitHub tokens, database URLs, private keys\n3. Exclusions: test fixtures, example files, documentation\n4. False positive handling: baseline, allowlists\n5. Remediation: rotate secrets, add to .gitignore, use vault\n6. Prevention: pre-commit hooks, CI/CD scanning',
            dependsOn: ['step-0'],
        },
        {
            agentType: 'runner',
            description: 'Execute the scan:\n1. Run secret detection tool against repo\n2. Review findings, filter false positives\n3. Document all confirmed secrets\n4. Verify secrets are not active (test them)\n5. Create remediation plan\n6. Set up prevention (pre-commit hooks)',
            dependsOn: ['step-1'],
        },
        {
            agentType: 'reviewer',
            description: 'Review: verify all secrets found, confirm rotation happened, check prevention is in place, verify no active secrets remain.',
            dependsOn: ['step-2'],
        },
    ],
    parameters: [],
    tags: ['secrets', 'security', 'scanning', 'credentials', 'leak-detection'],
    sourceTrajectoryIds: ['bundled'],
    qualityScore: 0.85,
    usageCount: 0,
    createdAt: PHASE3_CREATED_AT,
    lastUsedAt: PHASE3_CREATED_AT,
};
// ─── Software Development ──────────────────────────────────────────────────
export const BUNDLED_SKILL_ID_CODE_REVIEW = 'skill-code-review';
export const BUNDLED_SKILL_ID_DEPENDENCY_AUDIT = 'skill-dependency-audit';
export const BUNDLED_SKILL_ID_MONOREPO_SETUP = 'skill-monorepo-setup';
export const codeReviewSkill = {
    id: BUNDLED_SKILL_ID_CODE_REVIEW,
    name: 'code-review',
    description: 'Conduct thorough code reviews: correctness, security, performance, readability, and test coverage. Covers review checklists, constructive feedback, and automated review tools. Use when reviewing pull requests or code changes.',
    version: '1.0.0',
    goalPattern: 'code review pull request PR review feedback correctness security performance readability test coverage',
    steps: [
        {
            agentType: 'context-gatherer',
            description: 'Map the change: what files changed? What is the PR description? What tests exist? What is the change scope (bug fix, feature, refactor)?',
            dependsOn: [],
        },
        {
            agentType: 'planner',
            description: 'Plan the review:\n1. Correctness: does the code do what it claims? Edge cases handled?\n2. Security: injection, auth bypass, data exposure?\n3. Performance: O(n²) loops? N+1 queries? Memory leaks?\n4. Readability: clear naming, comments where needed, DRY?\n5. Tests: adequate coverage? Edge cases tested?\n6. Architecture: fits the existing patterns? Appropriate abstractions?',
            dependsOn: ['step-0'],
        },
        {
            agentType: 'runner',
            description: 'Conduct the review:\n1. Read the full diff with context\n2. Check each file against review criteria\n3. Verify tests pass and cover edge cases\n4. Check for security issues\n5. Note performance concerns\n6. Write constructive feedback with specific suggestions',
            dependsOn: ['step-1'],
        },
        {
            agentType: 'reviewer',
            description: 'Finalize the review: categorize findings (blocking, suggestion, nit), verify all feedback is actionable, ensure tone is constructive.',
            dependsOn: ['step-2'],
        },
    ],
    parameters: [],
    tags: ['code-review', 'pull-request', 'quality', 'security', 'feedback'],
    sourceTrajectoryIds: ['bundled'],
    qualityScore: 0.85,
    usageCount: 0,
    createdAt: PHASE3_CREATED_AT,
    lastUsedAt: PHASE3_CREATED_AT,
};
export const dependencyAuditSkill = {
    id: BUNDLED_SKILL_ID_DEPENDENCY_AUDIT,
    name: 'dependency-audit',
    description: 'Audit project dependencies for vulnerabilities, outdated versions, license compliance, and supply chain risks. Use when ensuring dependency health and security.',
    version: '1.0.0',
    goalPattern: 'dependency audit vulnerability outdated license supply chain security npm audit',
    steps: [
        {
            agentType: 'context-gatherer',
            description: 'Map the dependencies: what package manager (npm, pip, cargo)? How many direct and transitive dependencies? Current lockfile?',
            dependsOn: [],
        },
        {
            agentType: 'planner',
            description: 'Plan the audit:\n1. Vulnerability scan: npm audit, pip-audit, cargo audit\n2. Outdated check: npm outdated, pip list --outdated\n3. License audit: license-checker, licensee\n4. Supply chain: verify checksums, check maintainer reputation\n5. Update strategy: semver compatibility, breaking changes\n6. Automation: Dependabot, Renovate bot',
            dependsOn: ['step-0'],
        },
        {
            agentType: 'runner',
            description: 'Execute the audit:\n1. Run vulnerability scanner\n2. Check for outdated packages\n3. Audit licenses for compliance\n4. Review high-risk dependencies\n5. Create update plan\n6. Set up automated updates',
            dependsOn: ['step-1'],
        },
        {
            agentType: 'reviewer',
            description: 'Review: verify all vulnerabilities addressed, licenses compliant, update plan is feasible, automation configured.',
            dependsOn: ['step-2'],
        },
    ],
    parameters: [],
    tags: ['dependencies', 'audit', 'security', 'vulnerability', 'license'],
    sourceTrajectoryIds: ['bundled'],
    qualityScore: 0.85,
    usageCount: 0,
    createdAt: PHASE3_CREATED_AT,
    lastUsedAt: PHASE3_CREATED_AT,
};
export const monorepoSetupSkill = {
    id: BUNDLED_SKILL_ID_MONOREPO_SETUP,
    name: 'monorepo-setup',
    description: 'Set up a monorepo with Turborepo, Nx, or Lerna: workspace configuration, build caching, dependency management, and CI optimization. Use when organizing multiple packages in a single repository.',
    version: '1.0.0',
    goalPattern: 'monorepo turborepo nx lerna workspace build caching dependency management CI optimization',
    steps: [
        {
            agentType: 'context-gatherer',
            description: 'Map the monorepo: how many packages? What languages? What build tools? What CI system? What shared code between packages?',
            dependsOn: [],
        },
        {
            agentType: 'planner',
            description: 'Design the monorepo:\n1. Tool: Turborepo (fast, simple), Nx (powerful, opinionated), or Lerna (npm-focused)\n2. Workspaces: configure package manager workspaces\n3. Build: topological build order, parallel execution, caching\n4. Dependencies: shared dependencies, version management\n5. CI: affected-only builds, cache restoration\n6. Code sharing: shared configs, utilities, types',
            dependsOn: ['step-0'],
        },
        {
            agentType: 'runner',
            description: 'Set up the monorepo:\n1. Initialize workspace configuration\n2. Configure build tool (Turbo/Nx/Lerna)\n3. Move packages into workspace structure\n4. Set up shared configurations\n5. Configure build caching\n6. Update CI pipeline',
            dependsOn: ['step-1'],
        },
        {
            agentType: 'reviewer',
            description: 'Verify: builds work, caching works (verify second build is faster), dependency graph is correct, CI runs affected-only.',
            dependsOn: ['step-2'],
        },
    ],
    parameters: [],
    tags: ['monorepo', 'turborepo', 'nx', 'workspace', 'build'],
    sourceTrajectoryIds: ['bundled'],
    qualityScore: 0.85,
    usageCount: 0,
    createdAt: PHASE3_CREATED_AT,
    lastUsedAt: PHASE3_CREATED_AT,
};
// ─── Web Development ───────────────────────────────────────────────────────
export const BUNDLED_SKILL_ID_SSR_SETUP = 'skill-ssr-setup';
export const BUNDLED_SKILL_ID_PWA_BUILDER = 'skill-pwa-builder';
export const BUNDLED_SKILL_ID_MICRO_FRONTEND = 'skill-micro-frontend';
export const ssrSetupSkill = {
    id: BUNDLED_SKILL_ID_SSR_SETUP,
    name: 'ssr-setup',
    description: 'Set up server-side rendering: Next.js, Nuxt, or SvelteKit SSR configuration, hydration, streaming, and caching strategies. Use when the goal is to improve initial load performance and SEO with server rendering.',
    version: '1.0.0',
    goalPattern: 'SSR server side rendering Next.js Nuxt SvelteKit hydration streaming caching SEO performance',
    steps: [
        {
            agentType: 'context-gatherer',
            description: 'Map the SSR needs: what framework? What pages need SSR vs static? What data fetching patterns? Caching requirements?',
            dependsOn: [],
        },
        {
            agentType: 'planner',
            description: 'Design SSR architecture:\n1. Framework config: Next.js app router, Nuxt server routes, SvelteKit load functions\n2. Data fetching: server components, getServerSideProps, API routes\n3. Hydration: client-side hydration strategy, streaming with Suspense\n4. Caching: ISR (Incremental Static Regeneration), edge caching, stale-while-revalidate\n5. SEO: meta tags, structured data, sitemap, robots.txt\n6. Performance: streaming SSR, partial hydration, selective hydration',
            dependsOn: ['step-0'],
        },
        {
            agentType: 'runner',
            description: 'Implement SSR:\n1. Configure framework for SSR\n2. Move data fetching to server side\n3. Set up streaming/hydration\n4. Configure caching strategy\n5. Add SEO meta tags\n6. Test with Lighthouse',
            dependsOn: ['step-1'],
        },
        {
            agentType: 'reviewer',
            description: 'Verify: pages render server-side, hydration works, caching effective, SEO score improved, performance metrics acceptable.',
            dependsOn: ['step-2'],
        },
    ],
    parameters: [],
    tags: ['ssr', 'nextjs', 'nuxt', 'performance', 'seo'],
    sourceTrajectoryIds: ['bundled'],
    qualityScore: 0.85,
    usageCount: 0,
    createdAt: PHASE3_CREATED_AT,
    lastUsedAt: PHASE3_CREATED_AT,
};
export const pwaBuilderSkill = {
    id: BUNDLED_SKILL_ID_PWA_BUILDER,
    name: 'pwa-builder',
    description: 'Build a Progressive Web App: service workers, offline support, push notifications, app manifest, and installability. Use when the goal is to create an installable web app with offline capabilities.',
    version: '1.0.0',
    goalPattern: 'PWA progressive web app service worker offline push notifications manifest installable',
    steps: [
        {
            agentType: 'context-gatherer',
            description: 'Map the PWA requirements: what offline pages needed? What push notification provider? What caching strategy? What install experience?',
            dependsOn: [],
        },
        {
            agentType: 'planner',
            description: 'Design the PWA:\n1. Manifest: name, icons, theme color, display: standalone\n2. Service worker: cache-first for static, network-first for API\n3. Offline: offline page, cached assets, background sync\n4. Push notifications: Web Push API, notification permissions\n5. Installability: manifest + service worker = install prompt\n6. Update: service worker update flow with user notification',
            dependsOn: ['step-0'],
        },
        {
            agentType: 'runner',
            description: 'Build the PWA:\n1. Create web manifest with icons\n2. Register service worker\n3. Implement caching strategies\n4. Add offline fallback page\n5. Set up push notifications\n6. Test installability',
            dependsOn: ['step-1'],
        },
        {
            agentType: 'reviewer',
            description: 'Verify: offline mode works, push notifications received, app installs, service worker updates correctly.',
            dependsOn: ['step-2'],
        },
    ],
    parameters: [],
    tags: ['pwa', 'service-worker', 'offline', 'push-notifications', 'install'],
    sourceTrajectoryIds: ['bundled'],
    qualityScore: 0.85,
    usageCount: 0,
    createdAt: PHASE3_CREATED_AT,
    lastUsedAt: PHASE3_CREATED_AT,
};
export const microFrontendSkill = {
    id: BUNDLED_SKILL_ID_MICRO_FRONTEND,
    name: 'micro-frontend',
    description: 'Set up micro-frontends: module federation, iframes, or Web Components for independent team deployments. Covers routing, shared state, and communication between micro-frontends. Use when scaling frontend development across teams.',
    version: '1.0.0',
    goalPattern: 'micro-frontend module federation iframe web components independent deployment routing shared state',
    steps: [
        {
            agentType: 'context-gatherer',
            description: 'Map the architecture: how many teams? What frameworks? What shared state? What routing strategy? What deployment model?',
            dependsOn: [],
        },
        {
            agentType: 'planner',
            description: 'Design the micro-frontend architecture:\n1. Approach: module federation (Webpack 5), single-spa, or iframe isolation\n2. Shell app: routing, layout, shared navigation\n3. Micro-apps: independent builds, independent deployments\n4. Shared state: events bus, shared context, or URL-based\n5. Routing: path-based or attribute-based composition\n6. Communication: CustomEvents, shared library, or message passing',
            dependsOn: ['step-0'],
        },
        {
            agentType: 'runner',
            description: 'Implement micro-frontends:\n1. Set up shell application\n2. Configure module federation or single-spa\n3. Create first micro-app\n4. Implement routing between micro-apps\n5. Add shared state/communication\n6. Test independent deployment',
            dependsOn: ['step-1'],
        },
        {
            agentType: 'reviewer',
            description: 'Verify: micro-apps load independently, routing works, shared state syncs, deployment is independent, performance is acceptable.',
            dependsOn: ['step-2'],
        },
    ],
    parameters: [],
    tags: ['micro-frontend', 'module-federation', 'architecture', 'scalability'],
    sourceTrajectoryIds: ['bundled'],
    qualityScore: 0.85,
    usageCount: 0,
    createdAt: PHASE3_CREATED_AT,
    lastUsedAt: PHASE3_CREATED_AT,
};
// ─── Windows-Specific Skills ───────────────────────────────────────────────
export const BUNDLED_SKILL_ID_POWERSHELL_AUTOMATION = 'skill-powershell-automation';
export const BUNDLED_SKILL_ID_WSL_SETUP = 'skill-wsl-setup';
export const BUNDLED_SKILL_ID_REGISTRY_MANAGEMENT = 'skill-registry-management';
export const BUNDLED_SKILL_ID_GROUP_POLICY = 'skill-group-policy';
export const powershellAutomationSkill = {
    id: BUNDLED_SKILL_ID_POWERSHELL_AUTOMATION,
    name: 'powershell-automation',
    description: 'Automate Windows tasks with PowerShell: scripts, modules, DSC (Desired State Configuration), scheduled tasks, and Windows service management. Use when automating Windows system administration.',
    version: '1.0.0',
    goalPattern: 'powershell automation script module DSC windows scheduled task service management administration',
    steps: [
        {
            agentType: 'context-gatherer',
            description: 'Map the automation: what Windows task needs automating? What PowerShell version? What modules needed? Scheduling requirements?',
            dependsOn: [],
        },
        {
            agentType: 'planner',
            description: 'Design the PowerShell automation:\n1. Script structure: functions, error handling, logging\n2. Parameters: mandatory/optional, validation, pipeline input\n3. DSC: desired state configuration for server setup\n4. Scheduling: Task Scheduler for recurring tasks\n5. Services: install/start/stop Windows services\n6. Output: structured objects, CSV/JSON export',
            dependsOn: ['step-0'],
        },
        {
            agentType: 'runner',
            description: 'Implement the automation:\n1. Write PowerShell script with proper error handling\n2. Add parameter validation\n3. Implement logging\n4. Create scheduled task if needed\n5. Test on Windows\n6. Document usage',
            dependsOn: ['step-1'],
        },
        {
            agentType: 'reviewer',
            description: 'Verify: script runs without errors, handles edge cases, logging works, scheduled task triggers correctly.',
            dependsOn: ['step-2'],
        },
    ],
    parameters: [],
    tags: ['powershell', 'windows', 'automation', 'scripting', 'dsc'],
    sourceTrajectoryIds: ['bundled'],
    qualityScore: 0.85,
    usageCount: 0,
    createdAt: PHASE3_CREATED_AT,
    lastUsedAt: PHASE3_CREATED_AT,
};
export const wslSetupSkill = {
    id: BUNDLED_SKILL_ID_WSL_SETUP,
    name: 'wsl-setup',
    description: 'Set up and configure Windows Subsystem for Linux (WSL): distribution selection, filesystem configuration, networking, GPU passthrough, and development environment setup. Use when setting up a Linux development environment on Windows.',
    version: '1.0.0',
    goalPattern: 'WSL windows subsystem linux setup configuration development environment GPU networking',
    steps: [
        {
            agentType: 'context-gatherer',
            description: 'Map the WSL setup: what distribution (Ubuntu, Debian, Fedora)? What development tools needed? GPU support? Network configuration?',
            dependsOn: [],
        },
        {
            agentType: 'planner',
            description: 'Design the WSL setup:\n1. Distribution: choose and install WSL distro\n2. Filesystem: /mnt/c for Windows files, ext4 for Linux\n3. Networking: mirrored mode for port forwarding\n4. GPU: WSL2 GPU passthrough for CUDA/ML\n5. Dev tools: git, docker, node, python, vscode\n6. Integration: VSCode Remote WSL, Windows Terminal profiles',
            dependsOn: ['step-0'],
        },
        {
            agentType: 'runner',
            description: 'Set up WSL:\n1. Enable WSL2 feature\n2. Install chosen distribution\n3. Configure networking mode\n4. Set up GPU passthrough\n5. Install development tools\n6. Configure VSCode integration',
            dependsOn: ['step-1'],
        },
        {
            agentType: 'reviewer',
            description: 'Verify: Linux commands work, filesystem accessible, networking works, GPU detected, dev tools functional.',
            dependsOn: ['step-2'],
        },
    ],
    parameters: [],
    tags: ['wsl', 'windows', 'linux', 'development', 'gpu'],
    sourceTrajectoryIds: ['bundled'],
    qualityScore: 0.85,
    usageCount: 0,
    createdAt: PHASE3_CREATED_AT,
    lastUsedAt: PHASE3_CREATED_AT,
};
export const registryManagementSkill = {
    id: BUNDLED_SKILL_ID_REGISTRY_MANAGEMENT,
    name: 'registry-management',
    description: 'Manage the Windows Registry: reading, writing, exporting, importing, and backup of registry keys. Covers reg.exe, PowerShell registry cmdlets, and .reg files. Use when configuring Windows settings via the registry.',
    version: '1.0.0',
    goalPattern: 'windows registry management reg.exe powershell backup export import configure settings',
    steps: [
        {
            agentType: 'context-gatherer',
            description: 'Map the registry task: what keys need modification? What values? Backup needed? Import/export format?',
            dependsOn: [],
        },
        {
            agentType: 'planner',
            description: 'Design the registry operation:\n1. Read: Get-ItemProperty, reg query\n2. Write: Set-ItemProperty, reg add\n3. Backup: reg export, backup .reg files\n4. Import: reg import, .reg file merge\n5. Permissions: RunAs administrator when needed\n6. Safety: always backup before modifying',
            dependsOn: ['step-0'],
        },
        {
            agentType: 'runner',
            description: 'Execute registry operations:\n1. Backup target registry keys\n2. Verify backup file\n3. Apply registry changes\n4. Verify changes took effect\n5. Restart affected services if needed\n6. Document all changes',
            dependsOn: ['step-1'],
        },
        {
            agentType: 'reviewer',
            description: 'Verify: backup exists, registry changes applied, system behaves as expected, rollback works.',
            dependsOn: ['step-2'],
        },
    ],
    parameters: [],
    tags: ['registry', 'windows', 'configuration', 'backup', 'system'],
    sourceTrajectoryIds: ['bundled'],
    qualityScore: 0.85,
    usageCount: 0,
    createdAt: PHASE3_CREATED_AT,
    lastUsedAt: PHASE3_CREATED_AT,
};
export const groupPolicySkill = {
    id: BUNDLED_SKILL_ID_GROUP_POLICY,
    name: 'group-policy',
    description: 'Manage Group Policy: Local Group Policy Editor, GPO creation, policy deployment, and troubleshooting. Use when configuring Windows security and administrative policies.',
    version: '1.0.0',
    goalPattern: 'group policy GPO windows security configuration deployment management local policy',
    steps: [
        {
            agentType: 'context-gatherer',
            description: 'Map the policy requirements: what policies needed (security, software restriction, folder redirection)? Local or domain? What OU structure?',
            dependsOn: [],
        },
        {
            agentType: 'planner',
            description: 'Design the group policy:\n1. Policy type: computer config vs user config\n2. Security policies: password, account lockout, audit\n3. Software restriction: app whitelisting, execution policies\n4. Folder redirection: desktop, documents, app data\n5. Deployment: local GPO vs domain GPO vs Intune\n6. Troubleshooting: gpresult, rsop.msc',
            dependsOn: ['step-0'],
        },
        {
            agentType: 'runner',
            description: 'Configure group policy:\n1. Open Group Policy Editor\n2. Configure computer/user policies\n3. Set security settings\n4. Apply folder redirection if needed\n5. Run gpupdate /force\n6. Verify with gpresult',
            dependsOn: ['step-1'],
        },
        {
            agentType: 'reviewer',
            description: 'Verify: policies applied (gpresult), security settings enforced, no conflicts with existing policies, rollback plan documented.',
            dependsOn: ['step-2'],
        },
    ],
    parameters: [],
    tags: ['group-policy', 'windows', 'security', 'configuration', 'management'],
    sourceTrajectoryIds: ['bundled'],
    qualityScore: 0.85,
    usageCount: 0,
    createdAt: PHASE3_CREATED_AT,
    lastUsedAt: PHASE3_CREATED_AT,
};
// ─── Platform / Cross-Platform ─────────────────────────────────────────────
export const BUNDLED_SKILL_ID_CROSS_PLATFORM_BUILD = 'skill-cross-platform-build';
export const BUNDLED_SKILL_ID_ELECTRON_APP = 'skill-electron-app';
export const BUNDLED_SKILL_ID_MOBILE_BRIDGE = 'skill-mobile-bridge';
export const crossPlatformBuildSkill = {
    id: BUNDLED_SKILL_ID_CROSS_PLATFORM_BUILD,
    name: 'cross-platform-build',
    description: 'Build cross-platform applications: shared codebase targeting web, desktop (Electron/Tauri), and mobile (React Native/Flutter). Covers platform detection, shared logic, and platform-specific adaptations. Use when building for multiple platforms from one codebase.',
    version: '1.0.0',
    goalPattern: 'cross platform build electron tauri react native flutter shared codebase multi-platform',
    steps: [
        {
            agentType: 'context-gatherer',
            description: 'Map the platforms: what targets (web, desktop, mobile)? What shared business logic? What platform-specific features (camera, GPS, notifications)?',
            dependsOn: [],
        },
        {
            agentType: 'planner',
            description: 'Design the cross-platform architecture:\n1. Shared layer: business logic, data models, API clients (TypeScript/Dart/Kotlin)\n2. Platform adapters: interfaces for platform-specific code\n3. UI: shared components where possible, platform-specific where needed\n4. Build system: platform-specific builds from shared source\n5. Testing: shared tests for business logic, platform-specific E2E\n6. Deployment: platform-specific release pipelines',
            dependsOn: ['step-0'],
        },
        {
            agentType: 'runner',
            description: 'Implement cross-platform build:\n1. Set up shared project structure\n2. Extract shared business logic\n3. Create platform adapters\n4. Implement platform-specific UI\n5. Configure build for each platform\n6. Test on all target platforms',
            dependsOn: ['step-1'],
        },
        {
            agentType: 'reviewer',
            description: 'Verify: app builds for all platforms, shared logic works identically, platform features accessible, performance acceptable.',
            dependsOn: ['step-2'],
        },
    ],
    parameters: [],
    tags: ['cross-platform', 'electron', 'tauri', 'react-native', 'flutter'],
    sourceTrajectoryIds: ['bundled'],
    qualityScore: 0.85,
    usageCount: 0,
    createdAt: PHASE3_CREATED_AT,
    lastUsedAt: PHASE3_CREATED_AT,
};
export const electronAppSkill = {
    id: BUNDLED_SKILL_ID_ELECTRON_APP,
    name: 'electron-app',
    description: 'Build an Electron desktop application: main process, renderer process, IPC communication, auto-updates, and native modules. Use when creating a desktop application with web technologies.',
    version: '1.0.0',
    goalPattern: 'electron desktop app main process renderer IPC auto-update native modules packaging',
    steps: [
        {
            agentType: 'context-gatherer',
            description: 'Map the Electron app: what does it do? What native features (file system, notifications, tray)? What framework for UI (React, Vue, Svelte)?',
            dependsOn: [],
        },
        {
            agentType: 'planner',
            description: 'Design the Electron app:\n1. Architecture: main process (Node.js) + renderer (web)\n2. IPC: secure communication between processes\n3. Native modules: file system, notifications, system info\n4. Auto-update: electron-updater with GitHub releases\n5. Packaging: electron-builder or electron-forge\n6. Security: context isolation, no nodeIntegration, CSP headers',
            dependsOn: ['step-0'],
        },
        {
            agentType: 'runner',
            description: 'Build the Electron app:\n1. Set up Electron with TypeScript\n2. Create main process with window management\n3. Implement IPC communication\n4. Add native features (notifications, file dialogs)\n5. Configure auto-updater\n6. Package for distribution (dmg, exe, AppImage)',
            dependsOn: ['step-1'],
        },
        {
            agentType: 'reviewer',
            description: 'Verify: app launches, IPC works, native features functional, auto-update works, packaged app runs correctly.',
            dependsOn: ['step-2'],
        },
    ],
    parameters: [],
    tags: ['electron', 'desktop', 'app', 'ipc', 'packaging'],
    sourceTrajectoryIds: ['bundled'],
    qualityScore: 0.85,
    usageCount: 0,
    createdAt: PHASE3_CREATED_AT,
    lastUsedAt: PHASE3_CREATED_AT,
};
export const mobileBridgeSkill = {
    id: BUNDLED_SKILL_ID_MOBILE_BRIDGE,
    name: 'mobile-bridge',
    description: 'Bridge web and native mobile: Capacitor, Cordova, or React Native bridge for accessing native device features from web code. Use when adding native mobile capabilities to a web application.',
    version: '1.0.0',
    goalPattern: 'mobile bridge capacitor cordova react native native features camera GPS push notifications',
    steps: [
        {
            agentType: 'context-gatherer',
            description: 'Map the native features: what device APIs needed (camera, GPS, push notifications, biometrics)? What framework? iOS and/or Android?',
            dependsOn: [],
        },
        {
            agentType: 'planner',
            description: 'Design the mobile bridge:\n1. Framework: Capacitor (modern, recommended), Cordova (legacy), or React Native\n2. Native plugins: camera, geolocation, push notifications, haptics\n3. Build: platform-specific build configuration\n4. Testing: device testing, emulator testing\n5. Distribution: App Store, Play Store, or sideloading\n6. Updates: code push or app store updates',
            dependsOn: ['step-0'],
        },
        {
            agentType: 'runner',
            description: 'Implement the bridge:\n1. Add Capacitor/Cordova to the web project\n2. Install native plugins\n3. Configure platform builds\n4. Implement native feature calls\n5. Test on device/emulator\n6. Build for distribution',
            dependsOn: ['step-1'],
        },
        {
            agentType: 'reviewer',
            description: 'Verify: native features work on device, performance acceptable, no memory leaks, app store build succeeds.',
            dependsOn: ['step-2'],
        },
    ],
    parameters: [],
    tags: ['mobile', 'bridge', 'capacitor', 'cordova', 'native'],
    sourceTrajectoryIds: ['bundled'],
    qualityScore: 0.85,
    usageCount: 0,
    createdAt: PHASE3_CREATED_AT,
    lastUsedAt: PHASE3_CREATED_AT,
};
// ─── Productivity Advanced ─────────────────────────────────────────────────
export const BUNDLED_SKILL_ID_KANBAN_BOARD = 'skill-kanban-board';
export const BUNDLED_SKILL_ID_CHECKPOINT_MANAGER = 'skill-checkpoint-manager';
export const kanbanBoardSkill = {
    id: BUNDLED_SKILL_ID_KANBAN_BOARD,
    name: 'kanban-board',
    description: 'Build a Kanban board: drag-and-drop columns, WIP limits, swimlanes, and workflow automation. Use when creating a visual project management tool.',
    version: '1.0.0',
    goalPattern: 'kanban board drag drop columns WIP limits workflow project management task tracking',
    steps: [
        {
            agentType: 'context-gatherer',
            description: 'Map the board: what columns (Backlog, Todo, In Progress, Review, Done)? What WIP limits? What swimlanes? What automation rules?',
            dependsOn: [],
        },
        {
            agentType: 'planner',
            description: 'Design the Kanban board:\n1. Data model: boards, columns, cards, labels, assignees\n2. UI: drag-and-drop (dnd-kit, react-beautiful-dnd)\n3. WIP limits: visual indicators, prevent exceeding limits\n4. Swimlanes: grouping by team, priority, or category\n5. Automation: move card when status changes, auto-assign\n6. Persistence: database or local storage',
            dependsOn: ['step-0'],
        },
        {
            agentType: 'runner',
            description: 'Build the Kanban board:\n1. Create data model and API\n2. Build drag-and-drop UI\n3. Implement WIP limits\n4. Add swimlanes\n5. Set up automation rules\n6. Test with sample data',
            dependsOn: ['step-1'],
        },
        {
            agentType: 'reviewer',
            description: 'Verify: drag-and-drop works, WIP limits enforced, automation triggers, data persists, responsive on mobile.',
            dependsOn: ['step-2'],
        },
    ],
    parameters: [],
    tags: ['kanban', 'project-management', 'drag-drop', 'workflow', 'productivity'],
    sourceTrajectoryIds: ['bundled'],
    qualityScore: 0.85,
    usageCount: 0,
    createdAt: PHASE3_CREATED_AT,
    lastUsedAt: PHASE3_CREATED_AT,
};
export const checkpointManagerSkill = {
    id: BUNDLED_SKILL_ID_CHECKPOINT_MANAGER,
    name: 'checkpoint-manager',
    description: 'Manage code checkpoints: save progress snapshots, rollback to checkpoints, compare versions, and restore state. Use when building safety nets for complex refactoring or migration tasks.',
    version: '1.0.0',
    goalPattern: 'checkpoint save snapshot rollback restore version compare safety net refactoring',
    steps: [
        {
            agentType: 'context-gatherer',
            description: 'Map the checkpoint needs: what state to save (files, database, config)? How many checkpoints? Comparison needs? Rollback granularity?',
            dependsOn: [],
        },
        {
            agentType: 'planner',
            description: 'Design the checkpoint system:\n1. Save: capture file state, database state, config state\n2. Store: git branches, tar archives, or database snapshots\n3. Restore: selective or full rollback\n4. Compare: diff between checkpoints\n5. Naming: descriptive checkpoint names with timestamps\n6. Cleanup: auto-expire old checkpoints',
            dependsOn: ['step-0'],
        },
        {
            agentType: 'runner',
            description: 'Implement checkpoint management:\n1. Create save function (capture current state)\n2. Implement restore function\n3. Add comparison (diff between checkpoints)\n4. Set up auto-cleanup\n5. Test save/restore cycle\n6. Test rollback with data preservation',
            dependsOn: ['step-1'],
        },
        {
            agentType: 'reviewer',
            description: 'Verify: checkpoints save correctly, restore works, comparison shows differences, cleanup runs, no data loss.',
            dependsOn: ['step-2'],
        },
    ],
    parameters: [],
    tags: ['checkpoint', 'snapshot', 'rollback', 'safety', 'versioning'],
    sourceTrajectoryIds: ['bundled'],
    qualityScore: 0.85,
    usageCount: 0,
    createdAt: PHASE3_CREATED_AT,
    lastUsedAt: PHASE3_CREATED_AT,
};
// ─── Debug / Development ───────────────────────────────────────────────────
export const BUNDLED_SKILL_ID_DEBUG_HELPERS = 'skill-debug-helpers';
export const BUNDLED_SKILL_ID_TERMINAL_HINTS = 'skill-terminal-hints';
export const debugHelpersSkill = {
    id: BUNDLED_SKILL_ID_DEBUG_HELPERS,
    name: 'debug-helpers',
    description: 'Debug application issues: breakpoints, logging, profiling, memory analysis, and network inspection. Covers Chrome DevTools, Node.js inspector, and language-specific debuggers. Use when diagnosing bugs or performance issues.',
    version: '1.0.0',
    goalPattern: 'debug debugging breakpoints logging profiling memory analysis network inspection devtools inspector',
    steps: [
        {
            agentType: 'context-gatherer',
            description: 'Map the issue: what is the symptom? What runtime (browser, Node.js, Python)? What tools available? Reproduction steps?',
            dependsOn: [],
        },
        {
            agentType: 'planner',
            description: 'Plan the debugging approach:\n1. Reproduction: minimal steps to reproduce the issue\n2. Logging: add strategic console.log/print statements\n3. Breakpoints: set breakpoints at critical points\n4. Profiling: CPU profile, memory snapshot\n5. Network: request/response inspection\n6. Tools: Chrome DevTools, Node inspector, pdb, lldb',
            dependsOn: ['step-0'],
        },
        {
            agentType: 'runner',
            description: 'Debug the issue:\n1. Reproduce the bug\n2. Add logging around the suspected area\n3. Set breakpoints and step through code\n4. Capture memory/CPU profile\n5. Identify root cause\n6. Implement fix and verify',
            dependsOn: ['step-1'],
        },
        {
            agentType: 'reviewer',
            description: 'Verify: fix resolves the issue, no regressions, logging is appropriate (not verbose), performance is maintained.',
            dependsOn: ['step-2'],
        },
    ],
    parameters: [],
    tags: ['debug', 'debugging', 'profiling', 'performance', 'tools'],
    sourceTrajectoryIds: ['bundled'],
    qualityScore: 0.85,
    usageCount: 0,
    createdAt: PHASE3_CREATED_AT,
    lastUsedAt: PHASE3_CREATED_AT,
};
export const terminalHintsSkill = {
    id: BUNDLED_SKILL_ID_TERMINAL_HINTS,
    name: 'terminal-hints',
    description: 'Provide intelligent terminal assistance: command suggestions, error interpretation, shell completions, and workflow automation. Use when helping users with terminal commands or diagnosing shell errors.',
    version: '1.0.0',
    goalPattern: 'terminal hints command suggestion error interpretation shell completion workflow automation',
    steps: [
        {
            agentType: 'context-gatherer',
            description: 'Map the terminal context: what shell (bash, zsh, fish, PowerShell)? What was the user trying to do? What error occurred?',
            dependsOn: [],
        },
        {
            agentType: 'planner',
            description: 'Plan the terminal assistance:\n1. Error interpretation: parse error messages, suggest fixes\n2. Command suggestions: based on partial input or intent\n3. Shell completions: tab completion for commands\n4. Workflow automation: alias, function, or script suggestions\n5. Cross-platform: handle Windows/Linux/macOS differences\n6. Safety: warn about destructive commands',
            dependsOn: ['step-0'],
        },
        {
            agentType: 'runner',
            description: 'Provide terminal assistance:\n1. Parse the error message\n2. Identify the likely cause\n3. Suggest the fix command\n4. Explain what the command does\n5. Warn about side effects\n6. Offer to execute or let user run it',
            dependsOn: ['step-1'],
        },
        {
            agentType: 'reviewer',
            description: 'Verify: suggestion is correct, command is safe, explanation is clear, cross-platform compatible.',
            dependsOn: ['step-2'],
        },
    ],
    parameters: [],
    tags: ['terminal', 'shell', 'hints', 'error-help', 'automation'],
    sourceTrajectoryIds: ['bundled'],
    qualityScore: 0.85,
    usageCount: 0,
    createdAt: PHASE3_CREATED_AT,
    lastUsedAt: PHASE3_CREATED_AT,
};
// ─── Session / Context ─────────────────────────────────────────────────────
export const BUNDLED_SKILL_ID_SESSION_SEARCH = 'skill-session-search';
export const BUNDLED_SKILL_ID_THREAD_CONTEXT = 'skill-thread-context';
export const sessionSearchSkill = {
    id: BUNDLED_SKILL_ID_SESSION_SEARCH,
    name: 'session-search',
    description: 'Search and retrieve past coding sessions: find previous conversations, code changes, and decisions. Covers session storage, full-text search, and context retrieval. Use when the goal is to find information from past interactions.',
    version: '1.0.0',
    goalPattern: 'session search past conversation history code changes decisions context retrieval',
    steps: [
        {
            agentType: 'context-gatherer',
            description: 'Map the search: what are we looking for? What session data exists? What search capabilities available?',
            dependsOn: [],
        },
        {
            agentType: 'planner',
            description: 'Design session search:\n1. Storage: session history in files or database\n2. Indexing: full-text search index (FTS5, Meilisearch)\n3. Query: keyword search, date range, file filter\n4. Results: ranked by relevance, with context\n5. Retrieval: fetch full session details\n6. Privacy: search only within allowed scope',
            dependsOn: ['step-0'],
        },
        {
            agentType: 'runner',
            description: 'Implement session search:\n1. Build search index from session data\n2. Implement query parser\n3. Create search function with ranking\n4. Add context retrieval for results\n5. Test with sample sessions\n6. Optimize for performance',
            dependsOn: ['step-1'],
        },
        {
            agentType: 'reviewer',
            description: 'Verify: search returns relevant results, ranking is accurate, context is sufficient, performance is acceptable.',
            dependsOn: ['step-2'],
        },
    ],
    parameters: [],
    tags: ['session', 'search', 'history', 'context', 'retrieval'],
    sourceTrajectoryIds: ['bundled'],
    qualityScore: 0.85,
    usageCount: 0,
    createdAt: PHASE3_CREATED_AT,
    lastUsedAt: PHASE3_CREATED_AT,
};
export const threadContextSkill = {
    id: BUNDLED_SKILL_ID_THREAD_CONTEXT,
    name: 'thread-context',
    description: 'Manage thread context: maintain conversation history, summarize long threads, extract key decisions, and track action items. Use when managing long-running conversations or complex discussions.',
    version: '1.0.0',
    goalPattern: 'thread context conversation history summary decisions action items management',
    steps: [
        {
            agentType: 'context-gatherer',
            description: 'Map the thread: how long is the conversation? What key topics discussed? What decisions made? What action items pending?',
            dependsOn: [],
        },
        {
            agentType: 'planner',
            description: 'Design thread context management:\n1. Summarization: compress long threads into key points\n2. Decision tracking: extract and log decisions with rationale\n3. Action items: identify and track pending tasks\n4. Context window: manage token limits by summarizing old content\n5. Searchability: index thread content for retrieval\n6. Export: share thread summary as document',
            dependsOn: ['step-0'],
        },
        {
            agentType: 'runner',
            description: 'Manage the thread:\n1. Summarize the conversation so far\n2. Extract decisions and rationale\n3. List action items with owners\n4. Identify open questions\n5. Create thread summary document\n6. Set up context for continuation',
            dependsOn: ['step-1'],
        },
        {
            agentType: 'reviewer',
            description: 'Verify: summary is accurate, decisions captured correctly, action items complete, context enables continuation.',
            dependsOn: ['step-2'],
        },
    ],
    parameters: [],
    tags: ['thread', 'context', 'conversation', 'summary', 'management'],
    sourceTrajectoryIds: ['bundled'],
    qualityScore: 0.85,
    usageCount: 0,
    createdAt: PHASE3_CREATED_AT,
    lastUsedAt: PHASE3_CREATED_AT,
};
// ─── Memory ────────────────────────────────────────────────────────────────
export const BUNDLED_SKILL_ID_MEMORY_TOOL = 'skill-memory-tool';
export const memoryToolSkill = {
    id: BUNDLED_SKILL_ID_MEMORY_TOOL,
    name: 'memory-tool',
    description: 'Manage agent memory: store and retrieve facts, preferences, and context across sessions. Covers short-term (working memory) and long-term (persistent) memory with semantic search. Use when the agent needs to remember information across interactions.',
    version: '1.0.0',
    goalPattern: 'memory tool agent memory store retrieve facts preferences context session persistent semantic',
    steps: [
        {
            agentType: 'context-gatherer',
            description: 'Map the memory needs: what facts to remember? What preferences? How long to retain? What search capabilities?',
            dependsOn: [],
        },
        {
            agentType: 'planner',
            description: 'Design the memory system:\n1. Working memory: current session context, recent interactions\n2. Long-term memory: persistent facts, user preferences\n3. Storage: key-value store with embeddings for semantic search\n4. Retrieval: keyword + semantic search\n5. Forgetting: automatic decay, manual removal\n6. Privacy: user controls over what is remembered',
            dependsOn: ['step-0'],
        },
        {
            agentType: 'runner',
            description: 'Implement memory management:\n1. Create storage layer (file or database)\n2. Implement store/retrieve functions\n3. Add semantic search with embeddings\n4. Build decay/forgetting mechanism\n5. Add privacy controls\n6. Test with sample data',
            dependsOn: ['step-1'],
        },
        {
            agentType: 'reviewer',
            description: 'Verify: memories persist across sessions, search returns relevant results, forgetting works, privacy controls effective.',
            dependsOn: ['step-2'],
        },
    ],
    parameters: [],
    tags: ['memory', 'agent', 'persistence', 'semantic-search', 'context'],
    sourceTrajectoryIds: ['bundled'],
    qualityScore: 0.85,
    usageCount: 0,
    createdAt: PHASE3_CREATED_AT,
    lastUsedAt: PHASE3_CREATED_AT,
};
// ─── Budget / Cost ─────────────────────────────────────────────────────────
export const BUNDLED_SKILL_ID_BUDGET_CONFIG = 'skill-budget-config';
export const budgetConfigSkill = {
    id: BUNDLED_SKILL_ID_BUDGET_CONFIG,
    name: 'budget-config',
    description: 'Configure and manage budgets: API usage tracking, cost alerts, spending limits, and billing optimization. Use when setting up cost controls for API usage or cloud resources.',
    version: '1.0.0',
    goalPattern: 'budget cost tracking API usage billing alerts spending limits optimization cloud costs',
    steps: [
        {
            agentType: 'context-gatherer',
            description: 'Map the budget: what services to track? What budget limits? What alert thresholds? What billing period?',
            dependsOn: [],
        },
        {
            agentType: 'planner',
            description: 'Design the budget system:\n1. Tracking: log API calls, tokens used, compute time\n2. Limits: daily, weekly, monthly caps\n3. Alerts: at 50%, 80%, 100% of budget\n4. Optimization: cache results, batch requests, use cheaper models\n5. Reporting: daily/weekly cost breakdown\n6. Auto-shutoff: stop services when budget exceeded',
            dependsOn: ['step-0'],
        },
        {
            agentType: 'runner',
            description: 'Implement budget controls:\n1. Add usage tracking to API clients\n2. Create budget configuration\n3. Implement alert system\n4. Add cost optimization logic\n5. Build reporting dashboard\n6. Test with budget limits',
            dependsOn: ['step-1'],
        },
        {
            agentType: 'reviewer',
            description: 'Verify: usage tracked correctly, alerts fire at thresholds, limits enforced, reports accurate.',
            dependsOn: ['step-2'],
        },
    ],
    parameters: [],
    tags: ['budget', 'cost', 'billing', 'optimization', 'monitoring'],
    sourceTrajectoryIds: ['bundled'],
    qualityScore: 0.85,
    usageCount: 0,
    createdAt: PHASE3_CREATED_AT,
    lastUsedAt: PHASE3_CREATED_AT,
};
// ─── Schema / Data ─────────────────────────────────────────────────────────
export const BUNDLED_SKILL_ID_SCHEMA_SANITIZER = 'skill-schema-sanitizer';
export const BUNDLED_SKILL_ID_BINARY_EXTENSIONS = 'skill-binary-extensions';
export const schemaSanitizerSkill = {
    id: BUNDLED_SKILL_ID_SCHEMA_SANITIZER,
    name: 'schema-sanitizer',
    description: 'Sanitize and validate data schemas: input validation, output sanitization, schema transformation, and type coercion. Use when ensuring data conforms to expected formats and preventing injection attacks.',
    version: '1.0.0',
    goalPattern: 'schema sanitizer validation input output type coercion injection prevention transformation',
    steps: [
        {
            agentType: 'context-gatherer',
            description: 'Map the data: what input sources (API, form, file)? What formats (JSON, XML, CSV)? What validation rules? What security concerns?',
            dependsOn: [],
        },
        {
            agentType: 'planner',
            description: 'Design the sanitizer:\n1. Schema definition: JSON Schema, Zod, or custom validators\n2. Input validation: type checking, range validation, format matching\n3. Output sanitization: XSS prevention, SQL injection prevention\n4. Type coercion: safe type conversion with defaults\n5. Error handling: structured error messages\n6. Performance: streaming validation for large inputs',
            dependsOn: ['step-0'],
        },
        {
            agentType: 'runner',
            description: 'Implement the sanitizer:\n1. Define validation schemas\n2. Implement input validation\n3. Add output sanitization\n4. Create type coercion layer\n5. Test with valid and invalid inputs\n6. Benchmark performance',
            dependsOn: ['step-1'],
        },
        {
            agentType: 'reviewer',
            description: 'Verify: valid inputs pass, invalid inputs rejected, sanitization prevents attacks, performance acceptable.',
            dependsOn: ['step-2'],
        },
    ],
    parameters: [],
    tags: ['schema', 'validation', 'sanitizer', 'security', 'data'],
    sourceTrajectoryIds: ['bundled'],
    qualityScore: 0.85,
    usageCount: 0,
    createdAt: PHASE3_CREATED_AT,
    lastUsedAt: PHASE3_CREATED_AT,
};
export const binaryExtensionsSkill = {
    id: BUNDLED_SKILL_ID_BINARY_EXTENSIONS,
    name: 'binary-extensions',
    description: 'Detect and handle binary file extensions: identify binary vs text files, handle binary content appropriately, and configure editors/tools to skip binary files. Use when processing mixed file types in a codebase.',
    version: '1.0.0',
    goalPattern: 'binary extensions file detection text vs binary handling editor configuration skip binary',
    steps: [
        {
            agentType: 'context-gatherer',
            description: 'Map the file types: what binary extensions exist in the project? What tools process files? What tools need to skip binary files?',
            dependsOn: [],
        },
        {
            agentType: 'planner',
            description: 'Design binary handling:\n1. Detection: extension-based + magic byte detection\n2. Handling: skip binary files in text processing tools\n3. Configuration: .gitattributes for git, .editorconfig for editors\n4. MIME types: map extensions to MIME types\n5. Tool config: ignore patterns for linters, formatters\n6. Documentation: list of binary extensions for reference',
            dependsOn: ['step-0'],
        },
        {
            agentType: 'runner',
            description: 'Implement binary handling:\n1. Create binary extension list\n2. Implement detection function\n3. Configure .gitattributes\n4. Configure .editorconfig\n5. Update tool ignore patterns\n6. Test with mixed file types',
            dependsOn: ['step-1'],
        },
        {
            agentType: 'reviewer',
            description: 'Verify: binary files correctly detected, text tools skip binary files, git handles binary files correctly.',
            dependsOn: ['step-2'],
        },
    ],
    parameters: [],
    tags: ['binary', 'extensions', 'file-detection', 'configuration', 'tools'],
    sourceTrajectoryIds: ['bundled'],
    qualityScore: 0.85,
    usageCount: 0,
    createdAt: PHASE3_CREATED_AT,
    lastUsedAt: PHASE3_CREATED_AT,
};
// ─── Approval / Delegation ─────────────────────────────────────────────────
export const BUNDLED_SKILL_ID_APPROVAL_TOOL = 'skill-approval-tool';
export const BUNDLED_SKILL_ID_DELEGATION_LIVE_LOG = 'skill-delegation-live-log';
export const approvalToolSkill = {
    id: BUNDLED_SKILL_ID_APPROVAL_TOOL,
    name: 'approval-tool',
    description: 'Implement approval workflows: request approval before dangerous actions, track approval decisions, and enforce approval policies. Use when adding safety gates to agent operations.',
    version: '1.0.0',
    goalPattern: 'approval workflow request approval safety gate dangerous action policy enforcement',
    steps: [
        {
            agentType: 'context-gatherer',
            description: 'Map the approval needs: what actions need approval? Who can approve? What is the approval workflow? What is the timeout?',
            dependsOn: [],
        },
        {
            agentType: 'planner',
            description: 'Design the approval system:\n1. Action classification: safe, requires-approval, blocked\n2. Approval request: present action details, risk assessment\n3. Decision: approve, deny, modify\n4. Timeout: what happens if no response\n5. Audit: log all approval decisions\n6. Policy: rules for auto-approve vs manual review',
            dependsOn: ['step-0'],
        },
        {
            agentType: 'runner',
            description: 'Implement approval workflow:\n1. Classify actions by risk level\n2. Create approval request UI/format\n3. Implement decision handling\n4. Add timeout behavior\n5. Log all decisions\n6. Configure auto-approve rules',
            dependsOn: ['step-1'],
        },
        {
            agentType: 'reviewer',
            description: 'Verify: approval requests are clear, decisions are recorded, timeout works, policies are enforced.',
            dependsOn: ['step-2'],
        },
    ],
    parameters: [],
    tags: ['approval', 'workflow', 'safety', 'policy', 'governance'],
    sourceTrajectoryIds: ['bundled'],
    qualityScore: 0.85,
    usageCount: 0,
    createdAt: PHASE3_CREATED_AT,
    lastUsedAt: PHASE3_CREATED_AT,
};
export const delegationLiveLogSkill = {
    id: BUNDLED_SKILL_ID_DELEGATION_LIVE_LOG,
    name: 'delegation-live-log',
    description: 'Monitor delegated tasks in real-time: live log streaming, progress tracking, and status updates. Use when supervising background tasks or parallel agent operations.',
    version: '1.0.0',
    goalPattern: 'delegation live log real-time monitoring progress tracking status background tasks parallel agents',
    steps: [
        {
            agentType: 'context-gatherer',
            description: 'Map the delegation: what tasks are being delegated? What progress indicators? What log format? What refresh rate?',
            dependsOn: [],
        },
        {
            agentType: 'planner',
            description: 'Design the live log system:\n1. Log streaming: real-time log output from delegated tasks\n2. Progress tracking: percentage complete, step indicators\n3. Status dashboard: task status, elapsed time, errors\n4. Filtering: filter by task, log level, timestamp\n5. Alerting: notify on errors or completion\n6. History: retain logs for debugging',
            dependsOn: ['step-0'],
        },
        {
            agentType: 'runner',
            description: 'Implement live log monitoring:\n1. Set up log streaming from tasks\n2. Create progress tracking\n3. Build status dashboard\n4. Add log filtering\n5. Implement alerting\n6. Test with sample delegated tasks',
            dependsOn: ['step-1'],
        },
        {
            agentType: 'reviewer',
            description: 'Verify: logs stream in real-time, progress updates accurately, alerts work on errors, history is retained.',
            dependsOn: ['step-2'],
        },
    ],
    parameters: [],
    tags: ['delegation', 'live-log', 'monitoring', 'progress', 'real-time'],
    sourceTrajectoryIds: ['bundled'],
    qualityScore: 0.85,
    usageCount: 0,
    createdAt: PHASE3_CREATED_AT,
    lastUsedAt: PHASE3_CREATED_AT,
};
// ─── Export all Phase 3 skills ─────────────────────────────────────────────
export const PHASE3_SKILLS = [
    // AI/ML
    autonomousAgentsSkill,
    mlopsSkill,
    promptEngineeringSkill,
    ragPipelineSkill,
    fineTuningSkill,
    // Blockchain
    soliditySkill,
    web3DappSkill,
    nftMintSkill,
    // Communication
    discordBotSkill,
    slackIntegrationSkill,
    teamsWebhookSkill,
    // Creative
    logoDesignSkill,
    videoEditSkill,
    podcastProductionSkill,
    // Data Science
    dataVisualizationSkill,
    featureEngineeringSkill,
    timeSeriesSkill,
    // DevOps Advanced
    infraAsCodeSkill,
    serviceMeshSkill,
    chaosEngineeringSkill,
    // Email
    transactionalEmailSkill,
    newsletterSkill,
    // Finance
    paymentGatewaySkill,
    accountingIntegrationSkill,
    // Health
    healthDataSkill,
    fitnessApiSkill,
    // MCP
    mcpServerSkill,
    mcpClientSkill,
    mcpConnectorSkill,
    // Migration
    dataMigrationSkill,
    cloudMigrationSkill,
    // Productivity
    knowledgeBaseSkill,
    decisionFrameworkSkill,
    kanbanBoardSkill,
    checkpointManagerSkill,
    // Research
    osintInvestigationSkill,
    academicResearchSkill,
    // Security Advanced
    penetrationTestSkill,
    complianceCheckSkill,
    secretsScanSkill,
    // Software Development
    codeReviewSkill,
    dependencyAuditSkill,
    monorepoSetupSkill,
    // Web Development
    ssrSetupSkill,
    pwaBuilderSkill,
    microFrontendSkill,
    // Windows-Specific
    powershellAutomationSkill,
    wslSetupSkill,
    registryManagementSkill,
    groupPolicySkill,
    // Cross-Platform
    crossPlatformBuildSkill,
    electronAppSkill,
    mobileBridgeSkill,
    // Debug
    debugHelpersSkill,
    terminalHintsSkill,
    // Session
    sessionSearchSkill,
    threadContextSkill,
    // Memory
    memoryToolSkill,
    // Budget
    budgetConfigSkill,
    // Schema
    schemaSanitizerSkill,
    binaryExtensionsSkill,
    // Approval/Delegation
    approvalToolSkill,
    delegationLiveLogSkill,
];
//# sourceMappingURL=bundled-skills-phase3.js.map