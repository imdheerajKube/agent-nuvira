/**
 * File Operations — Advanced file handling capabilities.
 *
 * Hermes equivalent: file_operations.py + file_state.py + read_extract.py + read_preview_tool.py
 *
 * Provides:
 * - File state tracking (modified, created, deleted)
 * - Content extraction from various formats
 * - Preview generation for files
 * - Safe file operations with rollback
 */

import { readFile, writeFile, stat, readdir, mkdir, unlink, rename, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, extname, basename, dirname, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { logger } from '../utils/logger.js';

// ─── File State Tracking ──────────────────────────────────────────────────

export interface FileState {
  /** Absolute path */
  path: string;
  /** Content hash (SHA-256) */
  hash: string;
  /** File size in bytes */
  size: number;
  /** Last modified time */
  mtime: number;
  /** When state was captured */
  capturedAt: number;
  /** Previous state (if tracked) */
  previousHash?: string;
}

export interface FileDiff {
  /** File path */
  path: string;
  /** Whether file was added */
  added: boolean;
  /** Whether file was modified */
  modified: boolean;
  /** Whether file was deleted */
  deleted: boolean;
  /** Previous hash */
  previousHash?: string;
  /** Current hash */
  currentHash?: string;
  /** Content before change */
  before?: string;
  /** Content after change */
  after?: string;
}

export class FileStateManager {
  private states: Map<string, FileState> = new Map();

  /**
   * Capture the state of a file.
   */
  async captureState(filePath: string): Promise<FileState> {
    const content = await readFile(filePath, 'utf-8').catch(() => '');
    const fileStat = await stat(filePath).catch(() => null);
    const hash = createHash('sha256').update(content).digest('hex');
    const previous = this.states.get(filePath);

    const state: FileState = {
      path: filePath,
      hash,
      size: fileStat?.size || 0,
      mtime: fileStat?.mtimeMs || Date.now(),
      capturedAt: Date.now(),
      previousHash: previous?.hash,
    };

    this.states.set(filePath, state);
    return state;
  }

  /**
   * Capture state of all files in a directory.
   */
  async captureDirectoryState(dirPath: string, extensions?: string[]): Promise<FileState[]> {
    const states: FileState[] = [];
    const entries = await readdir(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.isFile()) {
        const filePath = join(dirPath, entry.name);
        if (!extensions || extensions.some((ext) => entry.name.endsWith(ext))) {
          states.push(await this.captureState(filePath));
        }
      }
    }

    return states;
  }

  /**
   * Detect changes since last capture.
   */
  async detectChanges(dirPath: string): Promise<FileDiff[]> {
    const diffs: FileDiff[] = [];
    const entries = await readdir(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const filePath = join(dirPath, entry.name);
      const previous = this.states.get(filePath);

      try {
        const content = await readFile(filePath, 'utf-8');
        const hash = createHash('sha256').update(content).digest('hex');
        const fileStat = await stat(filePath);

        if (!previous) {
          diffs.push({ path: filePath, added: true, modified: false, deleted: false, currentHash: hash });
        } else if (previous.hash !== hash) {
          diffs.push({ path: filePath, added: false, modified: true, deleted: false, previousHash: previous.hash, currentHash: hash });
        }
      } catch {
        if (previous) {
          diffs.push({ path: filePath, added: false, modified: false, deleted: true, previousHash: previous.hash });
        }
      }
    }

    return diffs;
  }

  /**
   * Get current state map.
   */
  getStates(): Map<string, FileState> {
    return new Map(this.states);
  }
}

// ─── Content Extraction ───────────────────────────────────────────────────

export interface ExtractionResult {
  /** Extracted content */
  content: string;
  /** Content type */
  type: string;
  /** Metadata */
  metadata: Record<string, unknown>;
}

export class ContentExtractor {
  /**
   * Extract content from a file based on its type.
   */
  async extract(filePath: string): Promise<ExtractionResult> {
    const ext = extname(filePath).toLowerCase();
    const content = await readFile(filePath, 'utf-8');

    switch (ext) {
      case '.json':
        return this.extractJson(content);
      case '.yaml':
      case '.yml':
        return this.extractYaml(content);
      case '.xml':
        return this.extractXml(content);
      case '.csv':
        return this.extractCsv(content);
      case '.md':
      case '.markdown':
        return this.extractMarkdown(content);
      case '.html':
        return this.extractHtml(content);
      case '.log':
        return this.extractLog(content);
      default:
        return { content, type: 'text', metadata: { ext } };
    }
  }

  private extractJson(content: string): ExtractionResult {
    try {
      const parsed = JSON.parse(content);
      return {
        content: JSON.stringify(parsed, null, 2),
        type: 'json',
        metadata: {
          keys: typeof parsed === 'object' ? Object.keys(parsed) : [],
          isArray: Array.isArray(parsed),
          length: Array.isArray(parsed) ? parsed.length : undefined,
        },
      };
    } catch {
      return { content, type: 'json-invalid', metadata: {} };
    }
  }

  private extractYaml(content: string): ExtractionResult {
    return { content, type: 'yaml', metadata: { lines: content.split('\n').length } };
  }

  private extractXml(content: string): ExtractionResult {
    const tagMatches = content.match(/<(\w+)[^>]*>/g) || [];
    const tags = [...new Set(tagMatches.map((m) => m.replace(/<(\w+).*/, '$1')))];
    return { content, type: 'xml', metadata: { rootTags: tags.slice(0, 10) } };
  }

