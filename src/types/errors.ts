/** HTTP status codes that indicate transient failures eligible for retry. Single source of truth. */
export const RETRYABLE_STATUS_CODES: readonly number[] = [429, 500, 503];

/** Base class for all application errors. Provides a machine-readable code and recoverability hint. */
export class AppError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly recoverable: boolean
  ) {
    super(message);
    this.name = this.constructor.name;
  }
}

/** Thrown when configuration is invalid or cannot be loaded. Non-recoverable. */
export class ConfigError extends AppError {
  constructor(message: string) {
    super(message, 'CONFIG_ERROR', false);
  }
}

/** Thrown when an LLM provider API call fails. Recoverable when statusCode is in RETRYABLE_STATUS_CODES. */
export class ProviderError extends AppError {
  constructor(message: string, public readonly statusCode?: number) {
    super(message, 'PROVIDER_ERROR', statusCode !== undefined && RETRYABLE_STATUS_CODES.includes(statusCode));
  }
}

/** Thrown when a tool execution fails. Recoverable by default. */
export class ToolError extends AppError {
  constructor(message: string, public readonly toolName: string) {
    super(message, 'TOOL_ERROR', true);
  }
}

/** Thrown for ACP (Agent Control Protocol) errors. Recoverable by default. */
export class AcpError extends AppError {
  constructor(message: string) {
    super(message, 'ACP_ERROR', true);
  }
}

/** Thrown when an operation is denied due to insufficient permissions. Non-recoverable. */
export class PermissionError extends AppError {
  constructor(message: string) {
    super(message, 'PERMISSION_DENIED', false);
  }
}

/** Thrown when the renderer encounters a failure. Recoverable by default. */
export class RenderError extends AppError {
  constructor(message: string) {
    super(message, 'RENDER_ERROR', true);
  }
}
