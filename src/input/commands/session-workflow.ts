import { randomBytes } from 'node:crypto';

import type { CommandRegistry } from '../command-registry.ts';
import { getSessionManager } from '../../sessions/manager.ts';

function printSessionExport(
  ctx: { print: (text: string) => void },
  sessionId: string,
  title: string,
  messages: Array<Record<string, unknown>>,
  format: string,
): void {
  const lines: string[] = [];
  if (format === 'markdown') {
    lines.push(`# Session: ${title || sessionId}`);
    lines.push('');
    for (const msg of messages) {
      const role = String(msg.role ?? 'unknown');
      const content = String(msg.content ?? '');
      if (!content.trim()) continue;
      if (role === 'user') {
        lines.push('## User');
        lines.push('');
        lines.push(content);
        lines.push('');
      } else if (role === 'assistant') {
        lines.push('## Assistant');
        lines.push('');
        lines.push(content);
        lines.push('');
      } else if (role === 'tool') {
        const toolName = String(msg.toolName ?? 'tool');
        lines.push(`## Tool Result: ${toolName}`);
        lines.push('');
        lines.push('```');
        lines.push(content.slice(0, 2000) + (content.length > 2000 ? '\n...(truncated)' : ''));
        lines.push('```');
        lines.push('');
      }
    }
  } else {
    for (const msg of messages) {
      const role = String(msg.role ?? 'unknown').toUpperCase();
      const content = String(msg.content ?? '');
      if (!content.trim()) continue;
      lines.push(`[${role}]`);
      lines.push(content);
      lines.push('');
    }
  }
  ctx.print(lines.join('\n'));
}

