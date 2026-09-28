#!/usr/bin/env node
/**
 * Localization coverage guard.
 *
 * A localization setup fails silently in two directions, both of which ship:
 *   - a `%key%` in `package.json` with no entry in `package.nls.json` renders as
 *     the literal text `%key%` to the user;
 *   - a translation bundle entry whose English source string no longer exists in
 *     the code is dead weight a translator kept maintaining for nothing.
 *
 * This checks both, for the manifest and for every per-locale runtime bundle.
 *
 * Run: node scripts/l10n-check.mjs
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (p) => JSON.parse(readFileSync(join(root, p), 'utf-8'));

const errors = [];
const readFileSafe = (p) => { try { return readFileSync(p, 'utf-8'); } catch { return ''; } };

// ── 1. Manifest: every %key% resolves, and no key is orphaned ────────────────

const pkg = readJson('package.json');
const nls = readJson('package.nls.json');

const manifestKeys = new Set();
for (const match of JSON.stringify(pkg).matchAll(/%([A-Za-z0-9_.]+)%/g)) {
  manifestKeys.add(match[1]);
}
for (const key of manifestKeys) {
  if (!(key in nls)) errors.push(`package.json references %${key}% but package.nls.json defines no such key`);
}
for (const key of Object.keys(nls)) {
  if (!manifestKeys.has(key)) errors.push(`package.nls.json defines unused key: ${key}`);
}

// ── 2. Runtime bundles: every translated English key must exist in the code ──

/** Recursively collect `src/**\/*.ts` excluding tests. */
function sourceFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name !== 'test' && name !== 'node_modules') out.push(...sourceFiles(full));
    } else if (name.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

const sourceText = sourceFiles(join(root, 'src')).map(readFileSafe).join('\n');

const l10nDir = join(root, 'l10n');
let bundleCount = 0;
for (const name of readdirSync(l10nDir)) {
  // bundle.l10n.json is the (empty) default; only locale bundles are checked.
  if (name === 'bundle.l10n.json' || !name.startsWith('bundle.l10n.') || !name.endsWith('.json')) continue;
  bundleCount += 1;
  const bundle = readJson(join('l10n', name));
  for (const key of Object.keys(bundle)) {
    // The key is the English source string; it must still be present in src.
    if (!sourceText.includes(key)) {
      errors.push(`${name}: translation key no longer present in src — ${JSON.stringify(key.slice(0, 60))}`);
    }
  }
}

if (errors.length > 0) {
  console.error('l10n check failed:');
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}

console.log(`l10n check passed: ${manifestKeys.size} manifest key(s), ${bundleCount} locale bundle(s)`);
