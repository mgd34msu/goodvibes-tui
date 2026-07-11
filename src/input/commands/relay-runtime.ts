import type { CommandContext } from '../command-registry.ts';
import type { CommandRegistry } from '../command-registry.ts';
import { generateQrMatrix, renderQrToString } from '@pellux/goodvibes-sdk/platform/pairing';

/**
 * Register the /relay command — reachability status and QR-encodable pairing
 * for the SDK's outbound zero-knowledge relay (relay.* settings, gated by the
 * `relay-connect` feature flag). The live registration state lives only in
 * the running daemon's memory (`DaemonServer.getRelayReachability()`), reached
 * here through `ctx.platform.externalServices` — see relay-reachability-bridge.ts.
 */

function relayConfigured(ctx: CommandContext): { enabled: boolean; url: string; rendezvousId: string; label: string; flagOn: boolean } {
  const config = ctx.platform.configManager;
  return {
    enabled: config.get('relay.enabled') === true,
    url: String(config.get('relay.url') ?? ''),
    rendezvousId: String(config.get('relay.rendezvousId') ?? ''),
    label: String(config.get('relay.label') ?? ''),
    flagOn: ctx.platform.featureFlagManager?.isEnabled('relay-connect') ?? false,
  };
}

async function renderStatus(ctx: CommandContext): Promise<void> {
  const cfg = relayConfigured(ctx);
  if (!cfg.enabled || !cfg.flagOn) {
    ctx.print([
      'Relay: disabled',
      `  relay.enabled: ${cfg.enabled ? 'yes' : 'no'}`,
      `  relay-connect flag: ${cfg.flagOn ? 'on' : 'off'}`,
      '  Both must be on for outbound relay reachability. See /config relay.',
    ].join('\n'));
    return;
  }
  const live = ctx.platform.externalServices?.relayStatus() ?? 'disabled';
  const state = live === 'registered' ? 'registered' : live === 'disabled' ? 'disabled' : 'offline';
  ctx.print([
    `Relay: ${state}`,
    `  rendezvous id: ${cfg.rendezvousId || '(not yet minted — start the daemon to generate one)'}`,
    `  url: ${cfg.url || '(not set)'}`,
    `  label: ${cfg.label || '(not set)'}`,
    `  live connection state: ${live}`,
    '  The relay operator sees only ciphertext and connection metadata — self-host your own relay for full control.',
  ].join('\n'));
}

async function renderPair(ctx: CommandContext): Promise<void> {
  const cfg = relayConfigured(ctx);
  if (!cfg.enabled || !cfg.flagOn) {
    ctx.print('Relay is disabled — enable relay.enabled and the relay-connect feature flag first (see /config relay, /flags).');
    return;
  }
  const externalServices = ctx.platform.externalServices;
  if (!externalServices) {
    ctx.print('Relay pairing is unavailable: background service controller is not running in this build.');
    return;
  }
  const minted = await externalServices.mintRelayPairing();
  if (!minted) {
    ctx.print('Could not mint a relay pairing payload — the relay connection may not be registered yet. Check /relay status.');
    return;
  }
  const qrMatrix = generateQrMatrix(minted.encoded);
  ctx.print([
    'Relay pairing payload (scan with a companion app, or copy the string below):',
    '',
    minted.encoded,
    '',
    renderQrToString(qrMatrix),
  ].join('\n'));
}

export function registerRelayRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'relay',
    description: 'Outbound relay reachability status, or mint a QR-encodable pairing payload',
    usage: '[status|pair]',
    argsHint: '[status|pair]',
    async handler(args, ctx) {
      const sub = args[0]?.toLowerCase();
      if (sub === 'pair') return renderPair(ctx);
      if (sub === undefined || sub === 'status') return renderStatus(ctx);
      ctx.print(`Unknown /relay subcommand: ${sub}. Use: status | pair`);
    },
  });
}
