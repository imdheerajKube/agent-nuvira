/**
 * Live view tests — rendered with ink-testing-library, the same harness the
 * pipeline board uses. These prove the Ink surface maps the shared AST to
 * visible text (headings, prose, code content) and shows the streaming caret.
 */

import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';

import { LiveAnswer } from '../../../src/cli/ui/answer-view.js';
import { DARK_THEME } from '../../../src/cli/ui/theme.js';

describe('LiveAnswer (ink)', () => {
  it('renders headings, prose and code content', () => {
    const md = '# Title\n\nHello **world**.\n\n```ts\nconst x = 1\n```';
    const { lastFrame } = render(<LiveAnswer text={md} theme={DARK_THEME} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Title');
    expect(frame).toContain('Hello');
    expect(frame).toContain('world');
    expect(frame).toContain('const x = 1');
  });

  it('shows the header and the streaming caret while incomplete', () => {
    const { lastFrame } = render(
      <LiveAnswer text="partial" theme={DARK_THEME} header="nuvira · groq/llama" />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('nuvira · groq/llama');
    expect(frame).toContain('▌');
  });

  it('drops the caret and marks the header done when finished', () => {
    const { lastFrame } = render(
      <LiveAnswer text="done" theme={DARK_THEME} header="nuvira" done />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('✔');
    expect(frame).not.toContain('▌');
  });
});
