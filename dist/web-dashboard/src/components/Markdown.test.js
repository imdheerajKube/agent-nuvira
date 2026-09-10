"use strict";
/**
 * Phase 1 — Markdown renderer tests (react-markdown + remark-gfm +
 * rehype-highlight stack).
 *
 * The chat answer renderer must turn the agent's markdown into rich blocks:
 * headings, lists, bold/italic, inline code, fenced code blocks with a copy
 * button, GFM tables/strikethrough/task lists, autolinks — while NEVER
 * injecting unsafe hrefs (react-markdown's defaultUrlTransform strips
 * javascript:/data:). The zero-dep fallback (`MarkdownZeroDep`) gets a smoke
 * test so the one-import switch stays verified.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const react_1 = require("@testing-library/react");
const Markdown_1 = __importDefault(require("./Markdown"));
const MarkdownZeroDep_1 = __importDefault(require("./MarkdownZeroDep"));
(0, vitest_1.afterEach)(() => {
    (0, react_1.cleanup)();
    vitest_1.vi.restoreAllMocks();
});
(0, vitest_1.describe)('Markdown (react-markdown stack)', () => {
    (0, vitest_1.it)('renders plain prose as paragraphs', () => {
        const { container } = (0, react_1.render)(<Markdown_1.default text={'hello world\n\nsecond para'}/>);
        (0, vitest_1.expect)(container.querySelectorAll('p.md-para')).toHaveLength(2);
        (0, vitest_1.expect)(react_1.screen.getByText('hello world')).toBeTruthy();
        (0, vitest_1.expect)(react_1.screen.getByText('second para')).toBeTruthy();
    });
    (0, vitest_1.it)('renders headings at the right level', () => {
        const { container } = (0, react_1.render)(<Markdown_1.default text={'# Big\n\n### Small'}/>);
        (0, vitest_1.expect)(container.querySelector('h1')?.textContent).toBe('Big');
        (0, vitest_1.expect)(container.querySelector('h3')?.textContent).toBe('Small');
    });
    (0, vitest_1.it)('renders bold, italic, inline code and links', () => {
        const { container } = (0, react_1.render)(<Markdown_1.default text={'**bold** and *italic* and `code` and [docs](https://example.com)'}/>);
        (0, vitest_1.expect)(container.querySelector('strong')?.textContent).toBe('bold');
        (0, vitest_1.expect)(container.querySelector('em')?.textContent).toBe('italic');
        (0, vitest_1.expect)(container.querySelector(':not(pre) > code')?.textContent).toBe('code');
        (0, vitest_1.expect)(container.querySelector('a')?.getAttribute('href')).toBe('https://example.com');
    });
    (0, vitest_1.it)('never turns a javascript: link into a clickable href (defaultUrlTransform)', () => {
        const { container } = (0, react_1.render)(<Markdown_1.default text={'[click](javascript:alert(1))'}/>);
        // v10 renders the text with an EMPTY href — never a javascript: URL.
        const a = container.querySelector('a');
        (0, vitest_1.expect)(a?.getAttribute('href') ?? '').not.toMatch(/^javascript:/);
        (0, vitest_1.expect)(react_1.screen.getByText('click')).toBeTruthy();
    });
    (0, vitest_1.it)('renders bullet and numbered lists as groups', () => {
        const { container } = (0, react_1.render)(<Markdown_1.default text={'- one\n- two\n- three'}/>);
        const ul = container.querySelector('ul.md-list');
        (0, vitest_1.expect)(ul).toBeTruthy();
        (0, vitest_1.expect)(ul?.querySelectorAll('li')).toHaveLength(3);
        const { container: c2 } = (0, react_1.render)(<Markdown_1.default text={'1. first\n2. second'}/>);
        (0, vitest_1.expect)(c2.querySelector('ol.md-list')).toBeTruthy();
    });
    (0, vitest_1.it)('handles nested lists (CommonMark depth the old renderer could not)', () => {
        const { container } = (0, react_1.render)(<Markdown_1.default text={'- outer\n  - inner\n- again'}/>);
        const ul = container.querySelector('ul.md-list');
        // The inner list is a real nested <ul>, not flattened text.
        (0, vitest_1.expect)(ul?.querySelector('ul')?.querySelector('li')?.textContent).toBe('inner');
        (0, vitest_1.expect)(react_1.screen.getByText('outer')).toBeTruthy();
        (0, vitest_1.expect)(react_1.screen.getByText('again')).toBeTruthy();
    });
    (0, vitest_1.it)('renders GFM strikethrough, task lists and autolinks', () => {
        const { container } = (0, react_1.render)(<Markdown_1.default text={'~~gone~~\n\n- [x] done\n- [ ] todo\n\nvisit <https://example.com> now'}/>);
        (0, vitest_1.expect)(container.querySelector('del')?.textContent).toBe('gone');
        // Task-list checkboxes are real inputs.
        (0, vitest_1.expect)(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(2);
        (0, vitest_1.expect)(container.querySelector('input[type="checkbox"]')?.hasAttribute('checked')).toBe(true);
        (0, vitest_1.expect)(container.querySelector('a')?.getAttribute('href')).toBe('https://example.com');
    });
    (0, vitest_1.it)('renders a fenced code block with a language label, syntax highlight and copy button', async () => {
        const writeText = vitest_1.vi.fn().mockResolvedValue(undefined);
        Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
        (0, react_1.render)(<Markdown_1.default text={'```ts\nconst x = 1;\n```'}/>);
        (0, vitest_1.expect)(react_1.screen.getByText('ts')).toBeTruthy();
        // rehype-highlight tokenized the body — the raw text is intact on the <code>.
        const codeEl = document.querySelector('.md-code-pre code');
        (0, vitest_1.expect)(codeEl?.textContent?.trim()).toBe('const x = 1;');
        (0, vitest_1.expect)(codeEl?.querySelector('.hljs-keyword')?.textContent).toBe('const');
        react_1.fireEvent.click(react_1.screen.getByRole('button', { name: /Copy/ }));
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(writeText).toHaveBeenCalledWith('const x = 1;\n'));
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(react_1.screen.getByText(/Copied/)).toBeTruthy());
    });
    (0, vitest_1.it)('keeps text inside code fences literal (no bold parsing)', () => {
        const { container } = (0, react_1.render)(<Markdown_1.default text={'```\n**not bold**\n```'}/>);
        (0, vitest_1.expect)(container.querySelector('strong')).toBeNull();
        (0, vitest_1.expect)(react_1.screen.getByText('**not bold**')).toBeTruthy();
    });
    (0, vitest_1.it)('renders blockquotes and GFM tables', () => {
        const { container } = (0, react_1.render)(<Markdown_1.default text={'> a note\n\n| a | b |\n|---|---|\n| 1 | 2 |'}/>);
        (0, vitest_1.expect)(container.querySelector('blockquote')?.textContent?.trim()).toBe('a note');
        const table = container.querySelector('table.md-table');
        (0, vitest_1.expect)(table).toBeTruthy();
        (0, vitest_1.expect)(table?.querySelectorAll('th')).toHaveLength(2);
        (0, vitest_1.expect)(table?.querySelectorAll('td')).toHaveLength(2);
        (0, vitest_1.expect)(react_1.screen.getByText('1')).toBeTruthy();
        (0, vitest_1.expect)(react_1.screen.getByText('2')).toBeTruthy();
    });
    (0, vitest_1.it)('renders an empty string safely', () => {
        const { container } = (0, react_1.render)(<Markdown_1.default text={''}/>);
        const root = container.querySelector('.md-root');
        (0, vitest_1.expect)(root).toBeTruthy();
        (0, vitest_1.expect)(root?.querySelector('p, pre, table, ul, ol, blockquote, h1, h2, h3, h4, h5, h6')).toBeNull();
    });
});
(0, vitest_1.describe)('MarkdownZeroDep (zero-dependency fallback)', () => {
    (0, vitest_1.it)('still renders prose and fenced code with a copy button', async () => {
        const writeText = vitest_1.vi.fn().mockResolvedValue(undefined);
        Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
        (0, react_1.render)(<MarkdownZeroDep_1.default text={'hello\n\n```js\nconsole.log(1)\n```'}/>);
        (0, vitest_1.expect)(react_1.screen.getByText('hello')).toBeTruthy();
        (0, vitest_1.expect)(react_1.screen.getByText('js')).toBeTruthy();
        (0, vitest_1.expect)(react_1.screen.getByText('console.log(1)')).toBeTruthy();
        react_1.fireEvent.click(react_1.screen.getByRole('button', { name: /Copy/ }));
        await (0, react_1.waitFor)(() => (0, vitest_1.expect)(writeText).toHaveBeenCalledWith('console.log(1)'));
    });
    (0, vitest_1.it)('still strips unsafe link schemes', () => {
        const { container } = (0, react_1.render)(<MarkdownZeroDep_1.default text={'[click](javascript:alert(1))'}/>);
        (0, vitest_1.expect)(container.querySelector('a')).toBeNull();
        (0, vitest_1.expect)(react_1.screen.getByText('click')).toBeTruthy();
    });
});
