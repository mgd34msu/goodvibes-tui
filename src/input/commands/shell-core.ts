import type { CommandRegistry } from '../command-registry.ts';
import type { SelectionItem } from '../selection-modal.ts';
import { EFFORT_DESCRIPTIONS } from '@pellux/goodvibes-sdk/platform/providers';
import { REASONING_BUDGET_MAP } from '@pellux/goodvibes-sdk/platform/providers';
import { executeWriteQuit } from './quit-shared.ts';
import { compactConversation, requireKeybindingsManager, requireProviderApi, requireSessionMemoryStore } from './runtime-services.ts';
import { buildCompactionPreview, buildCompactionAfterNotice, buildPinUsageText, buildPinSuccessText } from '../../renderer/compaction-preview.ts';
import { buildCompactionHistoryText } from '../../renderer/compaction-history-modal.ts';
import { ensureProviderKeyThenSelect } from '../provider-key-intake.ts';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils';
import { logger } from '@pellux/goodvibes-sdk/platform/utils';

export function registerShellCoreCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'model',
    aliases: ['m'],
    description: 'Select or display the current LLM model',
    usage: '[model-id]',
    argsHint: '[model-id]',
    async handler(args, ctx) {
      const providerApi = requireProviderApi(ctx);
      if (args.length === 0) {
        if (ctx.openModelPicker) {
          ctx.openModelPicker();
        } else {
          const models = await providerApi.listModels({ selectableOnly: true });
          const lines = ['Available models:', ...models.map((model) =>
            `  ${model.current ? '▶' : ' '} ${model.registryKey.padEnd(36)} ${model.displayName} (${model.providerId})`,
          )];
          ctx.print(lines.join('\n'));
        }
      } else {
        const modelId = args[0];
        try {
          const selected = await providerApi.selectModel(modelId);
          // Capture the key for an unconfigured provider inline before the
          // selection is announced, so the switch lands ready to chat.
          ensureProviderKeyThenSelect(ctx, selected.providerId, () => {
            ctx.session.runtime.model = selected.registryKey;
            ctx.session.runtime.provider = selected.providerId;
            ctx.platform.configManager.set('provider.model', selected.registryKey);
            ctx.print(`Switched to model: ${selected.displayName} (${selected.providerId})`);
            void providerApi.recordModelUsage(selected.registryKey).catch((err) => { logger.debug('model usage record failed', { err }); });
          });
        } catch (e) {
          ctx.print(`Error: ${summarizeError(e)}`);
        }
      }
    },
  });

  registry.register({
    name: 'commands',
    aliases: ['cmds'],
    description: 'Browse all commands in a scrollable list',
    handler(_args, ctx) {
      if (ctx.openHelpOverlay) {
        ctx.openHelpOverlay();
        return;
      }
      ctx.print('Use /help for interactive command list');
    },
  });

  registry.register({
    name: 'shortcuts',
    aliases: ['keys', 'keybinds'],
    description: 'Show keyboard shortcuts reference',
    handler(_args, ctx) {
      if (ctx.openShortcutsOverlay) {
        ctx.openShortcutsOverlay();
        return;
      }
      ctx.print('Use /commands for shortcuts');
    },
  });

  registry.register({
    name: 'find',
    aliases: ['findtext'],
    description: 'Search THIS conversation transcript (same as Ctrl+F) — searching the web instead? use /search',
    handler(_args, ctx) {
      if (ctx.openTranscriptSearch) {
        ctx.openTranscriptSearch();
        return;
      }
      ctx.print('Transcript search is not available in this context — try Ctrl+F.');
    },
  });

  registry.register({
    name: 'keybindings',
    aliases: ['kb'],
    description: 'List current keyboard bindings and their config file path',
    handler(_args, ctx) {
      const km = requireKeybindingsManager(ctx);
      // The full binding table (~45 rows) is presented via the same
      // generated, scrollable overlay /shortcuts opens (see
      // renderShortcutsOverlay) rather than a one-shot transcript dump —
      // the file path (dynamic, per-user) still gets a short transcript
      // line since the overlay itself doesn't show it.
      ctx.print(`Keybindings config: ${km.getConfigPath()}  (create it to override any binding: { "action": { "key": "x", "ctrl": true } })`);
      if (ctx.openShortcutsOverlay) {
        ctx.openShortcutsOverlay();
        return;
      }
      const all = km.getAll();
      const lines: string[] = [
        `  ${'Action'.padEnd(28)}  ${'Binding'.padEnd(20)}  Description`,
        `  ${'─'.repeat(28)}  ${'─'.repeat(20)}  ${'─'.repeat(34)}`,
      ];
      for (const { action, combos, description } of all) {
        const label = combos.map((combo) => km.formatCombo(combo)).join(', ');
        lines.push(`  ${action.padEnd(28)}  ${label.padEnd(20)}  ${description}`);
      }
      ctx.print(lines.join('\n'));
    },
  });

  registry.register({
    name: 'paste',
    aliases: ['clip'],
    description: 'Insert clipboard text or image into the prompt',
    handler(_args, ctx) {
      if (!ctx.pasteFromClipboard) {
        ctx.print('Paste is not available in this context.');
        return;
      }
      const result = ctx.pasteFromClipboard();
      if (!result.pasted) {
        ctx.print('Clipboard does not contain supported text or image data.');
      }
    },
  });

  registry.register({
    name: 'pastes',
    aliases: ['pending-pastes'],
    description: 'Preview the actual content behind each [TEXT: pN, M lines] fold in the composer, before you submit',
    usage: '[pN]',
    argsHint: '[pN]',
    handler(args, ctx) {
      const pending = ctx.getPendingPastes?.();
      if (!pending || pending.size === 0) {
        ctx.print('[Pastes] No folded pastes are currently in the composer (pastes over 8 lines fold to [TEXT: pN, M lines]).');
        return;
      }
      const requestedId = args[0]?.trim();
      if (requestedId) {
        const content = pending.get(requestedId);
        if (!content) {
          ctx.print(`[Pastes] No pending paste with id "${requestedId}". Pending: ${[...pending.keys()].join(', ')}`);
          return;
        }
        ctx.print(`[Pastes] ${requestedId} (${content.split('\n').length} lines):\n${content}`);
        return;
      }
      const lines = ['[Pastes] Folded in the composer right now:'];
      for (const [id, content] of pending) {
        const contentLines = content.split('\n');
        const preview = contentLines[0].slice(0, 80);
        lines.push(`  ${id} — ${contentLines.length} lines — ${preview}${contentLines.length > 1 || preview.length < contentLines[0].length ? '…' : ''}`);
      }
      lines.push('', 'Full text: /pastes <id>');
      ctx.print(lines.join('\n'));
    },
  });

  registry.register({
    name: 'help',
    aliases: ['h', '?'],
    description: 'Browse every command with its description; picking one runs it',
    handler(_args, ctx) {
      // Generated live from the command registry — never a hand-maintained
      // list — so /help can never drift from the real command set. Category
      // labels come from the same single source of truth as the generated
      // reference and the palette (ctx.getCommandCategories; see its doc for
      // why it is threaded through the context rather than imported here).
      const commands = registry
        .getAll()
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name));
      if (ctx.openSelection) {
        const categoryByName = ctx.getCommandCategories?.() ?? new Map<string, string>();
        const items: SelectionItem[] = commands.map((cmd) => {
          const argsHint = cmd.argsHint ?? cmd.usage;
          const aliases = cmd.aliases ?? [];
          return {
            id: cmd.name,
            label: argsHint ? `/${cmd.name} ${argsHint}` : `/${cmd.name}`,
            detail: aliases.length > 0 ? `${cmd.description} [aka ${aliases.map((a) => `/${a}`).join(', ')}]` : cmd.description,
            category: categoryByName.get(cmd.name) ?? 'Other',
          };
        });
        // every item here is a command, and picking one RUNS it — label
        // the verb "Run" (matching the slash-command palette) instead of the
        // generic "Select" default.
        ctx.openSelection('Help  —  Commands', items, { allowSearch: true, primaryVerbLabel: 'Run' }, (result) => {
          if (!result) return;
          const name = result.item.id;
          void (ctx.executeCommand?.(name, []) ?? registry.execute(name, [], ctx));
        });
        return;
      }
      ctx.print(
        [
          'Commands:',
          ...commands.map((cmd) => {
            const argsHint = cmd.argsHint ?? cmd.usage;
            return `  /${cmd.name}${argsHint ? ` ${argsHint}` : ''} — ${cmd.description}`;
          }),
        ].join('\n'),
      );
    },
  });

  registry.register({
    name: 'clear',
    aliases: ['cls'],
    description: 'Clear the conversation display (keeps LLM context)',
    handler(_args, ctx) {
      ctx.session.conversationManager.clearDisplay();
      ctx.renderRequest();
    },
  });

  registry.register({
    name: 'reset',
    aliases: [],
    description: 'Full reset: clear display and conversation context',
    handler(_args, ctx) {
      ctx.session.conversationManager.resetAll();
      if (ctx.reloadSystemPrompt) {
        ctx.session.runtime.systemPrompt = ctx.reloadSystemPrompt();
      }
      ctx.session.conversationManager.rebuildHistory();
      ctx.renderRequest();
    },
  });

  registry.register({
    name: 'compact',
    aliases: [],
    description: 'Summarize conversation to free context window',
    async handler(_args, ctx) {
      const messages = ctx.session.conversationManager.getMessagesForLLM();
      // contextWindow IS reachable from CommandContext — the same
      // call compactConversation() (runtime-services.ts) already makes to scale
      // its own behaviour by window size. Previously hardcoded to 0 here, which
      // silently suppressed buildCompactionPreview()'s capacity-% clause even
      // though the builder has always supported it.
      const contextWindow = ctx.provider.providerRegistry.getContextWindowForModel(
        ctx.provider.providerRegistry.getCurrentModel(),
      );
      const memStore = ctx.session.sessionMemoryStore;
      const pinnedMemoryCount = memStore ? memStore.list().length : 0;
      // Pre-compact preview: honest estimate, clearly labelled.
      const preview = buildCompactionPreview({ messages, contextWindow, pinnedMemoryCount, trigger: 'manual' });
      ctx.print(preview);
      const result = await compactConversation(ctx);
      if (result) {
        // Post-compact notice: uses real CompactionEvent figures, plus an
        // out-of-band quality-score grade line when one was computed ().
        ctx.print(buildCompactionAfterNotice({ event: result.event, pinnedMemoryCount, qualityScore: result.qualityScore }));
      } else {
        ctx.print('[Context] Compact complete.');
      }
      ctx.renderRequest();
    },
  });

  registry.register({
    name: 'compact-history',
    aliases: ['compaction-history'],
    description: 'Show compaction history for this session',
    handler(_args, ctx) {
      ctx.print(buildCompactionHistoryText());
      ctx.renderRequest();
    },
  });

  registry.register({
    name: 'keep',
    aliases: [],
    description: 'Pin text to session memory (survives compaction)',
    usage: '<text>',
    argsHint: '<text to preserve>',
    handler(args, ctx) {
      const text = args.join(' ').trim();
      if (!text) {
        ctx.print(buildPinUsageText());
        ctx.renderRequest();
        return;
      }
      const memStore = requireSessionMemoryStore(ctx);
      const id = memStore.add(text);
      if (!id) {
        ctx.print('[Pin] Nothing pinned — text was blank.');
      } else {
        const count = memStore.list().length;
        ctx.print(buildPinSuccessText(id, text, count));
      }
      ctx.renderRequest();
    },
  });

  registry.register({
    name: 'quit',
    aliases: [':q'],
    description: 'Exit the application',
    handler(_args, ctx) {
      ctx.exit();
    },
  });

  registry.register({
    name: 'wq',
    aliases: [':wq'],
    description: 'Commit all git changes and then exit',
    async handler(_args, ctx) {
      await executeWriteQuit(ctx);
    },
  });

  registry.register({
    name: 'debug',
    aliases: [],
    description: 'Toggle debug mode',
    handler(_args, ctx) {
      ctx.session.runtime.debugMode = !ctx.session.runtime.debugMode;
      ctx.print(`Debug mode: ${ctx.session.runtime.debugMode ? 'ON' : 'OFF'}`);
      // Honest quiet counter for direct terminal writes the guard intercepted
      // (routed here instead of spamming the transcript). (item 1a.)
      const intercepted = ctx.session.runtime.terminalWritesIntercepted ?? 0;
      if (intercepted > 0) {
        ctx.print(`Terminal writes intercepted this session: ${intercepted} (details in the activity log)`);
      }
    },
  });

  registry.register({
    name: 'effort',
    aliases: ['e'],
    description: 'Show or set reasoning effort level',
    usage: '[level]',
    argsHint: '[instant|low|medium|high]',
    async handler(args, ctx) {
      const currentModel = await requireProviderApi(ctx).getCurrentModel();
      const validLevels = currentModel.reasoningEffort ?? [];

      if (validLevels.length === 0) {
        ctx.print(`Current model (${currentModel.displayName}) does not support configurable reasoning effort.`);
        return;
      }

      if (args.length === 0) {
        const current = (ctx.session.runtime.reasoningEffort || ctx.platform.configManager.get('provider.reasoningEffort') || 'medium') as string;
        if (ctx.openSelection) {
          const descriptions: Record<string, string> = {
            ...EFFORT_DESCRIPTIONS,
            medium: 'Balanced speed and quality (default)',
          };
          const items: SelectionItem[] = validLevels.map((level) => ({
            id: level,
            label: level,
            detail: level === current ? `◉ ${descriptions[level] ?? level}` : (descriptions[level] ?? level),
          }));
          ctx.openSelection('Reasoning Effort', items, { preSelectId: current, allowSearch: false }, (result) => {
            if (!result) return;
            const level = result.item.id as 'instant' | 'low' | 'medium' | 'high';
            ctx.session.runtime.reasoningEffort = level;
            ctx.platform.configManager.set('provider.reasoningEffort', level);
            ctx.print(`Reasoning effort set to: ${level}`);
            ctx.renderRequest();
          });
          return;
        }
        const budget = REASONING_BUDGET_MAP[current];
        const lines = [
          `Reasoning effort: ${current}`,
          `  Mercury-2:  reasoning_effort = '${current}'`,
          `  Claude:     thinking.budget_tokens = ${budget}`,
          `  Gemini:     thinking_config.thinking_budget = ${budget}`,
          `  GPT-5:      (no-op)`,
          '',
          `Levels: ${validLevels.join(', ')}`,
        ];
        ctx.print(lines.join('\n'));
        return;
      }

      const level = args[0] as 'instant' | 'low' | 'medium' | 'high';
      if (!validLevels.includes(level)) {
        ctx.print(`Invalid effort level: ${level}\nValid levels: ${validLevels.join(', ')}`);
        return;
      }

      ctx.session.runtime.reasoningEffort = level;
      ctx.platform.configManager.set('provider.reasoningEffort', level);
      ctx.print(`Reasoning effort set to: ${level}`);
    },
  });

}
