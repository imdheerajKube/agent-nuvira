#!/usr/bin/env node
/**
 * Sync hub skills — regenerate the repo's `.agents/skills/` registry from the
 * built `BUNDLED_SKILLS` (P5c #3). The generated files are COMMITTED so the
 * configured default registry
 *   https://raw.githubusercontent.com/imdheerajKube/agent-nuvira/main/.agents/skills
 * resolves without a build.
 *
 * Usage:
 *   npm run build            # first — reads dist/skills/bundled-skills.js
 *   node scripts/sync-hub-skills.mjs [outDir]
 *
 * The pure generation lives in src/learning/hub-export.ts (unit-tested); this
 * script is only the load-from-dist + write glue.
 */

import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(process.argv[2] ?? join(here, '..', '.agents', 'skills'));

const { ALL_BUNDLED_SKILLS } = await import('../dist/skills/bundled-skills.js');
const BUNDLED_SKILLS = ALL_BUNDLED_SKILLS;
const { writeHubSkills } = await import('../dist/learning/hub-export.js');

const written = writeHubSkills(BUNDLED_SKILLS, outDir);
console.log(`✅ Wrote ${written.length} files under ${outDir}:`);
for (const f of written) console.log(`  • ${f}`);
