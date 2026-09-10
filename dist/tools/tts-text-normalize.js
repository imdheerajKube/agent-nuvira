/**
 * tts_text_normalize — Text normalization for speech synthesis.
 *
 * Prepares assistant text for TTS by:
 * - Removing markdown formatting
 * - Expanding abbreviations
 * - Normalizing numbers and dates
 * - Handling code blocks
 * - Removing URLs and emails
 * - Adding pauses for punctuation
 */
// ─── TTS Text Normalizer ────────────────────────────────────────────────────
class TTSTextNormalizer {
    abbreviations = {
        'Mr.': 'Mister',
        'Mrs.': 'Missus',
        'Dr.': 'Doctor',
        'Prof.': 'Professor',
        'Inc.': 'Incorporated',
        'Ltd.': 'Limited',
        'Corp.': 'Corporation',
        'etc.': 'et cetera',
        'vs.': 'versus',
        'approx.': 'approximately',
        'dept.': 'department',
        'est.': 'established',
        'govt.': 'government',
        'info.': 'information',
        'misc.': 'miscellaneous',
        'ref.': 'reference',
        'req.': 'request',
        'spec.': 'specification',
        'temp.': 'temporary',
        'viz.': 'namely',
        'i.e.': 'that is',
        'e.g.': 'for example',
        'NFT': 'NFT',
        'API': 'API',
        'URL': 'URL',
        'HTML': 'HTML',
        'CSS': 'CSS',
        'JSON': 'JSON',
        'SQL': 'SQL',
        'HTTP': 'HTTP',
        'HTTPS': 'HTTPS',
        'AWS': 'AWS',
        'GCP': 'GCP',
        'Azure': 'Azure',
        'Docker': 'Docker',
        'Kubernetes': 'Kubernetes',
        'Node.js': 'Node JS',
        'TypeScript': 'TypeScript',
        'JavaScript': 'JavaScript',
        'Python': 'Python',
        'GitHub': 'GitHub',
        'GitLab': 'GitLab',
    };
    numberWords = {
        '0': 'zero',
        '1': 'one',
        '2': 'two',
        '3': 'three',
        '4': 'four',
        '5': 'five',
        '6': 'six',
        '7': 'seven',
        '8': 'eight',
        '9': 'nine',
        '10': 'ten',
        '11': 'eleven',
        '12': 'twelve',
        '13': 'thirteen',
        '14': 'fourteen',
        '15': 'fifteen',
        '16': 'sixteen',
        '17': 'seventeen',
        '18': 'eighteen',
        '19': 'nineteen',
        '20': 'twenty',
        '30': 'thirty',
        '40': 'forty',
        '50': 'fifty',
        '60': 'sixty',
        '70': 'seventy',
        '80': 'eighty',
        '90': 'ninety',
        '100': 'one hundred',
        '1000': 'one thousand',
        '1000000': 'one million',
    };
    /**
     * Normalize text for TTS.
     */
    normalize(text, options) {
        const opts = {
            removeMarkdown: true,
            expandAbbreviations: true,
            normalizeNumbers: true,
            handleCodeBlocks: true,
            removeUrls: true,
            addPauses: true,
            maxLength: 5000,
            ...options,
        };
        let result = text;
        // Remove markdown formatting
        if (opts.removeMarkdown) {
            result = this.removeMarkdown(result);
        }
        // Handle code blocks
        if (opts.handleCodeBlocks) {
            result = this.handleCodeBlocks(result);
        }
        // Remove URLs
        if (opts.removeUrls) {
            result = this.removeUrls(result);
        }
        // Expand abbreviations
        if (opts.expandAbbreviations) {
            result = this.expandAbbreviations(result);
        }
        // Normalize numbers
        if (opts.normalizeNumbers) {
            result = this.normalizeNumbers(result);
        }
        // Add pauses for punctuation
        if (opts.addPauses) {
            result = this.addPauses(result);
        }
        // Truncate if too long
        if (opts.maxLength && result.length > opts.maxLength) {
            result = result.slice(0, opts.maxLength) + '...';
        }
        return result.trim();
    }
    /**
     * Remove markdown formatting.
     */
    removeMarkdown(text) {
        return text
            // Headers
            .replace(/^#{1,6}\s+/gm, '')
            // Bold
            .replace(/\*\*([^*]+)\*\*/g, '$1')
            .replace(/__([^_]+)__/g, '$1')
            // Italic
            .replace(/\*([^*]+)\*/g, '$1')
            .replace(/_([^_]+)_/g, '$1')
            // Strikethrough
            .replace(/~~([^~]+)~~/g, '$1')
            // Code blocks
            .replace(/```[\s\S]*?```/g, 'code block')
            // Inline code
            .replace(/`([^`]+)`/g, '$1')
            // Links
            .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
            // Images
            .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1 image')
            // Lists
            .replace(/^[\s]*[-*+]\s+/gm, '')
            .replace(/^[\s]*\d+\.\s+/gm, '')
            // Blockquotes
            .replace(/^>\s+/gm, '')
            // Horizontal rules
            .replace(/^[-*_]{3,}\s*$/gm, '')
            // Clean up extra whitespace
            .replace(/\n{3,}/g, '\n\n')
            .trim();
    }
    /**
     * Handle code blocks.
     */
    handleCodeBlocks(text) {
        return text
            // Replace code blocks with description
            .replace(/```[\s\S]*?```/g, 'code block omitted')
            // Replace inline code
            .replace(/`([^`]+)`/g, '$1')
            // Remove syntax highlighting markers
            .replace(/\{[^}]+\}/g, '');
    }
    /**
     * Remove URLs.
     */
    removeUrls(text) {
        return text
            // HTTP/HTTPS URLs
            .replace(/https?:\/\/[^\s]+/g, 'link')
            // WWW URLs
            .replace(/www\.[^\s]+/g, 'link')
            // Email addresses
            .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, 'email address');
    }
    /**
     * Expand abbreviations.
     */
    expandAbbreviations(text) {
        let result = text;
        for (const [abbr, expansion] of Object.entries(this.abbreviations)) {
            const regex = new RegExp(`\\b${abbr.replace('.', '\\.')}\\b`, 'g');
            result = result.replace(regex, expansion);
        }
        return result;
    }
    /**
     * Normalize numbers.
     */
    normalizeNumbers(text) {
        return text
            // Percentages
            .replace(/(\d+)%/g, '$1 percent')
            // Currency
            .replace(/\$(\d+(?:\.\d{2})?)/g, '$1 dollars')
            .replace(/€(\d+(?:\.\d{2})?)/g, '$1 euros')
            .replace(/£(\d+(?:\.\d{2})?)/g, '$1 pounds')
            // Dates (MM/DD/YYYY)
            .replace(/(\d{1,2})\/(\d{1,2})\/(\d{4})/g, '$1 $2 $3')
            // Times (HH:MM)
            .replace(/(\d{1,2}):(\d{2})\s*(AM|PM)?/gi, '$1 $2 $3')
            // Phone numbers
            .replace(/\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g, 'phone number');
    }
    /**
     * Add pauses for punctuation.
     */
    addPauses(text) {
        return text
            // Periods
            .replace(/\./g, '. ')
            // Commas
            .replace(/,/g, ', ')
            // Semicolons
            .replace(/;/g, '; ')
            // Colons
            .replace(/:/g, ': ')
            // Question marks
            .replace(/\?/g, '? ')
            // Exclamation marks
            .replace(/!/g, '! ')
            // Clean up multiple spaces
            .replace(/\s{2,}/g, ' ')
            .trim();
    }
}
// ─── Singleton ──────────────────────────────────────────────────────────────
let _instance = null;
export function getTTSTextNormalizer() {
    if (!_instance)
        _instance = new TTSTextNormalizer();
    return _instance;
}
export { TTSTextNormalizer };
//# sourceMappingURL=tts-text-normalize.js.map