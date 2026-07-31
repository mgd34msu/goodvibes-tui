import type { CommandRegistry } from '../command-registry.ts';
import type { WorkPlanItemStatus, WorkPlanStore } from '@pellux/goodvibes-sdk/platform/workflow';
import { WORK_PLAN_STATUSES } from '@pellux/goodvibes-sdk/platform/workflow';
import { openModalCommand } from './runtime-services.ts';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils';

const STATUS_COMMANDS: Record<string, WorkPlanItemStatus> = {
  pending: 'pending',
  todo: 'pending',
  start: 'in_progress',
  active: 'in_progress',
  progress: 'in_progress',
  block: 'blocked',
  blocked: 'blocked',
  done: 'done',
  complete: 'done',
  fail: 'failed',
  failed: 'failed',
  cancel: 'cancelled',
  cancelled: 'cancelled',
};

function getStore(ctx: import('../command-registry.ts').CommandContext): WorkPlanStore | null {
  return ctx.workspace.workPlanStore ?? null;
}

function openPanel(ctx: import('../command-registry.ts').CommandContext): void {
  // work-plan migrated to the 'work-plan' modal — open it via the seam.
  openModalCommand(ctx, 'work-plan-modal');
}

function formatList(store: WorkPlanStore): string {
  const items = store.listItems();
  if (items.length === 0) return 'Work plan is empty. Add one with /work-plan add <title>.';
  return [
    `Work Plan (${items.length})`,
    ...items.map((item) => {
      const owner = item.owner ? ` @${item.owner}` : '';
      return `  ${item.id}  ${item.status.padEnd(11)} ${item.title}${owner}`;
    }),
  ].join('\n');
}

function parseAddArgs(args: string[]): { title: string; owner?: string; source?: string; notes?: string } {
  const titleParts: string[] = [];
  let owner: string | undefined;
  let source: string | undefined;
  let notes: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const part = args[i] ?? '';
    if (part === '--owner' && args[i + 1]) {
      owner = args[++i];
      continue;
    }
    if (part === '--source' && args[i + 1]) {
      source = args[++i];
      continue;
    }
    if (part === '--notes' && args[i + 1]) {
      notes = args.slice(i + 1).join(' ').trim();
      break;
    }
    titleParts.push(part);
  }
  return {
    title: titleParts.join(' ').trim(),
    ...(owner ? { owner } : {}),
    ...(source ? { source } : {}),
    ...(notes ? { notes } : {}),
  };
}

export function registerWorkPlanRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'work-plan',
    aliases: ['wp', 'todo', 'workplan'],
    description: 'Track a persistent workspace-scoped work plan',
    usage: '[panel|list|show|export|add <title> [--owner name] [--source label] [--notes text]|edit <id> [<new title>] [--owner name] [--notes text]|done <id>|start <id>|block <id>|fail <id>|cancel <id>|pending <id>|remove <id>|clear-done]',
    argsHint: '[panel|add|list|done]',
    handler(args, ctx) {
      const store = getStore(ctx);
      if (!store) {
        ctx.print('Work plan store is not available in this runtime.');
        return;
      }
      const subcommand = (args[0] ?? 'panel').toLowerCase();
      try {
        if (subcommand === 'panel' || subcommand === 'open') {
          openPanel(ctx);
          ctx.print('Opened work plan panel.');
          return;
        }
        if (subcommand === 'list') {
          ctx.print(formatList(store));
          return;
        }
        if (subcommand === 'show' || subcommand === 'markdown') {
          ctx.print(store.toMarkdown());
          return;
        }
        if (subcommand === 'export') {
          // Thin wrapper over WorkPlanStore.exportMarkdown() — writes the plan's
          // markdown alongside the JSON and reports the path. (W6 command-path
          // parity: the work-plan modal's export action routes here.)
          const { path } = store.exportMarkdown();
          ctx.print(`Exported work plan markdown to ${path}`);
          return;
        }
        if (subcommand === 'add') {
          const parsed = parseAddArgs(args.slice(1));
          if (!parsed.title) {
            ctx.print('Usage: /work-plan add <title> [--owner name] [--source label] [--notes text]');
            return;
          }
          const addOptions = {
            ...(parsed.owner ? { owner: parsed.owner } : {}),
            source: parsed.source ?? 'manual',
            ...(parsed.notes ? { notes: parsed.notes } : {}),
          };
          const item = store.addItem(parsed.title, addOptions);
          openPanel(ctx);
          ctx.print(`Added work plan item ${item.id}.`);
          return;
        }
        if (subcommand === 'edit' || subcommand === 'update') {
          // Thin wrapper over WorkPlanStore.updateItem(idOrPrefix, patch).
          // (W6 command-path parity: the work-plan modal's edit action routes
          // here.) Only the flags the caller supplies are patched.
          const id = args[1];
          if (!id) {
            ctx.print(`Usage: /work-plan ${subcommand} <id> [<new title>] [--owner name] [--source label] [--notes text]`);
            return;
          }
          const parsed = parseAddArgs(args.slice(2));
          const patch = {
            ...(parsed.title ? { title: parsed.title } : {}),
            ...(parsed.owner !== undefined ? { owner: parsed.owner } : {}),
            ...(parsed.source !== undefined ? { source: parsed.source } : {}),
            ...(parsed.notes !== undefined ? { notes: parsed.notes } : {}),
          };
          if (Object.keys(patch).length === 0) {
            ctx.print(`Usage: /work-plan ${subcommand} <id> [<new title>] [--owner name] [--source label] [--notes text]`);
            return;
          }
          const item = store.updateItem(id, patch);
          ctx.print(`Updated work plan item ${item.id}: ${item.title}`);
          return;
        }
        if (subcommand === 'remove' || subcommand === 'delete' || subcommand === 'rm') {
          const id = args[1];
          if (!id) {
            ctx.print(`Usage: /work-plan ${subcommand} <id>`);
            return;
          }
          const item = store.removeItem(id);
          ctx.print(`Removed work plan item ${item.id}: ${item.title}`);
          return;
        }
        if (subcommand === 'clear-done' || subcommand === 'clear-completed') {
          const count = store.clearCompleted();
          ctx.print(`Cleared ${count} completed/cancelled work plan item${count === 1 ? '' : 's'}.`);
          return;
        }
        if (subcommand === 'cycle' || subcommand === 'toggle') {
          const id = args[1];
          if (!id) {
            ctx.print(`Usage: /work-plan ${subcommand} <id>`);
            return;
          }
          const item = store.cycleItemStatus(id);
          ctx.print(`Updated ${item.id}: ${item.status}.`);
          return;
        }
        const status = STATUS_COMMANDS[subcommand];
        if (status) {
          const id = args[1];
          if (!id) {
            ctx.print(`Usage: /work-plan ${subcommand} <id>`);
            return;
          }
          const item = store.setItemStatus(id, status);
          ctx.print(`Updated ${item.id}: ${item.status}.`);
          return;
        }
        if (WORK_PLAN_STATUSES.includes(subcommand as WorkPlanItemStatus)) {
          ctx.print(`Usage: /work-plan ${subcommand} <id>`);
          return;
        }
        ctx.print(`Unknown workplan subcommand: ${subcommand}`);
      } catch (error) {
        ctx.print(summarizeError(error));
      }
    },
  });
}
