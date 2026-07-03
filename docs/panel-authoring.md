# Panel Authoring Guide

This guide is the on-ramp for contributors who want to extend goodvibes-tui with a new panel. It covers the class hierarchy, the canonical implementation pattern used by the 22+ built-in panels, rendering utilities, input handling, performance instrumentation, and contract testing.

## Table of Contents

1. [Overview](#overview)
2. [Base class tree](#base-class-tree)
3. [Canonical example — SkillsPanel](#canonical-example--skillspanel)
4. [Palette convention](#palette-convention)
5. [Rendering patterns](#rendering-patterns)
6. [Performance](#performance)
7. [Input handling](#input-handling)
8. [Contract test registration](#contract-test-registration)
9. [Common pitfalls](#common-pitfalls)
10. [See also](#see-also)

---

## Overview

A **panel** is a full-terminal-area view that the panel manager renders into a grid of `Line` objects (arrays of styled cells). Each panel is responsible for two things:

- **Rendering** — given `(width, height)`, returning exactly `height` `Line` values, each with exactly `width` cells.
- **Input** — consuming or forwarding keyboard events.

Panels live in `src/panels/`. The panel manager (`src/panels/panel-manager.ts`) owns lifetime (activate, deactivate, destroy) and routes key events. The compositor calls `render()` only when `needsRender` is true.

**When to create a new panel:** When you need a distinct, full-area view that the user can navigate to. If you need a floating overlay or inline component, use a different abstraction.

---

## Base class tree

```
BasePanel  (src/panels/base-panel.ts)
  └── ScrollableListPanel<T>  (src/panels/scrollable-list-panel.ts)
```

`ScrollableListPanel<T>` has an opt-in `'/'`-to-filter affordance (`filterEnabled`,
`filterMatches()`) that coexists with single-letter action keys — see
[Opt-in filter](#opt-in-filter) below. There is no separate always-on-search base class;
WO-153 converged the former `SearchableListPanel<T>` (which intercepted every printable
keystroke as search input, with no modal on/off state) onto this same modal `'/'` filter so
every list panel shares one filter interaction.

### `BasePanel`

The minimal contract every panel satisfies. Extend this directly for panels with custom, non-list layouts (dashboards, detail views, diff viewers).

**Constructor:**
```ts
constructor(
  public readonly id: string,
  public readonly name: string,
  public readonly icon: string,
  public readonly category: PanelCategory,
  componentHealthMonitor?: ComponentHealthMonitor,
)
```

**Lifecycle hooks** (override as needed):

| Method | When called | Default |
|--------|-------------|--------|
| `onActivate()` | Panel becomes the active view | Sets `needsRender = true` |
| `onDeactivate()` | Panel loses focus | No-op |
| `onDestroy()` | Panel is removed from the manager | No-op |

**Required abstract:**
```ts
abstract render(width: number, height: number): Line[];
```

**Dirt / invalidation helpers:**

- `this.needsRender = true` / `this.markDirty()` — request a re-render.
- `this.invalidate()` — same, callable from outside (compositor contract).
- `this.markRendered()` — called by compositor after a successful render.

**Error surface (I2 slot):**

- `this.setError(msg)` — surface a transient error (bold red, auto-cleared on next keystroke when using `ScrollableListPanel`).
- `this.clearError()` — clear manually.
- `this.renderErrorLine(width)` — returns a `Line | null` for use in your footer.

**Loading spinner (I3 slot):**

- `this.startLoading(label?)` / `this.stopLoading()` — control visibility.
- `await this.withLoading(label, fn)` — run an async operation under the spinner (clears on success or throw).
- `this.renderLoadingLine(width, frame?)` — returns a `Line | null`.

---

### `ScrollableListPanel<T>`

Extend this when your panel displays a flat list of items the user scrolls through. Handles all navigation keys (up/down/j/k, page, g/G, home/end, enter) and scroll-window tracking internally.

**Required abstracts:**

```ts
protected abstract getItems(): readonly T[];
protected abstract renderItem(
  item: T,
  index: number,
  selected: boolean,
  width: number,
): Line;
```

**Optional overrides:**

| Method | Purpose | Default |
|--------|---------|--------|
| `getEmptyStateMessage()` | Title text when list is empty | `'No items'` |
| `getEmptyStateActions()` | Suggested commands in empty state | `[]` |
| `onSelect(item)` | Called on Enter | No-op |
| `onAction(item, action)` | Secondary key bindings | No-op |
| `getPalette()` | Domain colour palette | `DEFAULT_PANEL_PALETTE` |
| `getPageSize()` | Rows per page-up/down | `10` |

**Selection gutter:**

Set `this.showSelectionGutter = true` in the constructor to prepend a `▸ ` gutter on the selected row. All 22 list panels enable this for a non-color selection affordance.

**Rendering:**

```ts
render(width: number, height: number): Line[] {
  return this.renderList(width, height, {
    header: this.buildHeader(width),
    footer: this.buildFooter(width),
    title: 'My Panel',
  });
}
```

`renderList()` handles: scroll-window calculation, empty state, loading spinner, error line injection, and padding to exactly `height` rows.

After data changes, call `this.clampSelection()` to keep `selectedIndex` in bounds.

---

### Opt-in filter

Set `this.filterEnabled = true` in the constructor and override `filterMatches()` to give a
list panel a `'/'`-to-filter affordance that coexists with single-letter action keys —
filtering is modal: action keys work until you press `/`; while the filter is active,
every printable character (including ones that are action keys outside filter mode) extends
the query instead.

```ts
protected filterMatches(item: T, q: string): boolean;
```

`q` arrives already trimmed and lower-cased. `getItems()` stays the **unfiltered** list — do
not filter inside it. `getVisibleItems()` (inherited, not overridable) applies `filterMatches()`
against `getItems()` and is what `renderList()` and navigation actually read; anywhere your own
code previously read a filtered list (e.g. computing counts, or looking up "the selected item"
for an action key), call `this.getVisibleItems()[this.selectedIndex]`, not `getItems()[...]`.

A filter input line is auto-rendered at the top of `renderList()`'s header for free — you do
not need to build or pass it yourself. Set `this.filterLabel` (default `'Filter'`) for a
domain-specific noun, e.g. `'Filter tasks'`.

**Key contract** (implemented once, in `ScrollableListPanel`, shared by every filterable panel):

| State | Key | Effect |
|-------|-----|--------|
| inactive | `/` | Activate the filter |
| active | printable char | Append to `filterQuery`, reset `selectedIndex` to `0` |
| active | `backspace` / `delete` | Remove last character |
| active | `escape` | Deactivate and clear `filterQuery` |
| active | `return` / `enter` | Deactivate, **keep** `filterQuery` (commit) |
| active | `up` / `down` / `pageup` / `pagedown` / `home` / `end` | Fall through to normal navigation |

Single-letter action keys (`d` for delete, `r` for reload, etc.) must guard on
`!this.filterActive` so they keep working outside filter mode but get typed into the query
while it's active:

```ts
if (!this.filterActive && key === 'd') {
  const item = this.getVisibleItems()[this.selectedIndex];
  // ...
}
```

**Pinned rendering contract:** `Filter: query` when inactive, `[Filter] query_` when active
(literal trailing `_`, not a block-glyph cursor substitution). This is `buildFilterLine()` —
call it directly only if you need the line somewhere other than the auto-injected header slot
(e.g. `PanelListPanel`, `DocsPanel`, and `FileExplorerPanel` build their own equivalent because
they don't extend `ScrollableListPanel`; see those files for the pattern to mirror in a
non-list-panel class).

---

## Canonical example — SkillsPanel

Adapted from `src/panels/skills-panel.ts` — see `src/panels/memory-panel.ts` for the canonical `extendPalette` usage.

### Step 1 — palette constant

```ts
import { DEFAULT_PANEL_PALETTE, extendPalette } from './polish.ts';

// All hex colors live here. Never inline raw hex in render methods.
const C = extendPalette(DEFAULT_PANEL_PALETTE, {
  project:    '#38bdf8',
  global:     '#a78bfa',
  hint:       '#475569',
  path:       '#94a3b8',
  // Override base keys as needed:
  header:     '#94a3b8',
  headerBg:   '#1e293b',
  // Conventional domain extensions for selected-row coloring:
  selectedFg: '#e2e8f0',
  selectedBg: '#1e3a5f',
} as const);
```

`extendPalette` merges domain keys into a copy of `DEFAULT_PANEL_PALETTE` and preserves the `Readonly<Required<PanelPalette>>` shape that rendering utilities expect.

### Step 2 — type and class declaration

```ts
import { ScrollableListPanel } from './scrollable-list-panel.ts';

export interface SkillRecord {
  name: string;
  description: string;
  origin: 'project-local' | 'global';
  path: string;
  // ...
}

export class SkillsPanel extends ScrollableListPanel<SkillRecord> {
  private cached: SkillRecord[] | null = null;
  private cacheDirty = true;

  constructor(options: SkillsPanelOptions) {
    super('skills', 'Skills', '▩', 'automation-control', options.componentHealthMonitor);
    this.showSelectionGutter = true; // non-color selection affordance
    this.filterEnabled = true;       // opt-in modal '/' filter
    this.filterLabel = 'Filter';
  }

  // ...
}
```

The four positional arguments to `super()` are `id`, `name`, `icon` (single char for tab display), and `category`.

### Step 3 — implement required abstracts

```ts
protected getItems(): readonly SkillRecord[] {
  if (this.cached === null || this.cacheDirty) {
    this.cached = discoverSkills(this.shellPaths);
    this.cacheDirty = false;
  }
  return this.cached;
}

// q arrives already trimmed + lower-cased from getVisibleItems().
protected override filterMatches(skill: SkillRecord, q: string): boolean {
  return [skill.name, skill.description, skill.origin]
    .join(' ').toLowerCase().includes(q);
}

protected renderItem(
  skill: SkillRecord,
  _index: number,
  selected: boolean,
  width: number,
): Line {
  const bg = selected ? C.selectBg : undefined;
  return buildPanelLine(width, [
    [selected ? '▸' : ' ', C.selectedFg, bg],
    [' ', C.dim, bg],
    [skill.name, selected ? C.selectedFg : C.value, bg],
    ['  ', C.dim, bg],
    [skill.description, selected ? C.selectedFg : C.dim, bg],
  ]);
}
```

### Step 4 — override optional hooks

```ts
protected override getPalette() { return C; }
protected override getEmptyStateMessage() { return ' No skills discovered.'; }
protected override getEmptyStateActions() {
  return [
    { command: '.goodvibes/skills/', summary: 'place .md skill files here' },
  ];
}

public override onActivate(): void {
  super.onActivate(); // sets needsRender = true
  this.filterQuery = '';
  this.filterActive = false;
  this.cacheDirty = true;
}
```

### Step 5 — render

```ts
public render(width: number, height: number): Line[] {
  return this.trackedRender(() => {
    this.needsRender = false;

    // Detail footer for currently selected item. getVisibleItems() applies
    // the active filter — getItems() above stays the unfiltered full list.
    const items = this.getVisibleItems();
    const selected = items[this.selectedIndex];
    const footerLines: Line[] = [];
    if (selected) {
      footerLines.push(
        buildPanelLine(width, [['  Path: ', C.label], [selected.path, C.path]]),
      );
    }
    footerLines.push(
      buildPanelLine(width, [['  Up/Down navigate  / filter  Esc clear', C.hint]]),
    );

    // Filter input line is auto-injected by renderList() (filterEnabled=true).
    return this.renderList(width, height, {
      title: 'Skills',
      footer: footerLines,
    });
  });
}
```

`trackedRender(() => { ... })` wraps the body with throttle-check, wall-clock measurement, and stale-lines caching. See [Performance](#performance).

### Step 6 — input handling

```ts
public handleInput(key: string): boolean {
  // Panel-specific action key — guarded so it still types into the filter
  // query while the filter is active (WO-153: modal '/' filter coexists
  // with single-letter action keys).
  if (!this.filterActive && key === 'r') {
    this.cacheDirty = true;
    this.markDirty();
    return true;
  }

  // Navigation + filter: delegate to ScrollableListPanel ('/' activates the
  // filter, typing narrows, Esc clears, up/down/g/G/page/enter navigate).
  return super.handleInput(key);
}
```

---

## Palette convention

Raw hex colors must never appear inline inside `renderItem()`, `buildHeader()`, or any other render method. Instead:

1. Define a module-level `const C = extendPalette(DEFAULT_PANEL_PALETTE, { ... })` at the top of the file.
2. Reference `C.someKey` inside render methods.
3. Override `getPalette()` to return `C` so `renderList()` picks up the domain colors.

```ts
// BAD — inline hex
buildPanelLine(width, [[skill.name, '#38bdf8']]);

// GOOD — palette reference
buildPanelLine(width, [[skill.name, C.project]]);
```

`PanelPalette` fields:

| Field | Role |
|-------|------|
| `label` | Key text, secondary labels |
| `value` | Primary value text |
| `dim` | De-emphasized text |
| `info` | Info accent / selection highlight |
| `good` | Success state |
| `warn` | Warning state |
| `bad` | Error / critical state |
| `empty` | Empty-state text |
| `header` / `headerBg` | Panel title bar |
| `surfaceBg` | Panel body background |
| `inputBg` | Filter input background |
| `selectBg` | Selected row background |
| `accent` | Decorative accent |
| `sectionBg` | Section header background (workspace panels) |
| `summaryBg` | Summary/footer row background (workspace panels) |

> **Note:** `selectedFg` and `selectedBg` are conventional domain extensions — not fields on the base `PanelPalette`. Add them to your `extendPalette(...)` call when your `renderItem()` needs explicit foreground/background colors for the selected row.

---

## Rendering patterns

All helpers are exported from `src/panels/polish.ts`.

### `buildPanelLine(width, segments)`

Primary building block. Accepts an array of `[text, fg, bg?]` tuples or `StyledPanelSegment` objects. Concatenates them into a single `Line` padded/truncated to `width`.

```ts
buildPanelLine(width, [
  ['  ', C.dim],
  [item.name, selected ? C.selectedFg : C.value, selected ? C.selectBg : undefined],
  ['  ', C.dim],
  [item.status, C.good],
]);
```

### `buildStatusPill(state, label, opts?)`

Builds a status token (glyph + color) as a segment array for embedding inside `buildPanelLine`:

```ts
const pill = buildStatusPill('good', 'active');
buildPanelLine(width, [...pill, ['  ', C.dim], [item.name, C.value]]);
```

Valid `state` values: `'good'` | `'warn'` | `'bad'` | `'idle'` | `'loading'`.

### `buildFilterLine(width)` (`ScrollableListPanel` method)

Renders the filter input row from `this.filterLabel` / `this.filterActive` / `this.filterQuery`.
`renderList()` calls this automatically and prepends it to the header when
`this.filterEnabled = true` — you normally never call it directly. Panels that don't extend
`ScrollableListPanel` (`PanelListPanel`, `DocsPanel`, `FileExplorerPanel`) build the equivalent
line by hand; copy their `_buildFilterLine` private helper rather than reinventing the format.

- Active: `[Filter] query_` — bracketed, literal trailing `_` cursor.
- Inactive: `Filter: query` — dim, no cursor.

### `renderConfirmLines(width, state)` (`src/panels/confirm-state.ts`)

Renders a confirmation dialog. Use when a destructive action requires y/n:

```ts
import { type ConfirmState, handleConfirmInput, renderConfirmLines } from './confirm-state.ts';

// In handleInput:
const result = handleConfirmInput(this.confirm, key);
if (result === 'confirmed') { /* execute action */ this.confirm = null; }
if (result === 'cancelled') { this.confirm = null; }
if (result === 'absorbed') return true;

// In render:
if (this.confirm) {
  const lines = buildPanelWorkspace(width, height, {
    title: 'Panel — confirm action',
    sections: [{ title: 'Confirmation', lines: renderConfirmLines(width, this.confirm) }],
    palette: C,
  });
  while (lines.length < height) lines.push(createEmptyLine(width));
  return lines.slice(0, height);
}
```

By default the prompt reads `Delete "<label>"?`. Non-destructive confirms (cancel, regenerate,
promote) should set `verb` to the honest action word instead of borrowing "Delete" copy:

```ts
this.confirm = { subject: agentId, label: agentName, verb: 'Cancel' };
// renders: Cancel "agentName"?
```

`verb` is optional and defaults to `'Delete'`; the confirm/cancel keybinding contract
(`y`/`enter`/`return` confirms, `n`/`escape` cancels, all other keys absorbed) is unchanged.

---

## Performance

The health monitor (`ComponentHealthMonitor`) tracks render duration per panel and throttles expensive panels automatically.

### Recommended: use `trackedRender`

```ts
public render(width: number, height: number): Line[] {
  return this.trackedRender(() => {
    // ... all render logic ...
    return lines;
  });
}
```

`trackedRender` wraps the body with:
1. `canRenderNow()` — skips the body and returns the cached last lines when throttled.
2. Wall-clock timing.
3. `reportRenderDuration(ms)` — feeds the health monitor.

If throttled, the cached stale lines are returned to avoid flicker.

### Manual instrumentation

If you cannot wrap the entire body (e.g., the panel has multiple early-return paths):

```ts
public render(width: number, height: number): Line[] {
  if (!this.canRenderNow()) return this._lastLines ?? [];
  const start = Date.now();
  // ... render logic ...
  this.reportRenderDuration(Date.now() - start);
  return lines;
}
```

### Guidelines

- Keep `renderItem()` pure — no side effects, no I/O.
- Data fetching belongs in `onActivate()` or triggered by key events, not inside `render()`.
- Enable `showSelectionGutter = true` for all flat-list panels.

---

## Input handling

`ScrollableListPanel.handleInput()` already handles:

| Key(s) | Action |
|--------|-------|
| `up` / `k` | Move selection up |
| `down` / `j` | Move selection down |
| `pageup` | Jump up by `getPageSize()` rows |
| `pagedown` | Jump down by `getPageSize()` rows |
| `home` / `g` | Jump to first item |
| `end` / `G` | Jump to last item |
| `return` / `enter` | Call `onSelect(item)` |

When `this.filterEnabled = true`, `ScrollableListPanel.handleInput()` additionally handles the
modal filter (see [Opt-in filter](#opt-in-filter) for the full key contract):

| State | Key | Action |
|-------|-----|-------|
| inactive | `/` | Activate the filter |
| active | printable char | Append to `filterQuery` |
| active | backspace / delete | Remove last char from `filterQuery` |
| active | escape | Deactivate and clear `filterQuery` |
| active | return / enter | Deactivate, keep `filterQuery` |

**Override pattern:** Handle panel-specific action keys first (guarded on `!this.filterActive`
if the panel has a filter), then call `super.handleInput(key)` for the rest:

```ts
public handleInput(key: string): boolean {
  // Panel-specific keys FIRST — guard on !this.filterActive if this panel
  // has an opt-in filter, so the key still types into the query while active.
  if (!this.filterActive && key === 'r') { this.refresh(); return true; }
  if (!this.filterActive && key === 'd') { this.confirmDelete(); return true; }

  // Base class handles navigation and (if filterEnabled) the modal filter.
  return super.handleInput(key);
}
```

**Auto-clear error contract:** `ScrollableListPanel.handleInput()` calls `this.clearError()` at the top of every invocation. If you override `handleInput()` without calling `super.handleInput()`, call `this.clearError()` manually at the top of your handler to maintain this contract.

**Panels that don't extend `ScrollableListPanel`:** if you need the same modal filter contract
in a `BasePanel` subclass, mirror the private `_handleFilterKey(key): boolean | null` helper in
`PanelListPanel` / `DocsPanel` / `FileExplorerPanel` — it returns `true`/`false` when the key is
consumed/ignored in filter context, or `null` to fall through to your panel's own navigation and
action keys.

### Action-callback plumbing pattern

Panels get real services (not just read-only snapshots) through `ResolvedBuiltinPanelDeps`
(`src/panels/builtin/shared.ts`). Bootstrap wires the already-constructed runtime singletons —
`opsApi`, `planRuntime`, `watcherRegistry`, `runtimeStore`, `approvalBroker`, `sessionBroker`,
`automationManager`, `openAgentDetail`, `openPanel`, etc. — onto this single deps object, and
each `registerXPanels(manager, deps)` factory forwards exactly the slice a panel needs into its
constructor (see `CockpitPanel`'s `openAgentDetail` forwarding in
`src/panels/builtin/operations.ts` for the established shape).

**Rule: no signpost where an action is possible.** If a real service reachable from `deps` can
perform the action, bind a key to it directly. Never render a panel line like
`Run: /automation run <id>` when `deps.opsApi`/`deps.automationManager` (or the panel-specific
manager method) is already available in the factory closure.

Two dispatch paths cover nearly every case:

1. **Direct service call** — call the bound service method straight from `handleInput()`:

   ```ts
   public handleInput(key: string): boolean {
     if (key === 'c') { this.deps.opsApi?.cancel(this.selectedId); return true; }
     return super.handleInput(key);
   }
   ```

2. **`handlePanelIntegrationAction(key, ctx)`** — for cross-panel navigation or dispatching a
   command through the shared command pipeline. Implement this optional `Panel` hook
   (`src/panels/types.ts`); the router in `src/input/panel-integration-actions.ts` calls it
   BEFORE its own `instanceof` fallback chain, so new panels never need an `instanceof` addition
   there:

   ```ts
   public handlePanelIntegrationAction(key: string, ctx: PanelIntegrationContext): boolean {
     if (key === 'enter') {
       ctx.panelManager.open('agent-inspector'); // direct panel jump — never print "/panel open …"
       return true;
     }
     if (key === 'r' && ctx.executeCommand) {
       void ctx.executeCommand('automation', ['run', this.selectedJobId]);
       return true;
     }
     return false;
   }
   ```

   `ctx.executeCommand(name, args)` dispatches through the same `CommandRegistry` path the
   prompt uses; `ctx.panelManager.open(id)` (or the equivalent `deps.openPanel(id)` callback)
   performs a direct panel jump. Both are always preferable to printing a command string for the
   user to retype.

---

## Contract test registration

Every new panel must be added to `src/test/panels/migrated-panels-contract.test.ts`.

The test parameterizes over a `PANELS` array of `PanelEntry` objects:

```ts
type PanelEntry = {
  readonly label: string;
  readonly factory: () => BasePanel;
  readonly hasSelectionGutter?: boolean;
};
```

For each entry, the test suite verifies:

1. `render(W, H)` returns exactly `H` lines.
2. Every line in the result has exactly `W` cells.
3. `needsRender` starts `true`.
4. `handleInput()` with navigation keys returns a `boolean`.
5. `loadingState` starts `'idle'`.
6. (If `hasSelectionGutter: true`) `showSelectionGutter` is `true`.

**Minimum scaffolding for a simple panel:**

```ts
// Add to the PANELS array:
{
  label: 'MyPanel',
  factory: () => new MyPanel({ someService: EMPTY_SOME_SERVICE }),
  hasSelectionGutter: true,
},
```

For panels with complex dependencies, define a minimal mock constant above the `PANELS` array following the pattern already in the file (shape-only mocks using `as unknown as ImportedType`):

```ts
const EMPTY_SOME_SERVICE = {
  list: () => [],
  subscribe: (_cb: () => void) => () => {},
} as unknown as import('../../runtime/my-service.ts').MyService;
```

---

## Common pitfalls

| Pitfall | Fix |
|---------|-----|
| Re-implementing scroll state with `selectedIndex` / `scrollStart` manually | Don't — both are in `ScrollableListPanel`. Call `clampSelection()` after data changes. |
| Inlining hex colors in `renderItem()` | Move all colors to the module-level `const C = extendPalette(...)` palette. |
| Calling `render()` directly from `handleInput()` | Never — set `this.needsRender = true` (or call `this.markDirty()`) and let the compositor schedule the render. |
| Not wrapping expensive renders with `trackedRender` | Panels that read large data structures on every render will be throttled aggressively without health instrumentation. |
| Subscribing to registry events in the constructor | Subscribe in `onActivate()` and unsubscribe in `onDeactivate()` to avoid zombie listeners. |
| Reading `getItems()` where you want the filtered list | `getItems()` is always the unfiltered full list. Read `getVisibleItems()` for the filtered/displayed set (used by `renderList()`, navigation, and any "selected item" lookup for an action key). |
| Forgetting to add the panel to the contract test | All panels in `src/panels/` must have a corresponding entry in `migrated-panels-contract.test.ts`. |
| Rendering an action as printed text (e.g. `Run: /automation run <id>`) instead of binding a key to the real service already in `deps` | Bind the key directly, or implement `handlePanelIntegrationAction` to dispatch via `ctx.executeCommand` / `ctx.panelManager.open`. See "Action-callback plumbing pattern" under Input handling. |

---

## See also

- `src/panels/base-panel.ts` — `BasePanel` source with inline JSDoc for all lifecycle and render helpers.
- `src/panels/scrollable-list-panel.ts` — `ScrollableListPanel<T>` source, including the opt-in modal filter (`filterEnabled`, `_handleFilterKey`, `buildFilterLine`).
- `src/panels/polish.ts` — All rendering utility functions and `PanelPalette` type definition.
- `src/panels/skills-panel.ts` — Canonical `ScrollableListPanel` + opt-in filter implementation used throughout this guide.
- `src/panels/memory-panel.ts` — A `ScrollableListPanel` example where the filter is only enabled in one of two view modes (`filterEnabled` toggled per mode).
- `src/panels/panel-list-panel.ts`, `src/panels/docs-panel.ts`, `src/panels/file-explorer-panel.ts` — Panels that mirror the same modal filter contract without extending `ScrollableListPanel` (each has its own private `_handleFilterKey` / `_buildFilterLine`).
- `src/panels/confirm-state.ts` — `ConfirmState`, `handleConfirmInput`, `renderConfirmLines`.
- `src/panels/search-focus.ts` — `isPanelSearchBackspace`, `isPanelSearchPrintable`, plus `isPanelSearchCancel`/`isPanelSearchCommit`/`getPanelSearchFocusTransition` (retained for panels outside the WO-153 filter convergence, e.g. `knowledge-graph-panel.ts`, `session-browser-panel.ts`, `git-panel.ts`).
- `src/panels/builtin-panels.ts` — How built-in panels are grouped into categories and registered with the `PanelManager`.
- `src/test/panels/migrated-panels-contract.test.ts` — Contract test suite; add a `PanelEntry` here for every new panel.
