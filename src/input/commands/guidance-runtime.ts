import { estimateConversationTokens } from '@pellux/goodvibes-sdk/platform/core/context-compaction';
import { evaluateSessionMaintenance, formatSessionMaintenanceLines, getGuidanceMode } from '@pellux/goodvibes-sdk/platform/runtime/session-maintenance';
import { dismissGuidance, evaluateContextualGuidance, formatGuidanceItems, resetGuidance } from '@pellux/goodvibes-sdk/platform/runtime/guidance';
import type { CommandRegistry } from '../command-registry.ts';
import { requireProviderApi, requireReadModels, requireSessionMemoryStore, requireShellPaths } from './runtime-services.ts';

export function registerGuidanceRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'welcome',
    aliases: ['guide'],
    description: 'Open the product entry surface for the onboarding wizard, security, marketplace, remote, and operator workflows',
    usage: '[open|print]',
    handler(args, ctx) {
      const sub = args[0] ?? 'open';
      if (sub === 'open' || sub === 'panel') {
        if (ctx.openOnboardingWizard) {
          ctx.openOnboardingWizard({ mode: 'edit' });
          return;
        }
        ctx.print('Use /onboarding to open the setup wizard.');
        return;
      }
      if (sub === 'print') {
        ctx.print([
          'Welcome To GoodVibes',
          '  /onboarding         - open the onboarding wizard with current settings preloaded',
          '  /setup onboarding   - open the same onboarding wizard from setup workflows',
          '  /health review      - unified startup, service, and sandbox posture',
          '  /sandbox review     - inspect VM isolation posture',
          '  /marketplace open   - browse curated plugins, skills, hook packs, and policy packs',
          '  /remote setup       - review bridge, tunnel, env, and bootstrap flows',
          '  /security           - review trust posture, policy pressure, and incidents',
          '  /cockpit            - unified operator control room',
        ].join('\n'));
        return;
      }
      ctx.print('Usage: /welcome [open|print]');
    },
  });

  registry.register({
    name: 'guidance',
    description: 'Review contextual operational guidance without interrupting the main conversation flow',
    usage: '[review|dismiss <id>|reset [id]]',
    async handler(args, ctx) {
      const sub = (args[0] ?? 'review').toLowerCase();
      const shellPaths = requireShellPaths(ctx);
      const guidanceOptions = {
        homeDirectory: shellPaths.homeDirectory,
      };
      if (sub === 'dismiss') {
        const id = args[1];
        if (!id) {
          ctx.print('Usage: /guidance dismiss <id>');
          return;
        }
        dismissGuidance(id, guidanceOptions);
        ctx.print(`Dismissed guidance item ${id}.`);
        return;
      }
      if (sub === 'reset') {
        resetGuidance(args[1], guidanceOptions);
        ctx.print(args[1] ? `Reset guidance item ${args[1]}.` : 'Reset all dismissed guidance items.');
        return;
      }
      if (sub !== 'review') {
        ctx.print('Usage: /guidance [review|dismiss <id>|reset [id]]');
        return;
      }

      const providerApi = requireProviderApi(ctx);
      const currentModel = await providerApi.getCurrentModel().catch(() => null); // best-effort: null handled as unknown context window
      const llmMessages = ctx.session.conversationManager.getMessagesForLLM();
      const readModels = requireReadModels(ctx);
      const session = readModels.session.getSnapshot();
      const intelligence = readModels.intelligence.getSnapshot();
      const mcp = readModels.mcp.getSnapshot();
      const health = readModels.health.getSnapshot();
      const marketplace = readModels.marketplace.getSnapshot();
      const maintenance = evaluateSessionMaintenance({
        configManager: ctx.platform.configManager,
        currentTokens: estimateConversationTokens(llmMessages),
        contextWindow: currentModel?.contextWindow ?? 0,
        messageCount: llmMessages.length,
        sessionMemoryCount: requireSessionMemoryStore(ctx).list().length,
        session: session.session,
      });
      const contextual = evaluateContextualGuidance(ctx.platform.configManager, {
        pendingApproval: session.pendingApproval,
        denialCount: session.denialCount,
        authRequiredMcpCount: mcp.servers.filter((server) => server.status === 'auth_required').length,
        degradedProviderCount: health.providerProblems.length,
        intelligenceUnavailable: intelligence.diagnosticsStatus === 'unavailable' && intelligence.symbolSearchStatus === 'unavailable',
        recommendations: marketplace.recommendations,
      }, maintenance, guidanceOptions);

      ctx.print([
        `Guidance Review (${getGuidanceMode(ctx.platform.configManager)})`,
        '',
        ...formatGuidanceItems(contextual),
        '',
        ...formatSessionMaintenanceLines(maintenance, maintenance.guidanceMode === 'guided' ? 'guided' : 'minimal'),
      ].join('\n'));
    },
  });
}
