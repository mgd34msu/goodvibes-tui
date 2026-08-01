// Deliberately per-repo test scaffolding, byte-identical to the sibling product's copy by design: it binds to this repo's own working tree, source layout and Bun test lifecycle, so a shared home would mean inventing a test-only published package rather than hoisting anything.
export function createAuthenticatedWebSocket(token: string): typeof WebSocket {
  class AuthenticatedWebSocket extends WebSocket {
    constructor(url: string | URL) {
      super(url, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      } as unknown as string | string[]);
    }
  }

  return AuthenticatedWebSocket as unknown as typeof WebSocket;
}
