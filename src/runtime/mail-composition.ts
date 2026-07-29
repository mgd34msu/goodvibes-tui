/**
 * mail-composition.ts
 *
 * The deps that let the platform register this daemon's `email.*` verbs.
 *
 * `calendar.*` and `email.*` are served by the platform now, not by handlers in
 * this repository — those were deleted when the platform gained an
 * implementation the daemon could call. What is left for a product to supply is
 * the wiring, and it is not optional: without `homeDirectory` the calendar
 * composition returns null, without these deps the mail one does, and either way
 * the verbs stay cataloged-but-unhandled while every surface reports the daemon
 * unreachable on a daemon that is working perfectly.
 *
 * Extracted from services.ts rather than living there, because that file sits at
 * the 800-line architecture cap and a composition step is exactly the kind of
 * thing the cap exists to push into a module of its own.
 */

import {
  withSurfaceEmailConfig,
  describeSurfaceEmailConfigProblem,
  describeSenderClaimNeutrally,
  type EmailServiceDeps,
  type SurfaceEmailConfigProblem,
} from '@pellux/goodvibes-sdk/platform/email';
import { nodeEmailTransport } from '@pellux/goodvibes-sdk/platform/email/node';

/** The narrow slices this composition needs; the real managers satisfy them. */
interface MailCompositionInput {
  readonly configManager: { get(key: never): unknown };
  readonly secretsManager: { get(key: string): Promise<string | null> };
}

/**
 * Build the mail deps and the not-configured describer that go to
 * `registerGatewayVerbGroups`.
 *
 * The settings come from the daemon's own `surfaces.email.*` keys through
 * `withSurfaceEmailConfig`, so the keys an operator has already set — and that
 * the settings modal now shows — keep working unchanged, and a not-configured
 * answer names the keys THIS operator actually has rather than the ones the
 * service validates internally.
 */
export function composeMailDeps(input: MailCompositionInput): {
  readonly emailServiceDeps: EmailServiceDeps;
  readonly describeEmailConfigProblem: () => Promise<SurfaceEmailConfigProblem | null>;
} {
  const getConfig = (key: string): unknown => input.configManager.get(key as never);
  const emailServiceDeps = withSurfaceEmailConfig({
    getConfig,
    secretsManager: input.secretsManager,
    transport: nodeEmailTransport,
    // The daemon has no wording of its own for a sender line, so it takes the
    // platform's rather than growing a second implementation of a rule that is
    // security-relevant: a From: header is a claim, sender authentication
    // raises display confidence only, and commandAuthority is the literal
    // 'none'.
    describeSenderClaim: describeSenderClaimNeutrally,
  } as never);
  return {
    emailServiceDeps,
    describeEmailConfigProblem: () =>
      describeSurfaceEmailConfigProblem(getConfig, input.secretsManager),
  };
}
