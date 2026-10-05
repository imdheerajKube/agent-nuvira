/**
 * BUILD PROJECT PREREQUISITES (Workstream D2).
 *
 * The harness already detects MISSING BINARIES (`installableToolsFromFailure`,
 * `MISSING_BINARY_RE`) and hands the model the install command. It had NO check
 * for a MISSING PROJECT FILE/FEATURE — the other half of the same failure. The
 * live macOS build failed on `src-tauri/build.rs` (→ `OUT_DIR env var is not
 * set`), then on a missing Cargo `custom-protocol` feature, retrying the same
 * `npx tauri build` ~10 times because nothing recognized either as a
 * prerequisite.
 *
 * This module is a DATA TABLE: error-output signatures → the concrete fix, plus
 * project-marker pre-flight checks for Tauri/Rust. Adding an ecosystem is a row
 * + a test, not a code path. It is deliberately pure (no fs in the signature
 * path) so it can be unit tested from real error strings.
 */

// ─── Signature rules (error output → fix) ───────────────────────────────────

export interface PrerequisiteRule {
  /** Stable id (also used in tests). */
  id: string;
  /** Ecosystem family (rust, node, python, go, jvm, dotnet, swift, cmake, docker). */
  ecosystem: string;
  /** One-line description of the missing prerequisite. */
  description: string;
  /** Any match in a failed command's output selects this rule. */
  signature: RegExp[];
  /** The exact, concrete fix to hand the model. */
  fix: string;
}

export const PREREQUISITE_RULES: PrerequisiteRule[] = [
  {
    id: 'rust-build-script-missing',
    ecosystem: 'rust',
    description: 'a build script (build.rs) is missing',
    signature: [
      /OUT_DIR env var is not set/i,
      /The OUT_DIR environment variable is not set/i,
      /could not find a build script/i,
    ],
    fix:
      'Create `src-tauri/build.rs` (or the crate root\'s `build.rs`) containing ' +
      '`fn main() { tauri_build::build() }` (or the crate\'s own build call), and ensure ' +
      '`[build-dependencies] tauri-build` (or the matching build crate) is declared in Cargo.toml.',
  },
  {
    id: 'tauri-build-version-mismatch',
    ecosystem: 'rust',
    description: 'tauri-build major version does not match tauri',
    signature: [
      /tauri-build.*version.*(?:mismatch|incompatible|requirement|does not match)/i,
      /this version of `?tauri-build`?/i,
      /failed to select a version for the requirement `?tauri-build`?/i,
    ],
    fix:
      'Make `[build-dependencies] tauri-build` use the SAME major version as the `tauri` ' +
      'dependency (e.g. both `1`, or both `2`) in Cargo.toml.',
  },
  {
    id: 'cargo-feature-missing-custom-protocol',
    ecosystem: 'rust',
    description: 'a required Cargo feature (custom-protocol) is missing',
    signature: [
      /does not contain this feature:?\s*`?custom-protocol`?/i,
      /the package .* does not have the feature `?custom-protocol`?/i,
      /feature `?custom-protocol`? .* (?:not found|missing)/i,
    ],
    fix:
      'Add the feature to Cargo.toml:\n  [features]\n  custom-protocol = []\n  default = ["custom-protocol"]',
  },
  {
    id: 'icon-file-missing',
    ecosystem: 'rust',
    description: 'a bundled icon file referenced by bundle.icon does not exist',
    signature: [
      /failed to read icon/i,
      /icon .* (?:does not exist|not found|no such file)/i,
      /the icon path .* cannot be found/i,
    ],
    fix:
      'Create the file(s) named in `tauri.conf.json` → `bundle.icon` (a 512×512 PNG at ' +
      '`src-tauri/icons/icon.png` is the safe default) or remove the missing entry.',
  },
  {
    id: 'go-module-missing',
    ecosystem: 'go',
    description: 'go module/sum file is out of date',
    signature: [
      /missing go\.sum entry/i,
      /no required module provides package/i,
      /cannot find module providing package/i,
    ],
    fix: 'Run `go mod tidy` (and `go mod download`) before building.',
  },
  {
    id: 'dotnet-assets-missing',
    ecosystem: 'dotnet',
    description: 'NuGet restore has not run',
    signature: [/NETSDK1004/i, /Assets file .* project\.assets\.json .* not found/i],
    fix: 'Run `dotnet restore` before `dotnet build`.',
  },
  {
    id: 'node-config-file-missing',
    ecosystem: 'node',
    description: 'a build config file a script references is missing',
    signature: [
      /ENOENT: no such file or directory, open .*(tsconfig|vite\.config|webpack\.config|rollup\.config|next\.config|jest\.config|tailwind\.config)/i,
      /Could not resolve entry module/i,
    ],
    fix:
      'Create the referenced config file (e.g. `tsconfig.json`, `vite.config.ts`) at the project ' +
      'root, or fix the path the build script points at. If the config is optional, pass an ' +
      'explicit `--config` pointing at an existing file.',
  },
  {
    id: 'python-build-backend-missing',
    ecosystem: 'python',
    description: 'the build backend declared in pyproject.toml is not installed',
    signature: [
      /error: metadata-generation-failed/i,
      /ModuleNotFoundError: No module named '(?:setuptools|hatchling|flit_core|poetry)'/i,
    ],
    fix:
      'Install the declared build backend (e.g. `python -m pip install --upgrade setuptools wheel`) ' +
      'or add it to `[build-system] requires` in pyproject.toml.',
  },
  {
    id: 'cmake-config-missing',
    ecosystem: 'cmake',
    description: 'CMake has not been configured (no build directory)',
    signature: [
      /CMake Error: .* build directory/i,
      /No CMAKE_CXX_COMPILER could be found/i,
      /does not appear to contain CMakeLists\.txt/i,
    ],
    fix:
      'Run `cmake -S . -B build` first (and point it at the directory containing CMakeLists.txt), ' +
      'then `cmake --build build`.',
  },
  {
    id: 'jvm-wrapper-missing',
    ecosystem: 'jvm',
    description: 'the Gradle/Maven wrapper or build file is missing',
    signature: [
      /Could not find or load main class .*gradle\.wrapper/i,
      /No such file.*gradlew/i,
      /The project .* is not a Maven project/i,
    ],
    fix:
      'Use the project\'s wrapper (`./gradlew`, `./mvnw`) if present, else run `gradle wrapper` / ' +
      'ensure `pom.xml` or `build.gradle` exists at the project root.',
  },
];

