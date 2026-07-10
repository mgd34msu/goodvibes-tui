import { CommandRegistry } from './command-registry.ts';
import type { SlashCommand } from './command-registry.ts';
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
import { registerReviewRuntimeCommands } from './commands/review-runtime.ts';
import { registerPaletteRuntimeCommands } from './commands/palette-runtime.ts';
import { registerCiRuntimeCommands } from './commands/ci-runtime.ts';
import { registerCheckinRuntimeCommands } from './commands/checkin-runtime.ts';
import { registerPrincipalsRuntimeCommands } from './commands/principals-runtime.ts';

/**
 * A named group of built-in commands. The `category` label is the single
 * source of truth for command categorization: it drives both the runtime
 * registration order (via {@link registerBuiltinCommands}) and the generated
 * command-reference docs / command palette grouping (via
 * {@link categorizeBuiltinCommands}). Adding a new command group here is the
 * only edit needed for it to appear, categorized, everywhere.
 */
export interface BuiltinCommandGroup {
  readonly category: string;
  readonly register: (registry: CommandRegistry) => void;
}

/**
 * Every built-in command group, in registration order. Keeping runtime
 * registration and doc/palette categorization on one array means a category
 * label can never drift between the two.
 */
export const BUILTIN_COMMAND_GROUPS: readonly BuiltinCommandGroup[] = [
  { category: 'Shell & Session', register: registerShellCoreCommands },
  { category: 'Shell & Session', register: registerPaletteRuntimeCommands },
  { category: 'Configuration', register: registerConfigCommand },
  { category: 'Operator', register: registerOperatorRuntimeCommands },
  { category: 'Plugins', register: registerPluginRuntimeCommands },
  { category: 'Diff & Review', register: registerDiffRuntimeCommands },
  { category: 'Git', register: registerGitRuntimeCommands },
  { category: 'Testing', register: registerTestRuntimeCommands },
  { category: 'Notifications', register: registerNotifyRuntimeCommands },
  { category: 'Sessions & Replay', register: registerReplayRuntimeCommands },
  { category: 'Sharing', register: registerShareRuntimeCommands },
  { category: 'Channels', register: registerChannelRuntimeCommands },
  { category: 'Local Setup', register: registerLocalSetupCommands },
  { category: 'Product', register: registerProductRuntimeCommands },
  { category: 'Platform', register: registerPlatformRuntimeCommands },
  { category: 'Profiles', register: registerProfileSyncRuntimeCommands },
  { category: 'Managed Runtime', register: registerManagedRuntimeCommands },
  { category: 'Platform Access', register: registerPlatformAccessRuntimeCommands },
  { category: 'Platform Services', register: registerPlatformServicesRuntimeCommands },
  { category: 'Teamwork', register: registerTeamworkRuntimeCommands },
  { category: 'Marketplace', register: registerMarketplaceRuntimeCommands },
  { category: 'Guidance', register: registerGuidanceRuntimeCommands },
  { category: 'Remote', register: registerRemoteRuntimeCommands },
  { category: 'Remote', register: registerTeleportRuntimeCommands },
  { category: 'Subscriptions', register: registerSubscriptionRuntimeCommands },
  { category: 'Hooks', register: registerHooksRuntimeCommands },
  { category: 'Feature Flags', register: registerFlagsRuntimeCommands },
  { category: 'Editor', register: registerEditorRuntimeCommands },
  { category: 'Control Room', register: registerControlRoomRuntimeCommands },
  { category: 'MCP', register: registerMcpRuntimeCommands },
  { category: 'Incidents', register: registerIncidentRuntimeCommands },
  { category: 'Memory', register: registerMemoryProductRuntimeCommands },
  { category: 'Skills', register: registerSkillsRuntimeCommands },
  { category: 'Experience', register: registerExperienceRuntimeCommands },
  { category: 'Services', register: registerServicesRuntimeCommands },
  { category: 'Tasks', register: registerTasksRuntimeCommands },
  { category: 'Local Providers', register: registerLocalProviderRuntimeCommands },
  { category: 'Health', register: registerHealthRuntimeCommands },
  { category: 'Settings Sync', register: registerSettingsSyncRuntimeCommands },
  { category: 'Worktrees', register: registerWorktreeRuntimeCommands },
  { category: 'Provider Accounts', register: registerProviderAccountsRuntimeCommands },
  { category: 'Local Auth', register: registerLocalAuthRuntimeCommands },
  { category: 'Intelligence', register: registerIntelligenceRuntimeCommands },
  { category: 'Conversation', register: registerConversationRuntimeCommands },
  { category: 'QR Codes', register: registerQrcodeRuntimeCommands },
  { category: 'Onboarding', register: registerOnboardingRuntimeCommands },
  { category: 'Voice & TTS', register: registerTtsRuntimeCommands },
  { category: 'Cloudflare', register: registerCloudflareRuntimeCommands },
  { category: 'Work Plans', register: registerWorkPlanRuntimeCommands },
  { category: 'Cost', register: registerCostRuntimeCommands },
  { category: 'Local Runtime', register: registerLocalRuntimeCommands },
  { category: 'Discovery', register: registerDiscoveryRuntimeCommands },
  { category: 'Planning', register: registerPlanningRuntimeCommands },
  { category: 'Secrets', register: registerSecretRuntimeCommands },
  { category: 'Scheduling', register: registerScheduleRuntimeCommands },
  { category: 'Branches', register: registerBranchRuntimeCommands },
  { category: 'Session Content', register: registerSessionContentCommands },
  { category: 'Checkpoints', register: registerCheckpointRuntimeCommands },
  { category: 'Workstreams', register: registerWorkstreamRuntimeCommands },
  { category: 'Codebase', register: registerCodebaseRuntimeCommands },
  { category: 'Web Search', register: registerWebSearchRuntimeCommands },
  { category: 'Image', register: registerImageRuntimeCommands },
  { category: 'Permissions', register: registerPermissionsRuntimeCommands },
  { category: 'Diff & Review', register: registerReviewRuntimeCommands },
  { category: 'CI', register: registerCiRuntimeCommands },
  { category: 'Check-in', register: registerCheckinRuntimeCommands },
  { category: 'Principals', register: registerPrincipalsRuntimeCommands },
  { category: 'Policy', register: (registry) => registry.register(policyCommand) },
  { category: 'Providers', register: (registry) => registry.register(providerCommand) },
  { category: 'Eval', register: (registry) => registry.register(evalCommand) },
  { category: 'Sessions & Replay', register: (registry) => registry.register(sessionCommand) },
  { category: 'Sessions & Replay', register: (registry) => registry.register(resumeCommand) },
  { category: 'Memory', register: (registry) => registry.register(recallCommand) },
  { category: 'Knowledge', register: (registry) => registry.register(knowledgeCommand) },
];

/**
 * registerBuiltinCommands - Register all built-in slash commands into the registry.
 * Call once during application startup.
 */
export function registerBuiltinCommands(registry: CommandRegistry): void {
  for (const group of BUILTIN_COMMAND_GROUPS) {
    group.register(registry);
  }
}

/**
 * categorizeBuiltinCommands - Build every built-in command paired with its
 * category label, by replaying the same {@link BUILTIN_COMMAND_GROUPS} into a
 * throwaway registry and attributing each newly-registered command to the
 * group that added it. Handlers are never invoked, so this is side-effect free
 * and safe to call from build scripts and tests. Used by the generated command
 * reference (docs) and the command palette so both stay registry-driven.
 */
export function categorizeBuiltinCommands(): Array<{ command: SlashCommand; category: string }> {
  const registry = new CommandRegistry();
  const out: Array<{ command: SlashCommand; category: string }> = [];
  const seen = new Set<string>();
  for (const group of BUILTIN_COMMAND_GROUPS) {
    group.register(registry);
    for (const command of registry.getAll()) {
      if (seen.has(command.name)) continue;
      seen.add(command.name);
      out.push({ command, category: group.category });
    }
  }
  return out;
}
