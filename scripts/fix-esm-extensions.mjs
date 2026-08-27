#!/usr/bin/env node
/**
 * Postbuild script: adds .js extensions to relative imports in dist/ output.
 * 
 * TypeScript with moduleResolution: "bundler" allows extensionless imports like:
 *   import { foo } from '../config/paths'
 * 
 * But Node.js ESM requires the .js extension:
 *   import { foo } from '../config/paths.js'
 * 
 * This script fixes all relative imports in dist/ that are missing extensions.
 * It handles:
 *   - `from './foo'`        → `from './foo.js'`
 *   - `from '../bar/baz'`   → `from '../bar/baz.js'`
 *   - `import('./qux')`     → `import('./qux.js')`
 *   - Already correct imports are left alone
 *   - Package imports (starting with @ or no .) are skipped
 */

import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const DIST_DIR = join(import.meta.dirname, '..', 'dist');

let fixed = 0;
let filesProcessed = 0;

function processDir(dir) {
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      processDir(fullPath);
    } else if (entry.endsWith('.js') || entry.endsWith('.mjs')) {
      processFile(fullPath);
    }
  }
}

function processFile(filePath) {
  let content = readFileSync(filePath, 'utf-8');
  let modified = false;

  // Match from '...' and from "..." for relative imports (./ or ../)
  // Also match dynamic import('...')
  // Skip anything that already has a .js/.mjs/.json extension
  // Skip node: protocol imports
  const importRegex = /((?:from|import)\s*['"])(\.[^'"]+)(['"])/g;
  const dynamicImportRegex = /(import\s*\(\s*['"])(\.[^'"]+)(['"])/g;

  function fixMatch(match, prefix, specifier, suffix) {
    // Already has extension
    if (/\.(js|mjs|cjs|json|ts)$/.test(specifier)) return match;
    // Skip node: protocol
    if (specifier.startsWith('node:')) return match;
    
    fixed++;
    modified = true;
    return `${prefix}${specifier}.js${suffix}`;
  }

  content = content.replace(importRegex, fixMatch);
  content = content.replace(dynamicImportRegex, fixMatch);

  if (modified) {
    writeFileSync(filePath, content, 'utf-8');
  }
  filesProcessed++;
}

processDir(DIST_DIR);
console.log(`fix-esm-extensions: processed ${filesProcessed} files, fixed ${fixed} imports`);
