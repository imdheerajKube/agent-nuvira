/**
 * Init command — Scaffold new projects from templates.
 *
 * Usage:
 *   buff init                    — Interactive prompt for project name and template
 *   buff init my-app             — Create project 'my-app' with interactive template picker
 *   buff init my-app --template node-cli  — Create from a specific template
 *   buff init my-app --list      — List available templates
 *   buff init my-app --template custom --template-dir ~/my-templates
 *
 * Templates are stored in ~/.buff/templates/ and can be custom.
 * Built-in templates ship with the CLI.
 */

import { Command } from 'commander';
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, basename, extname } from 'node:path';
import { homedir } from 'node:os';
import inquirer from 'inquirer';

import { BaseCommand } from './commands.js';
import { logger } from '../utils/logger.js';
import { showModelPicker } from './model-picker.js';

// ─── Template Definitions ───────────────────────────────────────────────────

export interface InitTemplate {
  /** Template identifier */
  id: string;
  /** Human-readable name */
  name: string;
  /** Short description */
  description: string;
  /** Files to create (key = path, value = content or generator function) */
  files: Record<string, string | ((projectName: string) => string)>;
  /** Dependencies to add (npm packages, etc.) */
  dependencies?: string[];
  /** Dev dependencies */
  devDependencies?: string[];
  /** Post-creation instructions */
  postInstall?: string[];
}

