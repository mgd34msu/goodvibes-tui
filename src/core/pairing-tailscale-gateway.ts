// ---------------------------------------------------------------------------
// pairing-tailscale-gateway.ts
//
// The two tailscale verbs the pairing surfaces drive — a read-only detection
// (tailscale.get) and the one-action serve (tailscale.serve.run) — over the
// same generic operator invoke path the fleet acts use (resolveOperatorRpc ->
// sdk.operator.invoke), reaching the SAME daemon the command layer does.
//
// Both thunks degrade QUIETLY: when no daemon is reachable, the probe resolves
// to null (the pairing surface renders no tailscale affordance at all) rather
// than throwing into a render path. Absence is never a nag.
// ---------------------------------------------------------------------------

import type { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import { resolveOperatorRpc } from '../input/commands/operator-rpc.ts';
import type {
  PairingTailscaleServeReceipt,
  PairingTailscaleStatus,
} from '../panels/modals/pairing-modal.ts';

export interface PairingTailscaleGatewayDeps {
  readonly configManager: ConfigManager;
  readonly homeDirectory: string | (() => string);
}

/**
 * Probe tailscale (tailscale.get). Returns the honest status, or null when the
 * daemon is unreachable / the call fails — the pairing surface then stays quiet.
 */
export async function probePairingTailscale(
  deps: PairingTailscaleGatewayDeps,
): Promise<PairingTailscaleStatus | null> {
  const rpc = resolveOperatorRpc(deps);
  if (!rpc.available) return null;
  try {
    return (await rpc.sdk.operator.invoke('tailscale.get', {})) as PairingTailscaleStatus;
  } catch {
    return null;
  }
}

/**
 * Run tailscale.serve.run and return its receipt. Null when the daemon is
 * unreachable; a failed serve returns a receipt with `ok:false` and an honest
 * detail (never a throw the surface has to guess about).
 */
export async function runPairingTailscaleServe(
  deps: PairingTailscaleGatewayDeps,
): Promise<PairingTailscaleServeReceipt | null> {
  const rpc = resolveOperatorRpc(deps);
  if (!rpc.available) return null;
  const result = (await rpc.sdk.operator.invoke('tailscale.serve.run', {})) as {
    readonly receipt: PairingTailscaleServeReceipt;
  };
  return result.receipt;
}
