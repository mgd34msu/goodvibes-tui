import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ServiceRegistry } from '../../config/service-registry.ts';
import { ServicesPanel } from '../../panels/services-panel.ts';
import type { Line } from '../../types/grid.ts';

function linesText(lines: Line[]): string {
  return lines
    .map((line) => line.map((cell) => cell.char ?? ' ').join('').trimEnd())
    .filter(Boolean)
    .join('\n');
}

describe('ServicesPanel', () => {
  let root: string;
  let filePath: string;
  let registry: ServiceRegistry;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'gv-services-panel-'));
    filePath = join(root, '.goodvibes', 'tui', 'services.json');
    mkdirSync(join(root, '.goodvibes', 'tui'), { recursive: true });
    writeFileSync(filePath, JSON.stringify({
      slack: {
        name: 'Slack',
        baseUrl: 'https://slack.test/api',
        authType: 'bearer',
        tokenKey: 'SLACK_BOT_TOKEN',
        webhookUrlKey: 'SLACK_WEBHOOK_URL',
        signingSecretKey: 'SLACK_SIGNING_SECRET',
      },
    }), 'utf-8');
    process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';
    process.env.SLACK_WEBHOOK_URL = 'https://hooks.slack.test/example';
    process.env.SLACK_SIGNING_SECRET = 'secret';
    registry = new ServiceRegistry(filePath);
  });

  afterEach(() => {
    delete process.env.SLACK_BOT_TOKEN;
    delete process.env.SLACK_WEBHOOK_URL;
    delete process.env.SLACK_SIGNING_SECRET;
    rmSync(root, { recursive: true, force: true });
    mock.restore();
  });

  test('renders configured service details', async () => {
    const panel = new ServicesPanel(registry);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const text = linesText(panel.render(120, 14));
    expect(text).toContain('Service Control Room');
    expect(text).toContain('slack');
    expect(text).toContain('CONFIGURED');
    expect(text).toContain('Primary credential: present');
  });

  test('runs connection tests for the selected service', async () => {
    const fetchMock = mock(async () => new Response('{}', { status: 200 }));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    try {
      const panel = new ServicesPanel(registry);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(panel.handleInput('t')).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 0));
      const text = linesText(panel.render(120, 14));
      expect(text).toContain('HEALTHY');
      expect(text).toContain('Last test: ok');
      expect(fetchMock).toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
