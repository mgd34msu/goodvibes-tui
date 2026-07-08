import type { CommandRegistry } from '../command-registry.ts';
import { ToolContractVerifier } from '@/runtime/index.ts';
import type { ReplaySnapshotInput } from '@/runtime/index.ts';
import { logger } from '@pellux/goodvibes-sdk/platform/utils';
import { registerOperatorPanelCommand } from './operator-panel-runtime.ts';
import { requireOpsApi, requireProfileManager, requireReplayEngine } from './runtime-services.ts';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils';
import { estimateConversationTokens } from '@pellux/goodvibes-sdk/platform/core';
import { handleContextWindowSubcommand } from './context-window.ts';

export function registerOperatorRuntimeCommands(registry: CommandRegistry): void {
  registerOperatorPanelCommand(registry);

  registry.register({
    name: 'settings',
    aliases: ['cfg-ui'],
    description: 'Open the fullscreen configuration workspace',
    handler(_args, ctx) {
      if (ctx.openSettingsModal) ctx.openSettingsModal();
      else ctx.print('Configuration workspace is not available in this runtime.');
    },
  });

  registry.register({
    name: 'context',
    aliases: ['ctx'],
    description: 'Inspect context usage, or set/clear a custom context window for the current model',
    usage: '[window [<size>|clear]]',
    argsHint: '[window <size|clear>]',
    handler: (args, ctx) => {
      if (args[0]?.toLowerCase() === 'window') {
        handleContextWindowSubcommand(args.slice(1), ctx);
        return;
      }
      if (ctx.openContextInspector) {
        ctx.openContextInspector();
      } else {
        const msgs = ctx.session.conversationManager.getMessagesForLLM();
        if (msgs.length === 0) {
          ctx.print('[context] No messages in conversation.');
          return;
        }
        const total = estimateConversationTokens(msgs);
        const lines: string[] = ['Context breakdown:'];
        for (const m of msgs) {
          const t = estimateConversationTokens([m]);
          lines.push(`  ${m.role.padEnd(12)} ~${t.toLocaleString()} tokens`);
        }
        lines.push(`  ${'Total'.padEnd(12)} ~${total.toLocaleString()} tokens (${msgs.length} messages)`);
        ctx.print(lines.join('\n'));
      }
    },
  });

  registry.register({
    name: 'next-error',
    aliases: ['ne'],
    description: 'Jump to the next error message in the conversation',
    handler(_args, ctx) {
      const nextLine = ctx.session.conversationManager.nextErrorLine(ctx.getScrollTop?.() ?? 0);
      if (nextLine < 0) ctx.print('[No error messages found in conversation]');
      else ctx.scrollToLine?.(nextLine);
    },
  });

  registry.register({
    name: 'profiles',
    aliases: ['profile'],
    description: 'Browse and load config profiles',
    handler(_args, ctx) {
      if (ctx.openProfilePicker) {
        ctx.openProfilePicker();
      } else {
        const profiles = requireProfileManager(ctx).list();
        if (profiles.length === 0) ctx.print('No profiles saved. Open /profiles and press s to save the current settings as a profile.');
        else ctx.print(['Saved profiles:', ...profiles.map(p => `  ${p.name}`)].join('\n'));
      }
    },
  });

  registry.register({
    name: 'prev-error',
    aliases: ['pe'],
    description: 'Jump to the previous error message in the conversation',
    handler(_args, ctx) {
      const prevLine = ctx.session.conversationManager.prevErrorLine(ctx.getScrollTop?.() ?? 0);
      if (prevLine < 0) ctx.print('[No error messages found in conversation]');
      else ctx.scrollToLine?.(prevLine);
    },
  });

  registry.register({
    name: 'mode',
    aliases: ['hitl'],
    description: 'Manage HITL UX notification mode (quiet/balanced/operator)',
    usage: '[quiet|balanced|operator|show|set-domain <domain> <verbosity>]',
    argsHint: '[preset|show|set-domain]',
    handler(args, ctx) {
      const mgr = ctx.ops.modeManager;
      if (!mgr) {
        ctx.print('Interaction mode manager is not available in this runtime.');
        return;
      }
      const sub = args[0] ?? 'show';

      if (sub === 'quiet' || sub === 'balanced' || sub === 'operator') {
        const newMode = sub as 'quiet' | 'balanced' | 'operator';
        mgr.setHITLMode(newMode);
        try {
          ctx.platform.configManager.setDynamic('behavior.hitlMode' as import('@pellux/goodvibes-sdk/platform/config').ConfigKey, newMode);
        } catch (e) {
          logger.warn('[/mode] Failed to persist mode', { error: summarizeError(e) });
        }
        const preset = mgr.getHITLPreset();
        ctx.print(`HITL mode set to: ${preset.name}\n${preset.description}`);
        ctx.renderRequest();
        return;
      }

      if (sub === 'show') {
        const current = mgr.getHITLMode();
        const preset = mgr.getHITLPreset();
        const overrides = mgr.getDomainOverrides();
        const lines: string[] = [
          `HITL mode: ${current}`,
          `  ${preset.description}`,
          `  Default domain verbosity: ${preset.defaultDomainVerbosity}`,
          `  Quiet-while-typing: ${preset.quietWhileTyping}`,
          `  Batch window: ${preset.batchWindowMs}ms`,
        ];
        const overrideEntries = Object.entries(overrides);
        if (overrideEntries.length > 0) {
          lines.push('  Per-domain overrides:');
          for (const [domain, verbosity] of overrideEntries) lines.push(`    ${domain}: ${verbosity}`);
        } else {
          lines.push('  No per-domain overrides.');
        }
        lines.push('');
        lines.push('Available presets:');
        for (const p of mgr.listHITLPresets()) {
          const marker = p.name === current ? '\u25b6' : ' ';
          lines.push(`  ${marker} ${p.name.padEnd(10)} ${p.description}`);
        }
        ctx.print(lines.join('\n'));
        return;
      }

      if (sub === 'set-domain') {
        const domain = args[1];
        const verbosity = args[2];
        if (!domain || !verbosity) {
          ctx.print('Usage: /mode set-domain <domain> <minimal|normal|verbose>');
          return;
        }
        if (verbosity !== 'minimal' && verbosity !== 'normal' && verbosity !== 'verbose') {
          ctx.print(`Invalid verbosity "${verbosity}". Valid values: minimal, normal, verbose`);
          return;
        }
        mgr.setDomainVerbosity(domain, verbosity as 'minimal' | 'normal' | 'verbose');
        ctx.print(`Domain "${domain}" verbosity set to: ${verbosity}`);
        return;
      }

      ctx.print(
        'Usage: /mode [quiet|balanced|operator|show|set-domain <domain> <verbosity>]\n'
        + '  /mode                          — show current mode and settings\n'
        + '  /mode show                     — show current mode and settings\n'
        + '  /mode quiet                    — suppress all non-critical notifications\n'
        + '  /mode balanced                 — surface warnings, batch info noise (default)\n'
        + '  /mode operator                 — full verbosity, no suppression\n'
        + '  /mode set-domain <d> <v>       — per-domain verbosity override (minimal|normal|verbose)'
      );
    },
  });

  registry.register({
    name: 'ops',
    description: 'Operator Control Plane: view audit log, cancel/pause/resume/retry tasks and agents',
    usage: 'view | task <cancel|pause|resume|retry> <id> [note] | agent cancel <id> [note]',
    argsHint: '[view|task|agent]',
    handler(args, ctx) {
      const sub = args[0];

      if (sub === 'view' || sub === undefined) {
        // Parity with the Ctrl+O keybind (handler-shortcuts.ts): prefer the
        // flag-wired opener, else fall back to the always-registered panel,
        // which renders its own honest not-configured state.
        if (ctx.openOpsPanel) ctx.openOpsPanel();
        else if (ctx.showPanel) ctx.showPanel('ops-control');
        else ctx.print('Operator Control Plane panel is not available in this shell.');
        return;
      }

      if (sub === 'task') {
        const action = args[1];
        const taskId = args[2];
        const note = args.slice(3).join(' ') || undefined;
        if (!action || !taskId) {
          ctx.print('Usage: /ops task <cancel|pause|resume|retry> <task-id> [note]');
          return;
        }
        const opsApi = requireOpsApi(ctx);
        try {
          switch (action) {
            case 'cancel': opsApi.tasks.cancel(taskId, note); break;
            case 'pause': opsApi.tasks.pause(taskId, note); break;
            case 'resume': opsApi.tasks.resume(taskId, note); break;
            case 'retry': opsApi.tasks.retry(taskId, note); break;
            default:
              ctx.print(`Unknown task action "${action}". Use: cancel, pause, resume, retry`);
              return;
          }
          ctx.print(`[Ops] Task ${taskId}: ${action} dispatched.`);
        } catch (e) {
          ctx.print(`[Ops] Error: ${summarizeError(e)}`);
        }
        return;
      }

      if (sub === 'agent') {
        const action = args[1];
        const agentId = args[2];
        const note = args.slice(3).join(' ') || undefined;
        if (action !== 'cancel' || !agentId) {
          ctx.print('Usage: /ops agent cancel <agent-id> [note]');
          return;
        }
        const opsApi = requireOpsApi(ctx);
        try {
          opsApi.agents.cancel(agentId, note);
          ctx.print(`[Ops] Agent ${agentId}: cancel dispatched.`);
        } catch (e) {
          ctx.print(`[Ops] Error: ${summarizeError(e)}`);
        }
        return;
      }

      ctx.print(
        'Usage: /ops <subcommand>\n'
        + '  /ops view                              — open the Ops Control panel (Ctrl+O)\n'
        + '  /ops task cancel <id> [note]           — cancel a task\n'
        + '  /ops task pause  <id> [note]           — pause a task\n'
        + '  /ops task resume <id> [note]           — resume a blocked task\n'
        + '  /ops task retry  <id> [note]           — retry a failed task\n'
        + '  /ops agent cancel <id> [note]          — cancel a running agent'
      );
    },
  });

  registry.register({
    name: 'tool',
    description: 'Tool contract verification — verify registered tool contracts',
    usage: 'verify <name> | verify-all | contract show <name>',
    argsHint: 'verify <name> | verify-all | contract show <name>',
    handler(args, ctx) {
      const sub = args[0];
      if (sub === 'verify' && args[1]) {
        const result = ctx.extensions.toolRegistry.verifyContract(args[1]);
        if (!result) {
          ctx.print(`[tool verify] Tool '${args[1]}' is not registered.`);
          return;
        }
        ctx.print(ToolContractVerifier.formatResult(result));
        return;
      }
      if (sub === 'verify-all') {
        ctx.print(ToolContractVerifier.formatAllResults(ctx.extensions.toolRegistry.verifyAllContracts()));
        return;
      }
      if (sub === 'contract' && args[1] === 'show' && args[2]) {
        const toolName = args[2];
        const result = ctx.extensions.toolRegistry.verifyContract(toolName);
        if (!result) {
          ctx.print(`[tool contract show] Tool '${toolName}' is not registered.`);
          return;
        }
        const lines: string[] = [ToolContractVerifier.formatResult(result)];
        const tool = ctx.extensions.toolRegistry.list().find((t) => t.definition.name === toolName);
        if (tool) {
          lines.push('');
          lines.push('Tool Definition:');
          lines.push(`  Name:        ${tool.definition.name}`);
          lines.push(`  Description: ${tool.definition.description}`);
          lines.push(`  Parameters:  ${JSON.stringify(tool.definition.parameters, null, 2).replace(/\n/g, '\n               ')}`);
        }
        ctx.print(lines.join('\n'));
        return;
      }

      ctx.print(
        'Usage: /tool <subcommand>\n'
        + '  /tool verify <name>             — verify contract for a specific registered tool\n'
        + '  /tool verify-all                — verify contracts for all registered tools\n'
        + '  /tool contract show <name>      — show full contract details for a tool'
      );
    },
  });

  registry.register({
    name: 'forensics',
    aliases: ['foren'],
    description: 'Failure Forensics: view, inspect, and export auto-classified failure reports',
    usage: '[latest | show <id> | export <id>]',
    argsHint: '[latest|show|export]',
    handler(args, ctx) {
      const sub = args[0];
      if (sub === undefined || sub === 'view') {
        if (ctx.openForensicsPanel) ctx.openForensicsPanel();
        else ctx.print('Forensics panel is not available.');
        return;
      }
      if (sub === 'latest') {
        if (!ctx.extensions.forensicsRegistry) {
          ctx.print('[Forensics] Registry not active.');
          return;
        }
        const report = ctx.extensions.forensicsRegistry.latest();
        if (!report) {
          ctx.print('[Forensics] No failure reports recorded this session.');
          return;
        }
        const lines: string[] = [
          `[Forensics] Latest failure report (id: ${report.id})`,
          `  Time:           ${new Date(report.generatedAt).toISOString()}`,
          `  Classification: ${report.classification}`,
          `  Summary:        ${report.summary}`,
        ];
        if (report.errorMessage) lines.push(`  Error:          ${report.errorMessage}`);
        if (report.stopReason) lines.push(`  Stop reason:    ${report.stopReason}`);
        if (report.taskId) lines.push(`  Task ID:        ${report.taskId}`);
        if (report.turnId) lines.push(`  Turn ID:        ${report.turnId}`);
        if (report.causalChain.length > 0) {
          lines.push('  Causal chain:');
          for (const entry of report.causalChain) {
            const marker = entry.isRootCause ? '  ● ' : '  · ';
            lines.push(`  ${marker}${entry.description}`);
          }
        }
        if (report.jumpLinks.length > 0) {
          lines.push('  Jump links:');
          for (const link of report.jumpLinks) {
            lines.push(`    [${link.kind}] ${link.label} → ${link.target}${link.args ? ` (${link.args})` : ''}`);
          }
        }
        lines.push(`  Use "/forensics show ${report.id}" for full JSON.`);
        ctx.print(lines.join('\n'));
        return;
      }
      if (sub === 'show') {
        const id = args[1];
        if (!id) {
          ctx.print('Usage: /forensics show <id>');
          return;
        }
        if (!ctx.extensions.forensicsRegistry) {
          ctx.print('[Forensics] Registry not active.');
          return;
        }
        const json = ctx.extensions.forensicsRegistry.exportAsJson(id);
        if (!json) {
          ctx.print(`[Forensics] No report found with id "${id}". Use /forensics latest to see the most recent.`);
          return;
        }
        ctx.print(json);
        return;
      }
      if (sub === 'export') {
        const id = args[1];
        if (!id) {
          ctx.print('Usage: /forensics export <id>');
          return;
        }
        if (!ctx.extensions.forensicsRegistry) {
          ctx.print('[Forensics] Registry not active.');
          return;
        }
        const json = ctx.extensions.forensicsRegistry.exportBundleAsJson(id, {
          replaySnapshot: requireReplayEngine(ctx).getSnapshot() as ReplaySnapshotInput,
        });
        if (!json) {
          ctx.print(`[Forensics] No report found with id "${id}".`);
          return;
        }
        ctx.print(`[Forensics] Incident bundle ${id}:\n${json}`);
        return;
      }
      ctx.print(
        'Usage: /forensics <subcommand>\n'
        + '  /forensics             — open the Forensics panel\n'
        + '  /forensics latest      — print the most recent failure report summary\n'
        + '  /forensics show <id>   — show full JSON for a specific report\n'
        + '  /forensics export <id> — export incident bundle JSON to the conversation'
      );
    },
  });
}
