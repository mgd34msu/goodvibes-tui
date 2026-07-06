import { describe, expect, test } from 'bun:test';
import { GatewayMethodCatalog } from '@pellux/goodvibes-sdk/platform/control-plane';
import { registerCatalogHandler } from '../../../daemon/handlers/register.ts';
import { HandlerError } from '../../../daemon/handlers/errors.ts';

/**
 * W6-C4: registerCatalogHandler's "descriptor not in the catalog" guard used to
 * throw a locally-coined `'UNKNOWN_METHOD'` code. It now emits `'METHOD_NOT_FOUND'`
 * so it lines up byte-for-byte with the SDK's own SDKErrorCodes.METHOD_NOT_FOUND
 * (the code the SDK's uncataloged-method 404 carries, once the SDK pin catches up)
 * — no consumer of this daemon should ever have to distinguish two spellings of
 * the same "this method id isn't cataloged" condition.
 *
 * Deliberately a literal string comparison, not an import of SDKErrorCodes: the
 * pinned SDK (0.38.0) predates that constant, and the whole point of aligning by
 * value is that it needs no SDK version bump to stay true.
 */
describe('registerCatalogHandler — uncataloged methodId', () => {
  test('throws HandlerError with code METHOD_NOT_FOUND (not the old UNKNOWN_METHOD), status 404', () => {
    const catalog = new GatewayMethodCatalog({ includeBuiltins: false });

    let caught: unknown;
    try {
      registerCatalogHandler(catalog, 'w6-c4.definitely-not-a-real-method', async () => ({}));
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(HandlerError);
    const handlerError = caught as HandlerError;
    expect(handlerError.code).toBe('METHOD_NOT_FOUND');
    expect(handlerError.code).not.toBe('UNKNOWN_METHOD');
    expect(handlerError.status).toBe(404);
    expect(handlerError.message).toContain('w6-c4.definitely-not-a-real-method');
  });
});
