/**
 * Error type for daemon handler execution. Carries a stable machine `code`
 * and an HTTP `status` so the control-plane dispatcher can map failures to
 * wire responses without leaking implementation detail.
 */
export class HandlerError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'HandlerError';
  }
}

/** Code emitted when a confirmation-gated method is invoked without explicit user confirmation. */
export const REQUIRE_CONFIRM = 'REQUIRE_CONFIRM';
