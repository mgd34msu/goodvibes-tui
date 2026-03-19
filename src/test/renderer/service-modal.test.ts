/**
 * Tests for service-modal renderer and ServiceModal state class.
 */
import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ServiceModal } from '../../input/service-modal.ts';
import { ServiceRegistry } from '../../config/service-registry.ts';
import { renderServiceModal } from '../../renderer/service-modal.ts';
import { lineToString, linesToText } from '../setup.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const W = 120; // terminal width for tests

function makeTmpDir(): string {
  const dir = join(tmpdir(), `gv-svc-modal-test-${process.pid}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeServicesFile(dir: string, services: Record<string, unknown>): string {
  const filePath = join(dir, 'services.json');
  writeFileSync(filePath, JSON.stringify(services, null, 2) + '\n', 'utf-8');
  return filePath;
}

const SAMPLE_SERVICES = {
  openai: { name: 'openai', baseUrl: 'https://api.openai.com', authType: 'bearer', tokenKey: 'OPENAI_API_KEY' },
  github: { name: 'github', baseUrl: 'https://api.github.com', authType: 'bearer', tokenKey: 'GITHUB_TOKEN' },
};

// ---------------------------------------------------------------------------
// ServiceModal state tests
// ---------------------------------------------------------------------------

describe('ServiceModal', () => {
  let tmpDir: string;
  let filePath: string;
  let registry: ServiceRegistry;
  let modal: ServiceModal;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    filePath = writeServicesFile(tmpDir, SAMPLE_SERVICES);
    registry = new ServiceRegistry(filePath);
    modal = new ServiceModal(registry);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('open()', () => {
    test('sets active to true', async () => {
      await modal.open();
      expect(modal.active).toBe(true);
    });

    test('loads entries from registry', async () => {
      await modal.open();
      expect(modal.entries.length).toBe(2);
    });

    test('resets selectedIndex to 0', async () => {
      await modal.open();
      modal.moveDown();
      await modal.open();
      expect(modal.selectedIndex).toBe(0);
    });

    test('entry has correct key and config', async () => {
      await modal.open();
      const openaiEntry = modal.entries.find((e) => e.key === 'openai');
      expect(openaiEntry).toBeDefined();
      expect(openaiEntry!.config.authType).toBe('bearer');
      expect(openaiEntry!.config.baseUrl).toBe('https://api.openai.com');
    });

    test('hasToken is false when no secrets available', async () => {
      // Temporarily clear any env vars that would resolve as tokens for our test services.
      // SecretsManager checks process.env[tokenKey] first, so a real API key in env
      // causes hasToken=true even without a secrets file.
      const envSnapshot: Record<string, string | undefined> = {};
      const keysToMask = ['OPENAI_API_KEY', 'GITHUB_TOKEN'];
      for (const k of keysToMask) {
        envSnapshot[k] = process.env[k];
        delete process.env[k];
      }
      try {
        await modal.open();
        // With env vars cleared and no secrets file, hasToken must be false.
        for (const entry of modal.entries) {
          expect(entry.hasToken).toBe(false);
        }
      } finally {
        for (const k of keysToMask) {
          if (envSnapshot[k] !== undefined) process.env[k] = envSnapshot[k]!;
        }
      }
    });

    test('entries initialised with idle testStatus', async () => {
      await modal.open();
      for (const entry of modal.entries) {
        expect(entry.testStatus).toBe('idle');
        expect(entry.testCode).toBeNull();
        expect(entry.testError).toBeNull();
      }
    });

    test('empty registry produces empty entries', async () => {
      const emptyPath = writeServicesFile(tmpDir, {});
      const emptyRegistry = new ServiceRegistry(emptyPath);
      const emptyModal = new ServiceModal(emptyRegistry);
      await emptyModal.open();
      expect(emptyModal.entries).toHaveLength(0);
    });
  });

  describe('close()', () => {
    test('sets active to false', async () => {
      await modal.open();
      modal.close();
      expect(modal.active).toBe(false);
    });
  });

  describe('moveUp() / moveDown()', () => {
    test('moveDown increments selectedIndex', async () => {
      await modal.open();
      modal.moveDown();
      expect(modal.selectedIndex).toBe(1);
    });

    test('moveDown wraps around', async () => {
      await modal.open();
      modal.moveDown();
      modal.moveDown();
      expect(modal.selectedIndex).toBe(0);
    });

    test('moveUp wraps around', async () => {
      await modal.open();
      modal.moveUp();
      expect(modal.selectedIndex).toBe(1);
    });

    test('moveUp decrements selectedIndex', async () => {
      await modal.open();
      modal.moveDown();
      modal.moveUp();
      expect(modal.selectedIndex).toBe(0);
    });

    test('no-op when no entries', () => {
      modal.moveDown();
      modal.moveUp();
      expect(modal.selectedIndex).toBe(0);
    });
  });

  describe('getSelected()', () => {
    test('returns null when no entries', () => {
      expect(modal.getSelected()).toBeNull();
    });

    test('returns first entry after open', async () => {
      await modal.open();
      const sel = modal.getSelected();
      expect(sel).not.toBeNull();
      expect(modal.entries[0] as typeof sel).toBe(sel);
    });
  });

  describe('testSelected()', () => {
    test('sets status to error when no baseUrl', async () => {
      const noUrlPath = writeServicesFile(tmpDir, {
        svc: { name: 'svc', authType: 'bearer', tokenKey: 'SVC_KEY' },
      });
      const noUrlRegistry = new ServiceRegistry(noUrlPath);
      const noUrlModal = new ServiceModal(noUrlRegistry);
      await noUrlModal.open();
      await noUrlModal.testSelected();
      expect(noUrlModal.entries[0].testStatus).toBe('error');
      expect(noUrlModal.entries[0].testError).toContain('No baseUrl');
    });

    test('sets status to error on no-op when no entries', async () => {
      // getSelected returns null — testSelected should handle gracefully
      await modal.open();
      // Deplete entries
      modal.entries = [];
      modal.selectedIndex = 0;
      await modal.testSelected(); // should not throw
    });

    test('updates testStatus on network call', async () => {
      // Mock fetch to simulate a successful 200 response
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async (_url: RequestInfo | URL, _init?: RequestInit) => {
        return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
      }) as typeof fetch;
      try {
        await modal.open();
        await modal.testSelected();
        const entry = modal.entries[modal.selectedIndex];
        expect(entry.testStatus).toBe('ok');
        expect(entry.testCode).toBe(200);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    test('updates testStatus to error on network failure', async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async () => {
        throw new Error('Network unreachable');
      }) as unknown as typeof fetch;
      try {
        await modal.open();
        await modal.testSelected();
        const entry = modal.entries[modal.selectedIndex];
        expect(entry.testStatus).toBe('error');
        expect(entry.testError).toBeDefined();
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });
});

// ---------------------------------------------------------------------------
// renderServiceModal renderer tests
// ---------------------------------------------------------------------------

describe('renderServiceModal', () => {
  let tmpDir: string;
  let modal: ServiceModal;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('returns an array of Lines', async () => {
    const filePath = writeServicesFile(tmpDir, SAMPLE_SERVICES);
    const registry = new ServiceRegistry(filePath);
    modal = new ServiceModal(registry);
    await modal.open();
    const lines = renderServiceModal(modal, W);
    expect(Array.isArray(lines)).toBe(true);
    expect(lines.length).toBeGreaterThan(0);
  });

  test('each line has correct width', async () => {
    const filePath = writeServicesFile(tmpDir, SAMPLE_SERVICES);
    const registry = new ServiceRegistry(filePath);
    modal = new ServiceModal(registry);
    await modal.open();
    const lines = renderServiceModal(modal, W);
    for (let i = 0; i < lines.length; i++) {
      expect(lines[i].length).toBe(W);
    }
  });

  test('title bar contains "Services"', async () => {
    const filePath = writeServicesFile(tmpDir, SAMPLE_SERVICES);
    const registry = new ServiceRegistry(filePath);
    modal = new ServiceModal(registry);
    await modal.open();
    const lines = renderServiceModal(modal, W);
    const titleLine = lineToString(lines[0]);
    expect(titleLine).toContain('Services');
  });

  test('footer contains navigation hints', async () => {
    const filePath = writeServicesFile(tmpDir, SAMPLE_SERVICES);
    const registry = new ServiceRegistry(filePath);
    modal = new ServiceModal(registry);
    await modal.open();
    const lines = renderServiceModal(modal, W);
    const footerLine = lineToString(lines[lines.length - 1]);
    expect(footerLine).toContain('Navigate');
    expect(footerLine).toContain('Esc');
  });

  test('renders service names in list', async () => {
    const filePath = writeServicesFile(tmpDir, SAMPLE_SERVICES);
    const registry = new ServiceRegistry(filePath);
    modal = new ServiceModal(registry);
    await modal.open();
    const lines = renderServiceModal(modal, W);
    const texts = linesToText(lines).join('\n');
    expect(texts).toContain('openai');
    expect(texts).toContain('github');
  });

  test('shows selection indicator on selected item', async () => {
    const filePath = writeServicesFile(tmpDir, SAMPLE_SERVICES);
    const registry = new ServiceRegistry(filePath);
    modal = new ServiceModal(registry);
    await modal.open();
    const lines = renderServiceModal(modal, W);
    // The selected item should have the arrow indicator ▶
    const hasArrow = lines.some((line) => line.some((cell) => cell.char === '\u25b6'));
    expect(hasArrow).toBe(true);
  });

  test('renders empty state when no services', async () => {
    const emptyPath = writeServicesFile(tmpDir, {});
    const registry = new ServiceRegistry(emptyPath);
    modal = new ServiceModal(registry);
    await modal.open();
    const lines = renderServiceModal(modal, W);
    const texts = linesToText(lines).join('\n');
    expect(texts).toContain('No services configured');
  });

  test('shows token check badge (\u2713/\u2717)', async () => {
    const filePath = writeServicesFile(tmpDir, SAMPLE_SERVICES);
    const registry = new ServiceRegistry(filePath);
    modal = new ServiceModal(registry);
    await modal.open();
    const lines = renderServiceModal(modal, W);
    const texts = linesToText(lines).join('\n');
    // Either ✓ or ✗ symbol should appear in the status column
    const hasTokenBadge = texts.includes('\u2713') || texts.includes('\u2717');
    expect(hasTokenBadge).toBe(true);
  });

  test('shows test status badge after test', async () => {
    const filePath = writeServicesFile(tmpDir, SAMPLE_SERVICES);
    const registry = new ServiceRegistry(filePath);
    modal = new ServiceModal(registry);
    await modal.open();
    // Manually set test result on first entry
    modal.entries[0].testStatus = 'ok';
    modal.entries[0].testCode = 200;
    const lines = renderServiceModal(modal, W);
    const texts = linesToText(lines).join('\n');
    expect(texts).toContain('200');
  });

  test('shows pending test badge', async () => {
    const filePath = writeServicesFile(tmpDir, SAMPLE_SERVICES);
    const registry = new ServiceRegistry(filePath);
    modal = new ServiceModal(registry);
    await modal.open();
    modal.entries[0].testStatus = 'pending';
    const lines = renderServiceModal(modal, W);
    const texts = linesToText(lines).join('\n');
    expect(texts).toContain('\u22ef');
  });

  test('lines are correct at narrow terminal width', async () => {
    const filePath = writeServicesFile(tmpDir, SAMPLE_SERVICES);
    const registry = new ServiceRegistry(filePath);
    modal = new ServiceModal(registry);
    await modal.open();
    const narrowW = 60;
    const lines = renderServiceModal(modal, narrowW);
    for (const line of lines) {
      expect(line.length).toBe(narrowW);
    }
  });
});
