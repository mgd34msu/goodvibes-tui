/**
 * surface.ts — the TUI's single surface-root identifier.
 *
 * Every piece of the TUI's own on-disk state (sessions, the last-session
 * pointer, recovery snapshots, checkpoints, the transcript journal, the
 * multi-instance liveness markers) lives under `.goodvibes/tui/`. That scope
 * segment used to be spelled as a bare `'tui'` string literal at each call
 * site, which is how a writer and a reader ended up disagreeing about where
 * the last-session pointer lives: one call passed the scope, another omitted
 * it and silently resolved to the shared, unscoped `.goodvibes/` directory,
 * so `--continue` looked at an empty file forever.
 *
 * The constant below is the one place that name is written for the session /
 * recovery / checkpoint domain. It feeds `createSessionSurface` in
 * runtime/services.ts, which resolves every path once at startup into the
 * `SessionSurface` handle threaded through the rest of the runtime. Other
 * subsystems (config storage, sandbox scaffolding, keybindings, and so on)
 * still write their own `'tui'` surface-root segment at their own call
 * sites; this constant is not (yet) the single source for all of them.
 */
export const GOODVIBES_TUI_SURFACE_ROOT = 'tui';
