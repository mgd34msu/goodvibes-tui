export type {
  RawServerSentEventHandlers as ServerSentEventHandlers,
  RawServerSentEventOptions as ServerSentEventOptions,
} from '@pellux/goodvibes-sdk-beta/transport-http';
export { openRawServerSentEventStream as openServerSentEventStream } from '@pellux/goodvibes-sdk-beta/transport-http';

export function isAbortError(error: unknown): boolean {
  return (
    error instanceof DOMException && error.name === 'AbortError'
  ) || (
    typeof error === 'object'
    && error !== null
    && 'name' in error
    && (error as { readonly name?: string }).name === 'AbortError'
  );
}
