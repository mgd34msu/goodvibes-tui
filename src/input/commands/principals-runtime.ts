/**
 * principals-runtime.ts
 *
 * `/principals`, identity-mapping admin over `principals.*`: named
 * principals (people, bots, services, tokens) and the channel identities
 * ({channel, value} pairs, e.g. {channel:'slack', value:'U123'}) mapped to
 * them. Goes over the operator wire (see operator-rpc.ts) for the same
 * reason /ci and /checkin do: this verb family is not yet on the in-process
 * OperatorClient facade.
 *
 * `principals.resolve` is the honest lookup this command exists to make
 * reachable: an unmapped identity resolves to the shared "unknown" principal
 * with `known: false`, the registry never guesses, and this command never
 * papers over that with a name that looks real.
 */
import type { CommandRegistry } from '../command-registry.ts';
import { describeOperatorRpcError, getOperatorRpc } from './operator-rpc.ts';
import type { OperatorMethodOutput } from '@pellux/goodvibes-sdk';

type Principal = OperatorMethodOutput<'principals.list'>['principals'][number];
type PrincipalKind = Principal['kind'];

const PRINCIPAL_KINDS: readonly PrincipalKind[] = ['user', 'bot', 'service', 'token'];

function isPrincipalKind(value: string | undefined): value is PrincipalKind {
  return PRINCIPAL_KINDS.includes(value as PrincipalKind);
}

/** Parse `channel:value` tokens (e.g. `slack:U123`) into identity pairs. Skips malformed tokens. */
function parseIdentities(tokens: readonly string[]): Array<{ channel: string; value: string }> {
  const identities: Array<{ channel: string; value: string }> = [];
  for (const token of tokens) {
    const idx = token.indexOf(':');
    if (idx <= 0 || idx === token.length - 1) continue;
    identities.push({ channel: token.slice(0, idx), value: token.slice(idx + 1) });
  }
  return identities;
}

/** Extract `--flag value` pairs from an args array, returning the remaining positional tokens. */
function extractFlags(args: readonly string[], flagNames: readonly string[]): { flags: Map<string, string>; positional: string[] } {
  const flags = new Map<string, string>();
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const name = arg.startsWith('--') ? arg.slice(2) : null;
    if (name && flagNames.includes(name)) {
      const value = args[i + 1];
      if (value !== undefined) {
        flags.set(name, value);
        i++;
        continue;
      }
    }
    positional.push(arg);
  }
  return { flags, positional };
}

export function renderPrincipal(principal: Principal): string {
  const lines = [
    `  ${principal.id}  ${principal.name}  [${principal.kind}]`,
  ];
  if (principal.identities.length > 0) {
    lines.push(`    identities: ${principal.identities.map((i) => `${i.channel}:${i.value}`).join(', ')}`);
  } else {
    lines.push('    identities: (none)');
  }
  return lines.join('\n');
}

