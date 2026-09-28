/**
 * End-to-end suite — runs INSIDE a real VS Code instance.
 *
 * Every other test in this package mocks `vscode`, which means none of them can
 * catch the failure that matters most in the wild: the extension failing to
 * activate, or a command declared in `package.json` never getting registered.
 * This suite launches a real editor with the extension under development and
 * checks exactly that. It uses `node:assert` directly (no mocha) so the only
 * added dependency is `@vscode/test-electron`.
 */

import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

const EXTENSION_ID = 'dheerajsharma.agent-nuvira-vscode';

/** The manifest the running extension was loaded from. */
function readManifest(extensionPath: string): Record<string, any> {
  return JSON.parse(fs.readFileSync(path.join(extensionPath, 'package.json'), 'utf8'));
}

export async function run(): Promise<void> {
  // 1. The extension is present and activates without throwing.
  const extension = vscode.extensions.getExtension(EXTENSION_ID);
  assert.ok(extension, `Extension ${EXTENSION_ID} was not found in the test host`);

  const api = await extension!.activate();
  assert.ok(api, 'activate() must return the AgentNuviraApi');

  // 2. The public API surface is what other extensions would consume.
  for (const method of ['openChat', 'executeGoal', 'getActiveModel', 'getQuotaStatus'] as const) {
    assert.strictEqual(typeof api[method], 'function', `api.${method}() should be a function`);
  }
  assert.match(api.version, /^\d+\.\d+\.\d+/, 'api.version should be a semver string');

  // 3. Commands promised by the manifest and by the API are actually registered.
  //    This is the bug class that mocking `vscode` can never catch.
  const manifest = readManifest(extension!.extensionPath);
  const declared: string[] = (manifest.contributes?.commands ?? []).map((c: { command: string }) => c.command);
  assert.ok(declared.length >= 13, `expected at least 13 contributed commands, saw ${declared.length}`);

  const fromApi = new Set(api.commands as readonly string[]);
  const notAdvertised = declared.filter((id) => !fromApi.has(id));
  assert.deepStrictEqual(notAdvertised, [], `Declared commands missing from api.commands: ${notAdvertised.join(', ')}`);

  const registered = new Set(await vscode.commands.getCommands(true));
  const missing = declared.filter((id) => !registered.has(id));
  assert.deepStrictEqual(missing, [], `Commands declared but not registered: ${missing.join(', ')}`);

  // 4. Every `%placeholder%` the manifest uses must resolve from package.nls.json —
  //    VS Code leaves an unresolved placeholder as the literal string, which is
  //    invisible in code review and very visible in the UI.
  const nlsPath = path.join(extension!.extensionPath, 'package.nls.json');
  if (fs.existsSync(nlsPath)) {
    const nls = JSON.parse(fs.readFileSync(nlsPath, 'utf8')) as Record<string, string>;
    const raw = fs.readFileSync(path.join(extension!.extensionPath, 'package.json'), 'utf8');
    const missingKeys = [...raw.matchAll(/%([A-Za-z0-9_.]+)%/g)]
      .map((m) => m[1])
      .filter((key) => !(key in nls));
    assert.deepStrictEqual(missingKeys, [], `Manifest placeholders with no package.nls.json entry: ${missingKeys.join(', ')}`);
  }

  // 5. A view container icon declared as a path must exist on disk — VS Code
  //    silently falls back to a blank icon otherwise.
  for (const container of manifest.contributes?.viewsContainers?.activitybar ?? []) {
    const icon: string | undefined = container.icon;
    if (icon && !icon.startsWith('$(')) {
      const iconPath = path.join(extension!.extensionPath, icon);
      assert.ok(fs.existsSync(iconPath), `activitybar container icon not found on disk: ${icon}`);
    }
  }

  // 6. The settings the rest of the extension depends on exist.
  const config = vscode.workspace.getConfiguration('agent-nuvira');
  assert.ok(config.has('cliPath'), 'agent-nuvira.cliPath setting is missing');

  console.log(`E2E: ${declared.length} commands registered, API and manifest verified.`);
}
