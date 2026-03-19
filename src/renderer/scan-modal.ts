import { type Line } from '../types/grid.ts';
import { ModalFactory } from './modal-factory.ts';
import type { ScanResult } from '../discovery/scanner.ts';

/**
 * renderScanModal — Render scan state or results as a modal overlay (Line[]).
 *
 * @param result    Completed scan result, or null while scanning.
 * @param scanning  True while scan is in progress.
 * @param width     Full terminal width (passed to ModalFactory).
 */
export function renderScanModal(
  result: ScanResult | null,
  scanning: boolean,
  width: number,
): Line[] {
  // ── Scanning in progress ────────────────────────────────────────────────────
  if (scanning && result === null) {
    return ModalFactory.createModal(
      {
        title: 'Scanning for Local LLMs...',
        sections: [
          {
            type: 'text',
            content: 'Probing localhost and subnet for LLM servers...',
          },
        ],
      },
      width,
    );
  }

  // ── Results ready ───────────────────────────────────────────────────────────
  const servers = result?.servers ?? [];
  const count = servers.length;
  const title = `Local LLM Servers (${count} found)`;

  if (count === 0) {
    return ModalFactory.createModal(
      {
        title,
        sections: [
          {
            type: 'text',
            content: 'No local LLM servers detected.',
          },
          {
            type: 'text',
            content: 'Start Ollama, LM Studio, or another local server, then run /scan again.',
            style: { dim: true },
          },
        ],
        hints: ['[Esc] Close'],
      },
      width,
    );
  }

  // Each server gets two rows: name label + detail text
  return ModalFactory.createModal(
    {
      title,
      sections: [
        {
          type: 'list',
          items: servers.map((server) => ({
            label: `${server.name}  ·  ${server.models.length} model(s)  ·  ${server.host}:${server.port}`,
          })),
        },
      ],
      hints: ['[Enter] Select model', '[Esc] Close'],
    },
    width,
  );
}
