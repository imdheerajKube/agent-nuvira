# DESIGN — Model identity above the provider pair (A1)

**Status: DECIDED and LANDED (2026-10-07). The user chose option A — the declared alias table —
seeded from this machine's registry.** Implementation: `src/learning/model-identity.ts`
(`identityKey` / `sameModel` / `declaredAliasFor` / `identityProvenance`). The options below are kept
as the record of what was weighed.

## 1. The defect

The registry keys everything by `provider × model`, and two rows for the SAME model are unrelated:

| Row | Status | Source |
|---|---|---|
| `openrouter / deepseek/deepseek-v4.1-flash` | `unavailable` (`credit-exhausted`) | telemetry |
| `deepseek / deepseek-flash` | `verified` | telemetry |

Nothing in the system can say "these are the same model". Bundle 1b's `verifiedEquivalent()` is an
exact **bare-id** match (`verifiedEquivalent` compares the id after any `vendor/` prefix), which is
honest and deterministic — and it correctly suggests NOTHING for this pair, because `deepseek-v4.1-flash`
and `deepseek-flash` share no bare id. Family guessing ("both start with `deepseek`") is deliberately
absent: asserting two ids are one model from their spelling is the same name-based judgement Bundle 3
removes.

## 2. What identity would and would not buy (read before choosing)

- **Capability knowledge, yes.** If measurement (Bundle 3) says one twin is strong, a fair prior for
  the other is defensible — this is what makes a scorecard useful across providers.
- **Availability, NO.** This is the trap. `openrouter`'s dead credits and `deepseek`'s funded account
  are facts about two different ACCOUNTS, not about the model. Sharing health across twins would
  re-create exactly the failure F6 fixed (an entitlement verdict erased by unrelated evidence) and
  would have "the model works" masquerade as "this provider will serve it". **Identity must group
  capability, never routability.**
- **Naming an alternative, yes.** "The pair you pinned is dead; the same model is verified on
  `deepseek`" is the useful output, and it exists already for the exact-bare-id case.

## 3. Options

### A. Declared alias registry (data, not inference)

A small, hand-maintained file mapping ids to one canonical model id:

```
canonical: deepseek-v4.1-flash
  - deepseek/deepseek-flash            (provider: deepseek)
  - openrouter/deepseek/deepseek-v4.1-flash   (provider: openrouter)
```

- **Pros:** deterministic, reviewable, testable; an unknown pair is simply ungrouped (no wrong
  assertion); the mapping can be corrected by editing data, not code.
- **Cons:** it is maintained by hand, so it drifts as providers rename models; the `nuvira` sidecar
  can serve ANY upstream model, so its rows need a declared identity or none at all.
- **Failure mode:** a stale entry silently groups two different models. Mitigation: every mapping
  carries a `declaredAt` + a source note, and `model explain` prints the mapping it used.

### B. Metadata-derived identity only

Derive identity from what providers publish: OpenRouter's `vendor/model` prefix, Ollama's model
digests, a provider's explicit `alias_of` field where one exists.

- **Pros:** nothing hand-maintained; no invented identity.
- **Cons:** **it cannot join the measured pair.** `deepseek-flash` (DeepSeek's own API) and
  `deepseek/deepseek-v4.1-flash` (OpenRouter's catalogue id) share no derivable key. So the one case
  that motivated A1 stays ungrouped — this option is honest but does not fix the reported defect.
- **Failure mode:** none in correctness terms; it just answers "unknown" more often than the user
  expects.

### C. Hybrid — declared table, metadata as a HINT

Identity comes from the declared table (A), and metadata probes only ever SUGGEST candidates for a
human/CLI to confirm (`nuvira models identity suggest --confirm`); nothing auto-groups from fuzzy
matching.

- **Pros:** keeps the correctness of A while making the table cheaper to maintain; the suggestion
  path is where new provider metadata gets exploited without inventing identity.
- **Cons:** the confirm step is a new surface and a new command.

### D. No identity layer, extend `verifiedEquivalent` only

Accept that cross-provider twins are unknowable and just improve the naming of alternatives
(bare-id match + a human-readable "no known equivalent" explanation).

- **Pros:** smallest change; zero risk of a wrong grouping.
- **Cons:** leaves A1 open; the user-visible symptom ("the same model is listed as two unrelated
  things, with opposite verdicts") remains.

## 4. Where the choice lands in code

Regardless of the option: the canonical-id lookup is used by (a) `verifiedEquivalent` /
`strictPinRefusal` (name the equivalent pair), (b) the `model explain` / `model list` rendering
(group twins so opposite verdicts are explicable), and — only if you choose to — (c) the scorecard
from `DESIGN_CAPABILITY_BY_MEASUREMENT.md` as a cross-provider capability prior. **(c) is the only
place identity may touch scoring, and it must never touch routability.**

## 4b. LANDED — option A (`src/learning/model-identity.ts`)

| Where | What it does |
|---|---|
| `DECLARED_MODEL_ALIASES` | A tiny hand-checked table, each entry carrying `declaredAt` + the evidence it rests on. Seeded with one entry: `deepseek-v4.1-flash` = `deepseek-flash` (DeepSeek's own API id) = `deepseek/deepseek-v4.1-flash` (OpenRouter's catalogue id). |
| `identityKey` / `sameModel` | Exact id (or bare id after the `vendor/` prefix, `~` alias marker stripped), widened by the table and **never** by similarity. An undeclared id keeps the bare-id rule, so the table can only fail toward "unknown", never toward a wrong grouping. |
| `declaredAliasFor` / `identityProvenance` | The provenance line `model explain` prints, so a reader can tell a DECLARED grouping from a DERIVED one. |
| `pair-entitlement.ts` `twinKey`/`areTwins` | Twin grouping for the funded-twin rule now uses the same identity key. Grouping only — each twin's verdict still comes from its **own** registry row (the rule in §2). |
| `route-resolver.ts` `verifiedEquivalent` | The pin-refusal sentence can now name the funded twin for the case that motivated A1: a `deepseek/deepseek-v4.1-flash` pin refused on `openrouter` now answers "the same model is verified on `deepseek/deepseek-flash`". |
| `cli/model.ts` | `model explain` prints the twin set **and** its provenance; `model list` prints a "same model, different verdicts" section for identity groups whose verdicts disagree — the opposite-verdict pairs the table previously made invisible. |

**What it deliberately does NOT do.** No verdict is copied across twins (see §2 — that is F6), no
family/prefix/similarity matching, and identity is never consulted to decide whether a provider can
serve a request. `deepseek-v4-flash` and `deepseek-v4.1-flash` remain different models.

## 5. The decision record

The user chose **A**, seeded from this machine's registry. Option C's suggest-and-confirm surface and
option B's metadata derivation remain unbuilt on purpose: neither is needed while the table is small
enough to review by eye, and both would add a way to invent identity rather than declare it.
