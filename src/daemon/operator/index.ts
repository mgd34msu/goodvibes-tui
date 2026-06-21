// Foundation barrel for the daemon operator-method scaffolding.
// Surfaces import only from here, from src/config/*, and from the SDK.

export type {
  OperatorAccess,
  OperatorTransport,
  OperatorEffect,
  OperatorMethodDescriptor,
  CatalogMethodDescriptor,
  OperatorInvocation,
  OperatorHandler,
  OperatorLogger,
  OperatorContext,
  Unregister,
  SurfaceRegister,
  InboundChannelItem,
  ChannelRoute,
  DraftRecord,
  CalendarEventSummary,
} from './types.ts';
export { OperatorError, REQUIRE_CONFIRM, sha256First, redactWebhook } from './types.ts';

export {
  declareOperatorMethod,
  declareOperatorMethods,
  assertConfirmed,
} from './register-helper.ts';

export { OperatorSqliteStore } from './sqlite-store.ts';
export type { OperatorSqliteOptions } from './sqlite-store.ts';

export {
  createDaemonCredentialStore,
  createAtRestCipher,
} from './credential-store.ts';
export type { DaemonCredentialStore, AtRestCipher } from './credential-store.ts';

// NOTE: `registerDaemonOperatorSurfaces` / `DaemonOperatorSurfaces` are NOT
// re-exported here. `surfaces.ts` is the composition root that imports every
// surface register module; re-exporting it from this foundation barrel would
// make any leaf module that imports the barrel transitively pull in the whole
// surface graph, forming an import cycle. The composition root (services.ts)
// imports them directly from './surfaces.ts'.
