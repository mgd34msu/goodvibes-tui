import { describe, expect, test, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { registerQrcodeRuntimeCommands } from '../../input/commands/qrcode-runtime.ts';
import { getOrCreateCompanionToken } from '@pellux/goodvibes-sdk/platform/pairing';

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) { try { rmSync(r, { recursive: true, force: true }); } catch { /* best effort */ } } });

function ctx(homeDirectory: string, out: string[], opened: string[]): CommandContext {
  return {
    print: (m: string) => out.push(m),
    openModal: (n: string) => opened.push(n),
    workspace: { shellPaths: { homeDirectory } },
  } as unknown as CommandContext;
}

describe('/qrcode command', () => {
  test('no args opens the pairing modal', async () => {
    const registry = new CommandRegistry();
    registerQrcodeRuntimeCommands(registry);
    const opened: string[] = [];
    await registry.execute('qrcode', [], ctx('/tmp', [], opened));
    expect(opened).toEqual(['pairing-modal']);
  });

  test('regenerate rotates the pairing token so the previous token is invalidated', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gv-qr-regen-'));
    roots.push(home);
    const daemonHomeDir = join(home, '.goodvibes', 'daemon');
    const original = getOrCreateCompanionToken('tui', { daemonHomeDir });

    const registry = new CommandRegistry();
    registerQrcodeRuntimeCommands(registry);
    const out: string[] = [];
    const opened: string[] = [];
    await registry.execute('qrcode', ['regenerate'], ctx(home, out, opened));

    // The store now holds a different token — the old one no longer resolves.
    const afterRotate = getOrCreateCompanionToken('tui', { daemonHomeDir });
    expect(afterRotate.token).not.toBe(original.token);
    expect(out.join('\n')).toContain('Pairing token rotated');
    expect(opened).toEqual([]); // regenerate does not open the modal
  });
});
