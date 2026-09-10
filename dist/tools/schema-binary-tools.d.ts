/**
 * Schema Sanitizer — Input validation and output sanitization.
 *
 * Hermes equivalent: schema_sanitizer.py
 */
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
export declare class SchemaSanitizer {
    private rules;
    /**
     * Sanitize content using all rules.
     */
    sanitize(content: string): SanitizationResult;
    /**
     * Add a custom rule.
     */
    addRule(rule: SanitizationRule): void;
    /**
     * Get all rules.
     */
    getRules(): SanitizationRule[];
    /**
     * Validate input against a schema.
     */
    validate(input: unknown, schema: Record<string, string>): {
        valid: boolean;
        errors: string[];
    };
}
export declare class BinaryExtensions {
    private static BINARY_EXTENSIONS;
    private static TEXT_LIKE_EXTENSIONS;
    /**
     * Check if a file extension is binary.
     */
    static isBinary(extension: string): boolean;
    /**
     * Check if a file is likely text-based.
     */
    static isTextLike(extension: string): boolean;
    /**
     * Get the MIME type for a file extension.
     */
    static getMimeType(extension: string): string;
    /**
     * Get all binary extensions.
     */
    static getBinaryExtensions(): string[];
    /**
     * Get all text-like extensions.
     */
    static getTextExtensions(): string[];
}
export declare function getSchemaSanitizer(): SchemaSanitizer;
//# sourceMappingURL=schema-binary-tools.d.ts.map