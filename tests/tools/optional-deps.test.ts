/**
 * Optional-tool install recipes (`nuvira tools install <name>`).
 *
 * The load-bearing assertion is the CROSS-CHECK: the package a recipe tells the
 * user to install must be the same package the tool's own availability probe
 * resolves. If those two ever drift, the command installs something the tool
 * does not look for and reports failure on a machine where it just succeeded —
 * the exact class of bug this module was created to remove.
 */

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { OPTIONAL_TOOL_RECIPES, describeOptionalTools, getOptionalToolRecipe } from '../../src/tools/optional-deps.js';
import { isBrowserAvailable, resetBrowserAvailability } from '../../src/tools/modality/browser.js';

const require = createRequire(import.meta.url);

/** True when a package resolves from this project (what the probe checks). */
function packageResolves(name: string): boolean {
  try {
    require.resolve(name);
    return true;
  } catch {
    return false;
  }
}

describe('optional tool recipes', () => {
  it('looks a recipe up by id, case-insensitively, and never guesses', () => {
    expect(getOptionalToolRecipe('browser')?.packageName).toBe('playwright');
    expect(getOptionalToolRecipe('BROWSER')?.id).toBe('browser');
    expect(getOptionalToolRecipe('not-a-tool')).toBeNull();
    expect(getOptionalToolRecipe('')).toBeNull();
  });

  it('every recipe is actionable: a package, an install command, and a manual fallback', () => {
    expect(OPTIONAL_TOOL_RECIPES.length).toBeGreaterThan(0);
    for (const recipe of OPTIONAL_TOOL_RECIPES) {
      expect(recipe.packageName).toBeTruthy();
      expect(recipe.installPackage).toContain(recipe.packageName);
      expect(recipe.enables.length).toBeGreaterThan(20);
      // A failed automated install must always end in instructions, not a shrug.
      expect(recipe.manualHint).toContain(recipe.packageName);
    }
  });

  it('names the SAME package the browser tool probes for', () => {
    const recipe = getOptionalToolRecipe('browser')!;
    resetBrowserAvailability();
    // The tool's probe and the recipe agree on the package, whichever way the
    // machine is provisioned (this asserts the agreement, not the install).
    expect(isBrowserAvailable()).toBe(packageResolves(recipe.packageName));
  });

  it('describes each optional tool in one line for the listing command', () => {
    const lines = describeOptionalTools();
    expect(lines).toHaveLength(OPTIONAL_TOOL_RECIPES.length);
    expect(lines[0]).toMatch(/^browser — /);
  });

  it('browser ships a one-time binary download (the npm package alone cannot open a page)', () => {
    const recipe = getOptionalToolRecipe('browser')!;
    expect(recipe.installBinaries).toContain('playwright install chromium');
  });
});
