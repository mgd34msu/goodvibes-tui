import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConfigManager } from '@pellux/goodvibes-sdk/platform/config/manager';
import { MemoryRegistry, MemoryStore } from '@pellux/goodvibes-sdk/platform/state/memory-store';
import { MemoryEmbeddingProviderRegistry } from '@pellux/goodvibes-sdk/platform/state/index';
import { KnowledgePanel } from '../../panels/knowledge-panel.ts';
import type { Line } from '@pellux/goodvibes-sdk/platform/types/grid';

function linesText(lines: Line[]): string {
  return lines
    .map((line) => line.map((cell) => cell.char ?? ' ').join('').trimEnd())
    .filter(Boolean)
    .join('\n');
}

describe('KnowledgePanel', () => {
  let dir: string;
  let store: MemoryStore;
  let registry: MemoryRegistry;
  let configManager: ConfigManager;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'gv-knowledge-panel-'));
    configManager = new ConfigManager({ surfaceRoot: 'tui',  configDir: join(dir, '.goodvibes', 'tui'), workingDir: dir });
    store = new MemoryStore(join(dir, 'memory.sqlite'), {
      embeddingRegistry: new MemoryEmbeddingProviderRegistry({ configManager }),
    });
    await store.init();
    registry = new MemoryRegistry(store);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('renders empty knowledge guidance', () => {
    const panel = new KnowledgePanel(registry);
    const text = linesText(panel.render(120, 12));
    expect(text).toContain('Knowledge Control Room');
    expect(text).toContain('No durable project knowledge');
    expect(text).toContain('Suggested next steps');
  });

  test('renders knowledge counts and summaries', async () => {
    await registry.add({ cls: 'risk', summary: 'MCP deploy surface is broader than expected.', review: { state: 'fresh', confidence: 65 } });
    await registry.add({ cls: 'runbook', summary: 'Quarantine unknown MCP schema and require operator approval.', review: { state: 'fresh', confidence: 80 } });
    await registry.add({ cls: 'architecture', summary: 'Remote runners should connect through the daemon transport boundary.', review: { state: 'reviewed', confidence: 92 } });
    await registry.add({ cls: 'incident', summary: 'Provider timeout caused a failed verification turn.', review: { state: 'stale', confidence: 30, staleReason: 'provider contract changed' } });

    const panel = new KnowledgePanel(registry);
    const text = linesText(panel.render(140, 24));
    expect(text).toContain('risks');
    expect(text).toContain('Runbooks');
    expect(text).toContain('Architecture Notes');
    expect(text).toContain('Selected');
    expect(text).toContain('MCP deploy surface');
    expect(text).toContain('Review Queue');
    expect(text).toContain('stale');
  });

  test('supports operator review actions from the panel', async () => {
    const record = await registry.add({ cls: 'fact', summary: 'Knowledge item awaiting review.', review: { state: 'fresh', confidence: 55 } });
    const panel = new KnowledgePanel(registry);
    panel.onActivate();

    expect(panel.handleInput('r')).toBe(true);
    const reviewed = registry.get(record.id);
    expect(reviewed?.reviewState).toBe('reviewed');
    expect(reviewed?.confidence).toBeGreaterThanOrEqual(85);

    expect(panel.handleInput('ArrowDown')).toBe(true);
    expect(panel.handleInput('s')).toBe(true);
    expect(registry.get(record.id)?.reviewState).toBe('stale');

    panel.onDeactivate();
    panel.onDestroy();
  });
});
