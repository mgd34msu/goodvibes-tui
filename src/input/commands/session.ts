/**
 * /session command handler — Multi-session Orchestration.
 *
 * Implements session and workflow commands:
 *
 *   /session link-task <taskId> [--session <sessionId>] [--depends-on <ref>] [--label <label>]
 *     — Register a task as a global cross-session ref, optionally linking it to a
 *       dependency.
 *
 *   /session handoff <taskId> --to <sessionId> [--session <sessionId>] [--reason <reason>]
 *     — Initiate a task handoff from the current session to another.
 *
 *   /session graph [--session <sessionId>] [--format text|json]
 *     — Display the cross-session task dependency graph.
 *
 *   /session cancel <taskId|--scope session> [--session <sessionId>] [--scope task|subtree|session]
 *     — Cancel tasks with configurable scope semantics.
 */

import type { SlashCommand, CommandContext } from '../command-registry.ts';
import type { CancellationScope, CrossSessionTaskRef } from '../../sessions/orchestration/index.ts';
import { VALID_SCOPES } from '../../sessions/orchestration/index.ts';
import { handleSessionWorkflowCommand } from './session-workflow.ts';
import { requireSessionOrchestration } from './runtime-services.ts';

// ── Argument parsing helpers ──────────────────────────────────────────────────

/**
 * Extract a named flag value from args (e.g. `--to <value>`).
 * Returns undefined if the flag is not present.
 */
function flagValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

/**
 * Parse a cross-session task ref from a string of the form
 * `<sessionId>:<taskId>` or just `<taskId>` (uses currentSessionId as owner).
 */
function parseRef(
  raw: string,
  currentSessionId: string,
): { sessionId: string; taskId: string } {
  const parts = raw.split(':', 2);
  if (parts.length === 2) {
    return { sessionId: parts[0]!, taskId: parts[1]! };
  }
  return { sessionId: currentSessionId, taskId: raw };
}

// ── Formatting helpers ────────────────────────────────────────────────────────

/** Status badge for display. */
function statusBadge(status: string): string {
  switch (status) {
    case 'queued':    return '[ ]';
    case 'running':   return '[>]';
    case 'blocked':   return '[~]';
    case 'completed': return '[+]';
    case 'failed':    return '[!]';
    case 'cancelled': return '[x]';
    default:          return '[?]';
  }
}

/** Format a ref as a compact one-line string. */
function fmtRef(ref: CrossSessionTaskRef): string {
  const key = `${ref.sessionId.slice(0, 8)}...:${ref.taskId.slice(0, 8)}...`;
  const label = ref.label ? ` [${ref.label}]` : '';
  return `${statusBadge(ref.status)} ${key}${label}  "${ref.title}"`;
}

// ── /session link-task ────────────────────────────────────────────────────────

function handleLinkTask(args: string[], context: CommandContext): void {
  const taskId = args[0];
  if (!taskId) {
    context.print(
      '[session] Usage: /session link-task <taskId> [--session <sessionId>] ' +
      '[--depends-on <sessionId:taskId>] [--label <label>]',
    );
    return;
  }

  // Defense-in-depth: parser splits on whitespace but guard against future changes
  if (!taskId.trim()) {
    context.print('Error: taskId cannot be empty or whitespace.');
    return;
  }

  if (taskId.includes(':')) {
    context.print('Error: taskId cannot contain ":" — it conflicts with the composite key format.');
    return;
  }

  const sessionId = flagValue(args, '--session') ?? context.session.runtime.sessionId;
  const dependsOnRaw = flagValue(args, '--depends-on');
  const label = flagValue(args, '--label');

  const orchestration = requireSessionOrchestration(context);

  const ref: CrossSessionTaskRef = {
    sessionId,
    taskId,
    title: label ?? taskId,
    status: 'queued',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    label,
  };

  const dependsOn = dependsOnRaw ? parseRef(dependsOnRaw, sessionId) : undefined;

  const result = orchestration.linkTask(ref, dependsOn);

  if (!result.ok) {
    context.print(`[session] link-task failed: ${result.error}`);
    return;
  }

  context.print(
    `[session] Task linked: ${sessionId.slice(0, 8)}...:${taskId}` +
    (label ? ` [${label}]` : '') +
    (dependsOn ? ` → depends on ${dependsOnRaw}` : ''),
  );
}

