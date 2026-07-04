/**
 * DEBT-5 item 3 (report-vs-modal front doors) — /health has no single modal
 * that owns its data (it genuinely spans settings/accounts/auth/sandbox/
 * services/etc.), so bare `/health` and `/health report` stay a transcript
 * report; only a hint line was added pointing at the providers domain's real
 * modal front door (/health provider).
 *
 * The bare/default report path itself pulls from ~10 subsystems (service
 * registry, skills discovery, security snapshot, provider API, subscription
 * manager, sandbox review, the managed-hooks file, operator client, settings
 * snapshot, read-models — see buildSetupReviewSnapshot in
 * local-setup-review.ts) that would need a large, brittle mock to exercise
 * end-to-end and were not touched by this item's one-line change, so this
 * file covers the part that changed cheaply and reliably: the `provider`/
 * `open`/`panel` subcommands' unchanged modal jump. The hint line itself is
 * a static, unconditional line in the report array — verified by direct
 * source reading (see health-runtime.ts, right under the 'Health Review'
 * title) rather than by a heavy end-to-end mock.
 */
import { describe, test, expect } from 'bun:test';
import { registerHealthRuntimeCommands } from '../../input/commands/health-runtime.ts';
import { CommandRegistry } from '../../input/command-registry.ts';
import type { CommandContext } from '../../input/command-registry.ts';

describe('/health front door (DEBT-5 item 3)', () => {
  function getCommand() {
    const registry = new CommandRegistry();
    registerHealthRuntimeCommands(registry);
    return registry.get('health')!;
  }

  function makeContext(): { ctx: CommandContext; opened: string[] } {
    const opened: string[] = [];
    const ctx = {
      platform: { readModels: {} as never, configManager: {} as never },
      openModal: (name: string) => opened.push(name),
      print: () => {},
    } as unknown as CommandContext;
    return { ctx, opened };
  }

  test('/health provider opens the providers modal (the real front door named in the new hint line)', async () => {
    const cmd = getCommand();
    const { ctx, opened } = makeContext();
    await cmd.handler(['provider'], ctx);
    expect(opened).toEqual(['providers-modal']);
  });

  test('/health open and /health panel remain synonyms for the same modal jump (unchanged by this item)', async () => {
    const cmd = getCommand();
    for (const sub of ['open', 'panel']) {
      const { ctx, opened } = makeContext();
      await cmd.handler([sub], ctx);
      expect(opened).toEqual(['providers-modal']);
    }
  });
});
