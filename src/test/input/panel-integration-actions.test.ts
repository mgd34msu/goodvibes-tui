import { afterEach, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handlePanelIntegrationAction } from '../../input/handler.ts';
import { FileExplorerPanel } from '../../panels/file-explorer-panel.ts';
import { FilePreviewPanel } from '../../panels/file-preview-panel.ts';
import { SymbolOutlinePanel } from '../../panels/symbol-outline-panel.ts';
import { ApprovalPanel } from '../../panels/approval-panel.ts';
import { createTestManagers } from '../helpers/test-managers.ts';

let panelManager = createTestManagers().panelManager;

// SymbolOutlinePanel.loadFile() parses via a background tree-sitter query
// (WASM), so tests that need parsed symbols poll until getSelectedLocation()
// resolves rather than asserting synchronously right after loadFile().
async function waitForSymbolLocation(
  panel: SymbolOutlinePanel,
  timeoutMs = 2000,
): Promise<{ path: string; line: number } | null> {
  const start = Date.now();
  let location = panel.getSelectedLocation();
  while (location === null && Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 10));
    location = panel.getSelectedLocation();
  }
  return location;
}

describe('panel integration actions', () => {
  afterEach(() => {
    panelManager.destroyAll();
    mock.restore();
  });

  test('explorer selection opens the file in preview and syncs symbols', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gv-panel-bridge-'));
    const filePath = join(root, 'demo.ts');
    writeFileSync(filePath, 'export function alpha() {}\nexport const beta = 1;\n');

    panelManager = createTestManagers().panelManager;
    panelManager.registerType({
      id: 'preview',
      name: 'Preview',
      icon: 'P',
      category: 'development',
      description: 'preview',
      factory: () => new FilePreviewPanel(),
    });
    panelManager.registerType({
      id: 'symbols',
      name: 'Symbols',
      icon: 'S',
      category: 'development',
      description: 'symbols',
      factory: () => new SymbolOutlinePanel(),
    });

    const symbolsPanel = panelManager.open('symbols', 'top');
    expect(symbolsPanel).toBeInstanceOf(SymbolOutlinePanel);

    const explorer = new FileExplorerPanel(root, root);
    explorer.onActivate();
    await explorer.awaitReady();

    expect(handlePanelIntegrationAction(panelManager, explorer, 'enter')).toBe(true);

    const preview = panelManager.getPanel('preview');
    expect(preview).toBeInstanceOf(FilePreviewPanel);
    expect((preview as FilePreviewPanel).getCurrentFilePath()).toBe(filePath);

    const symbols = panelManager.getPanel('symbols');
    expect(symbols).toBeInstanceOf(SymbolOutlinePanel);
    const location = await waitForSymbolLocation(symbols as SymbolOutlinePanel);
    expect(location).toEqual({ path: filePath, line: 1 });

    rmSync(root, { recursive: true, force: true });
  });

  test('symbol enter jumps preview to the selected location', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gv-panel-bridge-'));
    const filePath = join(root, 'demo.ts');
    writeFileSync(filePath, 'export function alpha() {}\nexport function beta() {}\n');

    panelManager = createTestManagers().panelManager;
    panelManager.registerType({
      id: 'preview',
      name: 'Preview',
      icon: 'P',
      category: 'development',
      description: 'preview',
      factory: () => new FilePreviewPanel(),
    });

    const preview = panelManager.open('preview', 'top') as FilePreviewPanel;
    preview.openFile(filePath);

    const symbols = new SymbolOutlinePanel();
    symbols.loadFile(filePath, 'export function alpha() {}\nexport function beta() {}\n');
    await waitForSymbolLocation(symbols); // wait for the background parse to populate rows
    symbols.handleInput('down');

    expect(handlePanelIntegrationAction(panelManager, symbols, 'enter')).toBe(true);
    expect(preview.getCurrentFilePath()).toBe(filePath);
    expect(preview.getScrollOffset()).toBe(1);

    rmSync(root, { recursive: true, force: true });
  });

  test('symbol enter is not swallowed when there is no symbol selected', () => {
    const symbols = new SymbolOutlinePanel(); // no file loaded — nothing to select
    expect(symbols.handleInput('enter')).toBe(false);
    expect(handlePanelIntegrationAction(panelManager, symbols, 'enter')).toBe(false);
  });

  test('approval enter executes the selected review command', async () => {
    const executeCommand = mock(async () => true);
    // The panel is data-driven: it surfaces the live permission-audit requests
    // and resolves the next-step review command from the selected request's
    // lane. Seed a pending "file"-lane request so Enter dispatches its review.
    const policyDep = {
      getSnapshot: () => ({
        recentPermissionAudit: [{
          callId: 'call-0',
          tool: 'Write',
          category: 'file',
          approved: undefined,
          riskLevel: 'high',
          classification: 'destructive',
          summary: 'write secret-bearing config',
          reasons: ['config mutation'],
          requestedAt: Date.now() - 5000,
        }],
      }),
    } as unknown as ConstructorParameters<typeof ApprovalPanel>[0];
    const panel = new ApprovalPanel(policyDep);
    panel.handleInput('down');

    expect(handlePanelIntegrationAction(panelManager, panel, 'enter', { executeCommand } as never)).toBe(true);
    expect(executeCommand).toHaveBeenCalledWith('approval', ['review', 'file']);
  });
});
