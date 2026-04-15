import { describe, expect, test } from 'bun:test';
import { DocsPanel } from '../../panels/docs-panel.ts';
import type { ToolRegistry } from '@pellux/goodvibes-sdk/platform/tools/registry';
import type { ProviderRegistry } from '../../providers/registry.ts';

function linesText(lines: ReturnType<DocsPanel['render']>): string {
  return lines.map((line) => line.map((cell) => cell.char ?? ' ').join('').trimEnd()).join('\n');
}

describe('DocsPanel', () => {
  test('renders shared workspace shell and tool docs', () => {
    const toolRegistry = {
      list: () => [
        {
          definition: {
            name: 'read',
            description: 'Read files from disk',
            sideEffects: [],
            concurrency: 'safe',
            supportsProgress: false,
            supportsStreamingOutput: false,
          },
        },
      ],
    } as unknown as ToolRegistry;
    const providerRegistry = {
      listModels: () => [],
    } as unknown as ProviderRegistry;

    const panel = new DocsPanel(toolRegistry, providerRegistry);
    panel.onActivate();
    const lines = panel.render(80, 18);
    const text = linesText(lines);
    expect(text).toContain('Docs / Tools');
    expect(text).toContain('read');
    expect(text).toContain('Read files from disk');
  });

  test('renders keyboard shortcut section', () => {
    const panel = new DocsPanel();
    panel.onActivate();
    panel.handleInput('k');
    const lines = panel.render(80, 18);
    const text = linesText(lines);
    expect(text).toContain('Keyboard Shortcuts');
    expect(text).toContain('Ctrl+C');
  });

  test('up at top focuses search before section hotkeys apply', () => {
    const panel = new DocsPanel();
    panel.onActivate();
    panel.handleInput('up');
    panel.handleInput('m');
    let text = linesText(panel.render(80, 18));
    expect(text).toContain('Search: m');
    expect(text).toContain('Docs / Tools');

    panel.handleInput('down');
    panel.handleInput('m');
    text = linesText(panel.render(80, 18));
    expect(text).toContain('Docs / Models');
  });
});
