import { describe, expect, test } from 'bun:test';
import { PolicyRuntimeState } from '@/runtime/index.ts';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { registerBuiltinCommands } from '../../input/commands.ts';

// W6 command-path parity: /policy record-trend is a thin wrapper over
// PolicyRuntimeState.recordTrendEntry() (the policy modal dropped its 'r' action
// because the panel called that method directly and /policy had no equivalent
// verb). recordTrendEntry() forwards to the attached DivergencePanel, so the
// verb is honest about needing an active simulation dashboard.

function makeContext(out: string[], policyRuntimeState: PolicyRuntimeState): CommandContext {
  return {
    extensions: { policyRuntimeState },
    print: (text: string) => { out.push(text); },
    renderRequest: () => {},
    exit: () => {},
  } as unknown as CommandContext;
}

describe('/policy record-trend', () => {
  test('is registered as a policy subcommand', () => {
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);
    expect(registry.get('policy')).toBeDefined();
  });

  test('reports honestly when no simulation dashboard is active (no silent no-op)', async () => {
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);
    const policy = registry.get('policy')!;
    const out: string[] = [];
    // A fresh PolicyRuntimeState has no dashboard attached.
    await policy.handler(['record-trend'], makeContext(out, new PolicyRuntimeState()));
    const printed = out.join('\n');
    expect(printed).toContain('No active simulation dashboard');
    expect(printed).toContain('/policy simulate');
  });

  test("'trend' alias resolves to the same handler", async () => {
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);
    const policy = registry.get('policy')!;
    const out: string[] = [];
    await policy.handler(['trend'], makeContext(out, new PolicyRuntimeState()));
    expect(out.join('\n')).toContain('No active simulation dashboard');
  });
});
