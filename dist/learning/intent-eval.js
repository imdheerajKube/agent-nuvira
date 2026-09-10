/**
 * Intent-eval — classification accuracy harness for the two intent matchers.
 *
 * The eval-framework.ts measures END-TO-END coding tasks through the
 * orchestrator (pipeline quality). Intent matching is a different question —
 * "which intent does this plain-English ask map to?" — so this harness
 * measures exactly that, over a LABELED corpus of asks with ground-truth
 * intent ids:
 *
 *   nuvira intent eval              — run deterministic vs semantic, print scores
 *   nuvira intent eval --json       — machine-readable results
 *
 * Metrics per matcher:
 *   - top-1 accuracy   — ground-truth intent is the #1 ranked match
 *   - in-top-3 accuracy— ground-truth intent appears in the top 3
 *   - coverage         — share of asks with at least one match above threshold
 *
 * The corpus intentionally includes NOVEL phrasings that are NOT in the
 * manifest's alias lists (e.g. "bounce the UI", "where is the delivery log"),
 * because those are exactly the asks where the semantic tier should add
 * recall over the deterministic keyword matcher.
 */
import { logger } from '../utils/logger.js';
import { resolveAsk } from '../commands/intent-router.js';
import { semanticResolve } from '../commands/semantic-intent.js';
import { maskSenderId } from '../utils/mask.js';
/**
 * Ground-truth corpus. `novel: true` entries are phrasings that DO NOT appear
 * in src/resources/command-manifest.json aliases — keyword matching cannot
 * hit them by construction. Intent ids are the manifest's `intent` values.
 */
