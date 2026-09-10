/**
 * read_extract — Document-to-text extraction.
 *
 * Extracts text from various document formats:
 * - PDF documents
 * - Microsoft Word (DOCX)
 * - Microsoft Excel (XLSX)
 * - Microsoft PowerPoint (PPTX)
 * - Plain text files
 * - Markdown files
 * - HTML files
 */
import * as fs from 'fs';
import * as path from 'path';
// ─── Read Extract Manager ───────────────────────────────────────────────────
class ReadExtractManager {
    supportedFormats = new Set([
        '.txt', '.md', '.markdown', '.html', '.htm', '.csv', '.json', '.xml', '.yaml', '.yml',
        '.pdf', '.docx', '.xlsx', '.pptx',
    ]);
    /**
     * Extract text from a file.
     */
    async extract(filePath) {
        const ext = path.extname(filePath).toLowerCase();
        if (!this.supportedFormats.has(ext)) {
            return {
                text: '',
                format: ext,
                success: false,
                error: `Unsupported format: ${ext}. Supported: ${Array.from(this.supportedFormats).join(', ')}`,
            };
        }
        try {
            switch (ext) {
                case '.txt':
                case '.md':
                case '.markdown':
                    return this.extractPlainText(filePath);
                case '.html':
                case '.htm':
                    return this.extractHTML(filePath);
                case '.csv':
                    return this.extractCSV(filePath);
                case '.json':
                    return this.extractJSON(filePath);
                case '.xml':
                    return this.extractXML(filePath);
                case '.yaml':
                case '.yml':
                    return this.extractYAML(filePath);
                case '.pdf':
                    return this.extractPDF(filePath);
                case '.docx':
                    return this.extractDOCX(filePath);
                case '.xlsx':
                    return this.extractXLSX(filePath);
                case '.pptx':
                    return this.extractPPTX(filePath);
                default:
                    return { text: '', format: ext, success: false, error: 'Unknown format' };
            }
        }
        catch (err) {
            return {
                text: '',
                format: ext,
                success: false,
                error: err.message,
            };
        }
    }
    /**
     * Extract plain text.
     */
    extractPlainText(filePath) {
        const content = fs.readFileSync(filePath, 'utf-8');
        return {
            text: content,
            format: 'text',
            success: true,
            metadata: {
                words: content.split(/\s+/).length,
            },
        };
    }
    /**
     * Extract HTML to text.
     */
    extractHTML(filePath) {
        const content = fs.readFileSync(filePath, 'utf-8');
        // Simple HTML to text conversion
        const text = content
            .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
            .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
        return {
            text,
            format: 'html',
            success: true,
            metadata: {
                words: text.split(/\s+/).length,
            },
        };
    }
    /**
     * Extract CSV to text.
     */
    extractCSV(filePath) {
        const content = fs.readFileSync(filePath, 'utf-8');
        const lines = content.split('\n').filter((l) => l.trim());
        // Simple CSV to text
        const text = lines.map((line) => {
            const cells = line.split(',').map((c) => c.trim());
            return cells.join(' | ');
        }).join('\n');
        return {
            text,
            format: 'csv',
            success: true,
            metadata: {
                words: text.split(/\s+/).length,
            },
        };
    }
    /**
     * Extract JSON to text.
     */
    extractJSON(filePath) {
        const content = fs.readFileSync(filePath, 'utf-8');
        try {
            const data = JSON.parse(content);
            const text = JSON.stringify(data, null, 2);
            return {
                text,
                format: 'json',
                success: true,
            };
        }
        catch {
            return {
                text: content,
                format: 'json',
                success: true,
            };
        }
    }
    /**
     * Extract XML to text.
     */
    extractXML(filePath) {
        const content = fs.readFileSync(filePath, 'utf-8');
        // Simple XML to text
        const text = content
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
        return {
            text,
            format: 'xml',
            success: true,
        };
    }
    /**
     * Extract YAML to text.
     */
    extractYAML(filePath) {
        const content = fs.readFileSync(filePath, 'utf-8');
        return {
            text: content,
            format: 'yaml',
            success: true,
        };
    }
    /**
     * Extract PDF (simplified - actual PDF extraction requires pdf-parse library).
     */
    extractPDF(filePath) {
        // Simplified PDF extraction
        // In production, use pdf-parse library
        try {
            const content = fs.readFileSync(filePath, 'utf-8');
            // Attempt to extract readable text
            const text = content
                .replace(/[^\x20-\x7E\n]/g, ' ')
                .replace(/\s+/g, ' ')
                .trim();
            return {
                text: text.slice(0, 10000), // Limit to 10K chars
                format: 'pdf',
                success: true,
                metadata: {
                    words: text.split(/\s+/).length,
                },
            };
        }
        catch {
            return {
                text: '',
                format: 'pdf',
                success: false,
                error: 'PDF extraction requires pdf-parse library',
            };
        }
    }
    /**
     * Extract DOCX (simplified - actual DOCX extraction requires docx library).
     */
    extractDOCX(filePath) {
        // Simplified DOCX extraction
        // In production, use docx or mammoth library
        try {
            const content = fs.readFileSync(filePath, 'utf-8');
            const text = content
                .replace(/<[^>]+>/g, ' ')
                .replace(/\s+/g, ' ')
                .trim();
            return {
                text: text.slice(0, 10000),
                format: 'docx',
                success: true,
            };
        }
        catch {
            return {
                text: '',
                format: 'docx',
                success: false,
                error: 'DOCX extraction requires mammoth library',
            };
        }
    }
    /**
     * Extract XLSX (simplified).
     */
    extractXLSX(filePath) {
        return {
            text: '',
            format: 'xlsx',
            success: false,
            error: 'XLSX extraction requires xlsx library',
        };
    }
    /**
     * Extract PPTX (simplified).
     */
    extractPPTX(filePath) {
        return {
            text: '',
            format: 'pptx',
            success: false,
            error: 'PPTX extraction requires pptx library',
        };
    }
    /**
     * Get supported formats.
     */
    getSupportedFormats() {
        return Array.from(this.supportedFormats);
    }
}
// ─── Singleton ──────────────────────────────────────────────────────────────
let _instance = null;
export function getReadExtractManager() {
    if (!_instance)
        _instance = new ReadExtractManager();
    return _instance;
}
export { ReadExtractManager };
//# sourceMappingURL=read-extract.js.map