const BUILTIN_TEMPLATES: InitTemplate[] = [
  {
    id: 'node-cli',
    name: 'Node.js CLI',
    description: 'A minimal Node.js CLI application with TypeScript support',
    files: {
      'package.json': (name: string) => JSON.stringify({
        name,
        version: '1.0.0',
        description: '',
        type: 'module',
        main: 'dist/index.js',
        bin: { [name]: 'dist/index.js' },
        scripts: {
          build: 'tsc',
          start: 'node dist/index.js',
          dev: 'tsx src/index.ts',
        },
        dependencies: {},
        devDependencies: {
          typescript: '^5.3.0',
          'tsx': '^4.7.0',
          '@types/node': '^20.11.0',
        },
      }, null, 2),
      'tsconfig.json': JSON.stringify({
        compilerOptions: {
          target: 'ES2022',
          module: 'ESNext',
          moduleResolution: 'bundler',
          esModuleInterop: true,
          strict: true,
          outDir: './dist',
          rootDir: './src',
          declaration: true,
          skipLibCheck: true,
        },
        include: ['src'],
      }, null, 2),
      'src/index.ts': `#!/usr/bin/env node\n\nfunction main(): void {\n  const args = process.argv.slice(2);\n  console.log('Hello from {{name}}!', args);\n}\n\nmain();\n`,
      '.gitignore': 'node_modules/\ndist/\n.env\n',
      'README.md': (name: string) => `# ${name}\n\n## Usage\n\n\`\`\`bash\n${name} --help\n\`\`\`\n`,
    },
    dependencies: [],
    devDependencies: ['typescript', 'tsx', '@types/node'],
    postInstall: ['Run `npm run build` to compile', 'Run `npm link` to use globally'],
  },
  {
    id: 'ts-library',
    name: 'TypeScript Library',
    description: 'A TypeScript library with testing setup',
    files: {
      'package.json': (name: string) => JSON.stringify({
        name,
        version: '1.0.0',
        description: '',
        type: 'module',
        main: 'dist/index.js',
        types: 'dist/index.d.ts',
        scripts: {
          build: 'tsc',
          test: 'vitest run',
          'test:watch': 'vitest',
        },
        dependencies: {},
        devDependencies: {
          typescript: '^5.3.0',
          vitest: '^4.1.0',
        },
      }, null, 2),
      'tsconfig.json': JSON.stringify({
        compilerOptions: {
          target: 'ES2022',
          module: 'ESNext',
          moduleResolution: 'bundler',
          esModuleInterop: true,
          strict: true,
          outDir: './dist',
          rootDir: './src',
          declaration: true,
          skipLibCheck: true,
        },
        include: ['src'],
      }, null, 2),
      'src/index.ts': `export function greet(name: string): string {\n  return \`Hello, \${name}!\`;\n}\n`,
      'tests/index.test.ts': `import { describe, it, expect } from 'vitest';\nimport { greet } from '../src/index.js';\n\ndescribe('greet', () => {\n  it('should return a greeting', () => {\n    expect(greet('World')).toBe('Hello, World!');\n  });\n});\n`,
      '.gitignore': 'node_modules/\ndist/\n',
      'README.md': (name: string) => `# ${name}\n\n## Installation\n\n\`\`\`bash\nnpm install ${name}\n\`\`\`\n`,
    },
    devDependencies: ['typescript', 'vitest'],
    postInstall: ['Run `npm test` to verify setup', 'Run `npm run build` to compile'],
  },
  {
    id: 'node-api',
    name: 'Node.js API Server',
    description: 'An Express.js API server with TypeScript',
    files: {
      'package.json': (name: string) => JSON.stringify({
        name,
        version: '1.0.0',
        description: '',
        type: 'module',
        main: 'dist/index.js',
        scripts: {
          build: 'tsc',
          start: 'node dist/index.js',
          dev: 'tsx watch src/index.ts',
        },
        dependencies: {
          express: '^4.18.0',
        },
        devDependencies: {
          typescript: '^5.3.0',
          'tsx': '^4.7.0',
          '@types/node': '^20.11.0',
          '@types/express': '^4.17.0',
        },
      }, null, 2),
      'tsconfig.json': JSON.stringify({
        compilerOptions: {
          target: 'ES2022',
          module: 'ESNext',
          moduleResolution: 'bundler',
          esModuleInterop: true,
          strict: true,
          outDir: './dist',
          rootDir: './src',
          skipLibCheck: true,
        },
        include: ['src'],
      }, null, 2),
      'src/index.ts': `import express from 'express';\n\nconst app = express();\nconst PORT = process.env.PORT || 3000;\n\napp.use(express.json());\n\napp.get('/health', (_req, res) => {\n  res.json({ status: 'ok', timestamp: new Date().toISOString() });\n});\n\napp.listen(PORT, () => {\n  console.log(\`Server running on http://localhost:\${PORT}\`);\n});\n`,
      '.gitignore': 'node_modules/\ndist/\n.env\n',
      'README.md': (name: string) => `# ${name}\n\n## Quick Start\n\n\`\`\`bash\nnpm install\nnpm run dev\n\`\`\`\n`,
    },
    dependencies: ['express'],
    devDependencies: ['typescript', 'tsx', '@types/node', '@types/express'],
    postInstall: ['Run `npm run dev` to start the development server'],
  },
  {
    id: 'python-cli',
    name: 'Python CLI',
    description: 'A Python CLI application with testing setup',
    files: {
      'pyproject.toml': (name: string) => `[build-system]\nrequires = ["hatchling"]\nbuild-backend = "hatchling.build"\n\n[project]\nname = "${name}"\nversion = "1.0.0"\ndescription = ""\nrequires-python = ">=3.10"\ndependencies = []\n\n[project.scripts]\n${name} = "${name}.cli:main"\n`,
      'src/__init__.py': '',
      'src/cli.py': `#!/usr/bin/env python3\n\ndef main():\n    import sys\n    print(f"Hello from {__name__}!", sys.argv[1:])\n\n\nif __name__ == "__main__":\n    main()\n`,
      'tests/test_cli.py': `import pytest\n\ndef test_placeholder():\n    assert True\n`,
      '.gitignore': 'venv/\n__pycache__/\n*.pyc\n.env\n',
      'README.md': (name: string) => `# ${name}\n\n## Usage\n\n\`\`\`bash\npip install -e .\n${name} --help\n\`\`\`\n`,
    },
    postInstall: ['Install with `pip install -e .`', 'Or use `pip install hatchling` and `pip install -e .`'],
  },
  {
    id: 'minimal',
    name: 'Minimal Project',
    description: 'A minimal project with just a README and .gitignore',
    files: {
      '.gitignore': 'node_modules/\n.env\n',
      'README.md': (name: string) => `# ${name}\n\n## Getting Started\n\nDescribe your project here.\n`,
    },
    postInstall: ['Start adding your project files!'],
  },
];

