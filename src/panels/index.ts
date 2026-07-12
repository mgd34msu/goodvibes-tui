export type { Panel, PanelCategory, PanelRegistration } from './types.ts';
export type { Pane } from './panel-manager.ts';
export { BasePanel } from './base-panel.ts';
export { PanelManager } from './panel-manager.ts';
export { TokenBudgetPanel } from './token-budget-panel.ts';
export { CostTrackerPanel } from './cost-tracker-panel.ts';
export { GitPanel } from './git-panel.ts';
export { registerBuiltinPanels } from './builtin-panels.ts';
export type { BuiltinPanelDeps } from './builtin-panels.ts';
// (the purge) — group B: plugins/skills panels are register-retired but
// their modules are retained for shared non-class exports (PluginManagerControls;
// discoverSkills + SkillRecord/SkillOrigin, consumed by command runtimes and the
// skills modal). The other group-A and group-B panel classes are deleted outright
// (their views migrated to config-modal surfaces in src/panels/modals/).
export { PluginsPanel } from './plugins-panel.ts';
export { SkillsPanel } from './skills-panel.ts';
export { FleetPanel } from './fleet-panel.ts';
export type { FleetActionCallbacks } from './fleet-panel.ts';
export { NotificationsPanel } from './notifications-panel.ts';
export { PanelNotificationFeed, getSharedNotificationFeed } from './notifications-feed.ts';
export type { PanelFeedEntry } from './notifications-feed.ts';
