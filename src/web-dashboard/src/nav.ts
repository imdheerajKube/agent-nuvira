/**
 * The navigation model — one list, three consumers.
 *
 * The shell renders it, the Help page lists it (so the help text cannot describe
 * a destination that does not exist), and `Layout.test.tsx` cross-checks it
 * against the routes `App.tsx` declares (so a route with no link, or a link to
 * no route, fails a test rather than a user).
 *
 * It used to live inside `Layout.tsx`, which meant the Help page would have had
 * to import the shell to talk about navigation. Data about where things are is
 * not a property of the shell.
 */

export interface NavItem {
  path: string;
  label: string;
  icon: string;
}

/**
 * The destinations the reference design keeps in the top bar: cross-cutting
 * views of the whole system rather than one section each, which is why they are
 * not also in the rail. Help is the fifth — it is where a user goes when they do
 * not yet know which of the other four they want.
 */
export const PRIMARY_NAV: NavItem[] = [
  { path: '/overview', label: 'Overview', icon: '📊' },
  { path: '/tasks', label: 'Tasks', icon: '🚀' },
  { path: '/models', label: 'Models', icon: '🧠' },
  { path: '/system', label: 'System', icon: '⚙️' },
  { path: '/help', label: 'Help', icon: '❓' },
];

export interface NavGroup {
  label: string;
  items: NavItem[];
}

/**
 * Every route App declares has a home here. The grouping is the reference's
 * editorial split (what the agent does / what we measured / what it reads /
 * what it talks to / how it runs), and it replaces one 23-item flat list where
 * "Chat" and "Process Env" sat at the same level.
 *
 * `/bedrock` used to be a route with no link anywhere in the UI — reachable
 * only by typing the URL. It is listed here so the page can be found.
 */
export const NAV_GROUPS: NavGroup[] = [
  {
    label: 'Agent Management',
    items: [
      // Chat is the front door (the lobby); the other rooms are panels. It is
      // `/chat`, not `/`, so the app can LAND on Overview while chat stays a
      // reachable destination that survives navigation.
      { path: '/chat', label: 'Chat', icon: '💬' },
      // Agent Hub sits directly after Chat by design: it is the highest-value
      // destination in this group (enable/disable the agents a chat turn will
      // actually use), so it is one step from the front door rather than last.
      { path: '/hub', label: 'Agent Hub', icon: '🧰' },
      { path: '/dag', label: 'Execution', icon: '🔀' },
      { path: '/routing', label: 'Routing', icon: '🤖' },
      { path: '/requests', label: 'Requests', icon: '📨' },
    ],
  },
  {
    label: 'Analysis & Monitoring',
    items: [
      { path: '/traces', label: 'Traces', icon: '🔍' },
      { path: '/evals', label: 'Evals', icon: '🏆' },
      { path: '/benchmarks', label: 'Benchmarks', icon: '📈' },
      { path: '/costs', label: 'Costs', icon: '💰' },
    ],
  },
  {
    label: 'Resources',
    items: [
      { path: '/memory', label: 'Memory', icon: '💾' },
      { path: '/knowledge', label: 'Knowledge', icon: '📚' },
      { path: '/history', label: 'History', icon: '📝' },
      { path: '/env', label: 'Env Config', icon: '🔐' },
      { path: '/process-env', label: 'Process Env', icon: '🌱' },
    ],
  },
  {
    label: 'Integrations',
    items: [
      { path: '/platforms', label: 'Platforms', icon: '🌐' },
      { path: '/gateway', label: 'Gateway', icon: '📡' },
      { path: '/contacts', label: 'Contacts', icon: '📇' },
      { path: '/bedrock', label: 'Bedrock', icon: '🪨' },
    ],
  },
  {
    label: 'Runtime',
    items: [
      { path: '/models/timeline', label: 'Timeline', icon: '📅' },
      { path: '/executions', label: 'Executions', icon: '📜' },
      { path: '/admin', label: 'Admin', icon: '🛠️' },
      // Help is NOT repeated here: it lives in PRIMARY_NAV with the other
      // cross-cutting views. A destination in two places is a destination whose
      // active state is wrong in one of them.
    ],
  },
];

/** Case-insensitive match on the item label or its group's label. */
export function filterGroups(query: string): NavGroup[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return NAV_GROUPS;
  return NAV_GROUPS.map((group) => {
    if (group.label.toLowerCase().includes(needle)) return group;
    return { ...group, items: group.items.filter((i) => i.label.toLowerCase().includes(needle)) };
  }).filter((group) => group.items.length > 0);
}
