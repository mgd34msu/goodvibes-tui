import { estimateConversationTokens } from '../../core/context-compaction.ts';
import { evaluateSessionMaintenance, formatSessionMaintenanceLines, getGuidanceMode } from '../../runtime/session-maintenance.ts';
import { dismissGuidance, evaluateContextualGuidance, formatGuidanceItems, resetGuidance } from '../../runtime/guidance.ts';
import type { CommandRegistry } from '../command-registry.ts';
import { openCommandPanel, requireSessionMemoryStore } from './runtime-services.ts';

export function registerGuidanceRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'welcome',
    aliases: ['guide'],
    description: 'Open the guided start surface for setup, security, marketplace, remote, and operator workflows',
    usage: '[open|print]',
    handler(args, ctx) {
      const sub = args[0] ?? 'open';
      if (sub === 'open' || sub === 'panel') {
        openCommandPanel(ctx, 'welcome');
        return;
      }
      if (sub === 'print') {
        ctx.print([
          'Welcome To GoodVibes',
          '  /setup onboarding   - first-run checklist and health flows',
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
    handler(args, ctx) {
      const sub = (args[0] ?? 'review').toLowerCase();
      if (sub === 'dismiss') {
        const id = args[1];
        if (!id) {
          ctx.print('Usage: /guidance dismiss <id>');
          return;
        }
        dismissGuidance(id);
        ctx.print(`Dismissed guidance item ${id}.`);
        return;
      }
      if (sub === 'reset') {
        resetGuidance(args[1]);
        ctx.print(args[1] ? `Reset guidance item ${args[1]}.` : 'Reset all dismissed guidance items.');
        return;
      }
      if (sub !== 'review') {
        ctx.print('Usage: /guidance [review|dismiss <id>|reset [id]]');
        return;
      }

      const currentModel = ctx.providerRegistry.getCurrentModel?.();
      const llmMessages = ctx.conversationManager.getMessagesForLLM();
      const maintenance = evaluateSessionMaintenance({
        configManager: ctx.configManager,
        currentTokens: estimateConversationTokens(llmMessages),
        contextWindow: currentModel ? ctx.providerRegistry.getContextWindowForModel(currentModel) : 0,
        messageCount: llmMessages.length,
        sessionMemoryCount: requireSessionMemoryStore(ctx).list().length,
        session: ctx.runtimeStore?.getState().session,
      });
      const contextual = evaluateContextualGuidance(ctx.configManager, ctx.runtimeStore, maintenance);

      ctx.print([
        `Guidance Review (${getGuidanceMode(ctx.configManager)})`,
        '',
        ...formatGuidanceItems(contextual),
        '',
        ...formatSessionMaintenanceLines(maintenance, maintenance.guidanceMode === 'guided' ? 'guided' : 'minimal'),
      ].join('\n'));
    },
  });
}
