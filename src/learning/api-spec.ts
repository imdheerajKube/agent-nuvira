/**
 * GENERATE THE CONTRACT FROM THE ROUTES — so it cannot drift in the first place.
 *
 * WHY THIS EXISTS (measured 2026-10-27). Verifying a spec against the code catches a
 * contract that has already gone stale; it does not stop one. The winning arm's spec was
 * written by hand, 42 paths, and its own tree still served one undocumented route. Asking
 * a model to keep a hand-written document in step with 60 route registrations is asking it
 * to do bookkeeping it is measurably bad at — and the failure is silent, because a spec
 * that omits a route looks exactly like a spec that is complete.
 *
 * So the document is DERIVED from the routes the code registers: paths, methods and
 * parameter names, straight from the same scanner the verifier uses. Two consequences,
 * both intended:
 *
 *   - the generated paths can never disagree with the code, because they ARE the code;
 *   - what the generator cannot know — what each operation means, what it returns, which
 *     fields it takes — is emitted as an explicit `TODO` rather than invented. A summary
 *     that says TODO is honest and cheap to fill; a summary a model guessed is a lie a
 *     client author will build against.
 *
 * ORDER OF AUTHORITY, and this module is deliberately the lowest: an existing spec is
 * never overwritten without `force`, because hand-written descriptions, schemas and
 * examples are worth more than the skeleton. The tool that wraps this refuses by default
 * and reports the verification verdict instead, so a model that runs it on a real spec is
 * pointed at the drift rather than handed a flattened document.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { registeredRoutes, type RouteEntry } from './api-contract.js';

export const DEFAULT_SPEC_PATH = 'docs/openapi.yaml';

export interface GenerateSpecInput {
  cwd: string;
  /** Workspace-relative output path (default `docs/openapi.yaml`). */
  path?: string;
  /** Document metadata; read from package.json when absent. */
  title?: string;
  version?: string;
  description?: string;
  /** Routes to use, when the caller already has them. */
  routes?: readonly RouteEntry[];
  /** Only these methods (default: every method a client can call). */
  methods?: readonly string[];
}

export interface GeneratedSpec {
  path: string;
  yaml: string;
  operations: number;
  paths: number;
}

/** Methods a generated document should carry; `ALL` is a router catch-all, not an API. */
const DOCUMENTED_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

/** `/api/tasks/:id` → `/api/tasks/{id}` (OpenAPI's own parameter syntax). */
export function openApiPath(raw: string): string {
  const withParams = raw.replace(/:([A-Za-z0-9_]+)/g, '{$1}').replace(/<([A-Za-z0-9_]+)>/g, '{$1}');
  const collapsed = withParams.replace(/\/{2,}/g, '/').replace(/(.)\/+$/, '$1');
  return collapsed.startsWith('/') ? collapsed : `/${collapsed}`;
}

function packageMeta(cwd: string): { title?: string; version?: string; description?: string } {
  try {
    const pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf-8')) as {
      name?: string;
      version?: string;
      description?: string;
    };
    return {
      ...(pkg.name ? { title: pkg.name } : {}),
      ...(pkg.version ? { version: pkg.version } : {}),
      ...(pkg.description ? { description: pkg.description } : {}),
    };
  } catch {
    return {};
  }
}

/** YAML scalar quoting: only what would otherwise be misread. */
function quote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * The document, from the routes.
 *
 * Deterministic: same routes in, byte-identical document out (paths and methods sorted), so
 * a regeneration that changes nothing produces no diff — which is what makes it safe to run
 * on every build.
 */
export function generateOpenApi(input: GenerateSpecInput): GeneratedSpec {
  const routes = (input.routes ?? registeredRoutes({ cwd: input.cwd })).filter((r) =>
    (input.methods ? input.methods.includes(r.method) : DOCUMENTED_METHODS.has(r.method)),
  );
  const byPath = new Map<string, Map<string, RouteEntry>>();
  for (const route of routes) {
    const path = openApiPath(route.raw);
    const methods = byPath.get(path) ?? new Map<string, RouteEntry>();
    // First registration wins: a mounted router registered once is one operation.
    if (!methods.has(route.method)) methods.set(route.method, route);
    byPath.set(path, methods);
  }

  const meta = packageMeta(input.cwd);
  const title = input.title ?? meta.title ?? 'API';
  const version = input.version ?? meta.version ?? '1.0.0';
  const description =
    input.description ??
    'Generated from the routes this project registers. Operation summaries are TODOs: fill the ones that matter, and regenerate after adding a route.';

  const lines: string[] = [
    'openapi: 3.0.3',
    'info:',
    `  title: ${quote(title)}`,
    `  version: ${quote(version)}`,
    `  description: ${quote(description)}`,
    'servers:',
    '  - url: /',
    'paths:',
  ];

  let operations = 0;
  for (const path of [...byPath.keys()].sort()) {
    lines.push(`  ${quote(path)}:`);
    const methods = [...(byPath.get(path)?.entries() ?? [])].sort(([a], [b]) => a.localeCompare(b));
    for (const [method, route] of methods) {
      operations += 1;
      lines.push(
        `    ${method.toLowerCase()}:`,
        `      operationId: ${method.toLowerCase()}${path.replace(/[^A-Za-z0-9]+/g, '_')}`,
        `      summary: TODO — ${method} ${path} (registered in ${route.source})`,
        '      responses:',
        "        '200':",
        '          description: OK',
      );
    }
  }

  return {
    path: input.path ?? DEFAULT_SPEC_PATH,
    yaml: `${lines.join('\n')}\n`,
    operations,
    paths: byPath.size,
  };
}
