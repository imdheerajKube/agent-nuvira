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

  it('shows the model’s working notes while it thinks, above the answer', () => {
    const { lastFrame } = render(
      <LiveAnswer text="" theme={DARK_THEME} reasoning="Comparing the two repos: tool counts first." />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('✳ thinking');
    expect(frame).toContain('Comparing the two repos');
  });

  it('drops the caret and marks the header done when finished', () => {
    const { lastFrame } = render(
      <LiveAnswer text="done" theme={DARK_THEME} header="nuvira" done />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('✔');
    expect(frame).not.toContain('▌');
  });

  it('keeps the plan on screen with its progress and the running step', () => {
    // The plan used to appear as a table ONCE and then scroll away, so while a
    // long command ran the frame said nothing about how far along the turn was.
    const { lastFrame } = render(
      <LiveAnswer
        text=""
        theme={DARK_THEME}
        header="nuvira · deepseek/deepseek-flash"
        note="⚙ run_terminal …"
        plan={{
          goal: 'Add format_duration with tests',
          steps: [
            { description: 'Baseline the suite', status: 'done' },
            { description: 'Add the helper', status: 'running' },
            { description: 'Write the tests', status: 'pending' },
          ],
        }}
      />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('🗂 Add format_duration with tests · 1/3');
    expect(frame).toContain('✔ Baseline the suite');
    expect(frame).toContain('▶ Add the helper');
    expect(frame).toContain('⬜ Write the tests');
    // The running command stays visible beside it — the panel is state, the note
    // is the event, and a watching user needs both.
    expect(frame).toContain('run_terminal');
  });

  it('keeps a long plan bounded, centred on the running step', () => {
    const steps = Array.from({ length: 12 }, (_, i) => ({
      description: `step ${i + 1}`,
      status: i < 9 ? ('done' as const) : i === 9 ? ('running' as const) : ('pending' as const),
    }));
    const { lastFrame } = render(
      <LiveAnswer text="" theme={DARK_THEME} plan={{ goal: 'Twelve steps', steps }} />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('step 10');
    expect(frame).toContain('… 6 more step(s)');
    expect(frame).not.toContain('step 1 ');
  });
});
