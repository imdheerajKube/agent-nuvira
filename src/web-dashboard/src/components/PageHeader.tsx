import type { ReactNode } from 'react';

interface PageHeaderProps {
  /** Decorative: announced as part of the title would read "chart increasing System Overview". */
  icon: string;
  /**
   * ReactNode rather than string because two pages put a live badge inside the
   * heading ("Agent Hub  alice · admin"). That badge is status information a
   * screen-reader user needs, so it belongs in the name rather than beside it.
   */
  title: ReactNode;
  description?: ReactNode;
  /** Page-level controls that belong beside the title, not buried in the body. */
  actions?: ReactNode;
}

/**
 * The one page header every routed page uses.
 *
 * WHY IT EXISTS. Each page used to invent its own: most rendered
 * `<h2 className="section-title">`, three rendered a bare `<h2>` with no class,
 * `TasksPage` used `.panel-title`, `ExecutionHistory` used an `<h3>`, and
 * `TracePanel` inlined `style={{ fontSize: 15, … }}`. So the same page title
 * had five different sizes and six different margins, and the *level* was wrong
 * everywhere: no page in the dashboard had an `<h1>`, which means a screen
 * reader navigating by heading found the page's own title at level 2 — the same
 * level as the sidebar's "Agent Management" — and could not tell the page from
 * its chrome.
 *
 * One component fixes all three at once: level, size, and spacing are decided
 * in one place, and `dashboard-consistency.test.ts` fails if a routed page
 * renders a title without it.
 */
export default function PageHeader({ icon, title, description, actions }: PageHeaderProps) {
  return (
    <header className="page-header">
      <div className="page-header-text">
        <h1 className="page-header-title">
          <span aria-hidden="true">{icon}</span>{' '}
          {title}
        </h1>
        {description ? <p className="page-header-description">{description}</p> : null}
      </div>
      {actions ? <div className="page-header-actions">{actions}</div> : null}
    </header>
  );
}
