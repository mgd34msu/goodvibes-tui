import { randomBytes } from 'node:crypto';

import type { CommandContext } from '../command-registry.ts';
import { type SessionMeta } from '@pellux/goodvibes-sdk/platform/sessions';
import type { TranscriptEventKind } from '@pellux/goodvibes-sdk/platform/core';
import type { ConversationTitleSource } from '../../core/conversation';
import type { SessionReturnContextSummary } from '@/runtime/index.ts';
import { formatReturnContextForDisplay, getReturnContextMode, maybeAssistReturnContextSummary } from '@/runtime/index.ts';
import { requirePanelManager, requireProviderApi, requireSessionManager, requireShellPaths } from './runtime-services.ts';
import { replayJournalForSession } from '../../core/session-recovery.ts';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils';

function parseTranscriptKind(raw: string | undefined): TranscriptEventKind | 'all' {
  const normalized = (raw ?? 'all').toLowerCase().replace(/-/g, '_');
  const allowed = new Set<TranscriptEventKind | 'all'>([
    'all',
    'user_input',
    'assistant_output',
    'tool_call',
    'tool_result',
    'approval_request',
    'approval_resolution',
    'task_transition',
    'remote_status',
    'policy_warning',
    'artifact_preview',
    'review_state',
    'session_restore',
    'diagnostic_notice',
    'system_notice',
  ]);
  return allowed.has(normalized as TranscriptEventKind | 'all') ? (normalized as TranscriptEventKind | 'all') : 'all';
}

function buildTranscriptReviewLines(
  ctx: CommandContext,
  kind: TranscriptEventKind | 'all',
  mode: 'events' | 'groups' | 'hotspots',
): string[] {
  const index = ctx.session.conversationManager.getTranscriptEventIndex();
  const events = kind === 'all' ? index.events : index.events.filter((event) => event.kind === kind);
  const groups = kind === 'all' ? index.groups : index.groups.filter((group) => group.kind === kind);

  if (mode === 'groups') {
    return [
      `Transcript Groups${kind === 'all' ? '' : `: ${kind}`}`,
      `  groups: ${groups.length}`,
      ...groups.slice(0, 12).map((group) => (
        `  ${group.kind.padEnd(20)} ${String(group.events.length).padStart(2)} event(s)  msgs=${group.messageIndexes[0]}-${group.messageIndexes[group.messageIndexes.length - 1]}  ${group.title}`
      )),
      ...(groups.length > 12 ? [`  … ${groups.length - 12} more group(s)`] : []),
    ];
  }

  if (mode === 'hotspots') {
    const kindCounts = new Map<TranscriptEventKind, number>();
    for (const event of index.events) {
      kindCounts.set(event.kind, (kindCounts.get(event.kind) ?? 0) + 1);
    }
    const busiestGroups = [...index.groups]
      .sort((a, b) => b.events.length - a.events.length || a.messageIndexes[0]! - b.messageIndexes[0]!)
      .slice(0, 8);
    return [
      'Transcript Hotspots',
      ...[...kindCounts.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([eventKind, count]) => `  ${eventKind.padEnd(20)} ${count}`),
      '',
      'Busiest groups',
      ...busiestGroups.map((group) => `  ${group.kind.padEnd(20)} ${String(group.events.length).padStart(2)}  ${group.title}`),
    ];
  }

  return [
    `Transcript Events${kind === 'all' ? '' : `: ${kind}`}`,
    `  events: ${events.length}`,
    ...events.slice(0, 16).map((event) => `  #${String(event.messageIndex).padStart(3)}  ${event.kind.padEnd(20)} ${event.title} — ${event.detail}`),
    ...(events.length > 16 ? [`  … ${events.length - 16} more event(s)`] : []),
  ];
}

function reopenPanelsFromReturnContext(ctx: CommandContext, summary: SessionReturnContextSummary | undefined): string[] {
  if (!summary?.openPanels || summary.openPanels.length === 0) return [];
  const panelManager = requirePanelManager(ctx);
  const reopened: string[] = [];
  const movedToModal: string[] = [];
  for (const panelId of summary.openPanels.slice(0, 4)) {
    // W6.1 (the purge): a MIGRATE-TO-MODAL id has no panel to restore — a modal
    // is not part of the saved panel layout. Skip it (don't pop a modal
    // mid-resume) and note it once, rather than firing openModal + revealing an
    // empty workspace during resume.
    if (panelManager.getModalRedirect(panelId) !== undefined) {
      movedToModal.push(panelId);
      continue;
    }
    try {
      panelManager.open(panelId);
      reopened.push(panelId);
    } catch {
      // Ignore unknown or currently unavailable panel ids during resume.
    }
  }
  if (reopened.length > 0) panelManager.show();
  if (movedToModal.length > 0) {
    ctx.print(`Note: ${movedToModal.join(', ')} moved to a modal — reopen via its command instead of as a panel.`);
  }
  return reopened;
}

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

