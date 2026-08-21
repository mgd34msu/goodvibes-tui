/**
 * sandbox-exec-gate.ts, sandbox-aware layer over the exec approval ask.
 *
 * The per-command exec sandbox already RUNS boundary-safe commands inside a
 * bubblewrap boundary (the SDK exec tool's runner half). This is the APPROVAL
 * half: when the base permission policy would prompt ("ask") for an exec, and
 * the sandbox is genuinely active, a command that runs entirely inside the OS
 * boundary with no host-access need should auto-allow instead of prompting,
 * and a command that still needs host access should surface as an explicit ask
 * that NAMES what it wants ("wants network …", "wants host privilege
 * escalation").
 *
 * The decision is the SDK's `decideSandboxedExec`, never re-implemented here.
 * This module only (a) reads the live sandbox posture, (b) extracts the exec
 * command(s) from the request, (c) maps the SDK decision onto the existing ask
 * callback: allow → approve without prompting; ask → attach the named
 * escalations to the request so the approval card renders them, then delegate to
 * the underlying ask. Non-exec requests, and any request while the sandbox is
 * inactive, pass through byte-for-byte unchanged.
 *
 * This runs INSIDE the permission machinery's ask layer (like trustGatedAsk), so
 * it composes with the real layer chain and is only ever consulted for execs the
 * base policy already resolved to "ask", it can never turn a deny into an allow,
 * and the frozen catastrophic block is untouched.
 */
import { decideSandboxedExec } from '@pellux/goodvibes-sdk/platform/runtime/permissions/sandbox-policy';
import { detectSandboxAvailability, probeSandboxHost, type SandboxAvailability } from '@pellux/goodvibes-sdk/platform/tools/exec/sandbox';
import type {
  PermissionPromptRequest,
  PermissionPromptDecision,
} from '@pellux/goodvibes-sdk/platform/permissions';
import type { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import type { FeatureFlagManager } from '@/runtime/index.ts';
import { readSandboxExecList, SANDBOX_EGRESS_ALLOWLIST_CONFIG_KEY } from '../input/sandbox-exec-config.ts';

type AskCallback = (request: PermissionPromptRequest) => Promise<PermissionPromptDecision>;

/**
 * TUI-local metadata the gate attaches to an exec ask so the approval card can
 * render the sandbox posture and the named escalations. Carried as extra own
 * properties on the request object (they survive the broker → local-prompt
 * spread); the renderer reads them defensively.
 */
export interface SandboxAskAnnotation {
  /** True when the command(s) will run inside the boundary. */
  readonly sandboxed: boolean;
  /** Named host-access needs to show as the ask's escalations (from the SDK policy). */
  readonly sandboxEscalations: readonly string[];
}

export interface SandboxExecAskDeps {
  /** The graduation-gated `exec-sandbox` feature flag state (read live). */
  readonly isSandboxFeatureEnabled: () => boolean;
  /** The `sandbox.enabled` config switch (read live). */
  readonly isSandboxConfigEnabled: () => boolean;
  /** The `sandbox.egressAllowlist` command base names (read live). */
  readonly readEgressAllowlist: () => readonly string[];
  /**
   * Honest host availability of the exec sandbox backend. Probing the host spawns
   * bwrap, so the caller passes a memoized probe, invoked at most once, and only
   * when an exec ask actually arrives while the feature + config are on.
   */
  readonly detectAvailability: () => SandboxAvailability;
}

/**
 * Build the gate's live-reading dependencies from the runtime's config + feature
 * flags. The host probe (a bwrap spawn) is deferred to first use inside
 * createSandboxExecAsk, so the default path stays zero-cost until an exec ask
 * actually arrives with the sandbox turned on.
 */
export function sandboxExecAskDepsFromRuntime(
  configManager: Pick<ConfigManager, 'get' | 'getCategory'>,
  featureFlags: Pick<FeatureFlagManager, 'isEnabled'>,
): SandboxExecAskDeps {
  return {
    isSandboxFeatureEnabled: () => featureFlags.isEnabled('exec-sandbox'),
    isSandboxConfigEnabled: () => Boolean(configManager.getCategory('sandbox').enabled),
    readEgressAllowlist: () => readSandboxExecList(configManager, SANDBOX_EGRESS_ALLOWLIST_CONFIG_KEY),
    detectAvailability: () => detectSandboxAvailability(probeSandboxHost()),
  };
}

/** Pull the shell command string(s) out of an exec request's args. */
export function extractExecCommands(request: PermissionPromptRequest): string[] {
  const args = request.args ?? {};
  const out: string[] = [];
  if (Array.isArray(args.commands)) {
    for (const entry of args.commands) {
      if (typeof entry === 'string') out.push(entry);
      else if (entry && typeof entry === 'object' && typeof (entry as Record<string, unknown>).cmd === 'string') {
        out.push((entry as Record<string, string>).cmd);
      }
    }
  }
  if (typeof args.command === 'string') out.push(args.command);
  if (typeof args.cmd === 'string') out.push(args.cmd);
  return out.filter((c) => c.length > 0);
}

/** True for the shell-command tool whose asks the sandbox policy can relax. */
function isExecRequest(request: PermissionPromptRequest): boolean {
  return request.category === 'execute' && request.tool === 'exec';
}

/**
 * Wrap the permission machinery's ask callback with the sandbox-aware exec
 * policy. Only exec asks are considered; everything else delegates unchanged.
 */
export function createSandboxExecAsk(deps: SandboxExecAskDeps, ask: AskCallback): AskCallback {
  let cachedAvailability: SandboxAvailability | null = null;
  const availability = (): SandboxAvailability => {
    if (cachedAvailability === null) cachedAvailability = deps.detectAvailability();
    return cachedAvailability;
  };

  return (request) => {
    if (!isExecRequest(request)) return ask(request);
    const commands = extractExecCommands(request);
    if (commands.length === 0) return ask(request);

    // The sandbox is genuinely active only when the feature flag AND the config
    // switch are on AND the host can actually provide a boundary.
    const featureAndConfig = deps.isSandboxFeatureEnabled() && deps.isSandboxConfigEnabled();
    const sandboxActive = featureAndConfig && availability().available;
    if (!sandboxActive) return ask(request);

    const egressAllowlist = deps.readEgressAllowlist();
    const decisions = commands.map((command) =>
      decideSandboxedExec({ command, sandboxActive: true, egressAllowlist, baseEffectWhenNotSandboxed: 'ask' }),
    );

    // A batch auto-allows only when EVERY command is boundary-safe. If any needs
    // host access, the whole ask surfaces with the union of named escalations.
    if (decisions.every((decision) => decision.effect === 'allow')) {
      return Promise.resolve({ approved: true });
    }

    const escalations = dedupe(decisions.flatMap((decision) => decision.escalations));
    return ask(annotateExecAsk(request, { sandboxed: true, sandboxEscalations: escalations }));
  };
}

function dedupe(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/** Attach the sandbox annotation to a copy of the request (never mutate the original). */
function annotateExecAsk(
  request: PermissionPromptRequest,
  annotation: SandboxAskAnnotation,
): PermissionPromptRequest {
  return Object.assign({}, request, annotation);
}

/** Read the sandbox annotation off a request, if the gate attached one. */
export function readSandboxAskAnnotation(request: unknown): SandboxAskAnnotation | null {
  if (!request || typeof request !== 'object') return null;
  const candidate = request as Partial<SandboxAskAnnotation>;
  if (candidate.sandboxed !== true || !Array.isArray(candidate.sandboxEscalations)) return null;
  return { sandboxed: true, sandboxEscalations: candidate.sandboxEscalations };
}
