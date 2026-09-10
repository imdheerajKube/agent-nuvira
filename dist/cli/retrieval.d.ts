/**
 * RetrievalCommand — `nuvira retrieval` — inspect and drive the vector retrieval layer.
 *
 * The retrieval engine (src/learning/retrieval.ts) turns large code/doc context
 * into token-efficient, semantically-relevant context using a local embedding
 * model (bge-small-en-v1.5) + the pure-JS VectorStore. It complements the
 * quota ledger: retrieval SAVES tokens, the ledger MANAGES quotas.
 *
 * Subcommands:
 *   nuvira retrieval stats           — token-savings transparency (dashboard data)
 *   nuvira retrieval index <dir|file> — pre-index a repo (so first auto-run is instant)
 *   nuvira retrieval query <text>    — semantic search over the indexed repo
 *   nuvira retrieval clear           — wipe the index + stats
 */
import { Command } from 'commander';
import { BaseCommand } from './commands.js';
export declare class RetrievalCommand extends BaseCommand {
    create(): Command;
}
//# sourceMappingURL=retrieval.d.ts.map