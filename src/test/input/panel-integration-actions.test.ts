import { afterEach, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handlePanelIntegrationAction } from '../../input/handler.ts';
import { FileExplorerPanel } from '../../panels/file-explorer-panel.ts';
import { FilePreviewPanel } from '../../panels/file-preview-panel.ts';
import { SymbolOutlinePanel } from '../../panels/symbol-outline-panel.ts';
import { ApprovalPanel } from '../../panels/approval-panel.ts';
import { PolicyRuntimeState } from '@/runtime/index.ts';
import { createTestManagers } from '../helpers/test-managers.ts';

let panelManager = createTestManagers().panelManager;

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
    expect((symbols as SymbolOutlinePanel).getSelectedLocation()).toEqual({ path: filePath, line: 1 });

    rmSync(root, { recursive: true, force: true });
  });

  test('symbol enter jumps preview to the selected location', () => {
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
    symbols.handleInput('down');

    expect(handlePanelIntegrationAction(panelManager, symbols, 'enter')).toBe(true);
    expect(preview.getCurrentFilePath()).toBe(filePath);
    expect(preview.getScrollOffset()).toBe(1);

    rmSync(root, { recursive: true, force: true });
  });

  test('approval enter executes the selected review command', async () => {
    const executeCommand = mock(async () => true);
    const panel = new ApprovalPanel(new PolicyRuntimeState());
    panel.handleInput('down');

    expect(handlePanelIntegrationAction(panelManager, panel, 'enter', { executeCommand } as never)).toBe(true);
    expect(executeCommand).toHaveBeenCalledWith('approval', ['review', 'file']);
  });
});
