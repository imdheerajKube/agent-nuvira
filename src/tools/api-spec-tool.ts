/**
 * `api_spec` — write the OpenAPI document FROM the route table.
 *
 * WHY A TOOL AND NOT A HARNESS STEP. The harness knows the routes (it verifies the spec
 * against them), but the document is a deliverable the model must own: which operations
 * matter, what they mean, what they return. Generating it silently would hand over a
 * skeleton with no owner. So the model asks for it, gets the paths and methods exactly
 * right, and fills in what only it knows — the same division of labour as `plan_todo`.
 *
 * REFUSES BY DEFAULT. An existing spec is hand-written knowledge (descriptions, schemas,
 * examples, security) and the skeleton would flatten it. On refusal it reports the
 * verification verdict instead, so the model is pointed at the DRIFT rather than handed a
 * replacement — `force: true` is for a stub it wants to throw away.
 *
 * It never invents behaviour: every summary is a `TODO` carrying the method, the path and
 * the file the route was found in, because a guessed summary is a lie a client author
 * builds against.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { ToolContext } from './registry.js';
import { DEFAULT_SPEC_PATH, generateOpenApi } from '../learning/api-spec.js';
import { verifyApiContract } from '../learning/api-contract.js';

export interface ApiSpecArgs {
  /** Workspace-relative output path (default `docs/openapi.yaml`). */
  path?: string;
  /** Replace an existing document with the generated skeleton. */
  force?: boolean;
}

export function runApiSpec(args: ApiSpecArgs, ctx: ToolContext): string {
  const cwd = ctx.cwd ?? process.cwd();
  const rel = (args.path ?? DEFAULT_SPEC_PATH).replace(/^\.\//, '');
  const abs = join(cwd, rel);

  if (existsSync(abs) && args.force !== true) {
    const verdict = verifyApiContract({ cwd });
    const lines = [
      `Error: \`${rel}\` already exists — regenerating would replace descriptions, schemas and examples with a skeleton.`,
    ];
    if (verdict.specPath && verdict.parsed) {
      lines.push(
        `It documents ${verdict.documented} operation(s) against ${verdict.registered} registered route(s); ` +
          `${verdict.total} contract problem(s).`,
      );
      for (const problem of verdict.problems.slice(0, 5)) {
        lines.push(`  - ${problem.kind}: ${problem.claim} — ${problem.problem}`);
      }
      lines.push('Fix the document (or the routes it describes). Pass `force: true` only to replace a stub.');
    } else {
      lines.push('It could not be read as an OpenAPI document. Pass `force: true` to replace it with the generated skeleton.');
    }
    return lines.join('\n');
  }

  const generated = generateOpenApi({ cwd, path: rel });
  if (generated.operations === 0) {
    return (
      'Error: no HTTP routes were found in this project — there is nothing to document. ' +
      'Register the routes first (express/fastify routers mounted with `app.use`, or nest controllers).'
    );
  }
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, generated.yaml);
  return [
    `✅ Wrote \`${rel}\` — ${generated.operations} operation(s) across ${generated.paths} path(s), derived from the registered routes.`,
    'Paths, methods and parameter names are exact (they ARE the code). Every summary is a TODO:',
    'fill in the operations a client actually needs, and add request/response schemas where they matter.',
    'Do not describe behaviour the route does not implement.',
  ].join('\n');
}
