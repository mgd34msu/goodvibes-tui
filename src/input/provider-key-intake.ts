/**
 * Provider key intake — capture a provider's API key at the moment the user
 * selects an unconfigured provider or model, store it through the secrets
 * manager (never env-only, never cleartext into config or provider JSON), let
 * the provider re-register live, then complete the user's original selection.
 *
 * The decision of whether a key is needed is read from the provider's own
 * registration-time auth state (describeAuthState / isConfigured) — never a
 * hardcoded vendor list — so this works for any provider the registry knows
 * accepts a key. The secrets-store key name is the provider's declared auth env
 * var; it is used only as the storage key and is never shown to the user.
 */

import type { LLMProvider } from '@pellux/goodvibes-sdk/platform/providers';
import type { ConcealedInputRequest } from './concealed-input.ts';
import type { CommandContext } from './command-registry.ts';
import { summarizeError } from '@pellux/goodvibes-sdk/platform/utils';

/** The intake decision derived purely from a provider's registration truth. */
export interface ProviderKeyIntakeDecision {
  /** True when the provider accepts a key and does not yet have one. */
  readonly needsKey: boolean;
  /** Secrets-store key to write the value under (the provider's auth env var). */
  readonly secretKey?: string;
  /** True when the provider already has a credential (no prompt needed). */
  readonly alreadyConfigured: boolean;
}

/**
 * Decide whether to prompt for a key, reading only the provider's own auth
 * state. A provider that is already configured, works anonymously, or declares
 * no accepted env var is left alone (proceed straight through). A provider that
 * does not declare an auth state at all is treated per isConfigured(), and an
 * unknown state is assumed configured so a working selection is never nagged.
 */
export function decideProviderKeyIntake(provider: LLMProvider | undefined): ProviderKeyIntakeDecision {
  if (!provider) return { needsKey: false, alreadyConfigured: false };
  const state = provider.describeAuthState?.();
  if (state) {
    if (state.configured) return { needsKey: false, alreadyConfigured: true };
    if (state.anonymousReady) return { needsKey: false, alreadyConfigured: false };
    const secretKey = state.authEnvVars[0];
    if (secretKey) return { needsKey: true, secretKey, alreadyConfigured: false };
    return { needsKey: false, alreadyConfigured: false };
  }
  const configured = provider.isConfigured?.() ?? true;
  return { needsKey: false, alreadyConfigured: configured };
}

/** Human-facing name for a provider — plain, vendor-neutral, never an env var. */
export function providerIntakeLabel(providerId: string): string {
  return `the ${providerId} provider`;
}

/** Dependencies the intake orchestrator needs, decoupled from the command context for testing. */
export interface ProviderKeyIntakeDeps {
  /** The provider instance whose registration-time auth state drives the decision. */
  readonly provider: LLMProvider | undefined;
  /** Canonical secret store — the same path /secrets set writes through. */
  readonly secretsManager?: {
    set(key: string, value: string, options?: { scope?: 'project' | 'user'; medium?: 'secure' | 'plaintext' }): Promise<void>;
  } | undefined;
  /** Re-resolves credentials and re-registers providers live (no restart). */
  readonly refreshProviderCredentials?: (() => Promise<void>) | undefined;
  /** Begins one line of concealed composer input for the key. */
  readonly beginConcealedInput?: ((request: ConcealedInputRequest) => void) | undefined;
  /** Surfaces short status lines to the transcript. */
  readonly print: (text: string) => void;
}

/**
 * If the selected provider needs a key, open the concealed prompt, store the
 * pasted value through the secrets manager, re-register the provider live, then
 * run `proceed` (the user's original selection). If no key is needed — or the
 * concealed surface is unavailable — `proceed` runs immediately. `proceed`
 * always runs exactly once, including when the user skips (empty/Escape), so a
 * selection is never stranded.
 */
export function runProviderKeyIntake(
  providerId: string,
  deps: ProviderKeyIntakeDeps,
  proceed: () => void,
): void {
  const decision = decideProviderKeyIntake(deps.provider);
  if (!decision.needsKey || !decision.secretKey) {
    proceed();
    return;
  }
  const { secretsManager, beginConcealedInput } = deps;
  if (!secretsManager || !beginConcealedInput) {
    // No canonical store or no concealed surface here — keep the selection
    // rather than blocking it; the user can add the key via /secrets set later.
    proceed();
    return;
  }
  const secretKey = decision.secretKey;
  const label = providerIntakeLabel(providerId);
  let completed = false;
  const finishOnce = (): void => {
    if (completed) return;
    completed = true;
    proceed();
  };
  deps.print(`Enter the API key for ${label} (input is masked; press Enter to store, Esc to skip).`);
  beginConcealedInput({
    label: providerId,
    onSubmit: (value) => {
      if (value.length === 0) {
        deps.print(`No key entered for ${label}; selection kept, no key stored.`);
        finishOnce();
        return;
      }
      void (async () => {
        try {
          await secretsManager.set(secretKey, value, { scope: 'user', medium: 'secure' });
          await deps.refreshProviderCredentials?.();
          deps.print(`Stored the API key for ${label} and registered it live (value hidden). No restart needed.`);
        } catch (error) {
          deps.print(`Could not store the key for ${label}: ${summarizeError(error)}`);
        }
        finishOnce();
      })();
    },
    onCancel: () => {
      deps.print(`Key entry skipped for ${label}; selection kept, no key stored.`);
      finishOnce();
    },
  });
}

/**
 * Command-context adapter for {@link runProviderKeyIntake}: resolves the live
 * provider, secrets manager, live re-registration hook, and concealed-input
 * surface from the shell command context, then runs the intake before
 * completing the user's original selection (`proceed`).
 */
export function ensureProviderKeyThenSelect(
  ctx: CommandContext,
  providerId: string,
  proceed: () => void,
): void {
  // Resolve the live provider defensively: a command context that routes only
  // through the provider API (no raw registry access) leaves the intake a no-op
  // and the selection completes unchanged.
  let registry: CommandContext['provider']['providerRegistry'] | undefined;
  let provider: ReturnType<CommandContext['provider']['providerRegistry']['tryGet']> | undefined;
  try {
    registry = ctx.provider?.providerRegistry;
    provider = registry?.tryGet?.(providerId);
  } catch {
    registry = undefined;
    provider = undefined;
  }
  runProviderKeyIntake(
    providerId,
    {
      provider,
      secretsManager: ctx.platform?.secretsManager,
      refreshProviderCredentials: registry
        ? () => registry!.refreshProviderCredentials()
        : undefined,
      beginConcealedInput: ctx.beginConcealedInput,
      print: (text) => ctx.print(text),
    },
    proceed,
  );
}
