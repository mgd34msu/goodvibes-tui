import type { CommandRegistry } from './command-registry.ts';
import { policyCommand } from './commands/policy.ts';
import { providerCommand } from './commands/provider.ts';
import { evalCommand } from './commands/eval.ts';
import { sessionCommand, resumeCommand } from './commands/session.ts';
import { recallCommand } from './commands/memory.ts';
import { knowledgeCommand } from './commands/knowledge.ts';
import { registerShellCoreCommands } from './commands/shell-core.ts';
import { registerConfigCommand } from './commands/config.ts';
import { registerDiscoveryRuntimeCommands } from './commands/discovery-runtime.ts';
import { registerPlanningRuntimeCommands } from './commands/planning-runtime.ts';
import { registerSecretRuntimeCommands } from './commands/secret-runtime.ts';
import { registerScheduleRuntimeCommands } from './commands/schedule-runtime.ts';
import { registerBranchRuntimeCommands } from './commands/branch-runtime.ts';
import { registerOperatorRuntimeCommands } from './commands/operator-runtime.ts';
import { registerPluginRuntimeCommands } from './commands/plugin-runtime.ts';
import { registerDiffRuntimeCommands } from './commands/diff-runtime.ts';
import { registerGitRuntimeCommands } from './commands/git-runtime.ts';
import { registerTestRuntimeCommands } from './commands/test-runtime.ts';
import { registerNotifyRuntimeCommands } from './commands/notify-runtime.ts';
import { registerReplayRuntimeCommands } from './commands/replay-runtime.ts';
import { registerShareRuntimeCommands } from './commands/share-runtime.ts';
import { registerChannelRuntimeCommands } from './commands/channel-runtime.ts';
import { registerLocalSetupCommands } from './commands/local-setup.ts';
import { registerProductRuntimeCommands } from './commands/product-runtime.ts';
import { registerPlatformRuntimeCommands } from './commands/platform-runtime.ts';
import { registerProfileSyncRuntimeCommands } from './commands/profile-sync-runtime.ts';
import { registerManagedRuntimeCommands } from './commands/managed-runtime.ts';
import { registerPlatformAccessRuntimeCommands } from './commands/platform-access-runtime.ts';
import { registerPlatformServicesRuntimeCommands } from './commands/platform-services-runtime.ts';
import { registerTeamworkRuntimeCommands } from './commands/teamwork-runtime.ts';
import { registerMarketplaceRuntimeCommands } from './commands/marketplace-runtime.ts';
import { registerGuidanceRuntimeCommands } from './commands/guidance-runtime.ts';
import { registerRemoteRuntimeCommands } from './commands/remote-runtime.ts';
import { registerTeleportRuntimeCommands } from './commands/teleport-runtime.ts';
import { registerSubscriptionRuntimeCommands } from './commands/subscription-runtime.ts';
import { registerHooksRuntimeCommands } from './commands/hooks-runtime.ts';
import { registerFlagsRuntimeCommands } from './commands/flags-runtime.ts';
import { registerEditorRuntimeCommands } from './commands/editor-runtime.ts';
import { registerControlRoomRuntimeCommands } from './commands/control-room-runtime.ts';
import { registerMcpRuntimeCommands } from './commands/mcp-runtime.ts';
import { registerSessionContentCommands } from './commands/session-content.ts';
import { registerCheckpointRuntimeCommands } from './commands/checkpoint-runtime.ts';
import { registerWorkstreamRuntimeCommands } from './commands/workstream-runtime.ts';
import { registerCodebaseRuntimeCommands } from './commands/codebase-runtime.ts';
import { registerLocalRuntimeCommands } from './commands/local-runtime.ts';
import { registerExperienceRuntimeCommands } from './commands/experience-runtime.ts';
import { registerIncidentRuntimeCommands } from './commands/incident-runtime.ts';
import { registerMemoryProductRuntimeCommands } from './commands/memory-product-runtime.ts';
import { registerSkillsRuntimeCommands } from './commands/skills-runtime.ts';
import { registerServicesRuntimeCommands } from './commands/services-runtime.ts';
import { registerTasksRuntimeCommands } from './commands/tasks-runtime.ts';
import { registerLocalProviderRuntimeCommands } from './commands/local-provider-runtime.ts';
import { registerHealthRuntimeCommands } from './commands/health-runtime.ts';
import { registerSettingsSyncRuntimeCommands } from './commands/settings-sync-runtime.ts';
import { registerWorktreeRuntimeCommands } from './commands/worktree-runtime.ts';
import { registerProviderAccountsRuntimeCommands } from './commands/provider-accounts-runtime.ts';
import { registerLocalAuthRuntimeCommands } from './commands/local-auth-runtime.ts';
import { registerIntelligenceRuntimeCommands } from './commands/intelligence-runtime.ts';
import { registerConversationRuntimeCommands } from './commands/conversation-runtime.ts';
import { registerQrcodeRuntimeCommands } from './commands/qrcode-runtime.ts';
import { registerOnboardingRuntimeCommands } from './commands/onboarding-runtime.ts';
import { registerTtsRuntimeCommands } from './commands/tts-runtime.ts';
import { registerCloudflareRuntimeCommands } from './commands/cloudflare-runtime.ts';
import { registerWorkPlanRuntimeCommands } from './commands/work-plan-runtime.ts';
import { registerCostRuntimeCommands } from './commands/cost-runtime.ts';
import { registerWebSearchRuntimeCommands } from './commands/websearch-runtime.ts';
import { registerImageRuntimeCommands } from './commands/image-runtime.ts';
import { registerPermissionsRuntimeCommands } from './commands/permissions-runtime.ts';

