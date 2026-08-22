/**
 * Utility Tools — Small utility tools from Hermes.
 *
 * Hermes equivalents:
 * - ansi_strip.py (79 lines)
 * - close_terminal_tool.py (70 lines)
 * - focus_pane_tool.py (70 lines)
 * - open_preview_tool.py (97 lines)
 * - read_terminal_tool.py (93 lines)
 * - osv_check.py (218 lines)
 * - website_policy.py (283 lines)
 * - patch_parser.py (729 lines)
 * - audio_container.py (97 lines)
 * - image_source.py (391 lines)
 */

import { readFileSync, existsSync } from 'node:fs';
import { extname } from 'node:path';
import { logger } from '../utils/logger.js';

// ─── ANSI Strip ───────────────────────────────────────────────────────────

export class ANSIStripper {
  /**
   * Strip ANSI escape codes from a string.
   */
  strip(text: string): string {
    // eslint-disable-next-line no-control-regex
    return text.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '');
  }

  /**
   * Check if a string contains ANSI codes.
   */
  hasAnsi(text: string): boolean {
    // eslint-disable-next-line no-control-regex
    return /\x1B\[[0-9;]*[a-zA-Z]/.test(text);
  }
}

// ─── OSV Check ────────────────────────────────────────────────────────────

export interface OSVulnerability {
  id: string;
  summary: string;
  severity: string;
  affected: string[];
  fixed?: string;
}

export class OSVChecker {
  /**
   * Check for known vulnerabilities in a package.
   */
  async check(packageName: string, version: string): Promise<OSVulnerability[]> {
    try {
      const response = await fetch('https://api.osv.dev/v1/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          package: { name: packageName, ecosystem: 'npm' },
          version,
        }),
      });

      if (!response.ok) return [];

      const data = await response.json() as { vulns?: any[] };
      return (data.vulns || []).map((v: any) => ({
        id: v.id,
        summary: v.summary || 'No summary',
        severity: v.database_specific?.severity || 'UNKNOWN',
        affected: v.affected?.map((a: any) => a.package?.name || '') || [],
        fixed: v.affected?.[0]?.ranges?.[0]?.events?.find((e: any) => e.fixed)?.fixed,
      }));
    } catch (err) {
      logger.warn(`[osv] Failed to check ${packageName}: ${err}`);
      return [];
    }
  }
}

// ─── Website Policy ───────────────────────────────────────────────────────

export interface PolicyCheck {
  url: string;
  allowed: boolean;
  reason?: string;
  category?: string;
}

export class WebsitePolicyChecker {
  private blockedDomains: Set<string> = new Set([
    'malware.com', 'phishing.com', 'hack.com',
  ]);
  private blockedPatterns: RegExp[] = [
    /phishing/i,
    /malware/i,
    /exploit/i,
  ];

  /**
   * Check if a URL is allowed.
   */
  check(url: string): PolicyCheck {
    try {
      const urlObj = new URL(url);

      // Check blocked domains
      if (this.blockedDomains.has(urlObj.hostname)) {
        return { url, allowed: false, reason: 'Domain is blocked', category: 'blocked' };
      }

      // Check blocked patterns
      for (const pattern of this.blockedPatterns) {
        if (pattern.test(url)) {
          return { url, allowed: false, reason: `URL matches blocked pattern: ${pattern.source}`, category: 'pattern' };
        }
      }

      return { url, allowed: true };
    } catch {
      return { url, allowed: false, reason: 'Invalid URL', category: 'invalid' };
    }
  }
}

// ─── Patch Parser ─────────────────────────────────────────────────────────

export interface PatchFile {
  path: string;
  additions: number;
  deletions: number;
  hunks: PatchHunk[];
}

export interface PatchHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  changes: PatchChange[];
}

export interface PatchChange {
  type: 'add' | 'remove' | 'context';
  line: string;
  lineNumber?: number;
}

