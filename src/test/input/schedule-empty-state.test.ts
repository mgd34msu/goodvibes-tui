import { describe, expect, test } from 'bun:test';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { registerScheduleRuntimeCommands } from '../../input/commands/schedule-runtime.ts';

function makeCtx(jobs: unknown[]): { ctx: CommandContext; printed: string[] } {
  const printed: string[] = [];
  const ctx = {
    ops: { automationManager: { start: async () => {}, listJobs: () => jobs } },
    print: (text: string) => { printed.push(text); },
  } as unknown as CommandContext;
  return { ctx, printed };
}

describe('/schedule list: automation empty state', () => {
  test('with no routines, shows the how-to-create-first-routine empty state pointing at a real command', async () => {
    const registry = new CommandRegistry();
    registerScheduleRuntimeCommands(registry);
    const { ctx, printed } = makeCtx([]);

    await registry.execute('schedule', ['list'], ctx);

    const text = printed.join('\n');
    // The SDK's empty-state title, plus THIS registry's real command pointer.
    expect(text).toContain('No routines yet');
    expect(text).toContain('/schedule add');
    // Never a command this registry does not have.
    expect(text).not.toContain('/automation create');
  });
});
