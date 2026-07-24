/**
 * /secret — capture a password-like value through the composer's concealed
 * input mode, without the plaintext ever appearing in the transcript or input
 * history.
 *
 * This is the user-facing demonstration of the generalized concealed-input
 * affordance (see src/input/concealed-input.ts): the same masking that used to
 * live only on the local-auth and onboarding surfaces, now reachable for any
 * password-like prompt. The captured value is written to a process environment
 * variable so a subsequent shell command / tool run can read it, while the
 * transcript only ever shows a redacted confirmation.
 */

import type { CommandRegistry } from '../command-registry.ts';

/** Normalize a requested name into a conventional env-var identifier. */
function toEnvVarName(raw: string): string {
  return raw.trim().replace(/[^A-Za-z0-9_]/g, '_').replace(/^_+|_+$/g, '').toUpperCase();
}

export function registerSecretRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'secret',
    description: 'Quick one-off: type a value with masked input, stored as an env var for THIS session only (persistent storage + providers: /secrets)',
    usage: '/secret <NAME>',
    argsHint: '<NAME>',
    handler(args, ctx) {
      const name = toEnvVarName(args[0] ?? '');
      if (!name) {
        ctx.print('[Secret] Usage: /secret <NAME> — the value is typed on the next line with the keystrokes masked.');
        return;
      }
      if (!ctx.beginConcealedInput) {
        ctx.print('[Secret] Concealed input is not available on this surface.');
        return;
      }
      ctx.print(`[Secret] Enter value for ${name} (input is masked; press Enter to store, Esc to cancel).`);
      ctx.beginConcealedInput({
        label: name,
        onSubmit: (value) => {
          if (value.length === 0) {
            ctx.print(`[Secret] ${name} not set (empty value).`);
            return;
          }
          process.env[name] = value;
          // Never echo the value — only a redacted confirmation of length.
          ctx.print(`[Secret] Stored ${name} (${value.length} character${value.length === 1 ? '' : 's'}, value hidden). Available to shell/tool runs as $${name}.`);
        },
        onCancel: () => {
          ctx.print(`[Secret] ${name} cancelled.`);
        },
      });
    },
  });
}