// ── /session handoff ──────────────────────────────────────────────────────────

function handleHandoff(args: string[], context: CommandContext): void {
  const taskId = args[0];
  const toSessionId = flagValue(args, '--to');
  const fromSessionId = flagValue(args, '--session') ?? context.session.runtime.sessionId;
  const reason = flagValue(args, '--reason');

  if (!taskId || !toSessionId) {
    context.print(
      '[session] Usage: /session handoff <taskId> --to <sessionId> ' +
      '[--session <fromSessionId>] [--reason <reason>]',
    );
    return;
  }

  const orchestration = requireSessionOrchestration(context);

  const result = orchestration.initiateHandoff(
    { sessionId: fromSessionId, taskId },
    fromSessionId,
    toSessionId,
    reason,
  );

  if (!result.ok) {
    context.print(`[session] handoff failed: ${result.error}`);
    return;
  }

  context.print(
    `[session] Handoff initiated: ${taskId} (${fromSessionId.slice(0, 8)}...) → (${toSessionId.slice(0, 8)}...)` +
    (reason ? `  reason: ${reason}` : '') +
    `\n[session] handoffId: ${result.handoffId}`,
  );
  context.print(
    '[session] The task is now blocked pending acknowledgement from the destination session.',
  );
}

// ── /session graph ────────────────────────────────────────────────────────────

function handleGraph(args: string[], context: CommandContext): void {
  const filterSession = flagValue(args, '--session');
  const format = flagValue(args, '--format') ?? 'text';

  const orchestration = requireSessionOrchestration(context);
  const snap = orchestration.snapshot();

  const refs = Object.values(snap.refs);
  const filteredRefs = filterSession
    ? refs.filter((r) => r.sessionId === filterSession)
    : refs;

  if (format === 'json') {
    context.print(JSON.stringify(snap, null, 2));
    return;
  }

  // ── Text display ─────────────────────────────────────────────────────────────

  if (filteredRefs.length === 0) {
    if (filterSession) {
      context.print(`[session] No tasks registered for session ${filterSession.slice(0, 8)}...`);
    } else {
      context.print('[session] Task graph is empty. Use /session link-task to register tasks.');
    }
    return;
  }

  const lines: string[] = [
    `[session] Cross-session task graph (${filteredRefs.length} task${filteredRefs.length !== 1 ? 's' : ''}):`,
  ];

  // Group by session for readability
  const bySession = new Map<string, CrossSessionTaskRef[]>();
  for (const ref of filteredRefs) {
    const group = bySession.get(ref.sessionId) ?? [];
    group.push(ref);
    bySession.set(ref.sessionId, group);
  }

  for (const [sid, sessionRefs] of bySession) {
    lines.push(`  Session ${sid.slice(0, 16)}...`);
    for (const ref of sessionRefs) {
      lines.push(`    ${fmtRef(ref)}`);

      // Show dependencies
      const deps = orchestration.getDependencies(ref.sessionId, ref.taskId);
      for (const dep of deps) {
        lines.push(
          `      depends-on: ${statusBadge(dep.status)} ${dep.sessionId.slice(0, 8)}...:${dep.taskId.slice(0, 8)}...  "${dep.title}"`,
        );
      }

      // Show dependents
      const dependents = orchestration.getDependents(ref.sessionId, ref.taskId);
      for (const d of dependents) {
        lines.push(
          `      depended-by: ${statusBadge(d.status)} ${d.sessionId.slice(0, 8)}...:${d.taskId.slice(0, 8)}...  "${d.title}"`,
        );
      }
    }
  }

  // Handoffs summary
  const handoffs = orchestration.getHandoffs();
  const filteredHandoffs = filterSession
    ? handoffs.filter((h) => h.fromSessionId === filterSession || h.toSessionId === filterSession)
    : handoffs;

  if (filteredHandoffs.length > 0) {
    lines.push(`  Handoffs (${filteredHandoffs.length}):`);
    for (const h of filteredHandoffs) {
      const ack = h.acknowledged ? 'ack' : 'pending';
      lines.push(
        `    ${h.handoffId.slice(0, 8)}...  ` +
        `${h.fromSessionId.slice(0, 8)}... → ${h.toSessionId.slice(0, 8)}...  ` +
        `task:${h.taskRef.taskId.slice(0, 8)}...  [${ack}]` +
        (h.reason ? `  reason: ${h.reason}` : ''),
      );
    }
  }

  context.print(lines.join('\n'));
}

