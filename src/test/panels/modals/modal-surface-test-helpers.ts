import type {
  ConfigModalActionContext,
  ConfigModalRow,
  ConfigModalSurface,
  ConfigModalView,
} from '../../../input/config-modal-types.ts';

/** Build an action context, capturing nothing by default. */
export function actionCtx(row: ConfigModalRow | null, extra: Partial<ConfigModalActionContext> = {}): ConfigModalActionContext {
  return { row, tabId: 't', print: () => {}, requestRender: () => {}, setStatus: () => {}, close: () => {}, ...extra };
}

/** Open a surface (fires onOpen/refresh) and return its first view. */
export function open(surface: ConfigModalSurface): ConfigModalView {
  surface.onOpen?.(() => {});
  return surface.buildView();
}

/** Flatten a whole view (all tabs) into one searchable string. */
export function viewText(view: ConfigModalView): string {
  const parts: string[] = [view.title, view.degraded ?? ''];
  for (const tab of view.tabs) {
    parts.push(tab.label, ...(tab.header ?? []), ...tab.rows.map((r) => r.label), tab.emptyText ?? '', ...(tab.hints ?? []));
  }
  return parts.join('\n');
}

/** Flatten one tab's header + rows + emptyText into a searchable string. */
export function tabText(view: ConfigModalView, tabId: string): string {
  const tab = view.tabs.find((t) => t.id === tabId) ?? view.tabs[0]!;
  return [...(tab.header ?? []), ...tab.rows.map((r) => r.label), tab.emptyText ?? ''].join('\n');
}

/** The rows of a tab (by id, else first tab). */
export function tabRows(view: ConfigModalView, tabId?: string): readonly ConfigModalRow[] {
  const tab = tabId ? view.tabs.find((t) => t.id === tabId) ?? view.tabs[0]! : view.tabs[0]!;
  return tab.rows;
}

/** Find a declared action by its id. */
export function findAction(surface: ConfigModalSurface, id: string) {
  return (surface.actions ?? []).find((a) => a.id === id);
}

/** An executeCommand capture: returns the ctx extra + the recorded calls. */
export function captureCommands(): { calls: Array<[string, string[]]>; extra: Partial<ConfigModalActionContext> } {
  const calls: Array<[string, string[]]> = [];
  return { calls, extra: { executeCommand: async (name, args) => { calls.push([name, args]); return true; } } };
}
