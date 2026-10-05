import { defineConfig } from 'vitest/config';

export default defineConfig({
  esbuild: {
    // Automatic JSX runtime for .tsx test files (ink board tests).
    jsx: 'automatic',
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.{ts,tsx}'],
    // Every test file gets a throwaway memory store, so a test can never write
    // the developer's real ~/.nuvira/memory — the files the dashboard reports
    // and the router obeys. Without this, a test that drives the real pipeline
    // records real routing telemetry (see tests/setup/hermetic-env.ts).
    setupFiles: ['tests/setup/hermetic-env.ts'],
    // The suite must not modify the project it runs in: this fails the run if a
    // test (or something it spawns) changes the dependency set, and reports any
    // path that became dirty during the run. See tests/setup/tree-guard.ts for
    // why that distinction is drawn where it is.
    globalSetup: ['tests/setup/tree-guard.ts'],
    // The 5s default is sized for a unit test, and this suite is not all unit
    // tests. MEASURED: three consecutive runs of the same 350 files failed a
    // DIFFERENT single file each time — every one of them "Test timed out in
    // 5000ms", every one green on its own (long-form-story, web-dashboard/server,
    // orchestrator, gateway/retry-loop, composite-web-book). Chasing those one at
    // a time cannot converge, because the next run surfaces a different subset,
    // and a 5s deadline is a claim about machine scheduling rather than about the
    // code. Tests that carry their own budget (30s/60s/120s/180s) are untouched —
    // this only lifts the floor.
    testTimeout: 15_000,
    // Test files run in parallel. The old `fileParallelism: false` was written
    // when every test shared one JSON memory store at ~/.buff/memory, so two
    // files running at once corrupted the same files. `tests/setup/hermetic-env.ts`
    // closed that: every test file now gets its own throwaway store, and under
    // the forks pool a file runs in its own process. The guard outlived its
    // reason and cost far more than it protected.
    //
    // MEASURED, not assumed. Serial execution let leaked child processes pile up
    // as the run went on, and the suites that spawn real processes then stalled:
    // 6 files cost ~16 minutes EACH (≈96 of a 114-minute run — 84% of the wall
    // clock) while the other 344 files summed to ~18 minutes. The same 7
    // process-spawning files are green in 54s wall with parallelism on, which is
    // the difference between a suite that fits the release's Test Verification
    // gate and one that trips it.
    //
    // Bounded on purpose: these suites fork node processes and bind sockets, so
    // unbounded workers would trade one kind of contention for another.
    maxWorkers: 4,
    // Load every .mjs through Node's own loader instead of Vite's SSR transform.
    //
    // WHY. Vitest inlines project .mjs files (`defaultInline` contains
    // /^(?!.*node_modules).*\\.mjs$/) and hands them to Vite, which re-emits the
    // module body. Vite parks a shebang AFTER the hoisted `__vite_ssr_import__`
    // preamble, so `#!/usr/bin/env node` stops being line 1 and becomes line 9.
    // A `#!` anywhere but byte 0 is not a hashbang, it is a syntax error —
    // `SyntaxError: Invalid or unexpected token`, reported against the suite
    // with no stack and no location.
    //
    // This only bites when the file is checked out with CRLF: with LF, Vite
    // keeps the shebang on line 1. That is why it looked Windows-only — the
    // windows-latest runner has core.autocrlf=true and this repository had no
    // .gitattributes to override it, so the checked-out scripts/.*.mjs arrived
    // with CRLF and the whole suite failed to LOAD. (Reproduced on macOS by
    // converting scripts/build-dashboard.mjs to CRLF.)
    //
    // .gitattributes now pins those files to LF, but the suite should not be
    // able to fail on a line-ending decision at all. These are plain Node
    // scripts that import nothing but builtins, so the native loader is both
    // sufficient and what actually runs them in production
    // (`node scripts/build-dashboard.mjs`).
    server: {
      deps: {
        external: [/\.mjs$/],
      },
    },
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts', 'src/cli/**/*.ts'],
    },
  },
});
