/**
 * RetrievalCommand — `buff retrieval` — inspect and drive the vector retrieval layer.
 *
 * The retrieval engine (src/learning/retrieval.ts) turns large code/doc context
 * into token-efficient, semantically-relevant context using a local embedding
 * model (bge-small-en-v1.5) + the pure-JS VectorStore. It complements the
 * quota ledger: retrieval SAVES tokens, the ledger MANAGES quotas.
 *
 * Subcommands:
 *   buff retrieval stats           — token-savings transparency (dashboard data)
 *   buff retrieval index <dir|file> — pre-index a repo (so first auto-run is instant)
 *   buff retrieval query <text>    — semantic search over the indexed repo
 *   buff retrieval clear           — wipe the index + stats
 */

import { readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Command } from 'commander';

import { BaseCommand } from './commands.js';
import { logger } from '../utils/logger.js';
import {
  indexFiles,
  retrieve,
  readRetrievalAggregateStats,
  clearRetrievalState,
  retrievalOptionsFromConfig,
  REPO_NAMESPACE,
} from '../learning/retrieval.js';
import { getVectorStore } from '../memory/vector-store.js';

/** Recursively collect source files under a path (respects basic ignore list). */
function collectFiles(root: string, out: string[] = [], depth = 0): string[] {
  if (depth > 6) return out;
  let stat;
  try {
    stat = statSync(root);
  } catch {
    return out;
  }
  if (stat.isFile()) {
    out.push(root);
    return out;
  }
  if (!stat.isDirectory()) return out;
  let entries: string[] = [];
  try {
    entries = readdirSync(root);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (IGNORE_DIRS.has(entry)) continue;
    collectFiles(join(root, entry), out, depth + 1);
  }
  return out;
}

const IGNORE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', '.cache', '.venv', 'venv',
  '__pycache__', '.turbo', '.nx', 'coverage',
]);

const SOURCE_EXTS = new Set([
  '.ts', '.js', '.tsx', '.jsx', '.go', '.py', '.rs', '.java', '.kt', '.rb',
  '.php', '.c', '.h', '.cpp', '.hpp', '.cs', '.swift', '.md', '.mdx', '.json',
  '.yaml', '.yml', '.toml', '.sh', '.sql', '.vue', '.svelte',
]);

export class RetrievalCommand extends BaseCommand {
  create(): Command {
    const cmd = new Command('retrieval')
      .description('Vector retrieval — token-efficient context via local embeddings')
      .option('-v, --verbose', 'verbose output');

    cmd.command('stats')
      .description('Show token-savings transparency (how many tokens retrieval saved)')
      .action(async () => {
        const opts = retrievalOptionsFromConfig(this.configManager);
        const stats = readRetrievalAggregateStats();
        logger.highlight('\n🧠 Vector Retrieval — token-savings transparency');
        logger.info(`   Enabled: ${opts.enabled ? 'yes' : 'no'} (contexts > ${(opts.thresholdTokens ?? 12000).toLocaleString()} tokens are vectorized)`);
        logger.info(`   Model: ${opts.model} · topK: ${opts.topK} · chunkTokens: ${opts.chunkTokens}`);
        console.log('');
        console.log(`   Calls:                  ${stats.totalCalls}`);
        console.log(`   Retrievals used:        ${stats.totalRetrievals}`);
        console.log(`   Failovers (fell back):  ${stats.totalFailovers}`);
        console.log(`   Tokens before retrieval:${stats.totalOriginalTokens.toLocaleString().padStart(11)}`);
        console.log(`   Tokens after retrieval: ${stats.totalReducedTokens.toLocaleString().padStart(11)}`);
        console.log(`   TOKENS SAVED:           ${stats.totalSavedTokens.toLocaleString().padStart(11)}`);
        console.log(`   Avg reduction:          ${stats.avgPctReduced.toFixed(1)}%`);
        const idx = getVectorStore(REPO_NAMESPACE).stats();
        console.log(`   Repo index:             ${idx.totalEntries} chunk(s) · ${idx.dimensions}-dim`);
        if (stats.lastCall?.used && stats.lastCall?.hits?.length) {
          console.log('');
          console.log('   Last retrieval hits:');
          for (const h of stats.lastCall.hits.slice(0, 5)) {
            console.log(`     • ${h.filePath}  (sim ${h.similarity.toFixed(3)})`);
          }
        }
        console.log('');
        logger.info('Reduce token usage with: `buff retrieval index <dir>` then Auto mode uses the semantic ranking automatically.');
      });

    cmd.command('index [path]')
      .description('Index a repo/file into the retrieval store (chunks embedded locally)')
      .action(async (path?: string) => {
        const target = path || process.cwd();
        if (!existsSync(target)) {
          logger.error(`Path not found: ${target}`);
          return;
        }
        logger.info(`🧠 Indexing ${target} ... (first run downloads the bge-small-en-v1.5 model, ~130MB, then cached)`);
        const files = collectFiles(target)
          .filter((f) => SOURCE_EXTS.has(f.slice(f.lastIndexOf('.'))));
        if (files.length === 0) {
          logger.warn('No supported source files found to index.');
          return;
        }
        logger.info(`   Found ${files.length} source file(s)`);
        const opts = retrievalOptionsFromConfig(this.configManager);
        const { chunks } = await indexFiles(files, opts);
        const idx = getVectorStore(REPO_NAMESPACE).stats();
        logger.success(`   Indexed ${chunks} chunk(s) across ${files.length} file(s)`);
        logger.info(`   Repo index now holds ${idx.totalEntries} chunk(s) — run \`buff retrieval query "<question>"\` to test.`);
      });

    cmd.command('query <text>')
      .description('Semantic search over the indexed repo (top-k chunks)')
      .action(async (text: string, _options: unknown) => {
        const opts = retrievalOptionsFromConfig(this.configManager);
        logger.info(`🔍 Searching repo for: ${text.slice(0, 120)}`);
        const hits = await retrieve(text, opts);
        if (hits.length === 0) {
          logger.warn('No matches — index a repo first with `buff retrieval index <dir>`.');
          return;
        }
        hits.forEach((h, i) => {
          console.log('');
          logger.highlight(`  ${i + 1}. ${h.chunk.filePath} (chunk ${h.chunk.chunkIndex + 1}, sim ${h.similarity.toFixed(3)}, ${h.chunk.tokenCount} tokens)`);
          console.log(h.chunk.text.slice(0, 400));
        });
        console.log('');
      });

    cmd.command('clear')
      .description('Clear the retrieval index and token-savings stats')
      .action(async () => {
        await clearRetrievalState();
        logger.success('   Retrieval index + stats cleared.');
      });

    return cmd;
  }
}
