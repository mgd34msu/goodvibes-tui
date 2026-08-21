import type { CommandRegistry } from '../command-registry.ts';

// ---------------------------------------------------------------------------
// /queue, the mid-turn message queue as an editable list.
//
// Messages typed while a turn is streaming are QUEUED (they deliver after the
// turn). Until a message is delivered it stays editable and deletable via the
// SDK's editQueuedMessage / deleteQueuedMessage verbs; a delivered message has
// left the queue and is no longer listed, delivery is immutability. This
// command is the editable interface over the same list the composer renders.
// ---------------------------------------------------------------------------

export function registerQueueRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'queue',
    aliases: ['q'],
    description: 'Mid-turn message queue: list, edit, or delete still-undelivered messages',
    usage: '[list | edit <n> <text> | delete <n>]',
    argsHint: '[list|edit <n> <text>|delete <n>]',
    handler(args, ctx) {
      const list = ctx.listQueuedMessages?.() ?? [];
      const sub = (args[0] ?? 'list').toLowerCase();

      if (sub === 'list' || args.length === 0) {
        if (list.length === 0) {
          ctx.print('No queued messages. (Messages typed while a turn is streaming queue here until it finishes.)');
          return;
        }
        const lines = [`Queued messages (${list.length}): editable until delivered:`];
        list.forEach((m, i) => lines.push(`  ${i + 1}. ${m.text}`));
        lines.push('Use /queue edit <n> <new text> or /queue delete <n>.');
        ctx.print(lines.join('\n'));
        return;
      }

      // Both edit and delete address a message by its 1-based list position.
      const n = Number.parseInt(args[1] ?? '', 10);
      if (!Number.isInteger(n) || n < 1 || n > list.length) {
        ctx.print(list.length === 0
          ? 'No queued messages to act on.'
          : `No queued message #${args[1] ?? ''}. Valid range: 1..${list.length}. Run /queue to list them.`);
        return;
      }
      const target = list[n - 1]!;

      if (sub === 'delete') {
        const ok = ctx.deleteQueuedMessage?.(target.id) ?? false;
        ctx.print(ok
          ? `Deleted queued message #${n}.`
          : `Could not delete message #${n}; it was already delivered (delivered messages are immutable).`);
        return;
      }

      if (sub === 'edit') {
        const text = args.slice(2).join(' ');
        if (!text.trim()) {
          ctx.print('Usage: /queue edit <n> <new text>. Provide the replacement text.');
          return;
        }
        const ok = ctx.editQueuedMessage?.(target.id, text) ?? false;
        ctx.print(ok
          ? `Edited queued message #${n}.`
          : `Could not edit message #${n}; it was already delivered (delivered messages are immutable).`);
        return;
      }

      ctx.print('Usage: /queue [list | edit <n> <text> | delete <n>]');
    },
  });
}
