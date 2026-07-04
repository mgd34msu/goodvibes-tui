import type { Line } from '../types/grid.ts';
import { ModalFactory, type ModalSection, type ModalTab } from './modal-factory.ts';
import { activeUiTones } from './theme.ts';
import type { ConfigModal, ConfigModalRenderModel } from '../input/config-modal.ts';

/**
 * renderConfigModal — the single render path for every ConfigModalSurface.
 * Reads the host's frozen-structure-plus-live-values render model and maps it
 * onto ModalFactory.createModal (the same renderer settings-modal uses), so the
 * chrome, tab strip, list, and footer are one dialect across all migrated
 * surfaces. Pure: takes the modal's render model, returns Line[].
 */
export function renderConfigModal(modal: ConfigModal, width: number, height: number): Line[] {
  // Size the visible row window to the available height so the list scrolls
  // rather than overflowing (posture header + separator + chrome ≈ 8 rows).
  const visible = Math.max(3, Math.min(16, height - 8));
  modal.setViewportRows(visible);
  const model = modal.getRenderModel();
  return renderConfigModalModel(model, width);
}

/** Pure model→Line[] mapping — the shared inner step of renderConfigModal. */
function renderConfigModalModel(model: ConfigModalRenderModel, width: number): Line[] {
  // Read the active-mode chrome tones per call (this render path is not on a
  // hot loop; the modal renders once per keystroke).
  const TONES = activeUiTones();
  const sections: ModalSection[] = [];

  if (model.degraded) {
    sections.push({ type: 'text', content: `⚠ ${model.degraded}`, style: { fg: TONES.state.warn, bold: true } });
    sections.push({ type: 'separator' });
  }

  for (const line of model.header) {
    sections.push({ type: 'text', content: line, style: { fg: TONES.fg.secondary } });
  }
  if (model.header.length > 0) sections.push({ type: 'separator' });

  if (model.rows.length === 0) {
    sections.push({ type: 'text', content: model.emptyText ?? 'Nothing to show.', style: { fg: TONES.fg.muted, dim: true } });
  } else {
    sections.push({
      type: 'list',
      items: model.rows.map((row) => ({
        label: row.label,
        selected: row.selected,
        style: row.stale
          ? { fg: TONES.fg.muted, dim: true }
          : row.style,
      })),
    });
  }

  const tabs: ModalTab[] | undefined = model.tabs.length > 1
    ? model.tabs.map((t) => ({ label: t.label, active: t.active }))
    : undefined;

  // Keep the content region a stable height so live-value ticks never change
  // the box size: frozen header + separator + the fixed visible-row window.
  const targetContentRows =
    (model.degraded ? 2 : 0) +
    model.header.length +
    (model.header.length > 0 ? 1 : 0) +
    model.scroll.visible;

  const helpers = model.status
    ? [{ content: model.status, accent: true }]
    : undefined;

  return ModalFactory.createModal(
    {
      title: model.title,
      width: 76,
      tabs,
      sections,
      targetContentRows,
      helpers,
      hints: [...model.hints],
    },
    width,
  );
}