export function registerPrincipalsRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'principals',
    description: 'Identity mappings: named principals and their channel identities',
    usage: '[list|get <id>|create <name> <kind> [channel:value...]|update <id> [--name x] [--kind x] [--identities c:v,c:v]|delete <id>|resolve <channel> <value>]',
    argsHint: '[list|get|create|update|delete|resolve]',
    async handler(args, ctx) {
      const sub = args[0] ?? 'list';
      const knownSubcommands = ['list', 'get', 'create', 'update', 'delete', 'resolve'];
      if (!knownSubcommands.includes(sub)) {
        ctx.print(
          'Usage: /principals <subcommand>\n'
          + '  /principals list                                          — list every principal\n'
          + '  /principals get <id>                                      — show one principal\n'
          + '  /principals create <name> <user|bot|service|token> [channel:value...]\n'
          + '  /principals update <id> [--name x] [--kind x] [--identities c:v,c:v]\n'
          + '  /principals delete <id>                                   — permanently remove a principal\n'
          + '  /principals resolve <channel> <value>                     — resolve a sender identity to its principal, or "unknown principal"'
        );
        return;
      }

      // Validate each subcommand's required positional arguments before
      // touching the operator connection, so a usage mistake never depends
      // on daemon reachability to be reported.
      if (sub === 'get' && !args[1]) {
        ctx.print('Usage: /principals get <id>');
        return;
      }
      if (sub === 'create' && (!args[1] || !isPrincipalKind(args[2]))) {
        ctx.print(`Usage: /principals create <name> <${PRINCIPAL_KINDS.join('|')}> [channel:value...]`);
        return;
      }
      if (sub === 'update' && !args[1]) {
        ctx.print('Usage: /principals update <id> [--name x] [--kind user|bot|service|token] [--identities c:v,c:v]');
        return;
      }
      if (sub === 'delete' && !args[1]) {
        ctx.print('Usage: /principals delete <id>');
        return;
      }
      if (sub === 'resolve' && (!args[1] || !args[2])) {
        ctx.print('Usage: /principals resolve <channel> <value>');
        return;
      }

      const rpc = getOperatorRpc(ctx);
      if (!rpc.available) {
        ctx.print(`[principals] ${rpc.reason}`);
        return;
      }

      if (sub === 'list') {
        try {
          const { principals } = await rpc.sdk.operator.invoke('principals.list', {});
          if (principals.length === 0) {
            ctx.print('[principals] no principals registered.');
            return;
          }
          ctx.print(['Principals:', ...principals.map(renderPrincipal)].join('\n'));
        } catch (error) {
          ctx.print(`[principals list] ${describeOperatorRpcError(error)}`);
        }
        return;
      }

      if (sub === 'get') {
        const id = args[1]!;
        try {
          const { principal } = await rpc.sdk.operator.invoke('principals.get', { principalId: id });
          ctx.print(renderPrincipal(principal));
        } catch (error) {
          ctx.print(`[principals get] ${describeOperatorRpcError(error)}`);
        }
        return;
      }

      if (sub === 'create') {
        const name = args[1]!;
        const kind = args[2] as PrincipalKind;
        const identities = parseIdentities(args.slice(3));
        try {
          const { principal } = await rpc.sdk.operator.invoke('principals.create', { name, kind, identities });
          ctx.print(`[principals create] created ${principal.id}\n${renderPrincipal(principal)}`);
        } catch (error) {
          ctx.print(`[principals create] ${describeOperatorRpcError(error)}`);
        }
        return;
      }

      if (sub === 'update') {
        const id = args[1]!;
        const { flags } = extractFlags(args.slice(2), ['name', 'kind', 'identities']);
        const kind = flags.get('kind');
        if (kind !== undefined && !isPrincipalKind(kind)) {
          ctx.print(`Invalid --kind "${kind}". Valid values: ${PRINCIPAL_KINDS.join(', ')}`);
          return;
        }
        const identitiesRaw = flags.get('identities');
        try {
          const { principal } = await rpc.sdk.operator.invoke('principals.update', {
            principalId: id,
            ...(flags.has('name') ? { name: flags.get('name')! } : {}),
            ...(kind !== undefined ? { kind } : {}),
            ...(identitiesRaw !== undefined ? { identities: parseIdentities(identitiesRaw.split(',')) } : {}),
          });
          ctx.print(`[principals update] updated ${principal.id}\n${renderPrincipal(principal)}`);
        } catch (error) {
          ctx.print(`[principals update] ${describeOperatorRpcError(error)}`);
        }
        return;
      }

      if (sub === 'delete') {
        const id = args[1]!;
        try {
          const result = await rpc.sdk.operator.invoke('principals.delete', { principalId: id });
          ctx.print(result.deleted ? `[principals delete] deleted ${id}.` : `[principals delete] no principal found with id ${id}.`);
        } catch (error) {
          ctx.print(`[principals delete] ${describeOperatorRpcError(error)}`);
        }
        return;
      }

      if (sub === 'resolve') {
        const channel = args[1]!;
        const value = args[2]!;
        try {
          const result = await rpc.sdk.operator.invoke('principals.resolve', { channel, value });
          if (!result.known) {
            ctx.print(`[principals resolve] unknown principal: ${channel}:${value} is not mapped to any registered principal.`);
            return;
          }
          ctx.print(`[principals resolve] ${channel}:${value} -> ${result.principal.name}\n${renderPrincipal(result.principal)}`);
        } catch (error) {
          ctx.print(`[principals resolve] ${describeOperatorRpcError(error)}`);
        }
      }
    },
  });
}
