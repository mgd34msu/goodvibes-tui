export type { Panel, PanelCategory, PanelRegistration } from './types.ts';
export type { Pane } from './panel-manager.ts';
export { BasePanel } from './base-panel.ts';
export { PanelManager } from './panel-manager.ts';
export { TokenBudgetPanel } from './token-budget-panel.ts';
export { CostTrackerPanel } from './cost-tracker-panel.ts';
export { ProviderHealthPanel } from './provider-health-panel.ts';
export { ProviderHealthTracker } from './provider-health-tracker.ts';
export type { ProviderHealth, ProviderStatus } from './provider-health-tracker.ts';
export { GitPanel } from './git-panel.ts';
export { registerBuiltinPanels } from './builtin-panels.ts';
export type { BuiltinPanelDeps } from './builtin-panels.ts';
// W6.1 (the purge) — group B: plugins/skills panels are register-retired but
// their modules are retained for shared non-class exports (PluginManagerControls;
// discoverSkills + SkillRecord/SkillOrigin, consumed by command runtimes and the
// skills modal). The other group-B panel classes are deleted outright.
export { PluginsPanel } from './plugins-panel.ts';
export { SkillsPanel } from './skills-panel.ts';
export { FleetPanel } from './fleet-panel.ts';
export type { FleetActionCallbacks } from './fleet-panel.ts';
export { RemotePanel } from './remote-panel.ts';
export { ServicesPanel } from './services-panel.ts';
export { SubscriptionPanel } from './subscription-panel.ts';
export { SandboxPanel } from './sandbox-panel.ts';
