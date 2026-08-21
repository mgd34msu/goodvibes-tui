/**
 * Number of fixed chrome lines in the model-picker overlay (title + search + divider + detail×2 + footer).
 * Used by callers to compute maxVisible item rows.
 *
 * this file used to also hold `renderModelPickerOverlay`, the
 * overlay-style model-picker renderer. It was superseded by
 * `renderModelWorkspace` (model-workspace.ts), conversation-overlays.ts
 * routes `input.modelPicker.active` there, not here, and had no remaining
 * non-test import site, so it (and its dedicated unit/golden tests) were
 * removed. This constant is still live: handler-picker-routes.ts uses it to
 * size the current workspace's visible-row window.
 */
export const MODEL_PICKER_CHROME_LINES = 7;
