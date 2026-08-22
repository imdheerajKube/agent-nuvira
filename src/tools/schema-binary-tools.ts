/**
 * Schema Sanitizer — Input validation and output sanitization.
 *
 * Hermes equivalent: schema_sanitizer.py
 */

import { logger } from '../utils/logger.js';

// ─── Schema Sanitizer ─────────────────────────────────────────────────────

export interface SanitizationRule {
  /** Rule name */
  name: string;
  /** Pattern to match */
  pattern: RegExp;
  /** Replacement (null = strip) */
  replacement: string | null;
  /** Description */
  description: string;
}

export interface SanitizationResult {
  /** Sanitized content */
  content: string;
  /** Number of changes made */
  changes: number;
  /** Rules that matched */
  matchedRules: string[];
}

export class SchemaSanitizer {
  private rules: SanitizationRule[] = [
    // XSS prevention
    { name: 'script-tag', pattern: /<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, replacement: '', description: 'Remove script tags' },
    { name: 'event-handler', pattern: /\bon\w+\s*=\s*["'][^"']*["']/gi, replacement: '', description: 'Remove event handlers' },
    { name: 'javascript-protocol', pattern: /javascript\s*:/gi, replacement: '', description: 'Remove javascript: protocol' },
    { name: 'data-protocol', pattern: /data\s*:\s*text\/html/gi, replacement: '', description: 'Remove data:text/html protocol' },

    // SQL injection prevention
    { name: 'sql-comments', pattern: /--\s*$|\/\*[\s\S]*?\*\//gm, replacement: '', description: 'Remove SQL comments' },
    { name: 'sql-union', pattern: /\bUNION\b\s+(ALL\s+)?SELECT\b/gi, replacement: '', description: 'Remove SQL UNION SELECT' },

    // Path traversal prevention
    { name: 'path-traversal', pattern: /\.\.[\/\\]/g, replacement: '', description: 'Remove path traversal sequences' },

    // Null byte prevention
    { name: 'null-byte', pattern: /\x00/g, replacement: '', description: 'Remove null bytes' },

    // Control characters
    { name: 'control-chars', pattern: /[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]/g, replacement: '', description: 'Remove control characters' },
  ];

  /**
   * Sanitize content using all rules.
   */
  sanitize(content: string): SanitizationResult {
    let result = content;
    const matchedRules: string[] = [];
    let changes = 0;

    for (const rule of this.rules) {
      const before = result;
      result = result.replace(rule.pattern, rule.replacement || '');
      if (result !== before) {
        matchedRules.push(rule.name);
        changes++;
      }
    }

    return { content: result, changes, matchedRules };
  }

  /**
   * Add a custom rule.
   */
  addRule(rule: SanitizationRule): void {
    this.rules.push(rule);
  }

  /**
   * Get all rules.
   */
  getRules(): SanitizationRule[] {
    return [...this.rules];
  }

  /**
   * Validate input against a schema.
   */
  validate(input: unknown, schema: Record<string, string>): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    for (const [field, type] of Object.entries(schema)) {
      const value = (input as Record<string, unknown>)?.[field];

      switch (type) {
        case 'string':
          if (typeof value !== 'string') errors.push(`${field} must be a string`);
          break;
        case 'number':
          if (typeof value !== 'number') errors.push(`${field} must be a number`);
          break;
        case 'boolean':
          if (typeof value !== 'boolean') errors.push(`${field} must be a boolean`);
          break;
        case 'array':
          if (!Array.isArray(value)) errors.push(`${field} must be an array`);
          break;
        case 'object':
          if (typeof value !== 'object' || value === null) errors.push(`${field} must be an object`);
          break;
        case 'required':
          if (value === undefined || value === null || value === '') errors.push(`${field} is required`);
          break;
      }
    }

    return { valid: errors.length === 0, errors };
  }
}

// ─── Binary Extensions ────────────────────────────────────────────────────

export class BinaryExtensions {
  private static BINARY_EXTENSIONS = new Set([
    // Images
    '.jpg', '.jpeg', '.png', '.gif', '.bmp', '.ico', '.webp', '.tiff', '.tif', '.svg',
    '.psd', '.ai', '.eps', '.raw', '.cr2', '.nef', '.heic', '.heif', '.avif',
    // Audio
    '.mp3', '.wav', '.ogg', '.flac', '.aac', '.wma', '.m4a', '.opus',
    // Video
    '.mp4', '.avi', '.mkv', '.mov', '.wmv', '.flv', '.webm', '.m4v', '.mpg', '.mpeg',
    // Archives
    '.zip', '.tar', '.gz', '.bz2', '.xz', '.7z', '.rar', '.tgz',
    // Documents
    '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.odt', '.ods', '.odp',
    // Executables
    '.exe', '.dll', '.so', '.dylib', '.bin', '.dat', '.o', '.obj',
    // Compiled
    '.class', '.pyc', '.pyo', '.wasm', '.min.js', '.min.css',
    // Database
    '.db', '.sqlite', '.sqlite3', '.mdb',
    // Other
    '.woff', '.woff2', '.ttf', '.eot', '.otf',
  ]);

  private static TEXT_LIKE_EXTENSIONS = new Set([
    '.json', '.xml', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf',
    '.md', '.markdown', '.txt', '.csv', '.tsv',
    '.html', '.htm', '.css', '.scss', '.less',
    '.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs',
    '.py', '.rb', '.rs', '.go', '.java', '.c', '.cpp', '.h', '.hpp',
    '.sh', '.bash', '.zsh', '.fish', '.ps1', '.bat', '.cmd',
    '.sql', '.graphql', '.gql',
    '.env', '.gitignore', '.dockerignore', '.editorconfig',
  ]);

  /**
   * Check if a file extension is binary.
   */
  static isBinary(extension: string): boolean {
    return this.BINARY_EXTENSIONS.has(extension.toLowerCase());
  }

  /**
   * Check if a file is likely text-based.
   */
  static isTextLike(extension: string): boolean {
    return this.TEXT_LIKE_EXTENSIONS.has(extension.toLowerCase());
  }

  /**
   * Get the MIME type for a file extension.
   */
  static getMimeType(extension: string): string {
    const mimeTypes: Record<string, string> = {
      '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript',
      '.json': 'application/json', '.xml': 'application/xml', '.yaml': 'text/yaml',
      '.png': 'image/png', '.jpg': 'image/jpeg', '.gif': 'image/gif',
      '.svg': 'image/svg+xml', '.webp': 'image/webp',
      '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
      '.mp4': 'video/mp4', '.webm': 'video/webm',
      '.pdf': 'application/pdf', '.zip': 'application/zip',
      '.woff': 'font/woff', '.woff2': 'font/woff2',
      '.ttf': 'font/ttf',
    };
    return mimeTypes[extension.toLowerCase()] || 'application/octet-stream';
  }

  /**
   * Get all binary extensions.
   */
  static getBinaryExtensions(): string[] {
    return [...this.BINARY_EXTENSIONS].sort();
  }

  /**
   * Get all text-like extensions.
   */
  static getTextExtensions(): string[] {
    return [...this.TEXT_LIKE_EXTENSIONS].sort();
  }
}

// ─── Singletons ───────────────────────────────────────────────────────────

let _schemaSanitizer: SchemaSanitizer | null = null;

export function getSchemaSanitizer(): SchemaSanitizer {
  if (!_schemaSanitizer) _schemaSanitizer = new SchemaSanitizer();
  return _schemaSanitizer;
}
