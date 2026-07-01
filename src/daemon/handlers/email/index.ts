// ---------------------------------------------------------------------------
// Email handler surface composition root (IMAP / SMTP).
//
// Attaches host handlers to the SDK-registered builtin descriptors
// email.inbox.list / email.inbox.read / email.draft.create / email.send by id
// — it NEVER authors a descriptor or schema. The integration phase calls
// registerEmailMethods(ctx) exactly once and retains the returned Unregister.
//
// Confirmation posture: email.send is dangerous:true and is registered with
// { confirm: true } so the register wrapper enforces body.confirm===true AND
// explicitUserRequest. email.draft.create is access:admin (enforced by the SDK
// descriptor at dispatch) and carries no body.confirm in the SDK contract.
// ---------------------------------------------------------------------------

import type { HandlerContext } from '../context.ts';
import { registerCatalogHandlers, type Unregister } from '../register.ts';
import type { EmailMethodsOptions } from './config.ts';
import { createEmailRuntime } from './runtime.ts';
import { buildReadHandlerEntries } from './read-handlers.ts';
import { buildWriteHandlerEntries } from './write-handlers.ts';

export type { EmailMethodsOptions } from './config.ts';
export type { ImapClient, SmtpClient } from './config.ts';

/**
 * Register the email handler surface against the catalog held by `ctx`. Returns
 * an Unregister that removes every handler and disposes the draft store.
 */
export function registerEmailMethods(
  ctx: HandlerContext,
  options: EmailMethodsOptions = {},
): Unregister {
  const runtime = createEmailRuntime(ctx, options);
  const entries = [
    ...buildReadHandlerEntries(runtime),
    ...buildWriteHandlerEntries(runtime),
  ];
  const teardown = registerCatalogHandlers(ctx.catalog, entries);
  return () => {
    teardown();
    runtime.dispose();
  };
}