  private extractCsv(content: string): ExtractionResult {
    const lines = content.split('\n').filter(Boolean);
    const headers = lines[0]?.split(',') || [];
    return {
      content,
      type: 'csv',
      metadata: { headers, rowCount: lines.length - 1 },
    };
  }

  private extractMarkdown(content: string): ExtractionResult {
    const headings = content.match(/^#{1,6}\s+.+$/gm) || [];
    const links = content.match(/\[([^\]]+)\]\(([^)]+)\)/g) || [];
    const codeBlocks = content.match(/```[\s\S]*?```/g) || [];
    return {
      content,
      type: 'markdown',
      metadata: { headings: headings.length, links: links.length, codeBlocks: codeBlocks.length },
    };
  }

  private extractHtml(content: string): ExtractionResult {
    const titleMatch = content.match(/<title>([^<]+)<\/title>/i);
    const links = content.match(/href="([^"]+)"/g) || [];
    const scripts = content.match(/<script[^>]*>/g) || [];
    return {
      content,
      type: 'html',
      metadata: { title: titleMatch?.[1], links: links.length, scripts: scripts.length },
    };
  }

  private extractLog(content: string): ExtractionResult {
    const lines = content.split('\n');
    const errors = lines.filter((l) => /\berror\b/i.test(l));
    const warnings = lines.filter((l) => /\bwarn(ing)?\b/i.test(l));
    return {
      content,
      type: 'log',
      metadata: { totalLines: lines.length, errors: errors.length, warnings: warnings.length },
    };
  }
}

// ─── File Preview ─────────────────────────────────────────────────────────

export interface PreviewResult {
  /** Preview content */
  preview: string;
  /** Total lines */
  totalLines: number;
  /** Preview lines shown */
  previewLines: number;
  /** File type */
  type: string;
}

export class FilePreviewer {
  /**
   * Generate a preview of a file.
   */
  async preview(filePath: string, options: { maxLines?: number; maxChars?: number } = {}): Promise<PreviewResult> {
    const maxLines = options.maxLines || 50;
    const maxChars = options.maxChars || 5000;

    const content = await readFile(filePath, 'utf-8');
    const lines = content.split('\n');
    const ext = extname(filePath).toLowerCase();

    let preview = lines.slice(0, maxLines).join('\n');
    if (preview.length > maxChars) {
      preview = preview.slice(0, maxChars) + '\n... (truncated)';
    }

    return {
      preview,
      totalLines: lines.length,
      previewLines: Math.min(maxLines, lines.length),
      type: this.getFileType(ext),
    };
  }

  private getFileType(ext: string): string {
    const types: Record<string, string> = {
      '.ts': 'typescript', '.js': 'javascript', '.py': 'python',
      '.rs': 'rust', '.go': 'go', '.java': 'java',
      '.json': 'json', '.yaml': 'yaml', '.yml': 'yaml',
      '.md': 'markdown', '.html': 'html', '.css': 'css',
      '.sh': 'shell', '.bash': 'shell', '.zsh': 'shell',
      '.sql': 'sql', '.graphql': 'graphql',
    };
    return types[ext] || 'text';
  }
}

// ─── Safe File Operations ─────────────────────────────────────────────────

export interface BackupEntry {
  path: string;
  content: string;
  backedUpAt: number;
}

export class SafeFileOperations {
  private backups: Map<string, BackupEntry> = new Map();

  /**
   * Safely write a file with backup.
   */
  async safeWrite(filePath: string, content: string): Promise<void> {
    // Backup existing file
    if (existsSync(filePath)) {
      const existing = await readFile(filePath, 'utf-8').catch(() => '');
      this.backups.set(filePath, {
        path: filePath,
        content: existing,
        backedUpAt: Date.now(),
      });
    }

    await writeFile(filePath, content, 'utf-8');
  }

  /**
   * Safely delete a file with backup.
   */
  async safeDelete(filePath: string): Promise<void> {
    if (existsSync(filePath)) {
      const existing = await readFile(filePath, 'utf-8').catch(() => '');
      this.backups.set(filePath, {
        path: filePath,
        content: existing,
        backedUpAt: Date.now(),
      });
      await unlink(filePath);
    }
  }

  /**
   * Rollback a file to its backup.
   */
  async rollback(filePath: string): Promise<boolean> {
    const backup = this.backups.get(filePath);
    if (!backup) return false;

    await writeFile(backup.path, backup.content, 'utf-8');
    this.backups.delete(filePath);
    return true;
  }

  /**
   * Rollback all backed up files.
   */
  async rollbackAll(): Promise<number> {
    let count = 0;
    for (const [path] of this.backups) {
      if (await this.rollback(path)) count++;
    }
    return count;
  }

  /**
   * Get backup list.
   */
  getBackups(): BackupEntry[] {
    return [...this.backups.values()];
  }
}

// ─── Singletons ───────────────────────────────────────────────────────────

let _fileStateManager: FileStateManager | null = null;
let _contentExtractor: ContentExtractor | null = null;
let _filePreviewer: FilePreviewer | null = null;
let _safeFileOps: SafeFileOperations | null = null;

export function getFileStateManager(): FileStateManager {
  if (!_fileStateManager) _fileStateManager = new FileStateManager();
  return _fileStateManager;
}

export function getContentExtractor(): ContentExtractor {
  if (!_contentExtractor) _contentExtractor = new ContentExtractor();
  return _contentExtractor;
}

export function getFilePreviewer(): FilePreviewer {
  if (!_filePreviewer) _filePreviewer = new FilePreviewer();
  return _filePreviewer;
}

export function getSafeFileOps(): SafeFileOperations {
  if (!_safeFileOps) _safeFileOps = new SafeFileOperations();
  return _safeFileOps;
}
