/**
 * MODEL IDENTITY (A1) — when two provider × model rows are the SAME MODEL.
 *
 * THE DEFECT. The registry keys everything by `provider × model`, so two rows for
 * one model are unrelated. Measured on this machine:
 *
 * | Row | Status |
 * |---|---|
 * | `openrouter / deepseek/deepseek-v4.1-flash` | `unavailable` (`credit-exhausted`) |
 * | `deepseek / deepseek-flash` | `verified` |
 *
 * Nothing in the system could say "these are the same model", so the system could
 * not tell an operator that the model they pinned is available on another
 * provider, and the capability knowledge collected on one row could never inform
 * the other.
 *
 * WHY A DECLARED TABLE, NOT A GUESS. `deepseek-flash` and
 * `deepseek/deepseek-v4.1-flash` look similar and are the same model — but
 * `deepseek-v4-flash` and `deepseek-v4.1-flash` also look similar and are NOT.
 * Deciding identity from the spelling is the same name-based judgement this
 * programme removes from capability scoring, so identity here is **data**: a small
 * hand-maintained table, each entry carrying the date it was declared and the
 * evidence it rests on. An id in no entry simply gets its own bare-id group
 * (which is the pre-A1 behaviour), so an undeclared model is never grouped with
 * the wrong one — the failure mode of a table is "unknown", not "wrong".
 *
 * ─── THE ONE RULE THAT MUST NOT BREAK ──────────────────────────────────────
 *
 * **Identity groups CAPABILITY, never ROUTABILITY.** Two providers are two
 * ACCOUNTS with two independent truths: `openrouter`'s exhausted credits say
 * nothing about `deepseek`'s funded account. So a verdict is NEVER copied across
 * twins — not an availability verdict (that is defect F6: "the model works"
 * masquerading as "this provider will serve it"), and not an error rate either.
 * What identity buys is the QUESTION — "is the same model served by a provider
 * that can serve it?" — and every candidate the question produces is then judged
 * on its OWN registry row. `learning/pair-entitlement.ts` implements that
 * judgement; this module only answers what a model IS.
 */

/** One hand-declared model, and the provider-specific ids it is served under. */
export interface DeclaredAlias {
  /** The id this model is known as internally. */
  canonical: string;
  /**
   * Every provider-specific id it is served under. The canonical id itself is
   * implicitly a member (see `memberMatches`), so a provider serving the
   * canonical spelling needs no separate entry.
   */
  members: string[];
  /** `YYYY-MM-DD` the entry was declared — printed wherever it is used. */
  declaredAt: string;
  /** What the declaration rests on. An assertion without a basis is a guess. */
  note: string;
}

/**
 * The declared aliases.
 *
 * Deliberately tiny and hand-checked: every entry is an ASSERTION, and a wrong one
 * groups two different models. Entries are added from observed registry rows (a
 * `verified` row on one provider beside an `unavailable` row on another for the
 * same model is exactly how the first one was found), never from similarity.
 */
export const DECLARED_MODEL_ALIASES: DeclaredAlias[] = [
  {
    canonical: 'deepseek-v4.1-flash',
    members: ['deepseek-flash', 'deepseek/deepseek-v4.1-flash'],
    declaredAt: '2026-10-07',
    note:
      "DeepSeek's own API serves this model as `deepseek-flash`; OpenRouter's catalogue lists it as " +
      '`deepseek/deepseek-v4.1-flash`. Declared from this machine\'s registry, where ' +
      '`deepseek|deepseek-flash` was `verified` while `openrouter|deepseek/deepseek-v4.1-flash` was ' +
      '`credit-exhausted` — the pair the programme could not previously relate.',
  },
];

/** Lower-case, trimmed, and with the provider alias marker `~` stripped. */
function normalize(model: string | undefined | null): string {
  return (model ?? '').trim().toLowerCase().replace(/^~/, '');
}

/** Everything after the last `/` — the model's name without its vendor prefix. */
function bareId(id: string): string {
  const slash = id.lastIndexOf('/');
  return slash >= 0 ? id.slice(slash + 1) : id;
}

/**
 * Does this id name the declared member — exactly, or after dropping the vendor
 * prefix? The same EXACT rule as before (`deepseek-flash` ≡
 * `deepseek/deepseek-flash`), applied to each declared spelling.
 */
function memberMatches(member: string, id: string): boolean {
  const m = normalize(member);
  return m === id || bareId(m) === bareId(id);
}

/**
 * The identity key two ids must share to be treated as the same model.
 *
 * Prefixed (`canonical:` / `bare:`) so a canonical name can never collide with a
 * model that happens to be called the same thing without being declared.
 */
export function identityKey(model: string | undefined | null): string {
  const id = normalize(model);
  if (!id) return '';
  for (const alias of DECLARED_MODEL_ALIASES) {
    if (memberMatches(alias.canonical, id) || alias.members.some((m) => memberMatches(m, id))) {
      return `canonical:${normalize(alias.canonical)}`;
    }
  }
  return `bare:${bareId(id)}`;
}

/** Are these two ids the same model? Empty ids are never the same as anything. */
export function sameModel(a: string | undefined | null, b: string | undefined | null): boolean {
  const ka = identityKey(a);
  const kb = identityKey(b);
  return !!ka && ka === kb;
}

/** The declared entry that grouped this id, for printing WHERE identity came from. */
export function declaredAliasFor(model: string | undefined | null): DeclaredAlias | undefined {
  const id = normalize(model);
  if (!id) return undefined;
  return DECLARED_MODEL_ALIASES.find(
    (alias) => memberMatches(alias.canonical, id) || alias.members.some((m) => memberMatches(m, id)),
  );
}

/**
 * One line naming the provenance of a grouping, or `undefined` when the grouping
 * is the bare-id rule. `model explain` prints it, so a reader can always tell a
 * declared fact from a derived one.
 */
export function identityProvenance(model: string | undefined | null): string | undefined {
  const alias = declaredAliasFor(model);
  return alias ? `declared alias → '${alias.canonical}' (table, ${alias.declaredAt})` : undefined;
}