// ─── Paths ──────────────────────────────────────────────────────────────────

const BUFF_DIR = join(homedir(), '.buff');
const TEMPLATES_DIR = join(BUFF_DIR, 'templates');

function ensureTemplateDir(): void {
  if (!existsSync(TEMPLATES_DIR)) {
    try { mkdirSync(TEMPLATES_DIR, { recursive: true }); } catch { /* best-effort */ }
  }
}

// ─── InitCommand ────────────────────────────────────────────────────────────

export class InitCommand extends BaseCommand {
  create(): Command {
    const command = new Command('init')
      .description('Scaffold a new project from a template')
      .argument('[project-name]', 'Name of the project to create')
      .option('-t, --template <template>', 'Template to use (node-cli, ts-library, node-api, python-cli, minimal)')
      .option('--list', 'List available templates and exit', false)
      .option('--template-dir <path>', 'Custom template directory', String(TEMPLATES_DIR))
      .option('-p, --provider <provider>', 'Default AI provider for the project')
      .option('-m, --model <model>', 'Default model for the project')
      .action(async (projectName?: string, options?: {
        template?: string;
        list?: boolean;
        templateDir?: string;
        provider?: string;
        model?: string;
      }) => {
        await this.execute(projectName, options || {});
      });

    return command;
  }

