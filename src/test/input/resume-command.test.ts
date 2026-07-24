/**
 * /resume — the discoverable session-resume front door.
 *
 * Pins: no args opens the picker over saved sessions (newest first from the
 * session manager, current session excluded); headless surfaces (no
 * openSelection) fall back to the honest list + usage line; an explicit
 * id/name argument routes to the same /session resume workflow path.
 */
import { describe, expect, test } from 'bun:test';
import { resumeCommand } from '../../input/commands/session.ts';
import type { CommandContext } from '../../input/command-registry.ts';

interface PickerCall {
  title: string;
  items: Array<{ id: string; label: string; detail?: string }>;
  callback: (result: { item: { id: string } } | null) => void;
}

function makeCtx(opts: {
  sessions?: Array<{ name: string; title: string; timestamp: number; messageCount: number; model?: string }>;
  withPicker?: boolean;
}) {
  const printed: string[] = [];
  const pickerCalls: PickerCall[] = [];
  const ctx = {
    session: {
      runtime: { sessionId: 'current-session', model: 'm', provider: 'p' },
      sessionManager: {
        list: () => opts.sessions ?? [],
        // The workflow path is exercised only via the picker callback; these
        // stubs exist so an accidental full resume in a unit test fails loudly.
        load: () => { throw new Error('load not stubbed for this test'); },
        getMeta: () => null,
      },
      conversationManager: {
        getMessageCount: () => 0,
        title: '',
      },
    },
    print: (text: string) => { printed.push(text); },
    renderRequest: () => {},
    ...(opts.withPicker === false ? {} : {
      openSelection: (title: string, items: PickerCall['items'], _o: unknown, callback: PickerCall['callback']) => {
        pickerCalls.push({ title, items, callback });
      },
    }),
  } as unknown as CommandContext;
  return { ctx, printed, pickerCalls };
}

describe('/resume', () => {
  test('no args opens a picker over saved sessions, excluding the current one', async () => {
    const { ctx, pickerCalls } = makeCtx({
      sessions: [
        { name: 'current-session', title: 'me', timestamp: 3, messageCount: 1 },
        { name: 'sess-b', title: 'Bench run', timestamp: 2, messageCount: 42, model: 'openai:gpt-5.5' },
        { name: 'sess-a', title: '', timestamp: 1, messageCount: 7 },
      ],
    });
    await resumeCommand.handler([], ctx);

    expect(pickerCalls).toHaveLength(1);
    const call = pickerCalls[0]!;
    expect(call.title).toBe('Resume session');
    expect(call.items.map((i) => i.id)).toEqual(['sess-b', 'sess-a']);
    expect(call.items[0]!.label).toBe('Bench run');
    // An untitled session falls back to its id as the label.
    expect(call.items[1]!.label).toBe('sess-a');
    expect(call.items[0]!.detail).toContain('42 msgs');
    expect(call.items[0]!.detail).toContain('openai:gpt-5.5');
  });

  test('subagent transcripts (agent-* names) are excluded from the picker — a mixed fixture of user + agent sessions', async () => {
    const { ctx, pickerCalls } = makeCtx({
      sessions: [
        { name: 'user-2cf82b10', title: 'real work', timestamp: 5, messageCount: 4 },
        { name: 'agent-f56ac81c', title: 'subagent transcript', timestamp: 4, messageCount: 30 },
        { name: 'agent-972d20f3', title: 'another subagent transcript', timestamp: 3, messageCount: 12 },
        { name: 'fork-of-abcdef01', title: 'a fork (not agent-prefixed)', timestamp: 2, messageCount: 6 },
      ],
    });
    await resumeCommand.handler([], ctx);

    expect(pickerCalls).toHaveLength(1);
    const ids = pickerCalls[0]!.items.map((i) => i.id);
    expect(ids).toEqual(['user-2cf82b10', 'fork-of-abcdef01']);
    expect(ids).not.toContain('agent-f56ac81c');
    expect(ids).not.toContain('agent-972d20f3');
  });

  test('all sessions being agent-shaped reports the honest empty message, not an empty picker', async () => {
    const { ctx, printed, pickerCalls } = makeCtx({
      sessions: [
        { name: 'agent-aaaaaaaa', title: 'x', timestamp: 2, messageCount: 1 },
        { name: 'agent-bbbbbbbb', title: 'y', timestamp: 1, messageCount: 1 },
      ],
    });
    await resumeCommand.handler([], ctx);
    expect(pickerCalls).toHaveLength(0);
    expect(printed.join('\n')).toContain('No previous sessions to resume');
  });

  test('no saved sessions prints an honest empty message instead of an empty picker', async () => {
    const { ctx, printed, pickerCalls } = makeCtx({ sessions: [] });
    await resumeCommand.handler([], ctx);
    expect(pickerCalls).toHaveLength(0);
    expect(printed.join('\n')).toContain('No previous sessions to resume');
  });

  test('headless surface (no openSelection) falls back to the list + usage hint', async () => {
    const { ctx, printed } = makeCtx({
      sessions: [{ name: 'sess-a', title: 'One', timestamp: 1, messageCount: 3 }],
      withPicker: false,
    });
    await resumeCommand.handler([], ctx);
    expect(printed.join('\n')).toContain('/resume <id-or-name>');
  });
});