// ── /session cancel ───────────────────────────────────────────────────────────

function handleCancel(args: string[], context: CommandContext): void {
  const scopeRaw = flagValue(args, '--scope');
  if (scopeRaw && !VALID_SCOPES.includes(scopeRaw as CancellationScope)) {
    context.print(`Invalid --scope: "${scopeRaw}". Valid: ${VALID_SCOPES.join(', ')}`);
    return;
  }
  const scope: CancellationScope = (scopeRaw as CancellationScope) ?? 'task';
  const sessionId = flagValue(args, '--session') ?? context.session.runtime.sessionId;
  const reason = flagValue(args, '--reason');

  // For session scope, taskId is not required
  const taskId = scope === 'session' ? undefined : args[0];

  if (scope !== 'session' && !taskId) {
    context.print(
      '[session] Usage: /session cancel <taskId> [--scope task|subtree|session] ' +
      '[--session <sessionId>] [--reason <reason>]\n' +
      '  --scope task     Cancel only this task (default)\n' +
      '  --scope subtree  Cancel this task and all tasks that transitively depend on it\n' +
      '  --scope session  Cancel all tasks in the session',
    );
    return;
  }

  const orchestration = requireSessionOrchestration(context);

  const result = orchestration.cancel({
    sessionId,
    taskId,
    scope,
    reason,
    requestedAt: Date.now(),
  });

  if (!result.ok) {
    context.print(`[session] cancel failed: ${result.error}`);
    return;
  }

  const lines: string[] = [
    `[session] Cancelled ${result.cancelled.length} task${result.cancelled.length !== 1 ? 's' : ''} ` +
    `(scope=${scope}):`,
  ];

  for (const t of result.cancelled) {
    lines.push(`  [x] ${t.sessionId.slice(0, 8)}...:${t.taskId.slice(0, 8)}...  "${t.title}"`);
  }

  if (result.skipped.length > 0) {
    lines.push(`  Skipped ${result.skipped.length} (already terminal):`);
    for (const s of result.skipped) {
      lines.push(`  [-] ${s.sessionId.slice(0, 8)}...:${s.taskId.slice(0, 8)}...  "${s.title}"  (${s.reason})`);
    }
  }

  context.print(lines.join('\n'));
}

// ── Top-level command definition ───────────────────────────────────────────────

/**
 * sessionCommand — The `/session` slash command.
 *
 * Routes to multi-session orchestration subcommand handlers based on args[0].
 */
export const sessionCommand: SlashCommand = {
  name: 'session',
  aliases: ['sess'],
  description: 'Multi-session orchestration: link tasks, handoff, view graph, and cancel across sessions.',
  usage: '<subcommand> [args]',
  argsHint: 'link-task|handoff|graph|cancel',
  handler: async (args: string[], context: CommandContext): Promise<void> => {
    const [sub, ...rest] = args;

    switch (sub) {
      case 'link-task':
      case 'link':
        handleLinkTask(rest, context);
        break;

      case 'handoff':
      case 'ho':
        handleHandoff(rest, context);
        break;

      case 'graph':
      case 'g':
        handleGraph(rest, context);
        break;

      case 'cancel':
      case 'x':
        handleCancel(rest, context);
        break;

      default: {
        const handled = await handleSessionWorkflowCommand(args, context);
        if (!handled) {
          const usage = [
            'Usage: /session <subcommand>',
            '  list | rename <name> | resume <id|name> | fork [name] | save [name] | info [id] | export <id> [format] | search <query> | delete <id>',
            '                                 — Session continuity, export, resume, and pruning',
            '  link-task <taskId> [--session <sid>] [--depends-on <sid:taskId>] [--label <label>]',
            '                                 — Register a task in the cross-session graph',
            '  handoff <taskId> --to <sid>  [--session <sid>] [--reason <reason>]',
            '                                 — Hand a task off to another session',
            '  graph [--session <sid>] [--format text|json]',
            '                                 — Display the cross-session task dependency graph',
            '  cancel <taskId> [--scope task|subtree|session] [--session <sid>] [--reason <reason>]',
            '                                 — Cancel tasks with scoped semantics',
          ].join('\n');
          context.print(usage);
        }
        break;
      }
    }
  },
};
