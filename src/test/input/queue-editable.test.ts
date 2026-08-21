import { describe, expect, test } from 'bun:test';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { registerQueueRuntimeCommands } from '../../input/commands/queue-runtime.ts';
import { UIFactory } from '../../renderer/ui-factory.ts';
import { lineToString } from '../setup.ts';

// ---------------------------------------------------------------------------
// STEP 2b, mid-turn queued messages render as an editable list; edit/delete
// go through the SDK verbs until delivery, after which a message has left the
// queue (delivered = immutable).
// ---------------------------------------------------------------------------

/** A fake in-process queue mirroring the orchestrator's list/edit/delete semantics. */
function fakeQueue(initial: string[]) {
  let seq = 0;
  const items = initial.map((text) => ({ id: `m${seq++}`, queuedAt: seq, text }));
  const delivered = new Set<string>();
  return {
    items,
    delivered,
    list: () => items.filter((m) => !delivered.has(m.id)),
    edit: (id: string, text: string) => {
      const m = items.find((x) => x.id === id);
      if (!m || delivered.has(id)) return false;
      m.text = text;
      return true;
    },
    del: (id: string) => {
      const idx = items.findIndex((x) => x.id === id);
      if (idx < 0 || delivered.has(id)) return false;
      items.splice(idx, 1);
      return true;
    },
  };
}

function makeCtx(q: ReturnType<typeof fakeQueue>): { ctx: CommandContext; printed: string[] } {
  const printed: string[] = [];
  const ctx = {
    print: (t: string) => { printed.push(t); },
    renderRequest: () => {},
    listQueuedMessages: () => q.list(),
    editQueuedMessage: (id: string, text: string) => q.edit(id, text),
    deleteQueuedMessage: (id: string) => q.del(id),
  } as unknown as CommandContext;
  return { ctx, printed };
}

describe('createQueuedMessageList render (STEP 2b)', () => {
  const items = [
    { id: 'a', text: 'write the tests first' },
    { id: 'b', text: 'then run the whole suite' },
  ];

  test('renders a numbered editable list with the affordance header at 80 columns', () => {
    const text = UIFactory.createQueuedMessageList(80, items).map(lineToString).join('\n');
    expect(text).toContain('2 queued');
    expect(text).toContain('/queue edit');
    expect(text).toContain('1. write the tests first');
    expect(text).toContain('2. then run the whole suite');
  });

  test('renders the same numbered list at 60 columns', () => {
    const text = UIFactory.createQueuedMessageList(60, items).map(lineToString).join('\n');
    expect(text).toContain('2 queued');
    expect(text).toContain('1. write the tests first');
    expect(text).toContain('2. then run the whole suite');
  });

  test('an empty queue renders nothing', () => {
    expect(UIFactory.createQueuedMessageList(80, [])).toEqual([]);
  });
});

describe('/queue command (STEP 2b)', () => {
  function run(sub: string[], q: ReturnType<typeof fakeQueue>): string[] {
    const registry = new CommandRegistry();
    registerQueueRuntimeCommands(registry);
    const { ctx, printed } = makeCtx(q);
    void registry.execute('queue', sub, ctx);
    return printed;
  }

  test('list shows every still-undelivered message numbered', () => {
    const q = fakeQueue(['first', 'second']);
    const out = run(['list'], q).join('\n');
    expect(out).toContain('1. first');
    expect(out).toContain('2. second');
    expect(out).toContain('editable until delivered');
  });

  test('edit <n> replaces the message text via the verb', () => {
    const q = fakeQueue(['old text']);
    const out = run(['edit', '1', 'new', 'text'], q).join('\n');
    expect(out).toContain('Edited queued message #1');
    expect(q.items[0]!.text).toBe('new text');
  });

  test('delete <n> removes the message via the verb', () => {
    const q = fakeQueue(['gone', 'stays']);
    const out = run(['delete', '1'], q).join('\n');
    expect(out).toContain('Deleted queued message #1');
    expect(q.list().map((m) => m.text)).toEqual(['stays']);
  });

  test('editing a delivered message is refused (delivered = immutable)', () => {
    const q = fakeQueue(['msg']);
    q.delivered.add(q.items[0]!.id); // the turn delivered it
    // Once delivered the list is empty, so #1 is out of range and reported honestly.
    const out = run(['edit', '1', 'changed'], q).join('\n');
    expect(out).toMatch(/No queued message|already delivered/);
    expect(q.items[0]!.text).toBe('msg'); // unchanged
  });

  test('an out-of-range index is reported, not silently ignored', () => {
    const q = fakeQueue(['only']);
    const out = run(['delete', '5'], q).join('\n');
    expect(out).toContain('No queued message #5');
  });

  test('an empty queue lists a friendly empty state', () => {
    const q = fakeQueue([]);
    const out = run([], q).join('\n');
    expect(out).toContain('No queued messages');
  });
});