export function registerSessionWorkflowCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'session',
    aliases: ['sess'],
    description: 'Manage sessions: list, rename, resume, fork, save, info, export, search, delete',
    usage: '[list | rename <name> | resume <id|name> | fork | save | info <id> | export <id> [format] | search <query> | delete <id>]',
    argsHint: '<list|rename|resume|fork|save|info|export|search|delete>',
    async handler(args, ctx) {
      const sm = getSessionManager();
      const sub = args[0];

      if (!sub) {
        const id = ctx.runtime.sessionId;
        const msgCount = ctx.conversationManager.getMessageCount();
        const title = ctx.conversationManager.title || '(untitled)';
        const meta = sm.getMeta(id);
        const started = meta ? new Date(meta.timestamp).toLocaleString() : 'this session';
        ctx.print([
          'Current session',
          `  ID:       ${id}`,
          `  Name:     ${title}`,
          `  Started:  ${started}`,
          `  Messages: ${msgCount}`,
          `  Model:    ${ctx.runtime.model} (${ctx.runtime.provider})`,
        ].join('\n'));
        return;
      }

      if (sub === 'list') {
        const sessions = sm.list();
        if (sessions.length === 0) {
          ctx.print('No saved sessions. Use /session save [name] to save the current session.');
          return;
        }
        const lines = ['Sessions (most recent first):', ''];
        for (const session of sessions) {
          const date = new Date(session.timestamp).toLocaleString();
          const name = session.title || session.name;
          const model = session.model ? ` [${session.model}]` : '';
          const active = session.name === ctx.runtime.sessionId ? ' *' : '  ';
          lines.push(`${active} ${session.name.padEnd(28)} ${name.slice(0, 22).padEnd(22)} ${date}  ${session.messageCount} msgs${model}`);
        }
        ctx.print(lines.join('\n'));
        return;
      }

      if (sub === 'rename') {
        const newName = args.slice(1).join(' ').trim();
        if (!newName) {
          ctx.print('Usage: /session rename <new-name>');
          return;
        }
        try {
          const existingMeta = sm.getMeta(ctx.runtime.sessionId);
          if (!existingMeta) {
            const exportData = ctx.conversationManager.toJSON() as { messages: object[]; timestamp?: number };
            sm.save(ctx.runtime.sessionId, exportData.messages ?? [], {
              title: ctx.conversationManager.title || '',
              model: ctx.runtime.model,
              provider: ctx.runtime.provider,
              timestamp: Date.now(),
            });
          }
          sm.rename(ctx.runtime.sessionId, newName);
          ctx.conversationManager.title = newName;
          ctx.print(`Session renamed to: ${newName}`);
          ctx.renderRequest();
        } catch (e) {
          ctx.print(`Failed to rename: ${(e as Error).message}`);
        }
        return;
      }

      if (sub === 'resume') {
        const target = args.slice(1).join(' ').trim();
        if (!target) {
          ctx.print('Usage: /session resume <session-id-or-name>');
          return;
        }
        const sessions = sm.list();
        const found = sessions.find((session) =>
          session.name === target ||
          session.name.startsWith(target) ||
          session.title.toLowerCase() === target.toLowerCase(),
        );
        if (!found) {
          ctx.print(`Session not found: ${target}\nUse /session list to see available sessions.`);
          return;
        }
        try {
          const { meta, messages } = sm.load(found.name);
          ctx.conversationManager.resetAll();
          ctx.conversationManager.fromJSON({ messages: messages as never[] });
          if (meta.title) ctx.conversationManager.title = meta.title;
          ctx.conversationManager.rebuildHistory();
          ctx.runtime.sessionId = found.name;
          if (meta.model) {
            ctx.runtime.model = meta.model;
            try {
              ctx.providerRegistry.setCurrentModel(meta.model);
            } catch {
              // model may not exist locally
            }
          }
          if (meta.provider) ctx.runtime.provider = meta.provider;
          ctx.renderRequest();
          ctx.print(`Resumed session: ${found.name}\n  Name: ${meta.title || '(untitled)'}\n  Messages: ${messages.length}\n  Model: ${meta.model || ctx.runtime.model}`);
        } catch (e) {
          ctx.print(`Failed to resume session: ${(e as Error).message}`);
        }
        return;
      }

      if (sub === 'fork') {
        const newId = `user-${randomBytes(4).toString('hex')}`;
        const exportData = ctx.conversationManager.toJSON() as { messages: object[]; timestamp?: number };
        const messages = exportData.messages ?? [];
        const currentTitle = ctx.conversationManager.title;
        const forkName = args[1] ? args.slice(1).join(' ').trim() : `fork-of-${ctx.runtime.sessionId.slice(0, 8)}`;
        const meta = {
          title: forkName,
          model: ctx.runtime.model,
          provider: ctx.runtime.provider,
          timestamp: Date.now(),
        };
        try {
          sm.save(newId, messages, meta);
          ctx.runtime.sessionId = newId;
          ctx.conversationManager.title = forkName;
          ctx.renderRequest();
          ctx.print(`Session forked:\n  New ID: ${newId}\n  Name:   ${forkName}\n  From:   ${currentTitle || ctx.runtime.sessionId}\n  Messages: ${messages.length}`);
        } catch (e) {
          ctx.print(`Failed to fork session: ${(e as Error).message}`);
        }
        return;
      }

      if (sub === 'save') {
        const exportData = ctx.conversationManager.toJSON() as { messages: object[]; timestamp?: number };
        const messages = exportData.messages ?? [];
        const rawName = args[1] ? args.slice(1).join(' ').trim() : (ctx.conversationManager.title || ctx.runtime.sessionId);
        const meta = {
          title: ctx.conversationManager.title,
          model: ctx.runtime.model,
          provider: ctx.runtime.provider,
          timestamp: Date.now(),
        };
        try {
          const { filePath, sanitizedName } = sm.save(rawName, messages, meta);
          ctx.runtime.sessionId = sanitizedName;
          const nameNote = sanitizedName !== rawName ? ` (saved as "${sanitizedName}")` : '';
          ctx.print(`Session saved: ${rawName}${nameNote}\n  → ${filePath}`);
        } catch (e) {
          ctx.print(`Failed to save session: ${(e as Error).message}`);
        }
        return;
      }

      if (sub === 'info') {
        const target = args[1] || ctx.runtime.sessionId;
        const sessions = sm.list();
        const found = sessions.find((session) => session.name === target || session.name.startsWith(target));
        if (!found) {
          ctx.print(`Session not found: ${target}`);
          return;
        }
        const date = new Date(found.timestamp).toLocaleString();
        ctx.print([
          `Session: ${found.name}`,
          `  Title:    ${found.title || '(untitled)'}`,
          `  Model:    ${found.model || '(unknown)'}`,
          `  Provider: ${found.provider || '(unknown)'}`,
          `  Date:     ${date}`,
          `  Messages: ${found.messageCount}`,
          `  File:     ${found.filePath}`,
        ].join('\n'));
        return;
      }

      if (sub === 'export') {
        const target = args[1];
        if (!target) {
          ctx.print('Usage: /session export <session-id> [markdown|text]\nUse /session export . to export the current session.');
          return;
        }
        const format = (args[2] || 'markdown').toLowerCase();
        const sessionId = target === '.' ? ctx.runtime.sessionId : target;
        const sessions = sm.list();
        const found = sessions.find((session) => session.name === sessionId || session.name.startsWith(sessionId));
        if (!found && target !== '.') {
          try {
            const { meta, messages } = sm.load(sessionId);
            printSessionExport(ctx, sessionId, meta.title, messages as Array<Record<string, unknown>>, format);
          } catch {
            ctx.print(`Session not found: ${sessionId}`);
          }
          return;
        }
        const loadName = found ? found.name : sessionId;
        try {
          const { meta, messages } = sm.load(loadName);
          printSessionExport(ctx, loadName, meta.title, messages as Array<Record<string, unknown>>, format);
        } catch (e) {
          ctx.print(`Failed to export session: ${(e as Error).message}`);
        }
        return;
      }

      if (sub === 'search') {
        const query = args.slice(1).join(' ').trim();
        if (!query) {
          ctx.print('Usage: /session search <keyword>');
          return;
        }
        const results = sm.search(query);
        if (results.length === 0) {
          ctx.print(`No sessions found matching: "${query}"`);
          return;
        }
        const lines = [`Search results for "${query}" (${results.length} session${results.length !== 1 ? 's' : ''}):\n`];
        for (const result of results) {
          const date = new Date(result.session.timestamp).toLocaleString();
          lines.push(`  ${result.session.name}  ${result.session.title || '(untitled)'}  ${date}  (${result.matchCount} match${result.matchCount !== 1 ? 'es' : ''})`);
          for (const snippet of result.snippets) {
            lines.push(`    > ${snippet}`);
          }
          lines.push('');
        }
        ctx.print(lines.join('\n'));
        return;
      }

      if (sub === 'delete') {
        const target = args[1];
        if (!target) {
          ctx.print('Usage: /session delete <session-id>');
          return;
        }
        const sessions = sm.list();
        const found = sessions.find((session) => session.name === target || session.name.startsWith(target));
        if (!found) {
          ctx.print(`Session not found: ${target}`);
          return;
        }
        if (found.name === ctx.runtime.sessionId) {
          ctx.print(`Cannot delete the active session (${found.name}).\nSwitch to another session first with /session resume <id>.`);
          return;
        }
        try {
          sm.delete(found.name);
          ctx.print(`Session deleted: ${found.name}${found.title ? ` (${found.title})` : ''}`);
        } catch (e) {
          ctx.print(`Failed to delete session: ${(e as Error).message}`);
        }
        return;
      }

      ctx.print('Unknown subcommand: ' + sub + '\nUsage: /session [list | rename <name> | resume <id> | fork [name] | save [name] | info [id] | export <id> [format] | search <query> | delete <id>]');
    },
  });

}
