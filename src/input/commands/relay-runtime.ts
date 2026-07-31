import type { CommandContext } from '../command-registry.ts';
import type { CommandRegistry } from '../command-registry.ts';
import { generateQrMatrix, renderQrToString } from '@pellux/goodvibes-sdk/platform/pairing';
import { RELAY_STATE_NOT_READABLE_HERE } from '../../runtime/relay-reachability-bridge.ts';

/**
 * Register the /relay command — the relay's configuration, its reachability
 * state, and a QR-encodable pairing payload for the SDK's outbound
 * zero-knowledge relay (relay.* settings, gated by the `relay-connect` feature
 * flag).
 *
 * The CONFIGURATION half is read here, from this terminal's own config. The
 * LIVE half is not: registration state and pairing live in the running daemon's
 * memory (`DaemonServer.getRelayReachability()`), and no verb exposes either to
 * a client — so both read 'unavailable' with the reason said out loud rather
 * than a state this terminal is in no position to know. See
 * relay-reachability-bridge.ts.
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
  const live = ctx.platform.externalServices?.relayStatus() ?? 'unavailable';
  const state = live === 'registered' || live === 'disabled' || live === 'unavailable' ? live : 'offline';
  ctx.print([
    `Relay: ${state}`,
    `  rendezvous id: ${cfg.rendezvousId || '(not yet minted — start the daemon to generate one)'}`,
    `  url: ${cfg.url || '(not set)'}`,
    `  label: ${cfg.label || '(not set)'}`,
    state === 'unavailable'
      ? `  ${RELAY_STATE_NOT_READABLE_HERE}`
      : `  live connection state: ${live}`,
    '  The relay operator sees only ciphertext and connection metadata — self-host your own relay for full control.',
  ].join('\n'));
}

async function renderPair(ctx: CommandContext): Promise<void> {
  const cfg = relayConfigured(ctx);
  if (!cfg.enabled || !cfg.flagOn) {
    ctx.print('Relay is disabled — turn on relay.enabled in /config relay first.');
    return;
  }
  const externalServices = ctx.platform.externalServices;
  if (!externalServices) {
    ctx.print('Relay pairing is unavailable: background service controller is not running in this build.');
    return;
  }
  const minted = await externalServices.mintRelayPairing();
  if (!minted) {
    ctx.print(`Relay pairing cannot be minted from here. ${RELAY_STATE_NOT_READABLE_HERE}`);
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