/**
 * registerBuiltinCommands - Register all built-in slash commands into the registry.
 * Call once during application startup.
 */
export function registerBuiltinCommands(registry: CommandRegistry): void {
  registerShellCoreCommands(registry);
  registerConfigCommand(registry);
  registerOperatorRuntimeCommands(registry);
  registerPluginRuntimeCommands(registry);
  registerDiffRuntimeCommands(registry);
  registerGitRuntimeCommands(registry);
  registerTestRuntimeCommands(registry);
  registerNotifyRuntimeCommands(registry);
  registerReplayRuntimeCommands(registry);
  registerShareRuntimeCommands(registry);
  registerChannelRuntimeCommands(registry);
  registerLocalSetupCommands(registry);
  registerProductRuntimeCommands(registry);
  registerPlatformRuntimeCommands(registry);
  registerProfileSyncRuntimeCommands(registry);
  registerManagedRuntimeCommands(registry);
  registerPlatformAccessRuntimeCommands(registry);
  registerPlatformServicesRuntimeCommands(registry);
  registerTeamworkRuntimeCommands(registry);
  registerMarketplaceRuntimeCommands(registry);
  registerGuidanceRuntimeCommands(registry);
  registerRemoteRuntimeCommands(registry);
  registerTeleportRuntimeCommands(registry);
  registerSubscriptionRuntimeCommands(registry);
  registerHooksRuntimeCommands(registry);
  registerFlagsRuntimeCommands(registry);
  registerEditorRuntimeCommands(registry);
  registerControlRoomRuntimeCommands(registry);
  registerMcpRuntimeCommands(registry);
  registerIncidentRuntimeCommands(registry);
  registerMemoryProductRuntimeCommands(registry);
  registerSkillsRuntimeCommands(registry);
  registerExperienceRuntimeCommands(registry);
  registerServicesRuntimeCommands(registry);
  registerTasksRuntimeCommands(registry);
  registerLocalProviderRuntimeCommands(registry);
  registerHealthRuntimeCommands(registry);
  registerSettingsSyncRuntimeCommands(registry);
  registerWorktreeRuntimeCommands(registry);
  registerProviderAccountsRuntimeCommands(registry);
  registerLocalAuthRuntimeCommands(registry);
  registerIntelligenceRuntimeCommands(registry);
  registerConversationRuntimeCommands(registry);
  registerQrcodeRuntimeCommands(registry);
  registerOnboardingRuntimeCommands(registry);
  registerTtsRuntimeCommands(registry);
  registerCloudflareRuntimeCommands(registry);
  registerWorkPlanRuntimeCommands(registry);
  registerCostRuntimeCommands(registry);
  registerLocalRuntimeCommands(registry);
  registerDiscoveryRuntimeCommands(registry);
  registerPlanningRuntimeCommands(registry);
  registerSecretRuntimeCommands(registry);
  registerScheduleRuntimeCommands(registry);
  registerBranchRuntimeCommands(registry);
  registerSessionContentCommands(registry);
  registerCheckpointRuntimeCommands(registry);
  registerWorkstreamRuntimeCommands(registry);
  registerCodebaseRuntimeCommands(registry);
  registerWebSearchRuntimeCommands(registry);
  registerImageRuntimeCommands(registry);
  registerPermissionsRuntimeCommands(registry);

  // ── /policy ───────────────────────────────────────────────────────────────
  registry.register(policyCommand);

  // ── /provider ─────────────────────────────────────────────────────────────
  registry.register(providerCommand);

  // ── /eval ─────────────────────────────────────────────────────────────────
  registry.register(evalCommand);

  // ── /session ─────────────────────────────────────────────────────────────
  registry.register(sessionCommand);

  // ── /resume — the discoverable front door to /session resume ─────────────
  registry.register(resumeCommand);

  // ── /recall ──────────────────────────────────────────────────────────────
  registry.register(recallCommand);

  // ── /knowledge ───────────────────────────────────────────────────────────
  registry.register(knowledgeCommand);

}
