import { describe, expect, test } from 'bun:test';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { registerPlanningRuntimeCommands } from '../../input/commands/planning-runtime.ts';
import { registerSecretRuntimeCommands } from '../../input/commands/secret-runtime.ts';
import type { ConcealedInputRequest } from '../../input/concealed-input.ts';

interface FakeConfig {
  store: Record<string, unknown>;
  get(key: string): unknown;
  set(key: string, value: unknown): void;
}

function makeConfig(initial: Record<string, unknown> = {}): FakeConfig {
  return {
    store: { 'permissions.mode': 'prompt', ...initial },
    get(key) { return this.store[key]; },
    set(key, value) { this.store[key] = value; },
  };
}

function makeCtx(config: FakeConfig, out: string[], concealed?: { begun: ConcealedInputRequest[] }): CommandContext {
  return {
    print: (t: string) => { out.push(t); },
    platform: { configManager: config },
    beginConcealedInput: concealed
      ? (req: ConcealedInputRequest) => { concealed.begun.push(req); }
      : undefined,
  } as unknown as CommandContext;
}

describe('/plan mode toggle', () => {
  test('bare /plan toggles into plan mode and back to normal', async () => {
    const registry = new CommandRegistry();
    registerPlanningRuntimeCommands(registry);
    const config = makeConfig();
    const out: string[] = [];

    await registry.execute('plan', [], makeCtx(config, out));
    expect(config.store['permissions.mode']).toBe('plan');
    expect(out.at(-1)).toContain('Plan mode ON');

    await registry.execute('plan', [], makeCtx(config, out));
    expect(config.store['permissions.mode']).toBe('prompt');
    expect(out.at(-1)).toContain('Plan mode OFF');
  });

  test('/plan on and /plan off are explicit and idempotent', async () => {
    const registry = new CommandRegistry();
    registerPlanningRuntimeCommands(registry);
    const config = makeConfig({ 'permissions.mode': 'accept-edits' });
    const out: string[] = [];

    await registry.execute('plan', ['on'], makeCtx(config, out));
    expect(config.store['permissions.mode']).toBe('plan');
    await registry.execute('plan', ['on'], makeCtx(config, out));
    expect(config.store['permissions.mode']).toBe('plan');

    await registry.execute('plan', ['off'], makeCtx(config, out));
    expect(config.store['permissions.mode']).toBe('prompt');
  });

  test('the project-planning command is still reachable under /project-plan and its alias', () => {
    const registry = new CommandRegistry();
    registerPlanningRuntimeCommands(registry);
    expect(registry.get('project-plan')).toBeTruthy();
    expect(registry.get('planning')).toBeTruthy();
    // /plan is now the mode toggle, distinct from the project-planning command.
    expect(registry.get('plan')?.description).toContain('plan mode');
  });
});

describe('/secret concealed capture', () => {
  test('/secret <NAME> begins concealed input and stores the value in a redacted way', async () => {
    const registry = new CommandRegistry();
    registerSecretRuntimeCommands(registry);
    const config = makeConfig();
    const out: string[] = [];
    const concealed = { begun: [] as ConcealedInputRequest[] };

    await registry.execute('secret', ['my-token'], makeCtx(config, out, concealed));
    expect(concealed.begun.length).toBe(1);
    expect(concealed.begun[0].label).toBe('MY_TOKEN');

    // Simulate the user typing and submitting the secret.
    delete process.env.MY_TOKEN;
    concealed.begun[0].onSubmit('s3cr3t-value');
    // onSubmit mutates process.env.MY_TOKEN through a call TS's narrowing
    // can't see into, so it still treats the property as the `undefined`
    // the preceding `delete` left it as. Reassert its real declared type.
    expect(process.env.MY_TOKEN as string | undefined).toBe('s3cr3t-value');
    // The confirmation is redacted — it must never echo the plaintext.
    const confirmation = out.join('\n');
    expect(confirmation).not.toContain('s3cr3t-value');
    expect(confirmation).toContain('value hidden');
    delete process.env.MY_TOKEN;
  });

  test('/secret with no name prints usage instead of arming concealed input', async () => {
    const registry = new CommandRegistry();
    registerSecretRuntimeCommands(registry);
    const out: string[] = [];
    const concealed = { begun: [] as ConcealedInputRequest[] };
    await registry.execute('secret', [], makeCtx(makeConfig(), out, concealed));
    expect(concealed.begun.length).toBe(0);
    expect(out.join('\n')).toContain('Usage');
  });
});
