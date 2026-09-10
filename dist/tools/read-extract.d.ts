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
interface ExtractResult {
    text: string;
    format: string;
    metadata?: {
        title?: string;
        author?: string;
        created?: string;
        modified?: string;
        pages?: number;
        words?: number;
    };
    success: boolean;
    error?: string;
}
declare class ReadExtractManager {
    private supportedFormats;
    /**
     * Extract text from a file.
     */
    extract(filePath: string): Promise<ExtractResult>;
    /**
     * Extract plain text.
     */
    private extractPlainText;
    /**
     * Extract HTML to text.
     */
    private extractHTML;
    /**
     * Extract CSV to text.
     */
    private extractCSV;
    /**
     * Extract JSON to text.
     */
    private extractJSON;
    /**
     * Extract XML to text.
     */
    private extractXML;
    /**
     * Extract YAML to text.
     */
    private extractYAML;
    /**
     * Extract PDF (simplified - actual PDF extraction requires pdf-parse library).
     */
    private extractPDF;
    /**
     * Extract DOCX (simplified - actual DOCX extraction requires docx library).
     */
    private extractDOCX;
    /**
     * Extract XLSX (simplified).
     */
    private extractXLSX;
    /**
     * Extract PPTX (simplified).
     */
    private extractPPTX;
    /**
     * Get supported formats.
     */
    getSupportedFormats(): string[];
}
export declare function getReadExtractManager(): ReadExtractManager;
export { ReadExtractManager };
//# sourceMappingURL=read-extract.d.ts.map