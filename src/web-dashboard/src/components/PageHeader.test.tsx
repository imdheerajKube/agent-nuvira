/**
 * PageHeader — the level and the accessible name are the point.
 *
 * The name half matters more than it looks: the icon is decorative, and if it
 * were part of the heading's text a screen reader would announce
 * "chart increasing System Overview". It is `aria-hidden`, so the heading's
 * accessible name is exactly the title.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import PageHeader from './PageHeader';

afterEach(cleanup);

describe('PageHeader', () => {
  it('renders the page title as the only h1, named without the icon', () => {
    render(<PageHeader icon="📊" title="System Overview" />);

    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading).toBeDefined();
    expect(heading.textContent).toBe('📊 System Overview');
    // The icon is present visually but kept out of the announced name.
    expect(heading.querySelector('[aria-hidden="true"]')?.textContent).toBe('📊');
    expect(screen.getByRole('heading', { name: 'System Overview' })).toBe(heading);
  });

  it('omits the description and action slots rather than rendering empties', () => {
    const { container } = render(<PageHeader icon="🔍" title="Traces" />);
    expect(container.querySelector('.page-header-description')).toBeNull();
    expect(container.querySelector('.page-header-actions')).toBeNull();
  });

  it('renders a description and page-level actions when given them', () => {
    render(
      <PageHeader
        icon="💰"
        title="Cost Tracking"
        description="Spend per provider and model."
        actions={<button type="button">Refresh</button>}
      />,
    );

    expect(screen.getByText('Spend per provider and model.')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeDefined();
  });
});
