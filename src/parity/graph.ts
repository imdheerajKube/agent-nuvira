/**
 * WS0 (#22) — reading the real import graph so the registry cannot drift.
 *
 * A declared registry that nobody checks is documentation, and documentation
 * drifts silently — this repo has already been bitten by exactly that (the
 * dashboard bundle was hand-maintained generated output, and nothing noticed
 * until a whole tab was missing from it). So the surface registry is checked
 * against the modules themselves: a surface must actually reach a declared turn
 * entry, and the list of surfaces that construct their own provider must EQUAL
 * the frozen debt list, so the debt can only shrink.
 *
 * Dependency-free on purpose (regex + `fs`), for the same reason
 * `scripts/check-dashboard-bundle.mjs` is: this runs in the root suite on every
 * machine, and a parser here would be a new thing to keep working. A specifier
 * it fails to see makes the check NARROWER, never wrong — and the registry
 * assertions in `tests/parity/cross-surface.test.ts` fail loudly if the graph
 * comes back empty, so a silent zero-match cannot masquerade as compliance.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

import {
  SURFACES,
  SURFACE_DEBT,
  TURN_ENTRIES,
  type SurfaceDescriptor,
  type TurnEntryId,
} from './surfaces.js';

/** Source extensions a relative specifier may resolve to. */
const SOURCE_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json'];

/** The provider factory a surface must not construct for itself. */
export const PROVIDER_FACTORY_MODULE = 'src/inference/factory.ts';

const ORCHESTRATOR_MODULE = TURN_ENTRIES.orchestrator.module;
const PIPELINE_TOOL_MODULE = TURN_ENTRIES['pipeline-tool'].module;

/**
 * Relative import specifiers in a module — static `from '...'`, dynamic
 * `import('...')` (the dashboard reaches the chat engine this way), and
 * `require('...')` so a CJS shim cannot hide one.
 */
export function extractSpecifiers(code: string): string[] {
  const found = new Set<string>();
  const patterns = [
    /\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]/g,
  ];
  for (const pattern of patterns) {
    for (const match of code.matchAll(pattern)) found.add(match[1]);
  }
  return [...found];
}

/**
 * Resolve a relative specifier from `fromFile` to a repo-relative source path,
 * or null when it leaves the repo, points at a package, or does not exist.
 *
 * The `.js`-means-`.ts` rule is the repo's ESM convention (see
 * `scripts/fix-esm-extensions.mjs`): sources are written with the emitted
 * extension.
 */
export function resolveSpecifier(root: string, fromFile: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;
  const base = resolve(dirname(join(root, fromFile)), spec);
  const candidates = [
    base,
    base.replace(/\.js$/, '.ts'),
    base.replace(/\.js$/, '.tsx'),
    ...SOURCE_EXTS.map((ext) => base + ext),
    ...SOURCE_EXTS.map((ext) => join(base, `index${ext}`)),
  ];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    if (!statSync(candidate).isFile()) continue;
    const relPath = relative(root, candidate).split(sep).join('/');
    if (relPath.startsWith('..')) continue;
    return relPath;
  }
  return null;
}

/** The repo-relative modules `modulePath` imports directly (relative imports only). */
export function directImports(root: string, modulePath: string): string[] {
  let code: string;
  try {
    code = readFileSync(join(root, modulePath), 'utf-8');
  } catch {
    return [];
  }
  const out = new Set<string>();
  for (const spec of extractSpecifiers(code)) {
    const target = resolveSpecifier(root, modulePath, spec);
    if (target) out.add(target);
  }
  return [...out].sort();
}

/** What a surface's own modules actually do, read off the imports. */
export interface SurfaceReach {
  surface: SurfaceDescriptor['id'];
  /** Shared turn entries the surface's own modules reach, directly or by identity. */
  entries: TurnEntryId[];
  /** Surface modules that build their own provider. */
  providerFactory: string[];
  /** Surface modules that drive the pipeline engine without the wrapper. */
  pipelineWrapperBypass: string[];
  /**
   * True when the process-local rules were skipped because the surface IS its
   * own process. Recorded rather than silently empty: an exemption that is not
   * visible in the result is indistinguishable from a check that found nothing.
   */
  exemptFromProcessRules: boolean;
}

/**
 * Classify one surface from the real import graph.
 *
 * The rules are direct-import rules, deliberately: a surface reaching the
 * provider factory *through* a shared entry is the intended path, so only the
 * surface's own modules are inspected.
 */
export function classifySurface(root: string, surface: SurfaceDescriptor): SurfaceReach {
  const importsByModule = new Map<string, string[]>();
  for (const module of surface.modules) importsByModule.set(module, directImports(root, module));

  const reachesPipelineWrapper = [...importsByModule.values()].some((imports) =>
    imports.includes(PIPELINE_TOOL_MODULE),
  );

  const entries = new Set<TurnEntryId>();
  for (const [module, imports] of importsByModule) {
    for (const entry of Object.values(TURN_ENTRIES)) {
      // Identity counts: a surface whose own module IS the entry (cli/chat.ts,
      // tools/child-agent-runtime.ts) runs turns through it by definition.
      if (module === entry.module || imports.includes(entry.module)) entries.add(entry.id);
    }
  }

  // A surface that runs in its own process owns its provider AND its loop: that
  // is the isolation, not a silo, so the in-process rules do not apply. Its
  // behaviour is still compared — through the normalised observation, which is
  // where the child's provider/model/transport attribution is asserted.
  const exempt = surface.separateProcess === true;

  const providerFactory = exempt
    ? []
    : surface.modules
        .filter((module) => (importsByModule.get(module) ?? []).includes(PROVIDER_FACTORY_MODULE))
        .sort();

  const pipelineWrapperBypass =
    exempt || reachesPipelineWrapper
      ? []
      : surface.modules
          .filter((module) => (importsByModule.get(module) ?? []).includes(ORCHESTRATOR_MODULE))
          .sort();

  return {
    surface: surface.id,
    entries: [...entries].sort(),
    providerFactory,
    pipelineWrapperBypass,
    exemptFromProcessRules: exempt,
  };
}

/** Classify every declared surface. */
export function classifyAllSurfaces(root: string): SurfaceReach[] {
  return SURFACES.map((surface) => classifySurface(root, surface));
}

/**
 * The surface-level debt actually present in the tree, in the same shape as
 * `SURFACE_DEBT`. The architecture test asserts these are EQUAL, so a new
 * bypass fails and a fixed-but-not-unlisted one fails too.
 */
export function observedSurfaceDebt(root: string): Record<string, string[]> {
  const reached = classifyAllSurfaces(root);
  const collect = (pick: (reach: SurfaceReach) => string[]): string[] =>
    [...new Set(reached.flatMap(pick))].sort();
  return {
    'provider-factory': collect((r) => r.providerFactory),
    'pipeline-wrapper-bypass': collect((r) => r.pipelineWrapperBypass),
  };
}

/** The frozen debt, normalised the same way, for an equality assertion. */
export function declaredSurfaceDebt(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [kind, modules] of Object.entries(SURFACE_DEBT)) out[kind] = [...modules].sort();
  return out;
}