export async function handleSessionWorkflowCommand(args: string[], ctx: CommandContext): Promise<boolean> {
  const sm = requireSessionManager(ctx);
  const sub = args[0];

  if (!sub) {
    const id = ctx.session.runtime.sessionId;
    const msgCount = ctx.session.conversationManager.getMessageCount();
    const title = ctx.session.conversationManager.title || '(untitled)';
    const meta = sm.getMeta(id);
    const started = meta ? new Date(meta.timestamp).toLocaleString() : 'this session';
    ctx.print([
      'Current session',
      `  ID:       ${id}`,
      `  Name:     ${title}`,
      `  Started:  ${started}`,
      `  Messages: ${msgCount}`,
      `  Model:    ${ctx.session.runtime.model} (${ctx.session.runtime.provider})`,
    ].join('\n'));
    return true;
  }

  if (sub === 'list') {
    const sessions = sm.list();
    if (sessions.length === 0) {
      ctx.print('No saved sessions. Use /session save [name] to save the current session.');
      return true;
    }
    const lines = ['Sessions (most recent first):', ''];
    for (const session of sessions) {
      const date = new Date(session.timestamp).toLocaleString();
      const name = session.title || session.name;
      const model = session.model ? ` [${session.model}]` : '';
      const active = session.name === ctx.session.runtime.sessionId ? ' ●' : '  ';
      lines.push(`${active} ${session.name.padEnd(28)} ${name.slice(0, 22).padEnd(22)} ${date}  ${session.messageCount} msgs${model}`);
      if (session.returnContext?.activeTasks || session.returnContext?.blockedTasks || session.returnContext?.pendingApprovals || session.returnContext?.openPanels?.length) {
        const posture = [
          session.returnContext.activeTasks ? `active=${session.returnContext.activeTasks}` : null,
          session.returnContext.blockedTasks ? `blocked=${session.returnContext.blockedTasks}` : null,
          session.returnContext.pendingApprovals ? `approvals=${session.returnContext.pendingApprovals}` : null,
          session.returnContext.openPanels?.length ? `panels=${session.returnContext.openPanels.slice(0, 3).join(',')}` : null,
        ].filter(Boolean).join('  ');
        if (posture) lines.push(`     posture: ${posture}`);
      }
    }
    ctx.print(lines.join('\n'));
    return true;
  }

  if (sub === 'rename') {
    const newName = args.slice(1).join(' ').trim();
    if (!newName) {
      ctx.print('Usage: /session rename <new-name>');
      return true;
    }
    try {
      const existingMeta = sm.getMeta(ctx.session.runtime.sessionId);
      if (!existingMeta) {
        const exportData = ctx.session.conversationManager.toJSON() as { messages: object[]; timestamp?: number };
        sm.save(ctx.session.runtime.sessionId, exportData.messages ?? [], {
          title: ctx.session.conversationManager.title || '',
          model: ctx.session.runtime.model,
          provider: ctx.session.runtime.provider,
          timestamp: Date.now(),
        });
      }
      sm.rename(ctx.session.runtime.sessionId, newName);
      ctx.session.conversationManager.title = newName;
      ctx.print(`Session renamed to: ${newName}`);
      ctx.renderRequest();
    } catch (e) {
      ctx.print(`Failed to rename: ${summarizeError(e)}`);
    }
    return true;
  }

  if (sub === 'resume') {
    const target = args.slice(1).join(' ').trim();
    if (!target) {
      ctx.print('Usage: /session resume <session-id-or-name>');
      return true;
    }
    const sessions = sm.list();
    const found = sessions.find((session) =>
      session.name === target ||
      session.name.startsWith(target) ||
      session.title.toLowerCase() === target.toLowerCase(),
    );
    if (!found) {
      ctx.print(`Session not found: ${target}\nUse /session list to see available sessions.`);
      return true;
    }
    try {
      const { meta, messages } = sm.load(found.name);
      const providerApi = requireProviderApi(ctx);
      ctx.session.conversationManager.resetAll();
      ctx.session.conversationManager.fromJSON({ messages: messages as never[], title: meta.title, titleSource: meta.titleSource });
      ctx.session.conversationManager.rebuildHistory();
      ctx.session.runtime.sessionId = found.name;

      // Journal replay: recover turns that post-date the loaded snapshot.
      const shellPaths = requireShellPaths(ctx);
      const journalReplay = replayJournalForSession({
        homeDirectory: shellPaths.homeDirectory,
        snapshotTimestamp: meta.timestamp,
        conversation: ctx.session.conversationManager,
        sessionId: found.name,
        persistSnapshot: (replayedMessages) => {
          sm.save(found.name, replayedMessages as never[], {
            title: ctx.session.conversationManager.title || meta.title,
            model: meta.model,
            provider: meta.provider,
            timestamp: Date.now(),
            titleSource: meta.titleSource,
            returnContext: meta.returnContext,
          });
        },
      });
      // Hydrate the footer's token counters from the resumed (+ journal-replayed)
      // history now, before ctx.renderRequest() below (W0.9).
      ctx.session.hydrateSessionUsage?.();

      if (meta.model) {
        try {
          const selected = await providerApi.selectModel(meta.model);
          ctx.session.runtime.model = selected.registryKey;
          ctx.session.runtime.provider = selected.providerId;
        } catch {
          ctx.session.runtime.model = meta.model;
          // model may not exist locally
        }
      }
      if (meta.provider) ctx.session.runtime.provider = meta.provider;
      ctx.renderRequest();
      const resumedMsgCount = ctx.session.conversationManager.getMessageCount();
      ctx.print(`Resumed session: ${found.name}\n  Name: ${meta.title || '(untitled)'}\n  Messages: ${resumedMsgCount}\n  Model: ${meta.model || ctx.session.runtime.model}`);
      if (journalReplay.replayed > 0) {
        ctx.print(`  [Recovery] Replayed ${journalReplay.replayed} journal record(s) — restored turns since last snapshot.`);
      }
      if (journalReplay.hadCorruptTail && journalReplay.replayed === 0) {
        ctx.print('  [Recovery] Journal tail was corrupt or unrecognised (quarantined). Proceeding with snapshot only.');
      } else if (journalReplay.hadCorruptTail) {
        ctx.print('  [Recovery] Journal tail was partially corrupt (quarantined). Replay stopped at last good record.');
      }
      const reopenedPanels = reopenPanelsFromReturnContext(ctx, meta.returnContext);
      const returnContextMode = getReturnContextMode(ctx.platform.configManager);
      if (returnContextMode !== 'off' && meta.returnContext) {
        for (const line of formatReturnContextForDisplay(meta.returnContext)) {
          ctx.print(`  ${line}`);
        }
        if (reopenedPanels.length > 0) {
          ctx.print(`  Reopened panels: ${reopenedPanels.join(', ')}`);
        }
        if ((meta.returnContext.remoteRunners?.length ?? 0) > 0) {
          ctx.print(`  Remote re-entry: /remote recover ${meta.returnContext.remoteRunners![0]}`);
        }
        if ((meta.returnContext.worktreePaths?.length ?? 0) > 0) {
          ctx.print(`  Worktree re-entry: /worktree review`);
        }
        if (returnContextMode === 'assisted') {
          const helperModel = providerApi.createHelperModel(ctx.platform.configManager);
          void maybeAssistReturnContextSummary(ctx.platform.configManager, helperModel, meta.returnContext).then((assisted) => {
            if (!assisted.assistedNarrative) return;
            ctx.print(`  Assist: ${assisted.assistedNarrative}`);
            ctx.renderRequest();
          });
        }
      }
    } catch (e) {
      ctx.print(`Failed to resume session: ${summarizeError(e)}`);
    }
    return true;
  }

  if (sub === 'fork') {
    const newId = `user-${randomBytes(4).toString('hex')}`;
        const exportData = ctx.session.conversationManager.toJSON() as SessionExportData;
        const messages = exportData.messages ?? [];
        const currentTitle = ctx.session.conversationManager.title;
        const forkName = args[1] ? args.slice(1).join(' ').trim() : `fork-of-${ctx.session.runtime.sessionId.slice(0, 8)}`;
        const meta: SessionMeta = {
          title: forkName,
          model: ctx.session.runtime.model,
          provider: ctx.session.runtime.provider,
      timestamp: Date.now(),
      titleSource: exportData.titleSource,
      returnContext: exportData.returnContext,
    };
    try {
      sm.save(newId, messages, meta);
      ctx.session.runtime.sessionId = newId;
      ctx.session.conversationManager.title = forkName;
      ctx.renderRequest();
      ctx.print(`Session forked:\n  New ID: ${newId}\n  Name:   ${forkName}\n  From:   ${currentTitle || ctx.session.runtime.sessionId}\n  Messages: ${messages.length}`);
    } catch (e) {
      ctx.print(`Failed to fork session: ${summarizeError(e)}`);
    }
    return true;
  }

  if (sub === 'save') {
        const exportData = ctx.session.conversationManager.toJSON() as SessionExportData;
        const messages = exportData.messages ?? [];
        const rawName = args[1] ? args.slice(1).join(' ').trim() : (ctx.session.conversationManager.title || ctx.session.runtime.sessionId);
        const meta: SessionMeta = {
          title: ctx.session.conversationManager.title,
          model: ctx.session.runtime.model,
          provider: ctx.session.runtime.provider,
      timestamp: Date.now(),
      titleSource: exportData.titleSource,
      returnContext: exportData.returnContext,
    };
    try {
      const { filePath, sanitizedName } = sm.save(rawName, messages, meta);
      ctx.session.runtime.sessionId = sanitizedName;
      const nameNote = sanitizedName !== rawName ? ` (saved as "${sanitizedName}")` : '';
      ctx.print(`Session saved: ${rawName}${nameNote}\n  → ${filePath}`);
    } catch (e) {
      ctx.print(`Failed to save session: ${summarizeError(e)}`);
    }
    return true;
  }

  if (sub === 'info') {
    const target = args[1] || ctx.session.runtime.sessionId;
    const sessions = sm.list();
    const found = sessions.find((session) => session.name === target || session.name.startsWith(target));
    if (!found) {
      ctx.print(`Session not found: ${target}`);
      return true;
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
      ...(found.returnContext ? formatReturnContextForDisplay(found.returnContext).map((line) => `  ${line}`) : []),
    ].join('\n'));
    return true;
  }

  if (sub === 'export') {
    const target = args[1];
    if (!target) {
      ctx.print('Usage: /session export <session-id> [markdown|text]\nUse /session export . to export the current session.');
      return true;
    }
    const format = (args[2] || 'markdown').toLowerCase();
    const sessionId = target === '.' ? ctx.session.runtime.sessionId : target;
    const sessions = sm.list();
    const found = sessions.find((session) => session.name === sessionId || session.name.startsWith(sessionId));
    if (!found && target !== '.') {
      try {
        const { meta, messages } = sm.load(sessionId);
        printSessionExport(ctx, sessionId, meta.title, messages as Array<Record<string, unknown>>, format);
      } catch {
        ctx.print(`Session not found: ${sessionId}`);
      }
      return true;
    }
    const loadName = found ? found.name : sessionId;
    try {
      const { meta, messages } = sm.load(loadName);
      printSessionExport(ctx, loadName, meta.title, messages as Array<Record<string, unknown>>, format);
    } catch (e) {
      ctx.print(`Failed to export session: ${summarizeError(e)}`);
    }
    return true;
  }

  if (sub === 'search') {
    const query = args.slice(1).join(' ').trim();
    if (!query) {
      ctx.print('Usage: /session search <keyword>');
      return true;
    }
    const results = sm.search(query);
    if (results.length === 0) {
      ctx.print(`No sessions found matching: "${query}"`);
      return true;
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
    return true;
  }

  if (sub === 'events' || sub === 'groups' || sub === 'hotspots') {
    const kind = parseTranscriptKind(args[1]);
    ctx.print(buildTranscriptReviewLines(ctx, kind, sub).join('\n'));
    return true;
  }

  if (sub === 'delete') {
    const target = args[1];
    if (!target) {
      ctx.print('Usage: /session delete <session-id>');
      return true;
    }
    const sessions = sm.list();
    const found = sessions.find((session) => session.name === target || session.name.startsWith(target));
    if (!found) {
      ctx.print(`Session not found: ${target}`);
      return true;
    }
    if (found.name === ctx.session.runtime.sessionId) {
      ctx.print(`Cannot delete the active session (${found.name}).\nSwitch to another session first with /session resume <id>.`);
      return true;
    }
    try {
      sm.delete(found.name);
      ctx.print(`Session deleted: ${found.name}${found.title ? ` (${found.title})` : ''}`);
    } catch (e) {
      ctx.print(`Failed to delete session: ${summarizeError(e)}`);
    }
    return true;
  }

  return false;
}

// session-mgmt / smgmt was removed in TASK-032.
// All session lifecycle operations are now first-class subcommands of /session.
// Use /session list, /session resume, /session save, etc.
//
// CommandRegistry.register() throws on duplicate names/aliases, so this
// registration was intentionally deleted rather than left as dead code.

interface SessionExportData {
  readonly messages: object[];
  readonly timestamp?: number;
  readonly titleSource?: ConversationTitleSource;
  readonly returnContext?: SessionReturnContextSummary;
}