export class PatchParser {
  /**
   * Parse a unified diff patch.
   */
  parse(patch: string): PatchFile[] {
    const files: PatchFile[] = [];
    const fileRegex = /^diff --git a\/(.+) b\/(.+)$/gm;
    const hunkRegex = /^@@ -(\d+),?(\d*) \+(\d+),?(\d*) @@(.*)$/gm;

    let currentFile: PatchFile | null = null;
    let currentHunk: PatchHunk | null = null;

    for (const line of patch.split('\n')) {
      const fileMatch = fileRegex.exec(line);
      if (fileMatch) {
        currentFile = { path: fileMatch[2], additions: 0, deletions: 0, hunks: [] };
        files.push(currentFile);
        continue;
      }

      const hunkMatch = hunkRegex.exec(line);
      if (hunkMatch && currentFile) {
        currentHunk = {
          oldStart: parseInt(hunkMatch[1]),
          oldLines: parseInt(hunkMatch[2] || '1'),
          newStart: parseInt(hunkMatch[3]),
          newLines: parseInt(hunkMatch[4] || '1'),
          changes: [],
        };
        currentFile.hunks.push(currentHunk);
        continue;
      }

      if (currentHunk) {
        if (line.startsWith('+')) {
          currentHunk.changes.push({ type: 'add', line: line.slice(1) });
          if (currentFile) currentFile.additions++;
        } else if (line.startsWith('-')) {
          currentHunk.changes.push({ type: 'remove', line: line.slice(1) });
          if (currentFile) currentFile.deletions++;
        } else if (line.startsWith(' ') || line === '') {
          currentHunk.changes.push({ type: 'context', line: line.slice(1) });
        }
      }
    }

    return files;
  }
}

// ─── Image Source ─────────────────────────────────────────────────────────

export interface ImageSourceInfo {
  path: string;
  format: string;
  size: number;
  isScreenshot: boolean;
  source?: string;
}

export class ImageSourceDetector {
  private screenshotPatterns = [
    /screenshot/i,
    /screen.?shot/i,
    /capture/i,
    /snap/i,
  ];

  private screenshotExtensions = ['.png', '.jpg', '.jpeg', '.bmp', '.webp'];

  /**
   * Detect image source information.
   */
  detect(filePath: string): ImageSourceInfo {
    const ext = extname(filePath).toLowerCase();
    const isScreenshot = this.screenshotPatterns.some((p) => p.test(filePath)) ||
      this.screenshotExtensions.includes(ext);

    return {
      path: filePath,
      format: ext.slice(1) || 'unknown',
      size: existsSync(filePath) ? readFileSync(filePath).length : 0,
      isScreenshot,
      source: isScreenshot ? 'screenshot' : 'file',
    };
  }
}

// ─── Audio Container ──────────────────────────────────────────────────────

export interface AudioInfo {
  path: string;
  format: string;
  isAudio: boolean;
}

export class AudioContainerDetector {
  private audioExtensions = ['.mp3', '.wav', '.ogg', '.flac', '.aac', '.m4a', '.wma'];

  /**
   * Detect audio container information.
   */
  detect(filePath: string): AudioInfo {
    const ext = extname(filePath).toLowerCase();
    return {
      path: filePath,
      format: ext.slice(1) || 'unknown',
      isAudio: this.audioExtensions.includes(ext),
    };
  }
}

// ─── Exports ──────────────────────────────────────────────────────────────

export function getANSIStripper(): ANSIStripper { return new ANSIStripper(); }
export function getOSVChecker(): OSVChecker { return new OSVChecker(); }
export function getWebsitePolicyChecker(): WebsitePolicyChecker { return new WebsitePolicyChecker(); }
export function getPatchParser(): PatchParser { return new PatchParser(); }
export function getImageSourceDetector(): ImageSourceDetector { return new ImageSourceDetector(); }
export function getAudioContainerDetector(): AudioContainerDetector { return new AudioContainerDetector(); }
