import { join, resolve } from 'path';
import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import type { CommandRegistry } from '../command-registry.ts';
import type { SelectionItem } from '../selection-modal.ts';
import { exportToMarkdown } from '@pellux/goodvibes-sdk/platform/export/markdown';
import { TemplateManager, parseTemplateArgs } from '../../templates/manager.ts';
import { requireSessionManager, requireSessionMemoryStore, requireShellPaths } from './runtime-services.ts';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils/error-display';

export function registerSessionContentCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'export',
    description: 'Export conversation to a Markdown file',
    usage: '[format] [path]',
    argsHint: '[markdown] [path]',
    async handler(args, ctx) {
      const shellPaths = requireShellPaths(ctx);
      let format = 'markdown';
      let outPath: string | undefined;
      for (const arg of args) {
        if (arg === 'markdown' || arg === 'md' || arg === 'text' || arg === 'txt') {
          format = arg === 'md' ? 'markdown' : arg === 'txt' ? 'text' : arg;
        } else {
          outPath = arg;
        }
      }
      if (!outPath) {
        const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        outPath = `./conversation-${ts}.${format === 'markdown' ? 'md' : 'txt'}`;
      }
      const resolvedPath = shellPaths.resolveWorkspacePath(outPath);
      if (!shellPaths.isWithinWorkingDirectory(resolvedPath)) {
        ctx.print('Error: Export path must be within the current directory.');
        return;
      }

      try {
        const data = ctx.session.conversationManager.toJSON() as { messages: Array<Record<string, unknown>> };
        const msgs = data.messages ?? [];
        let fileContent: string;
        if (format === 'markdown') {
          const exportMsgs = msgs.map(m => ({
            role: String(m.role ?? 'user') as 'user' | 'assistant' | 'system' | 'tool',
            content: Array.isArray(m.content)
              ? m.content as import('../../providers/interface.ts').ContentPart[]
              : String(m.content ?? ''),
            toolCalls: m.toolCalls as import('@pellux/goodvibes-sdk/platform/types/tools').ToolCall[] | undefined,
            callId: m.callId as string | undefined,
            toolName: m.toolName as string | undefined,
            reasoningContent: m.reasoningContent as string | undefined,
            reasoningSummary: m.reasoningSummary as string | undefined,
            usage: m.usage as { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number } | undefined,
          }));
          fileContent = exportToMarkdown(exportMsgs, {
            model: ctx.session.runtime.model,
            provider: ctx.session.runtime.provider,
            sessionId: ctx.session.runtime.sessionId,
            title: ctx.session.conversationManager.title || undefined,
          });
        } else {
          const lines: string[] = [];
          for (const m of msgs) {
            const role = String(m.role ?? 'unknown').toUpperCase();
            const content = typeof m.content === 'string' ? m.content : '';
            if (!content.trim()) continue;
            lines.push(`[${role}]`);
            lines.push(content);
            lines.push('');
          }
          fileContent = lines.join('\n');
        }
        const { dirname } = await import('node:path');
        const dir = dirname(resolvedPath);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        await writeFile(resolvedPath, fileContent, 'utf-8');
        ctx.print(`Exported ${msgs.length} messages to: ${resolvedPath}`);
      } catch (err) {
        ctx.print(`Export failed: ${summarizeError(err)}`);
      }
    },
  });

  registry.register({
    name: 'title',
    description: 'Show or set the conversation title',
    usage: '[text]',
    argsHint: '[text]',
    handler(args, ctx) {
      if (args.length === 0) ctx.print(ctx.session.conversationManager.title ? `Conversation title: ${ctx.session.conversationManager.title}` : 'No title set.');
      else {
        ctx.session.conversationManager.title = args.join(' ');
        ctx.print(`Title set to: ${ctx.session.conversationManager.title}`);
        ctx.renderRequest();
      }
    },
  });

  registry.register({
    name: 'save',
    description: 'Save current session to .goodvibes/tui/sessions/',
    usage: '[name]',
    argsHint: '[name]',
    handler(args, ctx) {
      const sessionManager = requireSessionManager(ctx);
      const rawName = args[0] || ctx.session.conversationManager.title || `session-${Date.now()}`;
      const exportData = ctx.session.conversationManager.toJSON() as { messages: object[] };
      const messages = exportData.messages ?? [];
      const meta = {
        title: ctx.session.conversationManager.title,
        model: ctx.session.runtime.model,
        provider: ctx.session.runtime.provider,
        timestamp: Date.now(),
      };
      try {
        const agentManager = ctx.ops.agentManager;
        if (!agentManager) {
          ctx.print('Agent manager is not available in this runtime.');
          return;
        }
        const agentRecords = agentManager.exportState();
        const { filePath, sanitizedName } = sessionManager.save(rawName, messages, meta, agentRecords);
        ctx.print(`Session saved: ${rawName}${sanitizedName !== rawName ? ` (saved as "${sanitizedName}")` : ''}${agentRecords.length > 0 ? ` [${agentRecords.length} agent records]` : ''}\n  → ${filePath}`);
      } catch (e) {
        ctx.print(`Failed to save session: ${summarizeError(e)}`);
      }
    },
  });

  registry.register({
    name: 'load',
    description: 'Load a saved session',
    usage: '<name>',
    argsHint: '<name>',
    handler(args, ctx) {
      if (!args[0]) {
        ctx.print('Usage: /load <session-name>\nRun /sessions to list available sessions.');
        return;
      }
      const sessionManager = requireSessionManager(ctx);
      try {
        const { meta, messages, agentRecords } = sessionManager.load(args[0]);
        const agentManager = ctx.ops.agentManager;
        if (!agentManager) {
          ctx.print('Agent manager is not available in this runtime.');
          return;
        }
        ctx.session.conversationManager.resetAll();
        ctx.session.conversationManager.fromJSON({ messages: messages as never[] });
        if (meta.title) ctx.session.conversationManager.title = meta.title;
        ctx.session.conversationManager.rebuildHistory();
        agentManager.clear();
        if (agentRecords.length > 0) agentManager.importState(agentRecords);
        ctx.renderRequest();
        ctx.print(`Session loaded: ${args[0]} (${messages.length} messages)${agentRecords.length > 0 ? ` [${agentRecords.length} agent records restored]` : ''}`);
      } catch (e) {
        ctx.print(`Failed to load session: ${summarizeError(e)}`);
      }
    },
  });

  registry.register({
    name: 'undo',
    aliases: ['u'],
    description: 'Undo last action. /undo file — revert last file write/edit. /undo — remove last conversation turn.',
    usage: '[file]',
    argsHint: '[file]',
    handler(args, ctx) {
      if (args[0] === 'file') {
        if (!ctx.workspace.fileUndoManager) {
          ctx.print('File undo not available.');
          return;
        }
        try {
          const result = ctx.workspace.fileUndoManager.undo();
          ctx.print(result ? `File reverted: ${result.path} (${result.tool} tool). Use /redo file to re-apply.` : 'Nothing to undo. No file operations recorded.');
        } catch (err) {
          ctx.print(`File undo failed: ${summarizeError(err)}`);
        }
        return;
      }
      const success = ctx.session.conversationManager.undo();
      if (success) {
        ctx.print('Last turn undone. Use /redo to restore. Tip: /undo file to revert a file write/edit.');
        ctx.renderRequest();
      } else {
        ctx.print('Nothing to undo. Tip: use /undo file to revert the last file write/edit.');
      }
    },
  });

  registry.register({
    name: 'redo',
    description: 'Redo last undone action. /redo file — re-apply last reverted file. /redo — restore conversation turn.',
    usage: '[file]',
    argsHint: '[file]',
    handler(args, ctx) {
      if (args[0] === 'file') {
        if (!ctx.workspace.fileUndoManager) {
          ctx.print('File redo not available.');
          return;
        }
        try {
          const result = ctx.workspace.fileUndoManager.redo();
          ctx.print(result ? `File re-applied: ${result.path} (${result.tool} tool).` : 'Nothing to redo.');
        } catch (err) {
          ctx.print(`File redo failed: ${summarizeError(err)}`);
        }
        return;
      }
      const success = ctx.session.conversationManager.redo();
      if (success) {
        ctx.print('Turn restored. Tip: /redo file to re-apply a reverted file.');
        ctx.renderRequest();
      } else {
        ctx.print('Nothing to redo. Tip: use /redo file to re-apply the last reverted file.');
      }
    },
  });

  registry.register({
    name: 'retry',
    aliases: ['r'],
    description: 'Re-send the last user message',
    usage: '[modified text]',
    argsHint: '[modified text]',
    handler(args, ctx) {
      const lastMsg = ctx.session.conversationManager.getLastUserMessage();
      if (!lastMsg) {
        ctx.print('No message to retry.');
        return;
      }
      ctx.session.conversationManager.undo();
      ctx.submitInput?.(args.length > 0 ? args.join(' ') : lastMsg);
    },
  });

  registry.register({
    name: 'sessions',
    description: 'List saved sessions',
    async handler(_args, ctx) {
      const sessionManager = requireSessionManager(ctx);
      const sessions = sessionManager.list();
      if (ctx.openSelection) {
        const deleteAction = new Map([['d', 'delete' as const]]);
        const items: SelectionItem[] = sessions.length === 0
          ? [{ id: '_empty', label: 'No saved sessions', detail: 'Use /save [name] to save' }]
          : sessions.map(s => ({ id: s.name, label: s.name, detail: s.title || '(untitled)', actions: '[d] delete' }));
        ctx.openSelection('Sessions', items, { allowSearch: true, customActions: deleteAction }, (result) => {
          if (!result) return;
          if (result.action === 'delete') {
            try {
              const sessionInfo = sessions.find(s => s.name === result.item.id);
              if (sessionInfo) {
                unlinkSync(sessionInfo.filePath);
                ctx.print(`Session deleted: ${result.item.id}`);
              }
            } catch (e) {
              ctx.print(`Failed to delete session: ${summarizeError(e)}`);
            }
          } else {
            try {
              const { meta, messages } = sessionManager.load(result.item.id);
              ctx.session.conversationManager.resetAll();
              ctx.session.conversationManager.fromJSON({ messages: messages as never[] });
              if (meta.title) ctx.session.conversationManager.title = meta.title;
              ctx.session.conversationManager.rebuildHistory();
              ctx.renderRequest();
              ctx.print(`Session loaded: ${result.item.id} (${messages.length} messages)`);
            } catch (e) {
              ctx.print(`Failed to load session: ${summarizeError(e)}`);
            }
          }
        });
        return;
      }
      const lines = ['Saved sessions:', ''];
      for (const s of sessions) lines.push(`  ${s.name.padEnd(30)} ${(s.title || '(untitled)').padEnd(24)} ${new Date(s.timestamp).toLocaleString()}  (${s.messageCount} msgs)`);
      ctx.print(lines.join('\n'));
    },
  });

  registry.register({
    name: 'template',
    aliases: ['tmpl'],
    description: 'Manage and use prompt templates',
    usage: 'save <name> | use <name> [args] | list | edit <name> | delete <name>',
    argsHint: '<save|use|list|edit|delete> [name]',
    handler(args, ctx) {
      const shellPaths = requireShellPaths(ctx);
      const templateManager = new TemplateManager({
        projectRoot: shellPaths.workingDirectory,
        homeDirectory: shellPaths.homeDirectory,
      });
      const sub = args[0];
      const rest = args.slice(1);
      if (!sub || sub === 'list') {
        const templates = templateManager.list();
        if (ctx.openSelection) {
          const actions = new Map([['d', 'delete' as const], ['e', 'edit' as const]]);
          const items: SelectionItem[] = templates.length === 0
            ? [{ id: '_empty', label: 'No templates saved', detail: 'Use /template save <name>' }]
            : templates.map(t => ({ id: t.name, label: t.name, detail: t.preview, category: t.scope === 'project' ? 'project' : 'global', actions: '[d] delete  [e] edit' }));
          ctx.openSelection('Templates', items, { allowSearch: true, customActions: actions }, (result) => {
            if (!result) return;
            if (result.action === 'delete') {
              const deleted = templateManager.delete(result.item.id);
              ctx.print(deleted ? `Template deleted: ${result.item.id}` : `Template not found: ${result.item.id}`);
            } else {
              const content = templateManager.load(result.item.id);
              if (content !== null) {
                if (result.action === 'edit') ctx.print(`Template: ${result.item.id}\n\n${content}`);
                else ctx.submitInput?.(content);
              } else {
                ctx.print(`Template not found: ${result.item.id}`);
              }
            }
          });
          return;
        }
        ctx.print(['Templates:', '', ...templates.map(t => `  ${t.scope === 'project' ? '[project]' : '[global] '} ${t.name.padEnd(28)} ${t.preview}`)].join('\n'));
        return;
      }
      if (sub === 'save') {
        const name = rest[0];
        if (!name) {
          ctx.print('Usage: /template save <name>');
          return;
        }
        try {
          templateManager.save(name, ctx.session.conversationManager.getLastUserMessage() || '# Template\n\nReplace this with your template content.\n');
          ctx.print(`Template saved: ${name}`);
        } catch (e) {
          ctx.print(`Failed to save template: ${summarizeError(e)}`);
        }
        return;
      }
      if (sub === 'use') {
        const name = rest[0];
        if (!name) {
          ctx.print('Usage: /template use <name> [args...]');
          return;
        }
        const templateContent = templateManager.load(name);
        if (templateContent === null) {
          ctx.print(`Template not found: ${name}\nRun /template list to see available templates.`);
          return;
        }
        ctx.submitInput?.(templateManager.expand(templateContent, parseTemplateArgs(rest.slice(1))));
        return;
      }
      if (sub === 'edit') {
        const name = rest[0];
        if (!name) {
          ctx.print('Usage: /template edit <name>');
          return;
        }
        const content = templateManager.load(name);
        ctx.print(content === null ? `Template not found: ${name}` : `Template: ${name}\n\n${content}`);
        return;
      }
      if (sub === 'delete') {
        const name = rest[0];
        if (!name) {
          ctx.print('Usage: /template delete <name>');
          return;
        }
        ctx.print(templateManager.delete(name) ? `Template deleted: ${name}` : `Template not found: ${name}`);
        return;
      }
      ctx.print(`Unknown subcommand: ${sub}\nUsage: /template save|use|list|edit|delete`);
    },
  });

  registry.register({
    name: 'memory',
    description: 'Manage session memories (pinned across context compaction)',
    usage: '[list|add <text>|remove <id>]',
    argsHint: '[list|add|remove]',
    handler(args, ctx) {
      const sub = args[0] ?? 'list';
      if (sub === 'list' || args.length === 0) {
        const memories = requireSessionMemoryStore(ctx).list();
        ctx.print(memories.length === 0
          ? 'No session memories. Use !# prefix or /memory add <text> to create one.'
          : [`Session Memories (${memories.length}):`, ...memories.map(m => `  [${m.id}] ${m.text}`)].join('\n'));
      } else if (sub === 'add') {
        const text = args.slice(1).join(' ').trim();
        if (!text) {
          ctx.print('Usage: /memory add <text>');
          return;
        }
        const id = requireSessionMemoryStore(ctx).add(text);
        ctx.print(`Memory added: [${id}] ${text}`);
      } else if (sub === 'remove') {
        const id = args[1];
        if (!id) {
          ctx.print('Usage: /memory remove <id>');
          return;
        }
        const store = requireSessionMemoryStore(ctx);
        ctx.print(store.remove(id) ? `Memory removed: [${id}]` : `Memory not found: ${id}`);
      } else {
        ctx.print('Usage: /memory [list|add <text>|remove <id>]\n  /memory              — list all session memories\n  /memory list         — list all session memories\n  /memory add <text>   — add a memory without sending a message\n  /memory remove <id>  — remove a specific memory');
      }
    },
  });
}
