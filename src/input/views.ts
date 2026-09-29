/**
 * views.ts, where every old pane name goes now.
 *
 * The side panes are gone; their content lives in four kit modals (Usage,
 * Changes, Agents, Notifications), the session picker and the config-modal
 * surfaces. Old names still arrive from many places: `/panel open <id>`,
 * notifications that name the pane they are about, cross-modal jumps (the work
 * plan's "show this agent"), saved muscle memory. resolveViewName turns any of
 * them into the modal that holds that content now, so none of them dead-ends.
 */

/** A specific row to select when a view opens (a fleet process id, optionally its kind). */
export interface ViewTarget {
  readonly id: string;
  readonly kind?: string;
}

export type ViewRoute =
  | { readonly kind: 'agents'; readonly hosted?: boolean }
  | { readonly kind: 'usage'; readonly tab?: 'agents' }
  | { readonly kind: 'changes'; readonly mode?: 'review' | 'git' }
  | { readonly kind: 'notifications' }
  | { readonly kind: 'sessions' }
  | { readonly kind: 'modal'; readonly name: string };

/**
 * Every old name for the live process console. Fleet absorbed these consoles
 * before; the Agents modal holds that content now, and the palette uses the
 * list as search words so typing an old name finds it.
 */
export const AGENT_VIEW_NAMES: readonly string[] = [
  'agents', 'fleet', 'cockpit', 'approval', 'automation', 'routes', 'control-plane', 'worktrees',
  'tasks', 'orchestration', 'ops', 'ops-control', 'communication', 'incident', 'forensics',
  'agent-logs', 'inspector', 'wrfc', 'plan', 'processes',
];

/** Old names for the context and cost consoles. */
export const USAGE_VIEW_NAMES: readonly string[] = ['usage', 'tokens', 'context', 'cost'];

/** Old names for the git, diff and review consoles. */
export const CHANGES_VIEW_NAMES: readonly string[] = ['changes', 'git', 'diff', 'review'];

/** Parse `<id>[:<kind>]` (the `--target` flag's value). */
export function parseViewTarget(raw: string | undefined): ViewTarget | undefined {
  if (!raw) return undefined;
  const sep = raw.indexOf(':');
  return sep >= 0 ? { id: raw.slice(0, sep), kind: raw.slice(sep + 1) || undefined } : { id: raw };
}

/**
 * Remove `--target <id>[:<kind>]` from `args` (in place) and return it, so
 * positional arguments are read the same wherever the flag appears.
 */
export function takeTargetFlag(args: string[]): ViewTarget | undefined {
  const index = args.indexOf('--target');
  if (index < 0) return undefined;
  const raw = args[index + 1];
  args.splice(index, raw === undefined ? 1 : 2);
  return parseViewTarget(raw);
}

/**
 * The modal an old or current view name opens, or null when nothing holds it.
 * `modalRedirect` resolves config-modal names ('providers', 'services', ...).
 */
export function resolveViewName(name: string, modalRedirect: (name: string) => string | undefined): ViewRoute | null {
  const id = name.trim().toLowerCase();
  if (!id) return null;
  if (id === 'hosted') return { kind: 'agents', hosted: true };
  if (AGENT_VIEW_NAMES.includes(id)) return { kind: 'agents' };
  // The old cost pane's heart was the per-agent cost ledger: Usage's Agents tab.
  if (id === 'cost') return { kind: 'usage', tab: 'agents' };
  if (USAGE_VIEW_NAMES.includes(id)) return { kind: 'usage' };
  if (id === 'review') return { kind: 'changes', mode: 'review' };
  if (id === 'git') return { kind: 'changes', mode: 'git' };
  if (CHANGES_VIEW_NAMES.includes(id)) return { kind: 'changes' };
  if (id === 'notifications') return { kind: 'notifications' };
  if (id === 'sessions' || id === 'session-picker') return { kind: 'sessions' };
  if (id === 'local-auth') return { kind: 'modal', name: 'local-auth-modal' };
  const redirect = modalRedirect(id);
  if (redirect === 'sessionPicker') return { kind: 'sessions' };
  if (redirect) return { kind: 'modal', name: redirect };
  if (id.endsWith('-modal')) return { kind: 'modal', name: id };
  return null;
}

/** A one-line description of where a view name goes, for `/panel list`. */
export function describeViewRoute(route: ViewRoute): string {
  switch (route.kind) {
    case 'agents': return route.hosted ? 'Agents (the hosted session)' : 'Agents';
    case 'usage': return 'Usage';
    case 'changes': return route.mode === 'review' ? 'Changes (review)' : 'Changes';
    case 'notifications': return 'Notifications';
    case 'sessions': return 'Sessions';
    case 'modal': return route.name;
  }
}
