#!/usr/bin/env node

import { createCLI } from './cli/router.js';
import { setLogLevel } from './utils/logger.js';

/**
 * Buff CLI — Flexible AI inference tool
 * Supports local models (Ollama, HuggingFace, GGML) and cloud APIs
 * (NVIDIA NIM, Google Gemini, OpenRouter)
 */
async function main(): Promise<void> {
  const program = createCLI();

  // Parse args and handle debug mode
  const debugIndex = process.argv.indexOf('--debug');
  if (debugIndex > -1 || process.argv.includes('-d')) {
    setLogLevel('debug');
  }

  await program.parseAsync(process.argv);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
