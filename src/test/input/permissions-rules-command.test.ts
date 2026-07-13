import { describe, expect, test } from 'bun:test';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { registerPermissionsRuntimeCommands } from '../../input/commands/permissions-runtime.ts';
import type { SelectionItem, SelectionResult } from '../../input/selection-modal.ts';

function makeRuleStore(initial: Array<{ id: string; tool: string; effect: 'allow' | 'deny'; tier: string; description?: string }>) {
  const records = initial.map((r) => ({
    rule: { id: r.id, description: r.description, effect: r.effect },
    tier: r.tier,
    tool: r.tool,
    createdAt: 0,
  }));
  const deleted: string[] = [];
  return {
    deleted,
    list: () => records.slice(),
    delete: async (ruleId: string) => {
      deleted.push(ruleId);
      const idx = records.findIndex((r) => r.rule.id === ruleId);
      if (idx >= 0) { records.splice(idx, 1); return true; }
      return false;
    },
  };
}

function makeCtx(store: unknown) {
  const printed: string[] = [];
  const selections: Array<{ items: SelectionItem[]; run: (r: SelectionResult | null) => void }> = [];
  const ctx = {
    clients: { userPermissionRuleStore: store },
    platform: { configManager: { get: () => undefined, getAll: () => ({}) } },
    print: (text: string) => { printed.push(text); },
    openSelection: (_title: string, items: SelectionItem[], _opts: unknown, run: (r: SelectionResult | null) => void) => {
      selections.push({ items, run });
    },
  } as unknown as CommandContext;
  return { ctx, printed, selections };
}

describe('/permissions rules — list and revoke remembered approvals', () => {
  test('lists remembered rules and revokes the selected one through the live store', async () => {
    const store = makeRuleStore([
      { id: 'rule-1', tool: 'exec', effect: 'allow', tier: 'command', description: 'allow git status' },
      { id: 'rule-2', tool: 'write', effect: 'allow', tier: 'tool' },
    ]);
    const { ctx, selections } = makeCtx(store);
    const registry = new CommandRegistry();
    registerPermissionsRuntimeCommands(registry);

    await registry.execute('permissions', ['rules'], ctx);

    expect(selections).toHaveLength(1);
    const call = selections[0]!;
    expect(call.items.map((i) => i.id)).toEqual(['rule-1', 'rule-2']);
    expect(call.items[0]!.label).toBe('exec: allow git status');
    expect(call.items[0]!.actions).toContain('revoke');

    // Pressing the revoke action deletes exactly that rule from the live store.
    call.run({ item: call.items[0]!, action: 'delete' });
    await Promise.resolve();
    expect(store.deleted).toEqual(['rule-1']);

    // A plain select (Enter) does not revoke.
    call.run({ item: call.items[1]!, action: 'select' });
    await Promise.resolve();
    expect(store.deleted).toEqual(['rule-1']);
  });

  test('/permissions revoke <id> removes a rule by id', async () => {
    const store = makeRuleStore([{ id: 'rule-x', tool: 'exec', effect: 'allow', tier: 'command' }]);
    const { ctx, printed } = makeCtx(store);
    const registry = new CommandRegistry();
    registerPermissionsRuntimeCommands(registry);

    await registry.execute('permissions', ['revoke', 'rule-x'], ctx);
    expect(store.deleted).toEqual(['rule-x']);
    expect(printed.join('\n')).toContain('Revoked remembered rule: rule-x');
  });

  test('empty state is honest when there are no remembered rules', async () => {
    const store = makeRuleStore([]);
    const { ctx, printed, selections } = makeCtx(store);
    const registry = new CommandRegistry();
    registerPermissionsRuntimeCommands(registry);

    await registry.execute('permissions', ['rules'], ctx);
    expect(selections).toHaveLength(0);
    expect(printed.join('\n')).toContain('No remembered permission rules');
  });
});