  private async execute(
    projectName?: string,
    options?: {
      template?: string;
      list?: boolean;
      templateDir?: string;
      provider?: string;
      model?: string;
    },
  ): Promise<void> {
    // ── List templates ──────────────────────────────────────────────────
    if (options?.list) {
      this.listTemplates();
      return;
    }

    // ── Get project name ────────────────────────────────────────────────
    let name = projectName;
    if (!name) {
      const answer = await inquirer.prompt<{ name: string }>([
        {
          type: 'input',
          name: 'name',
          message: 'Project name:',
          default: 'my-project',
          validate: (input: string) => {
            if (!input.trim()) return 'Project name is required';
            if (!/^[a-z0-9-_.]+$/.test(input.trim())) return 'Use only lowercase letters, numbers, hyphens, underscores, and dots';
            return true;
          },
        },
      ]);
      name = answer.name.trim();
    }

    // Validate project name
    const projectDir = join(process.cwd(), name);
    if (existsSync(projectDir)) {
      logger.error(`Directory already exists: ${name}`);
      logger.info('Choose a different project name or navigate to a different directory.');
      return;
    }

    // ── Get template ────────────────────────────────────────────────────
    let templateId = options?.template;
    if (!templateId) {
      const templates = this.getAllTemplates(options?.templateDir);
      const answer = await inquirer.prompt<{ template: string }>([
        {
          type: 'list',
          name: 'template',
          message: 'Select a template:',
          choices: templates.map((t) => ({
            name: `${t.name} — ${t.description}`,
            value: t.id,
            short: t.name,
          })),
        },
      ]);
      templateId = answer.template;
    }

    const template = this.findTemplate(templateId, options?.templateDir);
    if (!template) {
      logger.error(`Unknown template: '${templateId}'`);
      console.log('Available templates:');
      this.listTemplates();
      return;
    }

    // ── Optional: Provider selection ────────────────────────────────────
    let providerChoice: { provider: string; model: string } | null = null;
    if (!options?.provider) {
      const wantsProvider = await inquirer.prompt<{ wantsProvider: boolean }>([
        {
          type: 'confirm',
          name: 'wantsProvider',
          message: 'Configure a default AI provider for this project?',
          default: true,
        },
      ]);

      if (wantsProvider.wantsProvider) {
        providerChoice = await showModelPicker(this.configManager);
      }
    } else if (options?.model) {
      providerChoice = { provider: options.provider, model: options.model };
    } else {
      providerChoice = { provider: options.provider, model: options.model || 'default' };
    }

    // ── Create project ──────────────────────────────────────────────────
    const spinText = `Creating project '${name}'...`;
    logger.info(spinText);

    try {
      mkdirSync(projectDir, { recursive: true });

      // Create files
      for (const [filePath, content] of Object.entries(template.files)) {
        const fullPath = join(projectDir, filePath);
        const dir = filePath.includes('/') ? join(projectDir, filePath.split('/').slice(0, -1).join('/')) : projectDir;
        if (!existsSync(dir)) {
          mkdirSync(dir, { recursive: true });
        }

        const resolvedContent = typeof content === 'function'
          ? content(name)
          : content.replace(/{{name}}/g, name).replace(/\{\{NAME\}\}/g, name);

        writeFileSync(fullPath, resolvedContent, 'utf-8');
      }

      // Generate .buffconfig.json if provider was selected
      if (providerChoice) {
        const buffConfig = {
          defaultProvider: providerChoice.provider,
          providers: {
            [providerChoice.provider]: {
              model: providerChoice.model || 'default',
              temperature: 0.7,
              maxTokens: 4096,
            },
          },
        };
        writeFileSync(join(projectDir, '.buffconfig.json'), JSON.stringify(buffConfig, null, 2), 'utf-8');
      }

      // ── Success output ──────────────────────────────────────────────
      logger.success(`Created project '${name}' in ${projectDir}\n`);

      console.log(`  📁 Project structure:`);
      this.printStructure(projectDir, '');

      if (template.dependencies && template.dependencies.length > 0) {
        console.log(`\n  📦 Dependencies: ${template.dependencies.join(', ')}`);
      }
      if (template.devDependencies && template.devDependencies.length > 0) {
        console.log(`  🔧 Dev dependencies: ${template.devDependencies.join(', ')}`);
      }

      if (template.postInstall && template.postInstall.length > 0) {
        console.log(`\n  📋 Next steps:`);
        console.log(`     cd ${name}`);
        for (const step of template.postInstall) {
          console.log(`     ${step}`);
        }
      }

      if (providerChoice) {
        console.log(`\n  🤖 AI provider: ${providerChoice.provider} (${providerChoice.model})`);
        console.log(`     Edit .buffconfig.json to change settings.`);
      }

      console.log('');

    } catch (err) {
      logger.error(`Failed to create project: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private listTemplates(templateDir?: string): void {
    const templates = this.getAllTemplates(templateDir);

    logger.highlight(`${'═'.repeat(60)}`);
    logger.highlight('  📋  Available Project Templates');
    logger.highlight(`${'═'.repeat(60)}`);

    for (const t of templates) {
      console.log(`\n  ${t.id}`);
      console.log(`  ${'─'.repeat(t.id.length)}`);
      console.log(`  ${t.description}`);
      if (t.files) {
        const fileCount = Object.keys(t.files).length;
        console.log(`  ${fileCount} files`);
      }
    }

    console.log(`\n  Usage:`);
    console.log('    buff init <project-name> --template <template-id>');
    console.log(`\n  Custom templates: ~/.buff/templates/`);
    console.log('');
  }

  /**
   * Get all available templates (built-in + custom from ~/.buff/templates/).
   */
  private getAllTemplates(templateDir?: string): InitTemplate[] {
    const templates = [...BUILTIN_TEMPLATES];
    const dir = templateDir || TEMPLATES_DIR;

    // Load custom templates from ~/.buff/templates/
    try {
      ensureTemplateDir();
      const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
      for (const file of files) {
        try {
          const content = readFileSync(join(dir, file), 'utf-8');
          const parsed = JSON.parse(content) as InitTemplate;
          if (parsed.id && parsed.name && parsed.files) {
            templates.push(parsed);
          }
        } catch {
          // Skip invalid template files
        }
      }
    } catch {
      // Directory might not exist yet
    }

    return templates;
  }

  /**
   * Find a template by ID (searches built-in first, then custom).
   */
  private findTemplate(id: string, templateDir?: string): InitTemplate | undefined {
    const templates = this.getAllTemplates(templateDir);
    return templates.find((t) => t.id === id);
  }

  /**
   * Print the project structure recursively.
   */
  private printStructure(dir: string, prefix: string): void {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        console.log(`  ${prefix}📁 ${entry.name}/`);
        this.printStructure(fullPath, `${prefix}   `);
      } else {
        console.log(`  ${prefix}📄 ${entry.name}`);
      }
    }
  }
}
