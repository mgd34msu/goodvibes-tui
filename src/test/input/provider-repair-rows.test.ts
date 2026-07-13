import { describe, expect, test } from 'bun:test';
import { presentRecommendedActions } from '../../input/commands/provider-accounts-runtime.ts';
import type { CommandContext } from '../../input/command-registry.ts';
import type { SelectionItem, SelectionResult } from '../../input/selection-modal.ts';

type OpenSelectionCall = {
  title: string;
  items: SelectionItem[];
  run: (result: SelectionResult | null) => void;
};

function makeCtx(): {
  ctx: CommandContext;
  selections: OpenSelectionCall[];
  executed: Array<{ name: string; args: string[] }>;
  prints: string[];
} {
  const selections: OpenSelectionCall[] = [];
  const executed: Array<{ name: string; args: string[] }> = [];
  const prints: string[] = [];
  const ctx = {
    print: (text: string) => { prints.push(text); },
    openSelection: (title: string, items: SelectionItem[], _opts: unknown, run: (result: SelectionResult | null) => void) => {
      selections.push({ title, items, run });
    },
    executeCommand: async (name: string, args: string[]) => {
      executed.push({ name, args });
      return true;
    },
  } as unknown as CommandContext;
  return { ctx, selections, executed, prints };
}

describe('provider repair rows execute through the command registry', () => {
  test('a command-bearing action becomes a press-Enter row that RUNS the command', () => {
    const bag = makeCtx();
    presentRecommendedActions(bag.ctx, 'acme', [
      { description: 'Store an API key for acme', command: { name: 'secrets', args: ['set', 'ACME_API_KEY'] } },
    ]);

    expect(bag.selections).toHaveLength(1);
    const call = bag.selections[0]!;
    expect(call.title).toBe('Repair acme');
    expect(call.items[0]!.detail).toContain('runs /secrets set ACME_API_KEY');

    // Selecting the row runs the exact command through the registry.
    call.run({ item: call.items[0]!, action: 'select' });
    expect(bag.executed).toEqual([{ name: 'secrets', args: ['set', 'ACME_API_KEY'] }]);
  });

  test('an action with no command stays a manual, non-executing row', () => {
    const bag = makeCtx();
    presentRecommendedActions(bag.ctx, 'acme', [
      { description: 'Rotate the key in the provider dashboard' },
    ]);
    const call = bag.selections[0]!;
    expect(call.items[0]!.detail).toBe('manual step (nothing to run)');
    call.run({ item: call.items[0]!, action: 'select' });
    expect(bag.executed).toHaveLength(0);
    expect(bag.prints).toContain('Rotate the key in the provider dashboard');
  });

  test('no recommended actions prints an honest empty notice', () => {
    const bag = makeCtx();
    presentRecommendedActions(bag.ctx, 'acme', []);
    expect(bag.selections).toHaveLength(0);
    expect(bag.prints).toContain('No active repair actions suggested.');
  });
});
