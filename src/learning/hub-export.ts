/**
 * Hub export — render bundled skills into the `.agents/skills/` registry
 * layout (P5c #3: "populate repo .agents/skills/ with the bundled skills").
 *
 * The configured default registry is
 *   https://raw.githubusercontent.com/imdheerajKube/agent-nuvira/main/.agents/skills
 * which 404s today because the repo has no `.agents/skills/` dir. Shipping
 * the bundled skills in that layout makes the default registry RESOLVE —
 * `nuvira skills search` / `nuvira skills install` then find the first-party
 * batch from the same sources the store seeds.
 *
 * The generation is deliberately pure (fixture-testable): `hubIndexFor`
 * renders the HubIndex contract, `skillMdFor` renders a SKILL.md with
 * frontmatter + the full methodology (parameters + ordered steps with agent
 * types and dependencies) — the same depth bar the skill-compiler displays.
 *
 * Wired from scripts/sync-hub-skills.mjs (runs against the built dist); the
 * generated files are COMMITTED so the registry resolves without a build.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Skill } from './skill-types.js';

/** The index entry contract the registry expects (skills-hub HubSkillEntry). */
export interface HubExportEntry {
  name: string;
  description: string;
  version: string;
  author: string;
  tags: string[];
  source: string;
  updatedAt: string;
}

/** Render the registry index.json for a set of bundled skills. */
export function hubIndexFor(skills: Skill[], updatedAt = new Date().toISOString()): {
  version: number;
  updatedAt: string;
  skills: HubExportEntry[];
} {
  return {
    version: 1,
    updatedAt,
    skills: skills.map((s) => ({
      name: s.name,
      description: s.description,
      version: s.version,
      author: 'agent-nuvira',
      tags: s.tags,
      source: 'agent-nuvira/bundled',
      updatedAt,
    })),
  };
}

/**
 * Render a SKILL.md for one bundled skill: frontmatter (name must match the
 * index entry — install validates that) + the full methodology body.
 */
export function skillMdFor(skill: Skill): string {
  const lines: string[] = [
    '---',
    `name: ${skill.name}`,
    `description: ${skill.description}`,
    `version: ${skill.version}`,
    '---',
    '',
    `# ${skill.name}`,
    '',
    skill.description,
    '',
    `## Goal pattern`,
    '',
    skill.goalPattern,
    '',
    '## Parameters',
    '',
  ];
  if (skill.parameters.length === 0) {
    lines.push('(none)', '');
  } else {
    for (const p of skill.parameters) {
      const required = p.required ? ' (required)' : '';
      const def = p.defaultValue ? ` [default: ${p.defaultValue}]` : '';
      lines.push(`- ${p.name} (${p.type}${required}${def}): ${p.description}`);
    }
    lines.push('');
  }
  lines.push('## Steps', '');
  for (let i = 0; i < skill.steps.length; i++) {
    const step = skill.steps[i];
    const deps = step.dependsOn.length > 0 ? ` (after: ${step.dependsOn.join(', ')})` : '';
    lines.push(`${i + 1}. [${step.agentType}] ${step.description}${deps}`, '');
  }
  return lines.join('\n');
}

/**
 * Write the `.agents/skills/` layout for a set of bundled skills: index.json
 * + `<name>/SKILL.md` per skill. Returns the written file paths.
 */
export function writeHubSkills(skills: Skill[], outDir: string): string[] {
  mkdirSync(outDir, { recursive: true });
  const index = hubIndexFor(skills);
  const written: string[] = [];
  const indexPath = join(outDir, 'index.json');
  writeFileSync(indexPath, JSON.stringify(index, null, 2) + '\n', 'utf-8');
  written.push(indexPath);
  for (const skill of skills) {
    const dir = join(outDir, skill.name);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'SKILL.md');
    writeFileSync(path, skillMdFor(skill), 'utf-8');
    written.push(path);
  }
  return written;
}
