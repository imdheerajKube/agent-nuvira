# CLI demos

Reproducible terminal recordings of the real CLI — not hand-written output.

| File | Commands | Purpose |
|---|---|---|
| `nuvira-cli-tour.cast` | 21 | The curated tour: identity → health → routing → surface → safety → gateway → GUI. Linked from the README. |
| `nuvira-commands-all.cast` | every command in `docs/COMMANDS_SURFACE.md` | The full sweep, for verification. Generated on demand, not committed. |

Both are [asciinema v2](https://docs.asciinema.org/manual/asciicast/v2/) casts:
plain, diffable text — a few tens of KB — so a renamed command changes a line in
a file rather than invalidating a video.

## Play one

```bash
# Local player (https://asciinema.org/docs/installation)
asciinema play docs/demos/nuvira-cli-tour.cast

# Or with no install: the file is text, so `cat` it, or embed it with
# https://github.com/asciinema/asciinema-player
```

## Regenerate

The recordings are captured from the **built** CLI, so build first:

```bash
npm run build
npm run demo:cli          # the curated 21-command tour → nuvira-cli-tour.cast
npm run demo:cli:all      # every documented command → nuvira-commands-all.cast
```

The generator is `scripts/generate-cli-demo.mjs`; `--bin`, `--out` and `--only`
are accepted for custom runs.

## Guards

Both run in `npm test` (`tests/docs/cli-demo.test.ts`), so a stale or leaky cast
cannot be committed:

```bash
# Validate the committed cast: asciinema v2 header, SECONDS-scale monotonic
# timestamps, no secrets, and a recorded --version matching package.json.
node scripts/generate-cli-demo.mjs --check-cast docs/demos/nuvira-cli-tour.cast

# Run every curated command against the BUILT CLI and fail if one prints local
# state, or if its redacted output still matches a secret pattern.
node scripts/generate-cli-demo.mjs --check
```

The guard and the scrubber share one `SECRET_PATTERNS` list by construction, so
extending the redaction is the only way to add a pattern the guard accepts.

## Safety — no observable effect

It runs on a developer's own machine, against their own config, so it must never
do anything observable to the outside world:

1. **No command that spends, sends, publishes or mutates.** `chat`, `execute`,
   `gateway send`, `publish`, `memory add/delete`, `skill gc`, `config set` and
   `npm publish` are represented by their `--help` text — the action never runs.
2. **Everything runs in a throwaway cwd**, removed afterwards, so a command that
   writes a stray file writes it where it is deleted — never in the repo.

## Privacy — why the tour is curated, not exhaustive

The output is committed and published, so it must not carry the developer's data
either:

1. **No command whose output is their own prose or state.** `stats`,
   `history list`, `trace list`, `memory list/facts`, `nlu learnings` and
   `gateway logs` print real session titles, prompts, memories and message
   metadata. Prose cannot be reliably redacted, so those commands are kept out of
   the tour entirely rather than scrubbed.
2. **Everything else is passed through `redact()`**, which removes key-shaped
   tokens (including the CLI's own partially-masked `gsk_…`), home directory
   paths, phone numbers and emails — while leaving every product name, model id,
   count and latency untouched.

Model ids, provider status, listings, policy and the gateway's platform matrix
stay real; that is what makes the demo worth watching. Keep both lists honest
when editing the tour in the script.