export const INTENT_EVAL_CORPUS = [
    // ── Dashboard lifecycle ──────────────────────────────────────────────────
    { ask: 'stop the dashboard', intent: 'dashboard.stop' },
    { ask: 'shut down the web ui', intent: 'dashboard.stop', novel: true },
    { ask: 'bounce the UI', intent: 'dashboard.stop', novel: true },
    { ask: 'kill the dashboard process', intent: 'dashboard.stop', novel: true },
    { ask: 'open the dashboard', intent: 'dashboard.start' },
    { ask: 'launch the admin panel', intent: 'dashboard.start', novel: true },
    // ── Gateway lifecycle ────────────────────────────────────────────────────
    { ask: 'start the gateway', intent: 'gateway.start' },
    { ask: 'terminate the bot', intent: 'gateway.stop', novel: true },
    { ask: 'stop the bot', intent: 'gateway.stop' },
    { ask: 'shut down all messaging adapters', intent: 'gateway.stop', novel: true },
    { ask: 'whatsapp status', intent: 'gateway.status', novel: true },
    { ask: 'are my channels reachable', intent: 'gateway.status', novel: true },
    // ── Verified senders / permissions ───────────────────────────────────────
    { ask: 'add Rahul mobile +919958604222 to whatsapp', intent: 'contacts.add' },
    { ask: 'let my customer message the bot', intent: 'permissions.allow', novel: true },
    { ask: 'remove daddy from the verified list', intent: 'contacts.remove' },
    { ask: 'block that number', intent: 'permissions.disallow', novel: true },
    { ask: 'list the allowed users', intent: 'permissions.list', novel: true },
    // ── Messaging / delivery ─────────────────────────────────────────────────
    { ask: 'send a message to ops', intent: 'gateway.send' },
    { ask: 'tell ops the build is done', intent: 'gateway.send', novel: true },
    { ask: 'where is the delivery log', intent: 'delivery.ledger', novel: true },
    { ask: 'show me what was delivered', intent: 'delivery.ledger', novel: true },
    { ask: 'delivery status', intent: 'delivery.ledger' },
    // ── Eval / CI / cron ─────────────────────────────────────────────────────
    { ask: 'run the eval suite', intent: 'eval.run' },
    { ask: 'run the nightly evaluation', intent: 'eval.run', novel: true },
    { ask: 'benchmark my models', intent: 'eval.benchmark', novel: true },
    { ask: 'schedule a nightly build', intent: 'cron.add', novel: true },
    { ask: 'show the scheduled jobs', intent: 'cron.list', novel: true },
    // ── Platform setup ───────────────────────────────────────────────────────
    { ask: 'enable telegram support', intent: 'config.gateway.set', novel: true },
    { ask: 'turn on discord', intent: 'config.gateway.set', novel: true },
    { ask: 'enable FAISS memory', intent: 'memory.backend' },
    // ── Diagnostics ──────────────────────────────────────────────────────────
    { ask: 'check the installation', intent: 'doctor' },
    { ask: 'is everything healthy', intent: 'doctor', novel: true },
    { ask: 'show the config', intent: 'config.show', novel: true },
];
/** Run one matcher over the corpus and score it. */
function scoreMatcher(matcher, rankFor) {
    return (async () => {
        const cases = [];
        let top1 = 0;
        let top3 = 0;
        let covered = 0;
        for (const item of INTENT_EVAL_CORPUS) {
            const ranked = await rankFor(item.ask);
            const hitTop1 = ranked[0] === item.intent;
            const hitTop3 = ranked.slice(0, 3).includes(item.intent);
            if (hitTop1)
                top1++;
            if (hitTop3)
                top3++;
            if (ranked.length > 0)
                covered++;
            cases.push({
                ask: item.ask,
                intent: item.intent,
                novel: item.novel,
                topIntent: ranked[0],
                hit: hitTop1,
            });
        }
        const total = INTENT_EVAL_CORPUS.length;
        return {
            matcher,
            top1,
            top3,
            coverage: covered,
            total,
            cases,
        };
    })();
}
/** Rank deterministic matches by score. */
async function deterministicRank(ask) {
    return resolveAsk(ask).map((m) => m.intent);
}
/** Rank semantic matches by similarity. */
async function semanticRank(ask) {
    const matches = await semanticResolve(ask);
    return matches.map((m) => m.intent);
}
/** Run both matchers and print a comparison table. */
export async function runIntentEval(opts = {}) {
    const deterministic = await scoreMatcher('deterministic', deterministicRank);
    const semantic = await scoreMatcher('semantic', semanticRank);
    if (opts.json) {
        console.log(JSON.stringify({ corpusSize: INTENT_EVAL_CORPUS.length, deterministic, semantic }, null, 2));
        return { deterministic, semantic };
    }
    const pct = (n, d) => `${n}/${d} (${((100 * n) / d).toFixed(1)}%)`;
    logger.highlight('\n🧪 Intent matcher eval — over a labeled corpus');
    logger.info(`   corpus: ${INTENT_EVAL_CORPUS.length} asks (${INTENT_EVAL_CORPUS.filter((c) => c.novel).length} novel phrasings not in the manifest)`);
    logger.info('');
    logger.info('   ┌───────────────┬──────────┬──────────┬───────────┐');
    logger.info('   │ matcher       │ top-1    │ top-3    │ coverage  │');
    logger.info('   ├───────────────┼──────────┼──────────┼───────────┤');
    logger.info(`   │ deterministic │ ${pct(deterministic.top1, deterministic.total).padEnd(8)} │ ${pct(deterministic.top3, deterministic.total).padEnd(8)} │ ${pct(deterministic.coverage, deterministic.total).padEnd(9)} │`);
    logger.info(`   │ semantic      │ ${pct(semantic.top1, semantic.total).padEnd(8)} │ ${pct(semantic.top3, semantic.total).padEnd(8)} │ ${pct(semantic.coverage, semantic.total).padEnd(9)} │`);
    logger.info('   └───────────────┴──────────┴──────────┴───────────┘');
    logger.info('');
    // Where they disagree — the interesting cases.
    const disagreements = [];
    for (let i = 0; i < INTENT_EVAL_CORPUS.length; i++) {
        const d = deterministic.cases[i];
        const s = semantic.cases[i];
        if (d.hit !== s.hit || (d.hit && s.hit && d.topIntent !== s.topIntent)) {
            disagreements.push(`   ${d.ask} — deterministic→${d.topIntent ?? 'none'}, semantic→${s.topIntent ?? 'none'} (want ${d.intent})`);
        }
    }
    if (disagreements.length > 0) {
        logger.info('   ⚖ cases where the tiers disagree or differ:');
        for (const line of disagreements.slice(0, 12))
            logger.info(line);
    }
    const novelD = deterministic.cases.filter((c) => c.novel && c.hit).length;
    const novelS = semantic.cases.filter((c) => c.novel && c.hit).length;
    const novelTotal = INTENT_EVAL_CORPUS.filter((c) => c.novel).length;
    logger.info('');
    logger.info(`   📈 novel-phrasing recall (the semantic tier's reason to exist): deterministic ${novelD}/${novelTotal}, semantic ${novelS}/${novelTotal}`);
    logger.info(`   (sender ids in entity output are masked — ${maskSenderId('+919958604222')})`);
    return { deterministic, semantic };
}
//# sourceMappingURL=intent-eval.js.map