/**
 * Find every prerequisite rule whose signature appears in a failed command's
 * output. Pure — the caller supplies the text.
 *
 * NOTE: build-command recognition is NOT duplicated here — it lives in
 * `utils/effect-verification.ts` (`isBuildCommand`), the single source of truth
 * shared with the effect-verification guard.
 */
export function matchPrerequisiteSignatures(output: string): PrerequisiteRule[] {
  if (!output) return [];
  const matched: PrerequisiteRule[] = [];
  for (const rule of PREREQUISITE_RULES) {
    if (rule.signature.some((re) => re.test(output))) matched.push(rule);
  }
  return matched;
}

/**
 * Build the deterministic takeover instruction for the matched rules — the same
 * shape as `toolTakeoverInstruction`: state the prerequisite, forbid the
 * "cannot" conclusion, give the exact fix.
 */
export function prerequisiteTakeoverInstruction(rules: PrerequisiteRule[]): string {
  if (rules.length === 0) return '';
  const lines = rules.map((r) => `- [${r.ecosystem}] ${r.description}\n  FIX: ${r.fix}`);
  return (
    '⚠️ BUILD PREREQUISITE MISSING — this is a project FILE/FEATURE to add, not a tool to ' +
    'install and not a capability limit. Do NOT retry the same command unchanged and do NOT ' +
    'tell the user you are unable to build. Apply the fix below, then re-run the ORIGINAL ' +
    'command:\n' +
    lines.join('\n')
  );
}

// ─── Pre-flight checks (project markers on disk) ────────────────────────────

/** Minimal filesystem view, injectable so checks are unit-testable. */
export interface PrereqFs {
  /** Read a file relative to the project root; undefined when missing. */
  readFile: (rel: string) => string | undefined;
  /** Does a file/dir exist relative to the project root? */
  exists: (rel: string) => boolean;
}

export interface PrerequisiteFinding {
  id: string;
  ecosystem: string;
  description: string;
  fix: string;
}

