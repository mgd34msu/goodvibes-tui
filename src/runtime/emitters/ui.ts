/**
 * UI emitters — typed wrappers for UIEvent domain.
 */

import { createEventEnvelope } from '@pellux/goodvibes-sdk/platform/runtime/events/envelope';
import type { RuntimeEventEnvelope } from '@pellux/goodvibes-sdk/platform/runtime/events/envelope';
import type { RuntimeEventBus } from '@pellux/goodvibes-sdk/platform/runtime/events/index';
import type { UIEvent } from '@pellux/goodvibes-sdk/platform/runtime/events/ui';
import type { EmitterContext } from '@pellux/goodvibes-sdk/platform/runtime/emitters/index';

function uiEvent<T extends UIEvent['type']>(
  type: T,
  data: Omit<Extract<UIEvent, { type: T }>, 'type'>,
  ctx: EmitterContext,
): RuntimeEventEnvelope<T, Extract<UIEvent, { type: T }>> {
  return createEventEnvelope(type, { type, ...data } as Extract<UIEvent, { type: T }>, ctx);
}

export function emitUiRenderRequest(bus: RuntimeEventBus, ctx: EmitterContext): void {
  bus.emit('ui', uiEvent('UI_RENDER_REQUEST', {}, ctx));
}

export function emitUiScrollDelta(bus: RuntimeEventBus, ctx: EmitterContext, data: { delta: number }): void {
  bus.emit('ui', uiEvent('UI_SCROLL_DELTA', data, ctx));
}

export function emitUiScrollTo(bus: RuntimeEventBus, ctx: EmitterContext, data: { line: number }): void {
  bus.emit('ui', uiEvent('UI_SCROLL_TO', data, ctx));
}

export function emitUiBlockToggleCollapse(bus: RuntimeEventBus, ctx: EmitterContext, data: { blockIndex: number }): void {
  bus.emit('ui', uiEvent('UI_BLOCK_TOGGLE_COLLAPSE', data, ctx));
}

export function emitUiBlockRerun(bus: RuntimeEventBus, ctx: EmitterContext, data: { blockIndex: number; content: string }): void {
  bus.emit('ui', uiEvent('UI_BLOCK_RERUN', data, ctx));
}

export function emitUiClearScreen(bus: RuntimeEventBus, ctx: EmitterContext): void {
  bus.emit('ui', uiEvent('UI_CLEAR_SCREEN', {}, ctx));
}

export function emitUiPanelOpen(bus: RuntimeEventBus, ctx: EmitterContext, data: { panelId: string }): void {
  bus.emit('ui', uiEvent('UI_PANEL_OPEN', data, ctx));
}

export function emitUiPanelClose(bus: RuntimeEventBus, ctx: EmitterContext, data: { panelId: string }): void {
  bus.emit('ui', uiEvent('UI_PANEL_CLOSE', data, ctx));
}

export function emitUiPanelFocus(bus: RuntimeEventBus, ctx: EmitterContext, data: { panelId: string }): void {
  bus.emit('ui', uiEvent('UI_PANEL_FOCUS', data, ctx));
}

export function emitUiViewChanged(bus: RuntimeEventBus, ctx: EmitterContext, data: { from: string; to: string }): void {
  bus.emit('ui', uiEvent('UI_VIEW_CHANGED', data, ctx));
}
