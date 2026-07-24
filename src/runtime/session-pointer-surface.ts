import { writeLastSessionPointer } from '@/runtime/index.ts';
import type { SessionSurface } from '@/runtime/index.ts';

/**
 * Binds the SDK's two-argument `writeLastSessionPointer(sessionId, options?)`
 * to one `SessionSurface`, returning a plain `(sessionId: string) => void`.
 *
 * Never pass the raw SDK function reference into a `(sessionId: string) =>
 * void` slot. A function with an extra optional parameter is structurally
 * assignable there, so it type-checks, but every downstream caller
 * (bootstrap-shell.ts -> bootstrap-hook-bridge.ts's resume handler) invokes
 * it with exactly one argument: `options` arrives as `undefined`, the legacy
 * compat path's `requireWorkingDirectory(undefined)` throws, and
 * `writeLastSessionPointer`'s own try/catch swallows that into a logged
 * warning. The pointer file then silently never gets written after a resume,
 * and the next launch's `--continue` / boot notice sees nothing. That was the
 * live defect at bootstrap.ts's `createBootstrapShell({ writeLastSessionPointer })`
 * call. See session-surface-pointer-journey.test.ts for the on-disk proof.
 */
export function bindWriteLastSessionPointerToSurface(surface: SessionSurface): (sessionId: string) => void {
  return (sessionId: string): void => writeLastSessionPointer(sessionId, { surface });
}
