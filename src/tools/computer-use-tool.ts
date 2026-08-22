/**
 * computer_use — Universal desktop control via cua-driver.
 *
 * Background computer-use: does NOT steal the user's cursor or keyboard focus.
 * Works with any tool-capable model. Preferred workflow:
 *   1. capture(mode='som') for numbered element overlays
 *   2. click(element=N) for reliable interaction
 *   3. Pixel coordinates as fallback for models trained on them
 *
 * Supports macOS, Windows, and Linux via cua-driver backend.
 */

import { execSync, spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

// ─── Types ──────────────────────────────────────────────────────────────────

type ComputerUseAction =
  | 'capture'
  | 'click'
  | 'double_click'
  | 'right_click'
  | 'middle_click'
  | 'drag'
  | 'scroll'
  | 'type'
  | 'key'
  | 'set_value'
  | 'wait'
  | 'list_apps'
  | 'list_windows'
  | 'focus_app'
  | 'health';

interface CaptureResult {
  image_base64?: string;
  som_elements?: { index: number; text: string; rect: { x: number; y: number; w: number; h: number } }[];
  text_summary?: string;
  width?: number;
  height?: number;
}

// ─── Safety ─────────────────────────────────────────────────────────────────

const SAFE_ACTIONS = new Set(['capture', 'wait', 'list_apps', 'list_windows', 'health']);
const DESTRUCTIVE_ACTIONS = new Set([
  'click', 'double_click', 'right_click', 'middle_click',
  'drag', 'scroll', 'type', 'key', 'set_value', 'focus_app',
]);

const BLOCKED_KEY_COMBOS = new Set([
  'cmd+shift+backspace', 'cmd+option+backspace',
  'cmd+ctrl+q', 'cmd+shift+q',
  'ctrl+alt+delete',
]);

// ─── Backend ────────────────────────────────────────────────────────────────

class CUABackend {
  private driverPath: string;
  private isAvailable = false;

  constructor() {
    // Check if cua-driver is available
    this.driverPath = this.findDriver();
    this.isAvailable = fs.existsSync(this.driverPath);
  }

  private findDriver(): string {
    // Common locations for cua-driver
    const candidates = [
      '/usr/local/bin/cua-driver',
      '/opt/homebrew/bin/cua-driver',
      path.join(process.env.HOME || '~', '.cargo/bin/cua-driver'),
      path.join(process.env.HOME || '~', '.local/bin/cua-driver'),
    ];

    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) return candidate;
    }

    // Try which
    try {
      return execSync('which cua-driver 2>/dev/null').toString().trim();
    } catch {
      return '';
    }
  }

  get available(): boolean {
    return this.isAvailable;
  }

  async execute(action: string, args: Record<string, any>): Promise<any> {
    if (!this.isAvailable) {
      throw new Error('cua-driver not found. Install it: cargo install cua-driver');
    }

    return new Promise((resolve, reject) => {
      const proc = spawn(this.driverPath, [action, JSON.stringify(args)], {
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 30_000,
      });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data) => { stdout += data; });
      proc.stderr.on('data', (data) => { stderr += data; });

      proc.on('close', (code) => {
        if (code === 0) {
          try {
            resolve(JSON.parse(stdout));
          } catch {
            resolve({ text: stdout });
          }
        } else {
          reject(new Error(stderr || `cua-driver exited with code ${code}`));
        }
      });

      proc.on('error', reject);
    });
  }

  async healthCheck(): Promise<{ available: boolean; platform: string; version?: string }> {
    if (!this.isAvailable) {
      return { available: false, platform: process.platform };
    }

    try {
      const result = await this.execute('health', {});
      return {
        available: true,
        platform: process.platform,
        version: result.version,
      };
    } catch {
      return { available: false, platform: process.platform };
    }
  }
}

// ─── Computer Use Tool ──────────────────────────────────────────────────────

class ComputerUseTool {
  private backend: CUABackend;
  private sessionApproved = false;

  constructor() {
    this.backend = new CUABackend();
  }

  /**
   * Execute a computer use action.
   */
  async execute(action: ComputerUseAction, args: Record<string, any>): Promise<any> {
    // Check if backend is available
    if (!this.backend.available) {
      return {
        error: 'cua-driver not installed',
        install: 'cargo install cua-driver',
        platform: process.platform,
      };
    }

    // Safety checks
    if (DESTRUCTIVE_ACTIONS.has(action) && !this.sessionApproved) {
      return {
        requires_approval: true,
        action,
        args,
        message: `Destructive action '${action}' requires approval. Set sessionApproved=true to proceed.`,
      };
    }

    // Block dangerous key combos
    if (action === 'key' && args.keys) {
      const keys = Array.isArray(args.keys) ? args.keys.join('+') : args.keys;
      if (BLOCKED_KEY_COMBOS.has(keys.toLowerCase())) {
        return { error: `Blocked key combination: ${keys}` };
      }
    }

    try {
      const result = await this.backend.execute(action, args);

      // Handle capture results
      if (action === 'capture' && result.image_base64) {
        return {
          _multimodal: true,
          content: [
            { type: 'text', text: result.text_summary || 'Screenshot captured' },
            { type: 'image_url', image_url: { url: `data:image/png;base64,${result.image_base64}` } },
          ],
          text_summary: result.text_summary || 'Screenshot captured',
          som_elements: result.som_elements,
        };
      }

      return result;
    } catch (err: any) {
      return { error: err.message };
    }
  }

  /**
   * Approve the session for destructive actions.
   */
  approveSession(): void {
    this.sessionApproved = true;
  }

  /**
   * Revoke session approval.
   */
  revokeApproval(): void {
    this.sessionApproved = false;
  }

  /**
   * Get health status.
   */
  async health(): Promise<any> {
    return this.backend.healthCheck();
  }

  /**
   * List available actions.
   */
  getActions(): string[] {
    return ['capture', 'click', 'double_click', 'right_click', 'middle_click',
      'drag', 'scroll', 'type', 'key', 'set_value', 'wait',
      'list_apps', 'list_windows', 'focus_app', 'health'];
  }
}

// ─── Singleton ──────────────────────────────────────────────────────────────

let _instance: ComputerUseTool | null = null;

export function getComputerUseTool(): ComputerUseTool {
  if (!_instance) _instance = new ComputerUseTool();
  return _instance;
}

export { ComputerUseTool };
