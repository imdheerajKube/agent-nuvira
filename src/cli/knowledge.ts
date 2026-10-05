/**
 * KnowledgeCommand — `nuvira knowledge` — tag-scoped retrieval over your own documents.
 *
 * Bring documents, give them a tag, then ask questions scoped to that tag. The
 * documents are extracted, chunked and embedded ONCE (vectorized), so later
 * questions only embed a short query instead of re-reading the files on every
 * turn. Each tag is its own vector namespace; nothing leaves the Nuvira data dir.
 *
 * The agent can drive the same pipeline mid-task via the `knowledge` tool.
 *
 * Subcommands:
 *   nuvira knowledge add <tag> <path...>      — ingest files/folders under a tag
 *   nuvira knowledge query <tag> "<question>" — retrieve the tag's relevant passages
 *   nuvira knowledge list                     — list tags, documents and chunk counts
 *   nuvira knowledge stats <tag>              — details for one tag
 *   nuvira knowledge forget <tag>             — remove a tag's vectors
 */

import { Command } from 'commander';
import { basename } from 'node:path';
import { existsSync } from 'node:fs';

import { BaseCommand } from './commands.js';
import { logger } from '../utils/logger.js';
import { formatCount } from '../utils/format.js';
import {
  ingestKnowledge,
  queryKnowledge,
  listKnowledgeTags,
  getKnowledgeTag,
  forgetKnowledgeTag,
  normalizeKnowledgeTag,
} from '../learning/knowledge-base.js';

export class KnowledgeCommand extends BaseCommand {
  create(): Command {
    const cmd = new Command('knowledge')
      .description('Knowledge base — answer questions from your own tagged documents (vector retrieval)')
      .option('-v, --verbose', 'verbose output');

    cmd
      .command('add <tag> <paths...>')
      .description('Ingest files or folders under a tag (extracted, chunked and embedded once)')
      .action(async (tag: string, paths: string[]) => {
        const missing = paths.filter((p) => !existsSync(p));
        if (missing.length > 0) {
          logger.error(`Path not found: ${missing.join(', ')}`);
          return;
        }
        const normalized = normalizeKnowledgeTag(tag);
        logger.info(`📚 Ingesting ${paths.length} path(s) under tag '${normalized}' ...`);
        logger.info('   (first run downloads the local embedding model, ~130MB, then cached)');
        try {
          const result = await ingestKnowledge(tag, paths);
          logger.success(`   Ingested ${result.files} document(s) / ${result.chunks} chunk(s) under '${result.tag}'.`);
          for (const s of result.skipped) {
            logger.warn(`   Skipped ${basename(s.path)}: ${s.reason}`);
          }
          logger.info(`   Ask it: nuvira knowledge query "${result.tag}" "<question>"`);
        } catch (err) {
          logger.error(`Failed to ingest: ${err instanceof Error ? err.message : String(err)}`);
        }
        console.log('');
      });

    cmd
      .command('query <tag> <question>')
      .description('Retrieve the most relevant passages for a question, scoped to a tag')
      .option('-k, --top-k <n>', 'chunks to retrieve (default 6)')
      .action(async (tag: string, question: string, opts: { topK?: string }) => {
        const normalized = normalizeKnowledgeTag(tag);
        const topK = opts.topK ? Number.parseInt(opts.topK, 10) : undefined;
        logger.info(`🔍 ${normalized}: ${question}`);
        const hits = await queryKnowledge(tag, question, { topK });
        if (hits.length === 0) {
          logger.warn(`No entries for tag '${normalized}' — ingest documents first: nuvira knowledge add "${normalized}" <files>.`);
          console.log('');
          return;
        }
        hits.forEach((h, i) => {
          console.log('');
          logger.highlight(`  ${i + 1}. ${basename(h.sourcePath)} (chunk ${h.chunkIndex + 1}, sim ${h.similarity.toFixed(3)})`);
          console.log(h.text.slice(0, 400));
        });
        console.log('');
        logger.info('The data part of an answer comes from these passages; the general part from the model / web-research.');
        console.log('');
      });

    cmd
      .command('list')
      .description('List knowledge tags with document and chunk counts')
      .action(async () => {
        const tags = listKnowledgeTags();
        logger.highlight('\n📚 Knowledge base');
        if (tags.length === 0) {
          logger.info('   No tags yet. Add one: nuvira knowledge add <tag> <files...>');
          console.log('');
          return;
        }
        for (const t of tags) {
          console.log(`   • ${t.tag} — ${t.chunkCount} chunk(s) across ${t.documents.length} document(s)`);
          for (const d of t.documents) {
            console.log(`       ${basename(d.path)} (${d.chunks} chunk${d.chunks === 1 ? '' : 's'})`);
          }
        }
        console.log('');
      });

    cmd
      .command('stats <tag>')
      .description('Show details for one knowledge tag')
      .action(async (tag: string) => {
        const entry = getKnowledgeTag(tag);
        if (!entry) {
          logger.warn(`No knowledge tag '${normalizeKnowledgeTag(tag)}' found.`);
          console.log('');
          return;
        }
        logger.highlight(`\n📚 ${entry.tag}`);
        console.log(`   Chunks:    ${formatCount(entry.chunkCount)}`);
        console.log(`   Documents: ${entry.documents.length}`);
        console.log(`   Updated:   ${new Date(entry.updatedAt).toISOString()}`);
        for (const d of entry.documents) {
          console.log(`     • ${d.path} (${d.chunks} chunk${d.chunks === 1 ? '' : 's'})`);
        }
        console.log('');
      });

    cmd
      .command('forget <tag>')
      .description("Remove a tag's vectors and manifest entry")
      .action(async (tag: string) => {
        const removed = await forgetKnowledgeTag(tag);
        if (removed) {
          logger.success(`🗑️  Removed knowledge tag '${normalizeKnowledgeTag(tag)}'.`);
        } else {
          logger.warn(`No knowledge tag '${normalizeKnowledgeTag(tag)}' found.`);
        }
        console.log('');
      });

    return cmd;
  }
}
