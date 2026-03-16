/**
 * renderServiceModal — renders the /services modal as Line[] using ModalFactory.
 *
 * Shows a list of registered services with:
 *   - name, baseUrl (truncated), authType, token status
 *   - test status indicator
 * Footer hints: [a] Add  [e] Edit  [d] Delete  [t] Test  [Esc] Close
 */

import { type Line } from '../types/grid.ts';
import { ModalFactory } from './modal-factory.ts';
import type { ServiceModal, ServiceEntry } from '../input/service-modal.ts';

// ---------------------------------------------------------------------------
// Status indicators
// ---------------------------------------------------------------------------

const AUTH_ICON: Record<string, string> = {
  bearer: 'bearer',
  basic: 'basic',
  'api-key': 'api-key',
};

function tokenBadge(entry: ServiceEntry): string {
  return entry.hasToken ? '\u2713 token' : '\u2717 no token';
}

function testBadge(entry: ServiceEntry): string {
  switch (entry.testStatus) {
    case 'pending': return '\u22ef testing';
    case 'ok':      return `\u2713 ${entry.testCode ?? ''}`;
    case 'error':   return `\u2717 ${entry.testCode ?? entry.testError ?? 'err'}`;
    default:        return ''; // idle
  }
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

/**
 * Render the service modal as Line[] for overlay in the viewport.
 *
 * @param modal  ServiceModal state object.
 * @param width  Terminal width.
 */
export function renderServiceModal(
  modal: ServiceModal,
  width: number,
): Line[] {
  const boxMargin = 4;
  const maxBoxW = 76;
  const boxW = Math.min(width - boxMargin * 2, maxBoxW);
  // contentW: inside borders + 1-space padding each side
  const contentW = boxW - 4;

  // Column widths: name(16) | baseUrl(remaining) | authType(9) | status(10)
  const nameW = 16;
  const authW = 9;
  const testW = 12;
  const urlW = Math.max(8, contentW - nameW - authW - testW - 6); // 6 = separators/spaces

  const sections: import('./modal-factory.ts').ModalSection[] = [];

  if (modal.entries.length === 0) {
    sections.push({
      type: 'text',
      content: 'No services configured.',
      style: { fg: '244', dim: true },
    });
    sections.push({
      type: 'text',
      content: 'Add services to .goodvibes/tui/services.json',
      style: { fg: '240', dim: true },
    });
  } else {
    // Column header
    const nameHdr = 'Name'.padEnd(nameW);
    const urlHdr  = 'BaseURL'.padEnd(urlW);
    const authHdr = 'Auth'.padEnd(authW);
    const statHdr = 'Status'.padEnd(testW);
    const header  = `${nameHdr}  ${urlHdr}  ${authHdr}  ${statHdr}`;
    sections.push({
      type: 'text',
      content: header,
      style: { fg: '240', dim: true },
    });
    sections.push({ type: 'separator' });

    // Service rows as list items
    const items: import('./modal-factory.ts').ModalListItem[] = modal.entries.map((entry, idx) => {
      const isSelected = idx === modal.selectedIndex;

      const nameStr = entry.key.length > nameW
        ? entry.key.slice(0, nameW - 1) + '\u2026'
        : entry.key.padEnd(nameW);

      const url = entry.config.baseUrl ?? '(none)';
      const urlStr = url.length > urlW
        ? url.slice(0, urlW - 1) + '\u2026'
        : url.padEnd(urlW);

      const authStr = (AUTH_ICON[entry.config.authType] ?? entry.config.authType).padEnd(authW);

      const badge = entry.testStatus !== 'idle'
        ? testBadge(entry)
        : tokenBadge(entry);
      const statStr = badge.length > testW
        ? badge.slice(0, testW - 1) + '\u2026'
        : badge.padEnd(testW);

      const label = `${nameStr}  ${urlStr}  ${authStr}  ${statStr}`;
      return {
        label,
        selected: isSelected,
      };
    });

    sections.push({ type: 'list', items });
  }

  return ModalFactory.createModal(
    {
      title: 'Services',
      width: boxW,
      margin: boxMargin,
      sections,
      hints: ['[\u2191\u2193] Navigate', '[t] Test', '[Esc] Close'],
    },
    width,
  );
}
