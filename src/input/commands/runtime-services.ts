import type { CommandContext } from '../command-registry.ts';

function requireContextValue<T>(value: T | null | undefined, name: string): T {
  if (value == null) {
    throw new Error(`commandContext.${name} is required but was not wired at bootstrap`);
  }
  return value;
}

export function openCommandPanel(
  context: CommandContext,
  panelId: string,
  pane?: 'top' | 'bottom',
): void {
  const showPanel = requireContextValue(context.showPanel, 'showPanel');
  showPanel(panelId, pane);
}

export function requireKeybindingsManager(context: CommandContext) {
  return requireContextValue(context.keybindingsManager, 'keybindingsManager');
}

export function requireProfileManager(context: CommandContext) {
  return requireContextValue(context.profileManager, 'profileManager');
}

export function requirePanelManager(context: CommandContext) {
  return requireContextValue(context.panelManager, 'panelManager');
}

export function requireBookmarkManager(context: CommandContext) {
  return requireContextValue(context.bookmarkManager, 'bookmarkManager');
}

export function requireSessionManager(context: CommandContext) {
  return requireContextValue(context.sessionManager, 'sessionManager');
}

export function requireSecretsManager(context: CommandContext) {
  return requireContextValue(context.secretsManager, 'secretsManager');
}

export function requireSubscriptionManager(context: CommandContext) {
  return requireContextValue(context.subscriptionManager, 'subscriptionManager');
}

export function requireServiceRegistry(context: CommandContext) {
  return requireContextValue(context.serviceRegistry, 'serviceRegistry');
}

export function requireLocalUserAuthManager(context: CommandContext) {
  return requireContextValue(context.localUserAuthManager, 'localUserAuthManager');
}

export function requireTokenAuditor(context: CommandContext) {
  return requireContextValue(context.tokenAuditor, 'tokenAuditor');
}

export function requireReplayEngine(context: CommandContext) {
  return requireContextValue(context.replayEngine, 'replayEngine');
}

export function requireWebhookNotifier(context: CommandContext) {
  return requireContextValue(context.webhookNotifier, 'webhookNotifier');
}

export function requireSessionMemoryStore(context: CommandContext) {
  return requireContextValue(context.sessionMemoryStore, 'sessionMemoryStore');
}

export function requireSessionLineageTracker(context: CommandContext) {
  return requireContextValue(context.sessionLineageTracker, 'sessionLineageTracker');
}

export function requireSessionChangeTracker(context: CommandContext) {
  return requireContextValue(context.changeTracker, 'changeTracker');
}

export function requirePlanManager(context: CommandContext) {
  return requireContextValue(context.planManager, 'planManager');
}

export function requireAdaptivePlanner(context: CommandContext) {
  return requireContextValue(context.adaptivePlanner, 'adaptivePlanner');
}

export function requireSessionOrchestration(context: CommandContext) {
  return requireContextValue(context.sessionOrchestration, 'sessionOrchestration');
}
