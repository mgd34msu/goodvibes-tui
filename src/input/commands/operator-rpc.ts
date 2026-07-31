/**
 * operator-rpc.ts — the command layer's handle on the daemon.
 *
 * The resolution itself (is the daemon enabled, what base URL, what bearer)
 * moved to runtime/client/operator-endpoint.ts when the terminal app became a
 * pure client: the runtime seams — approvals, config, credentials, sessions,
 * fleet, tasks, devices, checkpoints — all need the same answer, and two copies
 * of it is how one call ended up on a DirectTransport while another made a real
 * request. This module keeps the command-context-shaped entry point and
 * re-exports the rest so no command import site had to change.
 *
 * Every command verb is now a real HTTP round-trip to the configured
 * control-plane daemon; there is no in-process catalog left to answer one.
 */
export {
  describeOperatorRpcError,
  resolveOperatorRpc,
  type OperatorRpc,
  type OperatorRpcAvailable,
  type OperatorRpcUnavailable,
} from '../../runtime/client/operator-endpoint.ts';

import { resolveOperatorRpc } from '../../runtime/client/operator-endpoint.ts';
import type { OperatorRpc } from '../../runtime/client/operator-endpoint.ts';
import type { CommandContext } from '../command-registry.ts';
import { requireShellPaths } from './runtime-services.ts';

/**
 * Resolve (or honestly refuse to resolve) an operator SDK client wired to this
 * workspace's control-plane daemon. Reasons for refusal are surfaced verbatim
 * to the caller so commands print them directly rather than inventing their own
 * wording.
 */
export function getOperatorRpc(context: CommandContext): OperatorRpc {
  return resolveOperatorRpc({
    configManager: context.platform.configManager,
    // Lazy: only resolved once the daemon-enabled + base-URL refusals pass, so a
    // disabled-daemon context with no shell paths still returns the honest reason.
    homeDirectory: () => requireShellPaths(context).homeDirectory,
  });
}