/**
 * Pre-flight checks for a project about to be BUILT. Returns failures only.
 * Today: the four real Tauri blockers, guarded on the `src-tauri` marker so a
 * non-Tauri project is untouched.
 */
export function checkProjectPrerequisites(fs: PrereqFs): PrerequisiteFinding[] {
  const findings: PrerequisiteFinding[] = [];
  const hasTauri = fs.exists('src-tauri/tauri.conf.json') || fs.exists('src-tauri/Cargo.toml');
  if (!hasTauri) return findings;

  // 1) build.rs must exist.
  if (!fs.exists('src-tauri/build.rs')) {
    findings.push({
      id: 'rust-build-script-missing',
      ecosystem: 'rust',
      description: 'src-tauri/build.rs is missing',
      fix: 'Create `src-tauri/build.rs` with `fn main() { tauri_build::build() }`.',
    });
  }

  const cargo = fs.readFile('src-tauri/Cargo.toml');
  if (cargo !== undefined) {
    // 2) tauri-build major must match tauri.
    const tauriDep = cargo.match(/^\s*tauri\s*=\s*\{?\s*version\s*=\s*"([^"]+)"/m);
    const buildDep = cargo.match(/tauri-build\s*=\s*(?:\{[^}]*version\s*=\s*)?"([^"]+)"/m);
    if (tauriDep && buildDep) {
      const major = (v: string) => v.replace(/^[^0-9]*/, '').split('.')[0];
      if (major(tauriDep[1]) !== major(buildDep[1])) {
        findings.push({
          id: 'tauri-build-version-mismatch',
          ecosystem: 'rust',
          description: `tauri-build "${buildDep[1]}" major does not match tauri "${tauriDep[1]}"`,
          fix: `Set tauri-build to match tauri ${major(tauriDep[1])}.x in [build-dependencies].`,
        });
      }
    }
    // 3) custom-protocol feature must exist when tauri-build 1.x is used.
    if (/tauri-build/.test(cargo) && !/^\s*custom-protocol\s*=/m.test(cargo)) {
      findings.push({
        id: 'cargo-feature-missing-custom-protocol',
        ecosystem: 'rust',
        description: 'the `custom-protocol` Cargo feature is missing',
        fix: 'Add `[features]` with `custom-protocol = []` and `default = ["custom-protocol"]`.',
      });
    }
  }

  // 4) bundle.icon files must exist.
  const conf = fs.readFile('src-tauri/tauri.conf.json');
  if (conf !== undefined) {
    try {
      const parsed = JSON.parse(conf) as { bundle?: { icon?: unknown } };
      const icons = Array.isArray(parsed.bundle?.icon) ? parsed.bundle!.icon! : [];
      for (const icon of icons) {
        if (typeof icon === 'string' && icon && !fs.exists(icon)) {
          findings.push({
            id: 'icon-file-missing',
            ecosystem: 'rust',
            description: `bundle.icon references a missing file: ${icon}`,
            fix: `Create ${icon} (a 512×512 PNG) or remove it from bundle.icon.`,
          });
        }
      }
    } catch {
      // A malformed tauri.conf.json is a different error; leave it to the build.
    }
  }

  return findings;
}

import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

/** A real-filesystem {@link PrereqFs} rooted at `rootDir`. */
export function createNodePrereqFs(rootDir: string): PrereqFs {
  const abs = (rel: string): string => (isAbsolute(rel) ? rel : join(rootDir, rel));
  return {
    exists: (rel) => {
      try {
        return existsSync(abs(rel));
      } catch {
        return false;
      }
    },
    readFile: (rel) => {
      try {
        const p = abs(rel);
        return existsSync(p) ? readFileSync(p, 'utf-8') : undefined;
      } catch {
        return undefined;
      }
    },
  };
}

/** Format pre-flight findings as a prerequisite instruction, or '' when clean. */
export function formatPreflightFindings(findings: PrerequisiteFinding[]): string {
  if (findings.length === 0) return '';
  const lines = findings.map((f) => `- [${f.ecosystem}] ${f.description}\n  FIX: ${f.fix}`);
  return (
    '⚠️ PROJECT PREREQUISITES MISSING (pre-flight) — check these BEFORE building; do not ' +
    'discover them one failed build at a time:\n' +
    lines.join('\n')
  );
}
